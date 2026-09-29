"""Postgres: connection pool, schema migrations, the job store and the
accounts adapter.

Imported only while Postgres is the active database (backend/db.py) —
psycopg stays out of the desktop app, the Modal image and SQLite
deployments.

Connection: psycopg_pool.ConnectionPool(min_size=1, max_size=
CLEO_DB_POOL_MAX, default 10), prepare_threshold=None (no prepared
statements, so a transaction pooler such as PgBouncer / Neon's pooled
URL doesn't break the queries), 5 s connect timeout, autocommit off:
every `with database.connection()` block is one transaction (commit on
success, rollback on an exception). statement_timeout 15 s and UTC are
SET once per pooled connection (session level) — behind a transaction
pooler those don't carry over to the server connection a later
transaction lands on, so use the direct URL (Railway's
${{Postgres.DATABASE_URL}} is), or set them on the role (DEPLOY.md 8.1).
After an outage the pool reconnects in cycles of RECONNECT_TIMEOUT_S
(backoff 1, 2, 4, 8 … s inside a cycle, then the next request starts a
new one), so it serves again within seconds of Postgres coming back.

Schema: versioned migrations (MIGRATIONS), applied at boot inside an
advisory lock, recorded in schema_migrations. The jobs table keeps the
whole Job as JSON in `data` — the SQLite blob's shape: the structured
fields (jobs._JSON_FIELDS: settings, outputs, subtitles, …) are nested
JSON strings, so jsonb keeps their text exactly as written (it would
sort object keys — "primary" first in `outputs` is the order of the
download buttons — and hand floats >= 1e16 back as integers) — plus
hot columns kept in sync on every write
(owner_id, status, plan, created_at, updated_at) for the indexed
queries; the upload's storage key is `idempotency_key` (UNIQUE,
replaces SQLite's job_keys table). The accounts tables have the same
columns as in SQLite, with Postgres types.

Values SQLite stores but Postgres refuses are made storable on the way
in (to_json / clean_text, also in the cutover): NUL characters are
dropped, lone UTF-16 surrogates become U+FFFD — in the nested JSON
strings too, so a job reads back the same on both databases; top-level
NaN / ±Infinity and floats jsonb would hand back as integers (≥ 1e16)
are kept as {"$float": "…"}.

Timestamps: the Python code uses Unix floats everywhere. Postgres stores
timestamptz; floats are converted on the way in (db.Epoch parameters,
_dt() for the job hot columns) and timestamptz values come back as
floats (the accounts rows; the job data keeps its floats in the JSON).
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from contextlib import contextmanager
from dataclasses import fields
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterator

import psycopg
from psycopg.types.string import TextLoader
from psycopg_pool import ConnectionPool

from backend import db
from backend.jobs import (
    RUNNING_STATUSES, DuplicateKey, Job, _JSON_FIELDS, _STATUS_FIELDS,
    job_from_dict, job_to_dict,
    new_job_id,
)

STATEMENT_TIMEOUT_MS = 15_000
CONNECT_TIMEOUT_S = 5
# How long one reconnect cycle of the pool lasts before it gives up
# (psycopg_pool's backoff inside a cycle doubles: 1, 2, 4, 8 … s); the
# next request then starts a fresh cycle from 1 s. psycopg_pool's
# default (300 s) let the gaps grow to 64 / 128 s, so after an outage
# the pool stayed down for up to about as long again once Postgres was
# back.
RECONNECT_TIMEOUT_S = 20.0


def pool_max() -> int:
    try:
        return max(1, int(os.environ.get("CLEO_DB_POOL_MAX", "").strip()
                          or 10))
    except ValueError:
        return 10


# ── schema ───────────────────────────────────────────────────────────
# Append new versions; never edit an applied one. Each runs once, in the
# boot transaction that holds the schema advisory lock.

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS meta (
    key text COLLATE "C" PRIMARY KEY,
    value text
);
CREATE TABLE IF NOT EXISTS users (
    id text COLLATE "C" PRIMARY KEY,
    email text,
    created_at timestamptz,
    updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
CREATE TABLE IF NOT EXISTS subscriptions (
    id text COLLATE "C" PRIMARY KEY,
    user_id text NOT NULL,
    variant_id text,
    plan text,
    status text,
    test_mode boolean DEFAULT false,
    customer_id text,
    renews_at timestamptz,
    ends_at timestamptz,
    period_start timestamptz,
    portal_url text,
    update_payment_url text,
    raw_json jsonb,
    updated_at timestamptz,
    created_at timestamptz,
    ls_updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions (user_id);
CREATE TABLE IF NOT EXISTS usage (
    job_id text COLLATE "C" PRIMARY KEY,
    user_id text NOT NULL,
    seconds_billed double precision NOT NULL DEFAULT 0,
    seconds_actual double precision,
    created_at timestamptz NOT NULL,
    period_start timestamptz,
    refunded boolean DEFAULT false,
    note text
);
CREATE INDEX IF NOT EXISTS usage_user ON usage (user_id, created_at);
CREATE TABLE IF NOT EXISTS billing_events (
    key text COLLATE "C" PRIMARY KEY,
    created_at timestamptz
);
CREATE TABLE IF NOT EXISTS jobs (
    id text COLLATE "C" PRIMARY KEY,
    owner_id text,
    status text NOT NULL,
    plan text,
    created_at timestamptz,
    updated_at timestamptz,
    idempotency_key text UNIQUE,
    data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_owner_created
    ON jobs (owner_id, created_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS jobs_running
    ON jobs (status) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS jobs_updated ON jobs (updated_at);
"""

MIGRATIONS: list[tuple[int, str]] = [
    (1, _SCHEMA_V1),
]

_SCHEMA_MIGRATIONS_DDL = (
    "CREATE TABLE IF NOT EXISTS schema_migrations ("
    "version integer PRIMARY KEY, "
    "applied_at timestamptz NOT NULL DEFAULT now())"
)

# Data tables, in restore order (backend/pg_backup.py, pg_cutover.py).
TABLES = ("meta", "users", "subscriptions", "usage", "billing_events",
          "jobs")

# Column lists (and which are timestamps / booleans / JSON), for copies
# in and out.
COLUMNS: dict[str, tuple[str, ...]] = {
    "meta": ("key", "value"),
    "users": ("id", "email", "created_at", "updated_at"),
    "subscriptions": (
        "id", "user_id", "variant_id", "plan", "status", "test_mode",
        "customer_id", "renews_at", "ends_at", "period_start", "portal_url",
        "update_payment_url", "raw_json", "updated_at", "created_at",
        "ls_updated_at"),
    "usage": ("job_id", "user_id", "seconds_billed", "seconds_actual",
              "created_at", "period_start", "refunded", "note"),
    "billing_events": ("key", "created_at"),
    "jobs": ("id", "owner_id", "status", "plan", "created_at", "updated_at",
             "idempotency_key", "data"),
}
TIME_COLUMNS = {"created_at", "updated_at", "renews_at", "ends_at",
                "period_start", "ls_updated_at"}
BOOL_COLUMNS = {"test_mode", "refunded"}
JSON_COLUMNS = {"raw_json", "data"}
PRIMARY_KEYS = {"meta": "key", "users": "id", "subscriptions": "id",
                "usage": "job_id", "billing_events": "key", "jobs": "id"}


def _configure(conn: psycopg.Connection) -> None:
    """Every new pooled connection: JSON comes back as text (parsed where
    needed, like the SQLite blobs), statement_timeout, UTC."""
    conn.adapters.register_loader("jsonb", TextLoader)
    conn.adapters.register_loader("json", TextLoader)
    conn.execute(f"SET statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
    conn.execute("SET TIME ZONE 'UTC'")
    conn.commit()


class Database:
    """One Postgres database: a connection pool plus schema helpers."""

    def __init__(self, url: str, *, max_size: int | None = None,
                 name: str = "cleo") -> None:
        self.url = url
        self.pool = ConnectionPool(
            url,
            min_size=1,
            max_size=max_size or pool_max(),
            kwargs={"autocommit": False, "prepare_threshold": None,
                    "connect_timeout": CONNECT_TIMEOUT_S,
                    "application_name": "cleo-backend"},
            configure=_configure,
            check=ConnectionPool.check_connection,
            open=False,
            name=name,
            timeout=30.0,
            reconnect_timeout=RECONNECT_TIMEOUT_S,
        )
        try:
            self.pool.open(wait=True, timeout=CONNECT_TIMEOUT_S * 2)
        except BaseException:
            self.pool.close()
            raise

    def connection(self, timeout: float | None = None):
        """`with database.connection() as conn:` — one transaction."""
        return self.pool.connection(timeout=timeout)

    def close(self) -> None:
        self.pool.close()

    def apply_schema(self) -> list[int]:
        """Apply the migrations this database lacks, under an advisory
        lock (one process at a time). Returns the versions applied."""
        applied: list[int] = []
        with self.connection() as conn:
            conn.execute("SET LOCAL statement_timeout = 0")  # big indexes
            conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                         ("cleo:schema",))
            conn.execute(_SCHEMA_MIGRATIONS_DDL)
            done = {r[0] for r in conn.execute(
                "SELECT version FROM schema_migrations")}
            for version, sql in MIGRATIONS:
                if version in done:
                    continue
                conn.execute(sql)
                conn.execute("INSERT INTO schema_migrations (version) "
                             "VALUES (%s)", (version,))
                applied.append(version)
            newest = max(done | set(applied), default=0)
        if newest > MIGRATIONS[-1][0]:
            print(f"[db] WARNING: the database schema (v{newest}) is newer "
                  f"than this code (v{MIGRATIONS[-1][0]})", flush=True)
        if applied:
            print(f"[db] applied schema migration(s) {applied}", flush=True)
        return applied

    def schema_version(self) -> int:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT max(version) FROM schema_migrations").fetchone()
        return int(row[0] or 0)


# The active database of this process (db.startup → open_database).
_database: Database | None = None
_open_lock = threading.Lock()


def open_database(url: str) -> Database:
    """Open (once per process) the active database and apply the schema
    migrations (db.startup)."""
    global _database
    with _open_lock:
        if _database is None:
            database = Database(url)
            try:
                database.apply_schema()
            except BaseException:
                database.close()
                raise
            _database = database
        return _database


def database() -> Database:
    if _database is None:
        raise RuntimeError("Postgres is not open (backend.db.startup)")
    return _database


def close() -> None:
    global _database
    with _open_lock:
        if _database is not None:
            _database.close()
        _database = None


def job_store() -> "PgJobStore":
    return PgJobStore(database())


def accounts_db() -> "AccountsDB":
    return AccountsDB(database())


# ── conversions ──────────────────────────────────────────────────────


def _dt(value: Any) -> datetime | None:
    """Unix time → timestamptz parameter (0 / None / junk → NULL). The
    one conversion used for every hot column and keyset bound, so equal
    floats always give equal timestamps."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if not value or not math.isfinite(value):
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


_SURROGATE = re.compile("[\ud800-\udfff]")
# In json.dumps output (ASCII, lowercase escapes): a high surrogate not
# followed by a low one, or a low one without a high one before it.
_LONE_SURROGATE_ESCAPE = re.compile(
    r"\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})"
    r"|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}")
# A float json.dumps writes with a positive exponent (repr: >= 1e16).
_BIG_FLOAT = re.compile(r"[0-9]e\+[0-9]")


def clean_text(value: str) -> str:
    """A string Postgres can store: NUL characters dropped (text and
    jsonb refuse them), lone UTF-16 surrogates (a half emoji from a
    JSON request, surrogateescape'd bytes) replaced by U+FFFD — neither
    can be encoded for the server. Everything else unchanged."""
    if "\x00" in value:
        value = value.replace("\x00", "")
    if _SURROGATE.search(value):
        # Pairs (if any) are joined, lone halves become U+FFFD.
        value = value.encode("utf-16-le", "surrogatepass").decode(
            "utf-16-le", "replace")
    return value


def _pg_safe(obj: Any, floats: bool = True) -> Any:
    """What jsonb can't hold, made storable: NaN/±Infinity and floats of
    1e16 and more (jsonb would give them back as integers) as
    {"$float": "…"} (turned back into floats by _revive; floats=False
    leaves floats alone), strings and keys through clean_text."""
    if isinstance(obj, float):
        if not floats or (math.isfinite(obj) and abs(obj) < 1e16):
            return obj
        return {"$float": repr(obj)}
    if isinstance(obj, str):
        return clean_text(obj)
    if isinstance(obj, dict):
        return {(clean_text(k) if isinstance(k, str) else k):
                _pg_safe(v, floats) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_pg_safe(v, floats) for v in obj]
    return obj


def _needs_cleaning(text: str) -> bool:
    """json.dumps output (ASCII) with a NUL or a lone surrogate in it."""
    return "\\u0000" in text or (
        "\\ud" in text and _LONE_SURROGATE_ESCAPE.search(text) is not None)


def _revive(d: dict[str, Any]) -> Any:
    if len(d) == 1 and isinstance(d.get("$float"), str):
        try:
            return float(d["$float"])
        except ValueError:
            return d
    return d


def to_json(value: Any) -> str:
    """JSON text jsonb accepts and gives back unchanged (see _pg_safe).
    The common case costs one json.dumps; only text with a NUL, a lone
    surrogate or a big float takes the slow path."""
    try:
        text = json.dumps(value, allow_nan=False)
    except ValueError:  # NaN / Infinity somewhere
        return json.dumps(_pg_safe(value), allow_nan=False)
    if _needs_cleaning(text) or ("e+" in text and _BIG_FLOAT.search(text)):
        return json.dumps(_pg_safe(value), allow_nan=False)
    return text


def from_json(text: str) -> Any:
    if '"$float"' in text:
        return json.loads(text, object_hook=_revive)
    return json.loads(text)


def _nested_json(value: Any) -> str:
    """A structured job field as the SQLite blob stores it: json.dumps
    text (key order, float text and NaN kept), inside jsonb a plain
    string. Only NUL / lone surrogates are cleaned (clean_text)."""
    text = json.dumps(value)
    if _needs_cleaning(text):
        text = json.dumps(_pg_safe(value, floats=False))
    return text


# Structured Job fields stored as nested JSON strings: the SQLite blob's
# _JSON_FIELDS plus the ones SQLite keeps inline (its blob is text, so
# their key order survives there too).
_NESTED_FIELDS = frozenset(_JSON_FIELDS) | {
    "preview_segments", "edited_phrases", "costs", "output_keys"}


def dump_job(job: Job) -> str:
    """The jobs.data text: the SQLite blob's shape (structured fields as
    nested JSON strings — jsonb sorts object keys, and e.g. the order of
    `outputs`, "primary" first, is the order of the download buttons),
    made storable by to_json. load_job reads this and the earlier shape
    with the structured fields as real JSON. Keys the job was read with
    but this code doesn't know (job._extras, a later release's fields)
    are written back exactly as they were stored."""
    d = job_to_dict(job)
    for k in _NESTED_FIELDS:
        if isinstance(d.get(k), (dict, list, tuple)):
            d[k] = _nested_json(d[k])
    return to_json(d)


def load_job(text: str) -> Job:
    d = from_json(text)
    if not isinstance(d, dict):
        raise ValueError("job data is not a JSON object")
    for k in _NESTED_FIELDS - _JSON_FIELDS:  # (job_from_dict does those)
        if isinstance(d.get(k), str):
            d[k] = json.loads(d[k])
    return job_from_dict(d)


def _text(value: Any) -> Any:
    return clean_text(value) if isinstance(value, str) else value


def _is_id(value: Any) -> bool:
    """Can `value` be a job id here? Not with a NUL or a lone surrogate
    (from a URL / ?ids=): psycopg can't send those at all (DataError →
    500), and no stored id has one. Such an id is treated as unknown —
    like SQLite does — not cleaned: "a\\x00b" must not find job "ab"."""
    return isinstance(value, str) and clean_text(value) == value


def _hot(job: Job) -> tuple:
    """(owner_id, status, plan, created_at, updated_at) of the jobs row
    (text as dump_job stores it in data)."""
    return (_text(job.owner_id), _text(job.status), _text(job.plan),
            _dt(job.created_at), _dt(job.updated_at))


# ── job store ────────────────────────────────────────────────────────

# SQL tests for "the job has media keys" (Job.has_media_keys, which the
# boot sweep re-checks per row): a non-empty scalar key or a non-empty
# output_keys (stored as a nested JSON string or as an object).
_KEYED_SQL = [
    *(f"coalesce(data->>'{k}', '') <> ''" for k in (
        "source_key", "mezz_key", "proxy_key", "preview_key", "thumb_key",
        "media_store")),
    "coalesce(data->>'output_keys', '') NOT IN ('', '{}')",
]

# Left out of list_by_owner(summary=True): the editor's big fields.
_SUMMARY_DROP = ["settings", "subtitles", "segments", "cut_ranges",
                 "scene_events", "preview_segments", "edited_phrases",
                 "audio_levels", "audio_warnings", "costs"]

_UPDATE_SQL = (
    "UPDATE jobs SET data = %s::jsonb, owner_id = %s, status = %s, "
    "plan = %s, created_at = %s, updated_at = %s WHERE id = %s")


class PgJobStore:
    """backend.jobs.JobStore on Postgres — same methods, safe across
    processes: update() reads the row FOR UPDATE and writes it back in
    one transaction (no lost updates), update_if() is a real
    compare-and-set, modify() runs the caller's check under that row
    lock, create() with an idempotency key is race-free (UNIQUE + ON
    CONFLICT)."""

    # list_by_owner(limit=, before=) is one bounded, index-backed query.
    PAGES_BY_INDEX = True

    def __init__(self, database: Database) -> None:
        self._db = database

    def __repr__(self) -> str:
        return f"<PgJobStore {db.redacted(self._db.url)}>"

    def _load(self, job_id: str, text: str) -> Job | None:
        try:
            return load_job(text)
        except Exception as e:
            print(f"[jobstore] deserialize failed for {job_id}: {e}",
                  flush=True)
            return None

    def _jobs(self, sql: str, args: tuple = ()) -> list[Job]:
        with self._db.connection() as conn:
            rows = conn.execute(sql, args).fetchall()
        out: list[Job] = []
        for job_id, text in rows:
            job = self._load(job_id, text)
            if job is not None:
                out.append(job)
        return out

    def create(
        self,
        input_path: str,
        settings: dict[str, Any],
        job_id: str | None = None,
        idempotency_key: str | None = None,
        **extra: Any,
    ) -> Job:
        job_id = job_id or new_job_id()
        now = time.time()
        job = Job(id=job_id, input_path=input_path, settings=settings,
                  updated_at=now, created_at=now, **extra)
        idempotency_key = _text(idempotency_key) or None
        args = (job_id, *_hot(job), idempotency_key, dump_job(job))
        insert = ("INSERT INTO jobs (id, owner_id, status, plan, created_at, "
                  "updated_at, idempotency_key, data) "
                  "VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)")
        with self._db.connection() as conn:
            if not idempotency_key:
                conn.execute(insert, args)
                return job
            for _ in range(3):
                row = conn.execute(
                    insert + " ON CONFLICT (idempotency_key) DO NOTHING "
                    "RETURNING id", args).fetchone()
                if row is not None:
                    return job
                other = conn.execute(
                    "SELECT id FROM jobs WHERE idempotency_key = %s",
                    (idempotency_key,)).fetchone()
                if other is not None:
                    raise DuplicateKey(other[0])
                # The other job was deleted in between: try again.
        raise DuplicateKey(None)

    def find_by_key(self, key: str) -> Job | None:
        with self._db.connection() as conn:
            row = conn.execute(
                "SELECT id, data FROM jobs WHERE idempotency_key = %s",
                (_text(key),)).fetchone()
        if row is None:
            return None
        try:
            return load_job(row[1])
        except Exception:
            return None

    def get(self, job_id: str) -> Job | None:
        if not _is_id(job_id):
            return None
        with self._db.connection() as conn:
            row = conn.execute("SELECT data FROM jobs WHERE id = %s",
                               (job_id,)).fetchone()
        if row is None:
            return None
        return self._load(job_id, row[0])

    def update(self, job_id: str, **fields_to_update: Any) -> None:
        self._write(job_id, None, fields_to_update)

    def update_if(self, job_id: str, expect_status: str | tuple[str, ...],
                  **fields_to_update: Any) -> bool:
        if isinstance(expect_status, str):
            expect_status = (expect_status,)
        return self._write(job_id, tuple(expect_status),
                           fields_to_update) is not None

    def modify(self, job_id: str,
               fn: Callable[[Job], dict[str, Any] | None]
               ) -> dict[str, Any] | None:
        """backend.jobs.JobStore.modify: fn(job) runs while the row is
        locked (FOR UPDATE), so its check and the write are one step for
        every process."""
        return self._write(job_id, None, fn)

    def _write(self, job_id: str, expect: tuple[str, ...] | None,
               change: dict[str, Any] | Callable[[Job], Any]
               ) -> dict[str, Any] | None:
        if not _is_id(job_id):
            return None
        with self._db.connection() as conn:
            if expect is None:
                row = conn.execute(
                    "SELECT data FROM jobs WHERE id = %s FOR UPDATE",
                    (job_id,)).fetchone()
            else:
                row = conn.execute(
                    "SELECT data FROM jobs WHERE id = %s "
                    "AND status = ANY(%s) FOR UPDATE",
                    (job_id, list(expect))).fetchone()
            if row is None:
                return None
            try:
                job = load_job(row[0])
            except Exception:
                return None
            if expect is not None and job.status not in expect:
                return None
            fields_to_update = change(job) if callable(change) else change
            if fields_to_update is None:
                return None
            for k, v in fields_to_update.items():
                setattr(job, k, v)
            if "updated_at" not in fields_to_update:
                job.updated_at = time.time()
            conn.execute(_UPDATE_SQL, (dump_job(job), *_hot(job), job_id))
        return fields_to_update

    def status_many(self, job_ids: list[str]) -> dict[str, dict[str, Any]]:
        ids = list(dict.fromkeys(i for i in job_ids if i and _is_id(i)))
        if not ids:
            return {}
        with self._db.connection() as conn:
            rows = conn.execute(
                "SELECT id, (SELECT jsonb_object_agg(key, value) "
                "FROM jsonb_each(data) WHERE key = ANY(%s)) "
                "FROM jobs WHERE id = ANY(%s)",
                (list(_STATUS_FIELDS), ids)).fetchall()
        defaults = {f.name: f.default for f in fields(Job)
                    if f.name in _STATUS_FIELDS}
        out: dict[str, dict[str, Any]] = {}
        for job_id, text in rows:
            try:
                d = from_json(text) if text else {}
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            out[job_id] = {k: d.get(k, defaults.get(k)) for k in _STATUS_FIELDS}
            out[job_id]["id"] = job_id
        return out

    def ping(self) -> None:
        with self._db.connection(timeout=2.0) as conn:
            conn.execute("SELECT 1").fetchone()

    def claim(self, job_id: str, owner_id: str) -> str | None:
        if not _is_id(job_id):
            return None
        with self._db.connection() as conn:
            owner_id = clean_text(owner_id)
            conn.execute(
                "UPDATE jobs SET owner_id = %s, "
                "data = jsonb_set(data, '{owner_id}', to_jsonb(%s::text)) "
                "WHERE id = %s AND owner_id IS NULL",
                (owner_id, owner_id, job_id))
            row = conn.execute("SELECT owner_id FROM jobs WHERE id = %s",
                               (job_id,)).fetchone()
        return row[0] if row is not None else None

    def delete(self, job_id: str) -> None:
        if not _is_id(job_id):
            return
        with self._db.connection() as conn:
            conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))

    def list_all(self) -> list[Job]:
        return self._jobs("SELECT id, data FROM jobs")

    def list_by_owner(self, owner_id: str, limit: int | None = None,
                      before: tuple[float, str] | None = None,
                      summary: bool = False) -> list[Job]:
        """Index (owner_id, created_at desc): newest first, legacy jobs
        without created_at last; `before` = (created_at, id) of the last
        job of the previous page. summary=True leaves the big editor
        fields out (they stay at their defaults) — enough for GET /jobs."""
        data = "data - %s::text[]" if summary else "data"
        sql = f"SELECT id, {data} FROM jobs WHERE owner_id = %s"
        args: list[Any] = [_SUMMARY_DROP] if summary else []
        args.append(owner_id)
        if before is not None:
            bound = _dt(before[0])
            if bound is None:
                sql += " AND created_at IS NULL AND id < %s"
                args.append(before[1])
            else:
                sql += (" AND ((created_at, id) < (%s, %s) "
                        "OR created_at IS NULL)")
                args += [bound, before[1]]
        sql += " ORDER BY created_at DESC NULLS LAST, id DESC"
        if limit is not None:
            sql += " LIMIT %s"
            args.append(int(limit))
        return self._jobs(sql, tuple(args))

    def list_by_status(self, *statuses: str,
                       error: str | None = None) -> list[Job]:
        sql = "SELECT id, data FROM jobs WHERE status = ANY(%s)"
        args: list[Any] = [list(statuses)]
        if error is not None:
            sql += " AND data->>'error' = %s"
            args.append(error)
        return self._jobs(sql, tuple(args))

    def retention_candidates(self, before: float | None) -> list[Job]:
        sql = ("SELECT id, data FROM jobs WHERE status <> ALL(%s) "
               "AND (updated_at IS NULL")
        args: list[Any] = [list(RUNNING_STATUSES)]
        bound = _dt(before) if before is not None else None
        if bound is not None:
            sql += " OR updated_at < %s"
            args.append(bound)
        return self._jobs(sql + ")", tuple(args))

    def input_paths(self) -> set[str]:
        with self._db.connection() as conn:
            rows = conn.execute(
                "SELECT data->>'input_path' FROM jobs "
                "WHERE data->>'input_path' IS NOT NULL").fetchall()
        return {r[0] for r in rows if r[0]}

    def mark_stuck_as_error(
        self,
        message: str = "Processing was interrupted. "
                       "Please upload the video again.",
    ) -> int:
        """backend.jobs.JobStore.mark_stuck_as_error with indexed queries
        (running jobs via the partial status index; review jobs by their
        normalized_path only)."""
        marked = 0
        for job in self.list_by_status(*RUNNING_STATUSES):
            src_ok = job.has_mezz()
            if src_ok and job.segments:
                fields_ = dict(status="awaiting_review", progress=100.0,
                               message="render_failed",
                               error="container_restart",
                               queue_position=None)
            else:
                fields_ = dict(status="error", message=message,
                               error="container_restart", progress=0.0,
                               queue_position=None)
            if self.update_if(job.id, job.status, **fields_):
                marked += 1
        # A job with media keys (a later release's) is intact even
        # without local files.
        with self._db.connection() as conn:
            rows = conn.execute(
                "SELECT id, data->>'normalized_path' FROM jobs "
                "WHERE status = 'awaiting_review' AND NOT ("
                + " OR ".join(_KEYED_SQL) + ")").fetchall()
        for job_id, normalized in rows:
            if normalized and Path(normalized).exists():
                continue
            job = self.get(job_id)
            if job is None or job.has_media_keys():
                continue
            # Files are gone (old /tmp storage) — can't be edited.
            if self.update_if(job_id, "awaiting_review", status="error",
                              error="files_expired",
                              message="This project's files have expired. "
                                      "Please upload the video again."):
                marked += 1
        return marked

    def _truncate_for_tests(self) -> None:
        with self._db.connection() as conn:
            conn.execute("TRUNCATE jobs")


# ── accounts adapter ─────────────────────────────────────────────────


@lru_cache(maxsize=512)
def portable_sql(sql: str) -> str:
    """backend.accounts' SQL for psycopg: `?` → %s, literal % → %%
    (quoted strings left alone)."""
    out: list[str] = []
    quote: str | None = None
    for ch in sql:
        if quote:
            if ch == quote:
                quote = None
            out.append("%%" if ch == "%" else ch)
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
        elif ch == "?":
            out.append("%s")
        elif ch == "%":
            out.append("%%")
        else:
            out.append(ch)
    return "".join(out)


def _param(value: Any) -> Any:
    """db.Epoch → timestamptz (0 stays 1970-01-01, it round-trips as 0.0);
    db.JsonText → JSON jsonb accepts (to_json; text that isn't JSON is
    kept as a JSON string, like the cutover does); other text through
    clean_text (NUL / lone surrogates can't be sent to the server at
    all — SQLite stores them); everything else as is."""
    if isinstance(value, db.Epoch):
        if not value:
            return datetime.fromtimestamp(0, tz=timezone.utc)
        return _dt(value)
    if isinstance(value, db.JsonText):
        try:
            return to_json(json.loads(value))
        except (TypeError, ValueError):
            return json.dumps(clean_text(str(value)))
    if isinstance(value, str):
        return clean_text(value)
    return value


def _params(args: Any) -> tuple:
    return tuple(_param(v) for v in (args or ()))


def _epoch_dict_row(cursor: psycopg.Cursor):
    """Rows as dicts (like sqlite3.Row by name), timestamptz as floats."""
    desc = cursor.description
    if desc is None:
        return lambda values: None
    names = [d.name for d in desc]

    def make(values: Any) -> dict[str, Any]:
        return {n: (v.timestamp() if isinstance(v, datetime) else v)
                for n, v in zip(names, values)}
    return make


class _Tx:
    """One accounts transaction (what _tx hands to its fn): execute() with
    ? placeholders, lock() for an extra advisory lock."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def execute(self, sql: str, args: Any = ()) -> psycopg.Cursor:
        cur = self._conn.cursor(row_factory=_epoch_dict_row)
        cur.execute(portable_sql(sql), _params(args))
        return cur

    def lock(self, key: str) -> None:
        self._conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                           (key,))


class _Result:
    """Buffered result of AccountsDB.execute (connection already back in
    the pool)."""

    def __init__(self, rows: list[dict[str, Any]], rowcount: int) -> None:
        self._rows = rows
        self.rowcount = rowcount

    def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._rows)


class AccountsDB:
    """backend.accounts' database on Postgres (the SQLite path uses a
    sqlite3 connection with the same execute() interface)."""
    backend = "postgres"

    def __init__(self, database: Database) -> None:
        self._db = database

    @contextmanager
    def transaction(self, lock_key: str | None = None) -> Iterator[_Tx]:
        """BEGIN (+ pg_advisory_xact_lock(hashtext(lock_key))) … COMMIT;
        rolled back if the block raises."""
        with self._db.connection() as conn:
            tx = _Tx(conn)
            if lock_key:
                tx.lock(lock_key)
            yield tx

    def read(self, sql: str, args: Any = ()) -> list[dict[str, Any]]:
        with self._db.connection() as conn:
            return _Tx(conn).execute(sql, args).fetchall()

    def execute(self, sql: str, args: Any = ()) -> _Result:
        """One statement in its own transaction (reads, one-off fixes)."""
        with self._db.connection() as conn:
            cur = _Tx(conn).execute(sql, args)
            rows = cur.fetchall() if cur.description else []
            return _Result(rows, cur.rowcount)

    def truncate_for_tests(self) -> None:
        with self._db.connection() as conn:
            conn.execute("TRUNCATE meta, users, subscriptions, usage, "
                         "billing_events")
