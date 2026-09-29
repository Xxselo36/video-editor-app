"""First boot on Postgres: copy the SQLite data over, verify, switch.

backend.db.startup() calls migrate_if_needed() once per process, before
anything else touches the data (before mark_stuck_as_error). Only when
meta.migrated_from_sqlite is missing in Postgres:

1. take a global advisory lock (one process migrates; the others wait,
   then see the marker and skip),
2. if the SQLite file exists: copy every table in ONE Postgres
   transaction — jobs (blob → data + hot columns, job_keys →
   idempotency_key), meta (incl. the media / checkout secrets), users,
   subscriptions, usage, billing_events,
3. verify: row counts per table, and per user SUM(seconds_billed) of the
   unrefunded usage,
4. write meta.migrated_from_sqlite (time + counts), let the caller
   record the cutover next to the SQLite file (before_commit: the
   marker file, backend/db.py — if that fails nothing is committed),
   and commit.

Nothing is renamed or deleted: the SQLite file stays as a read-only
backup. Any error rolls the whole copy back and raises; db.startup then
stays on SQLite for this process (and the next boot tries again). A row
that can't be read (not JSON, not a job) or that Postgres refuses as
data (SQLSTATE class 22 / 23, or refused on our side while writing it)
is such an error — the message names it; fix or delete it in SQLite,
see DEPLOY.md. Postgres itself failing during the copy (connection
lost, statement cancelled, disk full, shutting down) names no row:
nothing is wrong with the data, the next boot just tries again. SQLite
failing to read its own file (a damaged page) names no row either, but
blames the file: it needs checking and repairing / restoring. Values
Postgres can't store (NUL characters, lone surrogates) are cleaned on
the way (backend.pg.clean_text / to_json). Without a SQLite file (fresh
deploy) only the marker is written. allow_import=False (the marker
file says this deployment was cut over before) refuses a database
without the marker — whether or not the SQLite file is still there:
copying it would bring back the stale state of the cutover day, and
starting on the database as a fresh one would make every project, the
usage ledger and the subscriptions look gone.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import quote

import psycopg

from backend import db, jobs, pg

MARKER_KEY = "migrated_from_sqlite"
_LOCK_KEY = "cleo:sqlite-cutover"


class CutoverError(RuntimeError):
    pass


class StaleImport(CutoverError):
    """The SQLite file was already copied to Postgres once, but this
    database has no cutover marker (a new / emptied / different
    database): copying the old file again would bring back deleted
    projects, spent minutes and old subscriptions."""


class CutoverBusy(CutoverError):
    """Another process is still copying (it holds the cutover lock)."""


@dataclass
class Result:
    status: str                     # "already" | "fresh" | "migrated"
    marker: str | None = None       # meta.migrated_from_sqlite
    counts: dict[str, int] = field(default_factory=dict)


def marker(database: pg.Database) -> str | None:
    with database.connection() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = %s",
                           (MARKER_KEY,)).fetchone()
    return row[0] if row else None


def migrate_if_needed(database: pg.Database, sqlite_path: str, *,
                      allow_import: bool = True,
                      before_commit: Callable[[str], None] | None = None
                      ) -> Result:
    value = marker(database)
    if value is not None:
        return Result("already", value)
    with database.connection() as conn:
        conn.execute("SET LOCAL statement_timeout = 0")
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                     (_LOCK_KEY,))
        row = conn.execute("SELECT value FROM meta WHERE key = %s",
                           (MARKER_KEY,)).fetchone()
        if row is not None:  # another process migrated while we waited
            return Result("already", row[0])
        if not allow_import:
            # Before the fresh-deploy branch: a deployment that was cut
            # over never starts on a database without the marker, even
            # when the SQLite file is gone by now.
            gone = not os.path.exists(sqlite_path)
            raise StaleImport(
                f"the SQLite file {sqlite_path} was already copied to "
                f"Postgres before{' (the file is gone now)' if gone else ''}"
                f", but this database has no meta.{MARKER_KEY} (new, "
                "emptied or a different database?) — "
                + ("not starting on it as if this were a fresh deployment"
                   if gone else "not copying the stale SQLite data into it")
                + ". Restore a backup into it (DEPLOY.md 8.4) or point "
                "DATABASE_URL back at the migrated database; to "
                + ("start with an empty database" if gone else
                   "import the old SQLite state")
                + " on purpose, delete the marker file (DEPLOY.md 8.3).")
        if not os.path.exists(sqlite_path):
            value = json.dumps({"at": db.now_iso(), "fresh": True,
                                "sqlite_path": sqlite_path})
            conn.execute("INSERT INTO meta (key, value) VALUES (%s, %s)",
                         (MARKER_KEY, value))
            return Result("fresh", value)
        _require_empty(conn)
        src = _open_sqlite(sqlite_path)
        try:
            counts, sums = _copy(src, conn)
        except sqlite3.Error as e:  # outside a table's COPY
            raise _sqlite_failed(None, e) from e
        finally:
            src.close()
        _verify(conn, counts, sums)
        value = json.dumps({"at": db.now_iso(), "sqlite_path": sqlite_path,
                            "counts": counts})
        conn.execute("INSERT INTO meta (key, value) VALUES (%s, %s)",
                     (MARKER_KEY, value))
        if before_commit is not None:
            before_commit(value)  # raises → rolled back, nothing moved
    return Result("migrated", value, counts)


def peek_marker(url: str, wait_s: float = 0.0) -> str | None:
    """meta.migrated_from_sqlite of the database at `url`, over a
    connection of its own (not the pool) — for a process that couldn't
    migrate and must know whether someone else did before it falls back
    to SQLite (backend/db.py). wait_s > 0 first waits that long for a
    cutover running in another process (its lock); still running →
    CutoverBusy. Raises when Postgres can't be reached."""
    import psycopg
    with psycopg.connect(url, connect_timeout=pg.CONNECT_TIMEOUT_S,
                         prepare_threshold=None,
                         application_name="cleo-backend") as conn:
        if wait_s > 0:
            conn.execute("SET LOCAL statement_timeout = 0")
            conn.execute(f"SET LOCAL lock_timeout = {int(wait_s * 1000)}")
            try:
                conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                             (_LOCK_KEY,))
            except psycopg.errors.LockNotAvailable as e:
                raise CutoverBusy("another process is still copying the "
                                  f"SQLite data (waited {wait_s:.0f} s)"
                                  ) from e
        if conn.execute("SELECT to_regclass('meta')").fetchone()[0] is None:
            return None
        row = conn.execute("SELECT value FROM meta WHERE key = %s",
                           (MARKER_KEY,)).fetchone()
        return row[0] if row else None


def _require_empty(conn: Any) -> None:
    for table in pg.TABLES:
        if conn.execute(f"SELECT EXISTS (SELECT 1 FROM {table})"
                        ).fetchone()[0]:
            raise CutoverError(
                f"Postgres table {table} already has rows but "
                f"meta.{MARKER_KEY} is missing — refusing to merge into it. "
                "Point DATABASE_URL at an empty database (see DEPLOY.md).")


def _open_sqlite(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True,
                           timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _sqlite_columns(src: sqlite3.Connection, table: str) -> list[str] | None:
    row = src.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' "
                      "AND name = ?", (table,)).fetchone()
    if row is None:
        return None
    return [r["name"] for r in src.execute(f"PRAGMA table_info({table})")]


def _value(table: str, column: str, value: Any) -> Any:
    """A SQLite value as the Postgres column wants it."""
    if value is None:
        return None
    if column in pg.TIME_COLUMNS:
        try:
            return pg._param(db.Epoch(float(value)))
        except (TypeError, ValueError, OverflowError) as e:
            raise CutoverError(f"{table}.{column}: {value!r} is not a "
                               "Unix time") from e
    if column in pg.BOOL_COLUMNS:
        return bool(value)
    if column in pg.JSON_COLUMNS:
        try:
            return pg.to_json(json.loads(value))
        except (TypeError, ValueError):
            # keep it, as a JSON string
            return json.dumps(pg.clean_text(str(value)))
    if isinstance(value, str):
        return pg.clean_text(value)
    return value


def _row_error(e: BaseException, current: bool) -> bool:
    """Is `e` about the data of a row (fixing or deleting it helps), not
    Postgres or the connection failing (nothing wrong with the data; a
    retry may just work)? A server error by its SQLSTATE: only class 22
    (data exception) and 23 (integrity constraint) — the server attaches
    'COPY …, line N' to every error during the COPY, so the line alone
    says nothing. A client-side error: only while writing the current
    row, and not a lost connection (psycopg.OperationalError /
    InterfaceError) — a psycopg.DataError (e.g. NUL in text) or our own
    dump / encoding error for that row."""
    if isinstance(e, psycopg.Error):
        state = (getattr(e, "sqlstate", None)
                 or getattr(getattr(e, "diag", None), "sqlstate", None)
                 or "")
        if state:
            return state[:2] in ("22", "23")
        return current and isinstance(e, psycopg.DataError)
    return current and not isinstance(e, sqlite3.Error)


def _what(e: BaseException) -> str:
    first = (str(e).strip().splitlines() or [""])[0]
    return f"{type(e).__name__}: {first}"


def _sqlite_failed(table: str | None, e: sqlite3.Error) -> CutoverError:
    """The SQLite file itself can't be read (a damaged page, a value
    SQLite can't decode): not Postgres, and no row we could name — a
    damaged file fails every boot the same way until it is repaired or
    restored, so don't say 'the next boot tries again'."""
    what = f"reading {table} from SQLite" if table else "reading from SQLite"
    return CutoverError(
        f"{what} failed ({_what(e)}) — the SQLite file can't be read, not "
        "Postgres: nothing was committed. A damaged file fails every boot "
        "like this until it is checked (PRAGMA integrity_check) and "
        "repaired or restored (DEPLOY.md 8.2)")


def _copy_failed(table: str, ids: list[Any], e: Exception,
                 current: bool = False) -> CutoverError:
    """A failed COPY. A data error (_row_error) names the row: the line
    of the COPY data the server says it choked on, or else the one being
    written (current=True: refused on our side). SQLite failing to read
    blames the file (_sqlite_failed). Anything else is reported as the
    failure it is — no row, no 'fix or delete'."""
    what = _what(e)
    if isinstance(e, sqlite3.Error):
        return _sqlite_failed(table, e)
    if not _row_error(e, current):
        return CutoverError(
            f"copying {table} to Postgres failed ({what}) — the database "
            "or the connection failed, not a row: nothing was committed "
            "and nothing needs fixing in SQLite; the next boot tries again")
    row = ""
    context = getattr(getattr(e, "diag", None), "context", None) or ""
    m = re.search(r"\bline (\d+)", context)
    if m and 0 < int(m.group(1)) <= len(ids):
        row = f" row {ids[int(m.group(1)) - 1]!r}"
    elif current and ids:
        row = f" row {ids[-1]!r}"
    return CutoverError(f"{table}{row} can't be written to Postgres "
                        f"({what}) — fix or delete it in SQLite")


def _copy(src: sqlite3.Connection, conn: Any
          ) -> tuple[dict[str, int], dict[str, float]]:
    """Copy all tables; returns the SQLite row counts (what Postgres must
    have now) and the per-user unrefunded seconds."""
    counts: dict[str, int] = {}
    for table in pg.TABLES:
        if table == "jobs":
            counts["jobs"], counts["job_keys"] = _copy_jobs(src, conn)
            continue
        have = _sqlite_columns(src, table)
        counts[table] = 0
        if have is None:  # accounts never used on this deployment
            continue
        cols = pg.COLUMNS[table]
        take = [c for c in cols if c in have]
        key = pg.PRIMARY_KEYS[table]
        ids: list[Any] = []
        try:
            with conn.cursor() as cur, cur.copy(
                    f"COPY {table} ({', '.join(cols)}) FROM STDIN") as cp:
                for row in src.execute(
                        f"SELECT {', '.join(take)} FROM {table}"):
                    values = dict(zip(take, row))
                    ids.append(values.get(key))
                    try:
                        cp.write_row(tuple(_value(table, c, values.get(c))
                                           for c in cols))
                    except CutoverError as e:   # _value: not a Unix time
                        raise CutoverError(
                            f"{table} row {ids[-1]!r}: {e} — fix or delete "
                            "it in SQLite") from e
                    except Exception as e:
                        raise _copy_failed(table, ids, e, current=True) from e
                    counts[table] += 1
        except CutoverError:
            raise
        except Exception as e:
            raise _copy_failed(table, ids, e) from e
    sums: dict[str, float] = {}
    if _sqlite_columns(src, "usage") is not None:
        for row in src.execute("SELECT user_id, SUM(seconds_billed) AS s "
                               "FROM usage WHERE refunded = 0 "
                               "GROUP BY user_id"):
            sums[row["user_id"]] = float(row["s"] or 0)
    return counts, sums


def _copy_jobs(src: sqlite3.Connection, conn: Any) -> tuple[int, int]:
    if _sqlite_columns(src, "jobs") is None:
        return 0, 0
    keys: dict[str, str] = {}
    if _sqlite_columns(src, "job_keys") is not None:
        for row in src.execute("SELECT k.key, k.job_id FROM job_keys k "
                               "JOIN jobs j ON j.id = k.job_id"):
            if row["job_id"] in keys:
                raise CutoverError(f"job {row['job_id']!r} has two upload "
                                   "keys in job_keys")
            keys[row["job_id"]] = row["key"]
    n = 0
    cols = pg.COLUMNS["jobs"]
    ids: list[str] = []
    try:
        with conn.cursor() as cur, cur.copy(
                f"COPY jobs ({', '.join(cols)}) FROM STDIN") as cp:
            for row in src.execute("SELECT id, data FROM jobs"):
                job_id = row["id"]
                try:
                    d = json.loads(row["data"])
                    if not isinstance(d, dict):
                        raise ValueError("not a JSON object")
                    if d.get("id") != job_id:
                        raise ValueError(f"its data says id {d.get('id')!r}")
                    job = jobs.job_from_dict(d)
                except Exception as e:
                    raise CutoverError(f"jobs row {job_id!r} can't be read "
                                       f"({type(e).__name__}: {e}) — fix or "
                                       "delete it in SQLite") from e
                ids.append(job_id)
                try:
                    cp.write_row((pg._text(job.id), *pg._hot(job),
                                  pg._text(keys.get(job_id)),
                                  pg.dump_job(job)))
                except Exception as e:
                    raise _copy_failed("jobs", ids, e, current=True) from e
                n += 1
    except CutoverError:
        raise
    except Exception as e:
        raise _copy_failed("jobs", ids, e) from e
    return n, len(keys)


def _verify(conn: Any, counts: dict[str, int], sums: dict[str, float]
            ) -> None:
    got: dict[str, int] = {}
    for table in pg.TABLES:
        got[table] = conn.execute(f"SELECT count(*) FROM {table}"
                                  ).fetchone()[0]
    got["job_keys"] = conn.execute(
        "SELECT count(*) FROM jobs WHERE idempotency_key IS NOT NULL"
    ).fetchone()[0]
    wrong = {t: (counts.get(t, 0), got[t]) for t in got
             if got[t] != counts.get(t, 0)}
    if wrong:
        raise CutoverError("row counts differ (sqlite, postgres): "
                           f"{wrong}")
    pg_sums = {r[0]: float(r[1] or 0) for r in conn.execute(
        "SELECT user_id, SUM(seconds_billed) FROM usage "
        "WHERE refunded = false GROUP BY user_id")}
    if set(pg_sums) != set(sums) or any(
            abs(pg_sums[u] - sums[u]) > 1e-6 for u in sums):
        diff = {u: (sums.get(u), pg_sums.get(u))
                for u in set(sums) | set(pg_sums)
                if abs((sums.get(u) or 0) - (pg_sums.get(u) or 0)) > 1e-6
                or (u in sums) != (u in pg_sums)}
        raise CutoverError(f"billed seconds per user differ (sqlite, "
                           f"postgres): {diff}")
