"""Accounts database: users, Lemon Squeezy subscriptions, minutes usage.

Lives in the same SQLite file as the jobs (backend.jobs._db_path()) but
in its own tables, with its own connection + lock — or, with Postgres
active (backend/db.py), in the same-named Postgres tables (backend/pg.py).
The SQL below is written once for both: `?` placeholders (the Postgres
adapter turns them into %s), INSERT … ON CONFLICT, timestamps passed as
db.ts(...) and read back as Unix floats, booleans as True/False. Writes
run in _tx(fn, lock_key): SQLite BEGIN IMMEDIATE (one writer at a time),
Postgres BEGIN + pg_advisory_xact_lock(hashtext(lock_key)), so a
read-check-write (the quota charge) is atomic across processes too.
Only backend/main.py, backend/auth.py and backend/billing.py import this
module; the desktop app and the Modal image never load it.

Tables (all CREATE TABLE IF NOT EXISTS, so adding them is migration-safe):

    meta(key, value)                     media-token secret etc.
    users(id, email, ...)                id = Clerk user id (JWT `sub`)
    subscriptions(id, user_id, ...)      one row per LS subscription
    usage(job_id, user_id, seconds_billed, ...)
                                         minutes ledger; outlives job
                                         deletion so deleting a project
                                         doesn't give minutes back
    billing_events(key, created_at)      webhook idempotency

All timestamps are Unix seconds (REAL; timestamptz in Postgres,
converted at the adapter boundary).
"""
from __future__ import annotations

import calendar
import json
import math
import os
import secrets
import sqlite3
import threading
import time
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from backend import db, jobs
from backend.db import ts

# Minutes of video per billing period (one calendar month). Override per
# plan with e.g. CLEO_PLAN_MINUTES_PRO=400. Retention per plan stays in
# backend.jobs.PLAN_RETENTION_DAYS.
PLAN_ORDER = ("starter", "pro", "studio")
PLAN_MINUTES: dict[str, float] = {
    plan: float(os.environ.get(f"CLEO_PLAN_MINUTES_{plan.upper()}", minutes))
    for plan, minutes in (("starter", 90), ("pro", 300), ("studio", 900))
}

# LS statuses that keep access. `cancelled` does too, until ends_at;
# paused / unpaid / expired don't.
_GRANTING = {"active", "on_trial", "past_due"}
# No access, but billing can start again (a paused subscription resumes,
# an unpaid one recovers once the card is fixed): a second checkout now
# would end in two paid subscriptions.
_REACTIVATABLE = {"paused", "unpaid"}

# The analysis may find the video longer than the upload probe said
# (container durations can be wrong or crafted); beyond this many
# seconds the difference is charged afterwards.
TRUE_UP_TOLERANCE_S = 5.0

_lock = threading.RLock()
# sqlite3.Connection, or backend.pg.AccountsDB while Postgres is active.
_conn: Any = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    created_at REAL,
    updated_at REAL
);
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    variant_id TEXT,
    plan TEXT,
    status TEXT,
    test_mode INTEGER DEFAULT 0,
    customer_id TEXT,
    renews_at REAL,
    ends_at REAL,
    period_start REAL,
    portal_url TEXT,
    update_payment_url TEXT,
    raw_json TEXT,
    updated_at REAL,
    created_at REAL,
    ls_updated_at REAL
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);
CREATE TABLE IF NOT EXISTS usage (
    job_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    seconds_billed REAL NOT NULL DEFAULT 0,
    seconds_actual REAL,
    created_at REAL NOT NULL,
    period_start REAL,
    refunded INTEGER DEFAULT 0,
    note TEXT
);
CREATE INDEX IF NOT EXISTS usage_user ON usage(user_id, created_at);
CREATE TABLE IF NOT EXISTS billing_events (
    key TEXT PRIMARY KEY,
    created_at REAL
);
"""


class QuotaExceeded(Exception):
    def __init__(self, remaining_seconds: float, needed_seconds: float):
        super().__init__("quota_exceeded")
        self.remaining_seconds = remaining_seconds
        self.needed_seconds = needed_seconds


class SubscriptionRequired(Exception):
    pass


@dataclass
class Entitlement:
    plan: str
    source: str  # "comp" | "subscription"
    subscription: dict[str, Any] | None = None


# ── connection ───────────────────────────────────────────────────────


def db_path() -> str:
    return jobs._db_path()


def db_is_persistent() -> bool:
    """False when the DB silently fell back to /tmp (wiped on every
    redeploy) — billing refuses to run on that. Postgres always is."""
    if db.active() == "postgres":
        return True
    if os.environ.get("CLEO_JOB_DB"):
        return True
    return db_path() != "/tmp/cleo_jobs.db"


def _db() -> Any:
    """Open (once) the accounts connection: SQLite in autocommit mode
    (every write below runs in an explicit BEGIN IMMEDIATE ... COMMIT),
    or the Postgres adapter (backend.pg.AccountsDB: same execute() with
    ? placeholders, rows as dicts) while Postgres is active."""
    global _conn
    if _conn is not None:
        return _conn
    backend = db.active()
    with _lock:
        if _conn is None:
            if backend == "postgres":
                from backend import pg
                _conn = pg.accounts_db()
                return _conn
            path = db_path()
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(path, check_same_thread=False,
                                   timeout=30, isolation_level=None)
            conn.row_factory = sqlite3.Row
            jobs.tune_connection(conn)  # WAL + busy_timeout
            conn.executescript(_SCHEMA)
            _conn = conn
        return _conn


def _is_sqlite(conn: Any) -> bool:
    return isinstance(conn, sqlite3.Connection)


def _local_lock(conn: Any):
    """The module lock on SQLite (one connection shared by all threads);
    nothing on Postgres, where every call gets its own pooled connection
    and _tx's advisory lock does the serializing, across processes."""
    return _lock if _is_sqlite(conn) else nullcontext()


def _tx(fn: Callable[[Any], Any], lock_key: str | None = None) -> Any:
    """Run fn(conn) in one write transaction. SQLite: BEGIN IMMEDIATE
    under the module lock (the database-wide write lock; lock_key is
    implied). Postgres: BEGIN, plus pg_advisory_xact_lock on
    hashtext(lock_key) when given — callers with the same key run one
    after the other, in any process."""
    conn = _db()
    if not _is_sqlite(conn):
        with conn.transaction(lock_key) as tx:
            return fn(tx)
    with _lock:
        conn.execute("BEGIN IMMEDIATE")
        try:
            out = fn(conn)
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")
        return out


def _xact_lock(conn: Any, key: str) -> None:
    """Inside a _tx transaction: also serialize on `key` (Postgres advisory
    lock until commit). SQLite's BEGIN IMMEDIATE holds the write lock
    already."""
    lock = getattr(conn, "lock", None)
    if lock is not None:
        lock(key)


def _read(sql: str, args: tuple = ()) -> list[Any]:
    conn = _db()
    if not _is_sqlite(conn):
        return conn.read(sql, args)
    with _lock:
        return conn.execute(sql, args).fetchall()


# ── meta ─────────────────────────────────────────────────────────────


def meta_get_or_create(key: str, factory: Callable[[], str]) -> str:
    """Value stored under `key`, created with factory() on first use.
    Reads first: only the very first call needs the write lock (media
    tokens are checked on every media request)."""
    value = meta_get(key)
    if value is not None:
        return value

    def _do(conn):
        row = conn.execute("SELECT value FROM meta WHERE key = ?",
                           (key,)).fetchone()
        if row is not None:
            return row["value"]
        value = factory()
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)",
                     (key, value))
        return value
    return _tx(_do, lock_key=f"meta:{key}")


def meta_get(key: str) -> str | None:
    rows = _read("SELECT value FROM meta WHERE key = ?", (key,))
    return rows[0]["value"] if rows else None


def meta_set(key: str, value: str) -> None:
    _tx(lambda conn: conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value)))


def sqlite_identity(path: str) -> str:
    """The SQLite file's identity: its real path and inode. A copy (a
    clone, a backup put in place of the file) is a new file."""
    real = os.path.realpath(path)
    try:
        ino = os.stat(real).st_ino
    except OSError:
        ino = 0
    return f"sqlite:{real}:{ino}"


def db_identity() -> str:
    """What this database physically is — unlike anything stored IN it
    (meta), which a clone, dump or restore copies along. SQLite: the
    file (sqlite_identity). Postgres: the cluster's system_identifier
    (new for every initdb — a restore elsewhere, a fresh staging server)
    plus the database's name and OID (new for every CREATE DATABASE — a
    restore into an empty database of the same cluster). Without the
    rights to read pg_control_system() the system_identifier is "?"."""
    conn = _db()
    if _is_sqlite(conn):
        return sqlite_identity(db_path())
    try:
        sysid = str(conn.read("SELECT system_identifier::text AS v "
                              "FROM pg_control_system()")[0]["v"])
    except Exception:
        sysid = "?"
    row = conn.read("SELECT current_database() AS d, (SELECT oid::text FROM "
                    "pg_database WHERE datname = current_database()) AS o")[0]
    return f"pg:{sysid}:{row['d']}:{row['o']}"


def media_secret() -> str:
    """Key for media-URL tokens (backend/auth.py). CLEO_MEDIA_SECRET wins;
    otherwise one is generated once and kept in the DB, so tokens stay
    valid across restarts."""
    env = os.environ.get("CLEO_MEDIA_SECRET", "").strip()
    if env:
        return env
    return meta_get_or_create("media_secret", lambda: secrets.token_hex(32))


def checkout_secret() -> str:
    """Key that signs the user id in our checkouts' custom data
    (backend/billing.py). Generated once, kept in the DB."""
    return meta_get_or_create("checkout_secret",
                              lambda: secrets.token_hex(32))


def note_checkout(user_id: str, now: float | None = None) -> None:
    """Remember when the user last opened one of our checkouts."""
    meta_set(f"checkout_at:{user_id}", repr(time.time() if now is None
                                             else float(now)))


def last_checkout_at(user_id: str) -> float | None:
    value = meta_get(f"checkout_at:{user_id}")
    try:
        return float(value) if value else None
    except ValueError:
        return None


# ── users ────────────────────────────────────────────────────────────


def ensure_user(user_id: str, email: str | None = None) -> dict[str, Any]:
    """Create the user row on first sight; fill in / update the email."""
    now = time.time()

    def _do(conn):
        row = conn.execute("SELECT * FROM users WHERE id = ?",
                           (user_id,)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO users (id, email, created_at, updated_at) "
                "VALUES (?, ?, ?, ?)", (user_id, email, ts(now), ts(now)))
        elif email and row["email"] != email:
            conn.execute("UPDATE users SET email = ?, updated_at = ? "
                         "WHERE id = ?", (email, ts(now), user_id))
        return dict(conn.execute("SELECT * FROM users WHERE id = ?",
                                 (user_id,)).fetchone())
    return _tx(_do, lock_key=f"user:{user_id}")


def get_user(user_id: str) -> dict[str, Any] | None:
    rows = _read("SELECT * FROM users WHERE id = ?", (user_id,))
    return dict(rows[0]) if rows else None


def users_by_email(email: str) -> list[dict[str, Any]]:
    rows = _read("SELECT * FROM users WHERE lower(email) = lower(?)",
                 (email,))
    return [dict(r) for r in rows]


# ── subscriptions ────────────────────────────────────────────────────

_SUB_COLUMNS = (
    "user_id", "variant_id", "plan", "status", "test_mode", "customer_id",
    "renews_at", "ends_at", "portal_url", "update_payment_url", "raw_json",
    "created_at", "ls_updated_at",
)
_SUB_TIMES = {"renews_at", "ends_at", "created_at", "ls_updated_at"}


def _sub_params(sub: dict[str, Any]) -> tuple:
    """sub's _SUB_COLUMNS values as query parameters: times via ts(),
    test_mode as a boolean (SQLite stores 1/0, Postgres a boolean),
    raw_json marked as JSON (Postgres cleans what jsonb refuses, e.g. a
    NUL in the buyer's name, instead of failing the webhook forever)."""
    out = []
    for c in _SUB_COLUMNS:
        value = sub.get(c)
        if c in _SUB_TIMES:
            value = ts(value)
        elif c == "test_mode" and value is not None:
            value = bool(value)
        elif c == "raw_json" and isinstance(value, str):
            value = db.JsonText(value)
        out.append(value)
    return tuple(out)


def upsert_subscription_tx(conn: Any, sub: dict[str, Any]) -> bool:
    """Insert or update one subscription inside the caller's transaction.

    Skips (returns False) when the stored row is newer than `sub`
    (ls_updated_at), so a late or replayed event can't roll the state
    back. period_start is only ever set by set_period_start_tx.
    """
    now = time.time()
    _xact_lock(conn, f"sub:{sub['id']}")
    row = conn.execute("SELECT user_id, ls_updated_at FROM subscriptions "
                       "WHERE id = ?", (sub["id"],)).fetchone()
    if row is not None:
        old = row["ls_updated_at"] or 0
        new = sub.get("ls_updated_at") or 0
        if new and old and new < old:
            return False
        cols = ", ".join(f"{c} = ?" for c in _SUB_COLUMNS)
        conn.execute(
            f"UPDATE subscriptions SET {cols}, updated_at = ? WHERE id = ?",
            _sub_params(sub) + (ts(now), sub["id"]))
        return True
    cols = ", ".join(("id",) + _SUB_COLUMNS + ("updated_at",))
    marks = ", ".join("?" for _ in range(len(_SUB_COLUMNS) + 2))
    conn.execute(
        f"INSERT INTO subscriptions ({cols}) VALUES ({marks})",
        (sub["id"],) + _sub_params(sub) + (ts(now),))
    return True


def set_period_start_tx(conn: Any, sub_id: str,
                        period_start: float) -> None:
    """Move the quota period start forward (never back — an old invoice
    arriving late must not re-open a finished period)."""
    conn.execute(
        "UPDATE subscriptions SET period_start = ? WHERE id = ? AND "
        "(period_start IS NULL OR period_start < ?)",
        (ts(period_start), sub_id, ts(period_start)))


def upsert_subscription(sub: dict[str, Any]) -> bool:
    return _tx(lambda conn: upsert_subscription_tx(conn, sub))


def set_period_start(sub_id: str, period_start: float) -> None:
    _tx(lambda conn: set_period_start_tx(conn, sub_id, period_start))


def get_subscription(sub_id: str) -> dict[str, Any] | None:
    rows = _read("SELECT * FROM subscriptions WHERE id = ?", (sub_id,))
    return dict(rows[0]) if rows else None


def subscriptions_for(user_id: str) -> list[dict[str, Any]]:
    """Newest first by Lemon Squeezy's own time. Not by `updated_at`: that
    is the local sync time, bumped by every re-sync, so the order (and
    the subscription GET /me shows) would flip with each refresh."""
    rows = _read("SELECT * FROM subscriptions WHERE user_id = ? "
                 "ORDER BY COALESCE(ls_updated_at, created_at, updated_at) "
                 "DESC, id DESC", (user_id,))
    return [dict(r) for r in rows]


def all_subscription_ids() -> set[str]:
    return {r["id"] for r in _read("SELECT id FROM subscriptions")}


def event_seen(key: str) -> bool:
    return bool(_read("SELECT 1 FROM billing_events WHERE key = ?", (key,)))


def apply_event(key: str, fn: Callable[[Any], Any]) -> bool:
    """Record webhook `key` and run fn(conn) in ONE transaction: if fn
    fails nothing is recorded, so Lemon Squeezy's retry is processed
    again. Returns False when the key was already processed (also when
    another process records it at the same moment: its insert wins, ours
    waits for it and then does nothing)."""
    def _do(conn):
        cur = conn.execute("INSERT INTO billing_events (key, created_at) "
                           "VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                           (key, ts(time.time())))
        if cur.rowcount == 0:
            return False
        fn(conn)
        return True
    return _tx(_do)


# ── entitlement ──────────────────────────────────────────────────────


def test_mode() -> bool:
    """LEMONSQUEEZY_TEST_MODE=1: only test-mode subscriptions count (for
    trying the flow on production with a test card); otherwise only
    live ones."""
    return os.environ.get("LEMONSQUEEZY_TEST_MODE", "").strip().lower() in (
        "1", "true", "yes")


def _listed(env: str, user_id: str, email: str | None) -> bool:
    """Is the user in the comma list of Clerk user ids / emails in `env`?
    Emails match the token's email or the stored one — which is only
    known with CLERK_SECRET_KEY set (session tokens carry none)."""
    raw = os.environ.get(env, "")
    entries = {e.strip().lower() for e in raw.split(",") if e.strip()}
    if not entries:
        return False
    if user_id.lower() in entries:
        return True
    if email is None:
        u = get_user(user_id)
        email = u["email"] if u else None
    return bool(email) and email.lower() in entries


def is_comp(user_id: str, email: str | None = None) -> bool:
    """CLEO_COMP_USERS: comma list of Clerk user ids or emails that get
    Studio without paying (testers, friends, grandfathered beta users)."""
    return _listed("CLEO_COMP_USERS", user_id, email)


def is_billing_tester(user_id: str, email: str | None = None) -> bool:
    """May check out while LEMONSQUEEZY_TEST_MODE is on: CLEO_BILLING_TESTERS
    (same format as CLEO_COMP_USERS) and the comp users. Everyone else
    would get a plan for a public test card number."""
    return (_listed("CLEO_BILLING_TESTERS", user_id, email)
            or is_comp(user_id, email))


def grants_access(sub: dict[str, Any], now: float | None = None) -> bool:
    now = time.time() if now is None else now
    status = sub.get("status")
    if status in _GRANTING:
        return True
    if status == "cancelled":
        return bool(sub.get("ends_at")) and sub["ends_at"] > now
    return False


def entitlement(user_id: str, email: str | None = None,
                now: float | None = None) -> Entitlement | None:
    """Best plan the user currently has, or None."""
    if is_comp(user_id, email):
        return Entitlement(plan="studio", source="comp")
    mode = test_mode()
    best: dict[str, Any] | None = None
    for sub in subscriptions_for(user_id):
        if bool(sub.get("test_mode")) != mode:
            continue
        if sub.get("plan") not in PLAN_ORDER or not grants_access(sub, now):
            continue
        if best is None or (PLAN_ORDER.index(sub["plan"])
                            > PLAN_ORDER.index(best["plan"])):
            best = sub
    if best is None:
        return None
    return Entitlement(plan=best["plan"], source="subscription",
                       subscription=best)


def open_subscription(user_id: str, now: float | None = None
                      ) -> dict[str, Any] | None:
    """A subscription in the configured mode that still grants access or
    can resume billing (paused, unpaid) — mapped to a plan or not, comp
    user or not. A new checkout then would mean paying twice; plan
    changes, resuming and card updates go through the portal instead."""
    mode = test_mode()
    subs = [s for s in subscriptions_for(user_id)
            if bool(s.get("test_mode")) == mode]
    for sub in subs:
        if grants_access(sub, now):
            return sub
    for sub in subs:
        if sub.get("status") in _REACTIVATABLE:
            return sub
    return None


def latest_subscription(user_id: str) -> dict[str, Any] | None:
    """Newest subscription in the configured mode, granting or not (so
    the account page can say 'expired' / 'paused')."""
    mode = test_mode()
    for sub in subscriptions_for(user_id):
        if bool(sub.get("test_mode")) == mode:
            return sub
    return None


# ── periods ──────────────────────────────────────────────────────────


def add_months(ts: float, months: int) -> float:
    """ts plus whole calendar months (UTC), day clamped to the month's
    length: Jan 31 + 1 → Feb 28/29."""
    d = datetime.fromtimestamp(ts, tz=timezone.utc)
    m = d.month - 1 + months
    year, month = d.year + m // 12, m % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return d.replace(year=year, month=month, day=day).timestamp()


def _months_advanced(start: float, now: float) -> float:
    """`start` advanced by whole calendar months to the last point <= now
    (computed from `start` each time, so day clamping doesn't drift)."""
    if start > now:
        return start
    d0 = datetime.fromtimestamp(start, tz=timezone.utc)
    d1 = datetime.fromtimestamp(now, tz=timezone.utc)
    n = (d1.year - d0.year) * 12 + (d1.month - d0.month)
    while n > 0 and add_months(start, n) > now:
        n -= 1
    return add_months(start, max(n, 0))


def period_for(ent: Entitlement, now: float | None = None
               ) -> tuple[float, float]:
    """(start, end) of the quota period.

    Subscription: start = created_at of the last paid initial/renewal
    invoice (set from webhooks / the API); without one, the subscription
    start advanced by whole months. A past_due user whose renewal hasn't
    been paid keeps the old period (and its remaining minutes) — it is
    NOT reset just because the date passed. Comp: the calendar month.
    """
    now = time.time() if now is None else now
    sub = ent.subscription or {}
    start = sub.get("period_start")
    if not start:
        created = sub.get("created_at")
        if created:
            start = _months_advanced(created, now)
        else:
            d = datetime.fromtimestamp(now, tz=timezone.utc)
            start = datetime(d.year, d.month, 1, tzinfo=timezone.utc
                             ).timestamp()
    return start, add_months(start, 1)


def limit_seconds(plan: str) -> float:
    return PLAN_MINUTES.get(plan, 0.0) * 60


# ── usage ledger ─────────────────────────────────────────────────────


def _used_tx(conn: Any, user_id: str, period_start: float) -> float:
    row = conn.execute(
        "SELECT COALESCE(SUM(seconds_billed), 0) AS s FROM usage "
        "WHERE user_id = ? AND refunded = ? AND created_at >= ?",
        (user_id, False, ts(period_start))).fetchone()
    return float(row["s"] or 0)


def used_seconds(user_id: str, period_start: float) -> float:
    conn = _db()
    with _local_lock(conn):
        return _used_tx(conn, user_id, period_start)


def charge(job_id: str, user_id: str, seconds: float, *,
           email: str | None = None, enforce: bool = True,
           now: float | None = None) -> Entitlement | None:
    """Check the quota and record `seconds` for job_id — atomically, so
    two parallel uploads can't both spend the last minutes: the sum and
    the insert run in one transaction under the user's lock (SQLite: the
    write lock; Postgres: advisory lock 'user:<id>', across processes).

    enforce=False records the usage (the account page shows it) but
    never refuses. Raises SubscriptionRequired / QuotaExceeded. Returns
    the entitlement the charge ran under (None = no plan, not enforced).
    """
    now = time.time() if now is None else now
    seconds = float(math.ceil(max(0.0, seconds)))
    with _local_lock(_db()):
        ent = entitlement(user_id, email, now)
        if ent is None and enforce:
            raise SubscriptionRequired()
        period_start = period_for(ent, now)[0] if ent else None

        def _do(conn):
            if ent is not None and enforce:
                used = _used_tx(conn, user_id, period_start)
                remaining = max(0.0, limit_seconds(ent.plan) - used)
                if seconds > remaining:
                    raise QuotaExceeded(remaining, seconds)
            conn.execute(
                "INSERT INTO usage (job_id, user_id, seconds_billed, "
                "created_at, period_start) VALUES (?, ?, ?, ?, ?)",
                (job_id, user_id, seconds, ts(now), ts(period_start)))
        _tx(_do, lock_key=f"user:{user_id}")
        return ent


def get_usage(job_id: str) -> dict[str, Any] | None:
    rows = _read("SELECT * FROM usage WHERE job_id = ?", (job_id,))
    return dict(rows[0]) if rows else None


def true_up(job_id: str, actual_seconds: float) -> float:
    """After analysis: record the real length and charge the difference
    if it is longer than billed + tolerance. May push the user slightly
    over quota — the job is never failed for it. Returns the extra
    seconds charged (0 if none / no ledger row)."""
    def _do(conn):
        row = conn.execute("SELECT seconds_billed, refunded FROM usage "
                           "WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            return 0.0
        billed = float(row["seconds_billed"] or 0)
        extra = 0.0
        if actual_seconds > billed + TRUE_UP_TOLERANCE_S and not row["refunded"]:
            extra = float(math.ceil(actual_seconds)) - billed
        conn.execute(
            "UPDATE usage SET seconds_actual = ?, seconds_billed = ? "
            "WHERE job_id = ?", (actual_seconds, billed + extra, job_id))
        return extra
    return _tx(_do)


def refund(job_id: str, note: str = "") -> bool:
    """Give a job's minutes back (infrastructure failures only).
    Idempotent; returns True if something was refunded."""
    def _do(conn):
        cur = conn.execute(
            "UPDATE usage SET refunded = ?, note = ? "
            "WHERE job_id = ? AND refunded = ?",
            (True, note[:200], job_id, False))
        return cur.rowcount > 0
    return _tx(_do)


def minutes_summary(user_id: str, ent: Entitlement,
                    now: float | None = None) -> dict[str, Any]:
    """Quota numbers for GET /me. Minutes are shown with one decimal;
    the raw seconds are included for exact comparisons."""
    start, end = period_for(ent, now)
    limit = limit_seconds(ent.plan)
    used = used_seconds(user_id, start)
    remaining = max(0.0, limit - used)
    return {
        "limit": round(limit / 60, 1),
        "used": round(used / 60, 1),
        "remaining": round(remaining / 60, 1),
        "limit_seconds": limit,
        "used_seconds": used,
        "remaining_seconds": remaining,
        "period_start": iso(start),
        "period_end": iso(end),
    }


# ── time helpers ─────────────────────────────────────────────────────


def parse_ts(value: Any) -> float | None:
    """LS timestamps ('2025-05-23T13:50:48.000000Z') → Unix seconds."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")
                                      ).timestamp()
    except ValueError:
        return None


def iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def subscription_public(sub: dict[str, Any] | None) -> dict[str, Any] | None:
    """What GET /me shows about a subscription."""
    if not sub:
        return None
    return {
        "status": sub.get("status"),
        "plan": sub.get("plan"),
        "renews_at": iso(sub.get("renews_at")),
        "ends_at": iso(sub.get("ends_at")),
        "test_mode": bool(sub.get("test_mode")),
    }


def _reset_for_tests() -> None:
    """Close the connection so the next call reopens jobs._db_path()
    (with Postgres: drops the adapter; the pool stays open)."""
    global _conn
    with _lock:
        if _conn is not None and _is_sqlite(_conn):
            _conn.close()
        _conn = None


def dump_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), default=str)
