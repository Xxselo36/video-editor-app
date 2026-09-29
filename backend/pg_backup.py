"""Nightly logical backup of the Postgres database to R2.

pg_dump is not in the image, so the export is Python-level: one
REPEATABLE READ snapshot, every table streamed with COPY … TO STDOUT into
one gzip'd SQL file — the schema DDL, then a COPY … FROM stdin block per
table. psql restores it as is; so does `restore` below.

The retention loop (backend/main.py) calls maybe_run() hourly; it runs
at most once per 24 h across all processes (a claim in meta, taken under
an advisory lock — pooler-safe, no session locks), uploads
backups/pg/<YYYY-MM-DD>.sql.gz to R2 and deletes backups older than
CLEO_PG_BACKUP_KEEP_DAYS (default 14). Only with Postgres active and R2
configured. The dump holds everything (but meta.media_owner_fp),
including meta's media/checkout secrets — keep the bucket private;
R2_BACKUP_BUCKET puts the dumps into a bucket of their own (recommended:
the Modal render token then has no access to them, backend/storage.py).

CLI (DATABASE_URL and the R2_* variables from the environment):
    python -m backend.pg_backup export FILE.sql.gz
    python -m backend.pg_backup restore FILE.sql.gz  # into an EMPTY database
    python -m backend.pg_backup run                  # backup to R2 now
    python -m backend.pg_backup list                 # backups in R2
    python -m backend.pg_backup download KEY FILE    # fetch one from R2
"""
from __future__ import annotations

import gzip
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg

from backend import db, pg

PREFIX = "backups/pg/"
EVERY_S = 24 * 3600
# A run that started this long ago without finishing is presumed dead.
STALE_CLAIM_S = 3 * 3600
STATE_KEY = "pg_backup"
_LOCK_KEY = "cleo:pg-backup"
_KEY_RE = re.compile(r"^backups/pg/(\d{4}-\d{2}-\d{2})\.sql\.gz$")


def keep_days() -> float:
    try:
        return float(os.environ.get("CLEO_PG_BACKUP_KEEP_DAYS", "").strip()
                     or 14)
    except ValueError:
        return 14.0


# ── export / restore ─────────────────────────────────────────────────


def export(database: pg.Database, path: str) -> dict[str, int]:
    """Write a restorable dump of every table to `path` (gzip'd SQL).
    Returns the rows per table."""
    counts: dict[str, int] = {}
    with database.connection() as conn, gzip.open(path, "wb",
                                                  compresslevel=6) as gz:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, "
                     "READ ONLY")
        conn.execute("SET LOCAL statement_timeout = 0")
        applied = conn.execute("SELECT version, applied_at::text FROM "
                               "schema_migrations ORDER BY version"
                               ).fetchall()
        version = max((v for v, _ in applied), default=0)
        known = pg.MIGRATIONS[-1][0]
        if version > known:
            print(f"[backup] WARNING: database schema v{version} is newer "
                  f"than this code (v{known}); the dump has the v{known} "
                  "tables and columns only", flush=True)

        def w(text: str) -> None:
            gz.write(text.encode("utf-8"))

        w("-- CleoCuts Postgres backup (backend/pg_backup.py)\n"
          f"-- created_at: {db.now_iso()}\n"
          f"-- schema_version: {version}\n"
          "-- restore into an EMPTY database:\n"
          "--   gunzip -c FILE | psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1\n"
          "--   or: python -m backend.pg_backup restore FILE\n"
          "SET statement_timeout = 0;\n"
          "SET client_encoding = 'UTF8';\n"
          "BEGIN;\n")
        w(pg._SCHEMA_MIGRATIONS_DDL + ";\n")
        for v, sql in pg.MIGRATIONS:
            if v <= version:
                w(sql.strip() + "\n")
        for v, at in applied:
            w("INSERT INTO schema_migrations (version, applied_at) VALUES "
              f"({int(v)}, '{at}') ON CONFLICT DO NOTHING;\n")
        for table in pg.TABLES:
            cols = ", ".join(pg.COLUMNS[table])
            w(f"COPY {table} ({cols}) FROM stdin;\n")
            n = 0
            # The media owner's binding (backend/main.py _media_owner)
            # stays out: a restored database must not pass as the one
            # that owns the bucket's jobs/ (the orphan sweep refuses it).
            where = (" WHERE key <> 'media_owner_fp'" if table == "meta"
                     else "")
            with conn.cursor() as cur, cur.copy(
                    f"COPY (SELECT {cols} FROM {table}{where} ORDER BY "
                    f"{pg.PRIMARY_KEYS[table]}) TO STDOUT") as cp:
                for chunk in cp:
                    data = bytes(chunk)
                    n += data.count(b"\n")
                    gz.write(data)
            w("\\.\n")
            counts[table] = n
        w("COMMIT;\n")
    return counts


def restore(url: str, path: str) -> dict[str, int]:
    """Load a dump (export) into the EMPTY database at `url`, in one
    transaction. Returns the rows per table."""
    counts: dict[str, int] = {}
    with psycopg.connect(url, autocommit=False, prepare_threshold=None,
                         connect_timeout=pg.CONNECT_TIMEOUT_S) as conn:
        for table in pg.TABLES:
            exists = conn.execute("SELECT to_regclass(%s)",
                                  (table,)).fetchone()[0]
            if exists and conn.execute(
                    f"SELECT EXISTS (SELECT 1 FROM {table})").fetchone()[0]:
                raise RuntimeError(f"table {table} is not empty — restore "
                                   "into an empty database")
        sql: list[str] = []

        def flush() -> None:
            text = "".join(sql).strip()
            sql.clear()
            if text:
                conn.execute(text)

        with gzip.open(path, "rt", encoding="utf-8", newline="\n") as f:
            for line in f:
                if line.strip() in ("BEGIN;", "COMMIT;"):
                    continue  # this whole restore is one transaction
                m = re.match(r"^COPY (\w+) \((.*)\) FROM stdin;$",
                             line.rstrip("\n"))
                if not m:
                    sql.append(line)
                    continue
                flush()
                table, n = m.group(1), 0
                with conn.cursor() as cur, cur.copy(
                        f"COPY {table} ({m.group(2)}) FROM STDIN") as cp:
                    for data in f:
                        if data == "\\.\n":
                            break
                        cp.write(data)
                        n += 1
                counts[table] = n
        flush()
    return counts


# ── nightly run ──────────────────────────────────────────────────────


def _state(conn: Any) -> dict[str, Any]:
    row = conn.execute("SELECT value FROM meta WHERE key = %s",
                       (STATE_KEY,)).fetchone()
    try:
        state = json.loads(row[0]) if row and row[0] else {}
    except ValueError:
        state = {}
    return state if isinstance(state, dict) else {}


def _save_state(conn: Any, state: dict[str, Any]) -> None:
    conn.execute("INSERT INTO meta (key, value) VALUES (%s, %s) "
                 "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                 (STATE_KEY, json.dumps(state)))


def _claim(database: pg.Database, now: float, force: bool = False) -> bool:
    """Take the next run (True) unless one ran in the last 24 h or is
    running now — in any process."""
    with database.connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                     (_LOCK_KEY,))
        state = _state(conn)
        running = state.get("running_since")
        if running and now - float(running) < STALE_CLAIM_S:
            return False
        last = state.get("last_ok")
        # 5 min slack: the hourly loop doesn't tick at the same second.
        if not force and last and now - float(last) < EVERY_S - 300:
            return False
        state["running_since"] = now
        _save_state(conn, state)
    return True


def _finish(database: pg.Database, **changes: Any) -> None:
    with database.connection() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                     (_LOCK_KEY,))
        state = _state(conn)
        state.update(changes)
        state["running_since"] = None
        _save_state(conn, state)


def backup_key(now: float) -> str:
    day = datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%d")
    return f"{PREFIX}{day}.sql.gz"


def prune(now: float, days: float | None = None) -> list[str]:
    """Delete backups (by the date in their key) older than `days`."""
    from backend import storage
    days = keep_days() if days is None else days
    cutoff = (datetime.fromtimestamp(now, tz=timezone.utc)
              - timedelta(days=days)).strftime("%Y-%m-%d")
    deleted = []
    for obj in storage.backup_list(PREFIX):
        m = _KEY_RE.match(obj["key"])
        if m and m.group(1) < cutoff:
            storage.backup_delete(obj["key"])
            deleted.append(obj["key"])
    return deleted


def maybe_run(database: pg.Database | None = None, now: float | None = None,
              force: bool = False) -> str | None:
    """Back up now if it's due (see module doc). Returns the R2 key
    written, or None if nothing ran. Raises when a started run fails
    (the next hourly tick tries again)."""
    from backend import storage
    if not storage.r2_available():
        return None
    database = database or pg.database()
    now = time.time() if now is None else now
    if not _claim(database, now, force):
        return None
    key = backup_key(now)
    try:
        fd, tmp = tempfile.mkstemp(prefix="cleo-pg-backup-",
                                   suffix=".sql.gz")
        os.close(fd)
        try:
            counts = export(database, tmp)
            size = os.path.getsize(tmp)
            storage.backup_put(tmp, key)
        finally:
            os.unlink(tmp)
        try:
            pruned = prune(now)
        except Exception as e:  # the backup itself is done
            print(f"[backup] pruning old backups failed: {e}", flush=True)
            pruned = []
    except BaseException as e:
        try:
            _finish(database, last_error=f"{type(e).__name__}: {e}"[:300],
                    last_error_at=now)
        except Exception:
            pass
        raise
    _finish(database, last_ok=now, last_key=key, last_error=None)
    print(f"[backup] {key}: {size / 1e6:.1f} MB, rows {counts}"
          + (f", deleted {len(pruned)} old backup(s)" if pruned else ""),
          flush=True)
    return key


# ── CLI ──────────────────────────────────────────────────────────────


def _main(argv: list[str]) -> int:
    usage = __doc__.split("CLI", 1)[1]
    if not argv:
        print("usage:" + usage.split("\n", 1)[1], file=sys.stderr)
        return 2
    cmd, args = argv[0], argv[1:]
    url = db.database_url()
    if cmd in ("export", "restore", "run") and not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    if cmd == "export" and len(args) == 1:
        database = pg.Database(url, max_size=1)
        try:
            print(export(database, args[0]))
        finally:
            database.close()
        return 0
    if cmd == "restore" and len(args) == 1:
        print(restore(url, args[0]))
        return 0
    if cmd == "run" and not args:
        database = pg.Database(url, max_size=2)
        try:
            print(maybe_run(database, force=True) or
                  "not run (R2 not configured, or a backup is running)")
        finally:
            database.close()
        return 0
    if cmd == "list" and not args:
        from backend import storage
        for obj in sorted(storage.backup_list(PREFIX), key=lambda o: o["key"]):
            print(f"{obj['key']}\t{obj['size']}\t{obj['last_modified']}")
        return 0
    if cmd == "download" and len(args) == 2:
        from backend import storage
        storage.backup_get(args[0], args[1])
        print(args[1])
        return 0
    print("usage:" + usage.split("\n", 1)[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
