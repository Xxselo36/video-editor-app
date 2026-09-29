"""Which database the web backend runs on, chosen once per process.

SQLite (one file, backend.jobs._db_path(), used by backend/jobs.py and
backend/accounts.py) is the default: dev, tests, the desktop app and the
Modal image. With DATABASE_URL set, Postgres (backend/pg.py) is the
source of truth for jobs and accounts:

    DATABASE_URL unset                       → sqlite
    DATABASE_URL set                         → postgres
    CLEO_DB_BACKEND=sqlite                   → sqlite (explicit override,
                                               e.g. rollback right after
                                               the cutover)
    CLEO_DB_BACKEND=postgres, no DATABASE_URL → refuse to start

startup() runs at boot (main.lifespan) or on the first use of
backend.jobs.store / the accounts DB, whichever comes first. With
Postgres it applies the schema migrations and — on the first boot —
copies the SQLite data over (backend/pg_cutover.py), verifies it and
switches. If that fails the process stays on SQLite ("[db] MIGRATION
FAILED — staying on SQLite: …") and the next boot tries again.

The marker file next to the SQLite file (<db>.migrated-to-postgres)
records the cutover. It is written (fsynced) BEFORE the cutover commits
— as "pending"; if that write fails nothing is committed — and made
final after it. While it exists:
  - an unreachable Postgres stops the boot (after waiting
    CLEO_DB_BOOT_WAIT_S, default 180 s, for it) instead of silently
    running on the stale SQLite copy;
  - a Postgres database without the cutover marker (new, emptied, a
    wrong DATABASE_URL) is not filled with the stale SQLite data again:
    the boot stops (pg_cutover.StaleImport) — unless the file is still
    "pending", i.e. that cutover never committed.
Before falling back to SQLite a process checks once more whether the
cutover committed after all (a lost COMMIT answer) or another process
cut over meanwhile (it waits for that one's cutover lock); then it uses
Postgres. The SQLite fallback is for one process: if another one cuts
over later, peer_cut_over() says so and main.py stops this one.

stdlib only — backend.jobs imports this module; psycopg is imported by
backend.pg alone, and only when Postgres is selected.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit


class ConfigError(RuntimeError):
    """CLEO_DB_BACKEND / DATABASE_URL don't make sense: don't start."""


class Unavailable(RuntimeError):
    """Postgres is (or must be) the source of truth but can't be used, and
    SQLite is no safe fallback: don't start."""


class Epoch(float):
    """A Unix time bound as a query parameter (backend.accounts): SQLite
    stores the float as REAL, like before; backend.pg turns it into a
    timestamptz. Rows read from Postgres come back as floats again."""
    __slots__ = ()


class JsonText(str):
    """JSON text bound as a query parameter for a JSON column
    (subscriptions.raw_json): SQLite stores it as is; backend.pg first
    makes it storable for jsonb (no NUL, no lone surrogates)."""
    __slots__ = ()


def ts(value: Any) -> Epoch | None:
    """Mark a Unix time (float, int or None) as a timestamp parameter."""
    return None if value is None else Epoch(value)


def database_url() -> str:
    return os.environ.get("DATABASE_URL", "").strip()


def configured_backend() -> str:
    """'sqlite' or 'postgres' from the environment (see module doc)."""
    choice = os.environ.get("CLEO_DB_BACKEND", "").strip().lower()
    url = database_url()
    if choice in ("", "auto"):
        return "postgres" if url else "sqlite"
    if choice == "sqlite":
        return "sqlite"
    if choice in ("postgres", "postgresql", "pg"):
        if not url:
            raise ConfigError(
                "CLEO_DB_BACKEND=postgres but DATABASE_URL is not set — "
                "set DATABASE_URL (Railway: ${{Postgres.DATABASE_URL}}) or "
                "remove CLEO_DB_BACKEND")
        return "postgres"
    raise ConfigError(f"CLEO_DB_BACKEND={choice!r}: use 'sqlite' or "
                      "'postgres' (or leave it unset)")


def redacted(url: str) -> str:
    """host:port/dbname of a connection URL, without credentials."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<unparsable DATABASE_URL>"
    host = parts.hostname or "localhost"
    if parts.port:
        host = f"{host}:{parts.port}"
    return f"{host}{parts.path or ''}"


def cutover_marker_path(sqlite_path: str) -> str:
    """File written next to the SQLite DB once its data lives in Postgres."""
    return sqlite_path + ".migrated-to-postgres"


_lock = threading.RLock()
_active: str | None = None
# Set when this process fell back to SQLite after a failed cutover:
# {"since", "marker", "url"} — see peer_cut_over().
_fallback: dict[str, Any] | None = None


def startup() -> str:
    """Pick and open the database for this process (idempotent, thread
    safe). Returns 'sqlite' or 'postgres'. Raises ConfigError /
    Unavailable when it must not start at all."""
    global _active, _fallback
    with _lock:
        if _active is not None:
            return _active
        _fallback = None
        if configured_backend() == "postgres":
            _active = _start_postgres()
        else:
            _active = "sqlite"
            _log_sqlite()
        return _active


def active() -> str:
    """The database of this process ('sqlite' / 'postgres'); runs
    startup() on first use."""
    return _active or startup()


def is_postgres() -> bool:
    return active() == "postgres"


def is_transient(exc: BaseException) -> bool:
    """Is `exc` the database being unavailable for a while — a retry may
    succeed (Postgres restarting or unreachable, a lost connection, the
    pool timing out: psycopg.OperationalError, which psycopg_pool's
    PoolTimeout is too)? False for everything else, and always while
    psycopg isn't loaded (SQLite: a failed write there is no outage)."""
    psycopg = sys.modules.get("psycopg")
    error = getattr(psycopg, "OperationalError", None)
    return error is not None and isinstance(exc, error)


def _sqlite_path() -> str:
    from backend import jobs
    return jobs._db_path()


def _log_sqlite() -> None:
    path = _sqlite_path()
    print(f"[db] backend: sqlite ({path})", flush=True)
    marker = cutover_marker_path(path)
    if os.path.exists(marker):
        try:
            with open(marker, encoding="utf-8") as f:
                info = f.read().strip()
        except OSError:
            info = "?"
        why = ("CLEO_DB_BACKEND=sqlite" if database_url()
               else "DATABASE_URL is not set")
        print(f"[db] !!! WARNING: running on SQLite ({why}), but this SQLite "
              f"file was already migrated to Postgres ({info}). Everything "
              "written to Postgres since the cutover is NOT in it, and what "
              "is written here now will not be copied back. !!!", flush=True)


def boot_wait_s() -> float:
    """How long a boot that must use Postgres (the marker file exists)
    waits for it to become reachable: CLEO_DB_BOOT_WAIT_S, default 180 s
    — a Postgres restart shouldn't burn the platform's restart retries."""
    try:
        return max(0.0, float(os.environ.get("CLEO_DB_BOOT_WAIT_S", "")
                              .strip() or 180))
    except ValueError:
        return 180.0


# How long a process that couldn't migrate waits for another process's
# cutover to finish before deciding between Postgres and SQLite.
PEER_WAIT_S = 300.0


def _start_postgres(retried: bool = False) -> str:
    global _fallback
    path = _sqlite_path()
    marker = cutover_marker_path(path)
    url = database_url()
    where = redacted(url)
    state = _read_marker(marker)
    wrote_pending = False

    def before_commit(value: str) -> None:
        # Inside the cutover transaction: the marker file first, so a
        # committed cutover can never be left without it. Raises (OSError,
        # e.g. a full volume) → rolled back, nothing moved.
        nonlocal wrote_pending
        _write_marker_file(marker, _with_pending(value))
        wrote_pending = True

    try:
        from backend import pg, pg_cutover
        database = _open_postgres(url, wait=state is not None)
        if (state is not None and state.get("pending")
                and pg_cutover.marker(database) is None):
            # Written by a boot whose cutover never committed: SQLite is
            # still the source of truth.
            print(f"[db] cutover marker {marker} is from a cutover that "
                  "never committed — removing it", flush=True)
            _remove_marker(marker)
            state = None
        result = pg_cutover.migrate_if_needed(
            database, path, allow_import=state is None,
            before_commit=before_commit)
    except Exception as e:
        _close_pg()
        if type(e).__name__ == "StaleImport":  # pg_cutover.StaleImport
            raise Unavailable(
                f"[db] refusing to start: Postgres ({where}) has no cutover "
                f"marker but {marker} says this SQLite file was already "
                f"migrated ({state}) — {e}") from e
        if state is not None:
            raise Unavailable(
                f"[db] Postgres ({where}) failed and this deployment was "
                f"already cut over to it ({marker}) — refusing to run on the "
                f"stale SQLite copy: {e}") from e
        if not os.path.exists(path):
            raise Unavailable(
                f"[db] Postgres ({where}) failed and there is no SQLite data "
                f"to fall back to ({path}): {e}") from e
        committed = _committed_elsewhere(url, e, wrote_pending)
        if committed is not None:
            if retried:
                raise Unavailable(
                    f"[db] Postgres ({where}) holds the cutover "
                    f"({committed}) but can't be used: {e}") from e
            print(f"[db] the cutover to Postgres ({where}) was committed "
                  f"after all ({committed}); using Postgres", flush=True)
            _write_marker(marker, committed)
            return _start_postgres(retried=True)
        if wrote_pending:  # our commit really failed
            _remove_marker(marker)
        print(f"[db] MIGRATION FAILED — staying on SQLite: {e}\n"
              f"{traceback.format_exc()}"
              f"[db] running on SQLite ({path}) for this process; the next "
              "boot tries the migration again.", flush=True)
        _fallback = {"since": time.time(), "marker": marker, "url": url}
        return "sqlite"
    if os.path.exists(path):
        _write_marker(marker, result.marker)
        if result.status == "already" and '"fresh": true' in (
                result.marker or ""):
            print(f"[db] !!! WARNING: this Postgres database was set up "
                  f"empty (no SQLite file at its first boot), but there is "
                  f"one now: {path}. Its data was NOT copied — see DEPLOY.md "
                  "section 8.2. !!!", flush=True)
    if result.status == "migrated":
        counts = ", ".join(f"{k}={v}" for k, v in result.counts.items())
        print(f"[db] migrated SQLite → Postgres ({where}): {counts}. The "
              f"SQLite file stays as a read-only backup: {path}", flush=True)
    elif result.status == "fresh":
        print(f"[db] fresh Postgres database ({where}): no SQLite file at "
              f"{path}, nothing to copy", flush=True)
    print(f"[db] backend: postgres ({where}, pool max "
          f"{pg.pool_max()}, schema v{database.schema_version()})",
          flush=True)
    return "postgres"


def _open_postgres(url: str, wait: bool) -> Any:
    """pg.open_database; with `wait` (the deployment already runs on
    Postgres) retried with backoff for boot_wait_s() first."""
    from backend import pg
    deadline = time.monotonic() + (boot_wait_s() if wait else 0.0)
    delay = 2.0
    while True:
        try:
            return pg.open_database(url)
        except Exception as e:
            left = deadline - time.monotonic()
            if left <= 0:
                raise
            print(f"[db] Postgres ({redacted(url)}) not reachable: {e} — "
                  f"this deployment runs on Postgres, retrying for up to "
                  f"{left:.0f} s more", flush=True)
            time.sleep(min(delay, left))
            delay = min(delay * 2, 30.0)


def _committed_elsewhere(url: str, error: Exception,
                         wrote_pending: bool) -> str | None:
    """After a failed start, before falling back to SQLite: the cutover
    marker if Postgres has one after all — our COMMIT went through but
    its answer was lost, or another process cut over while we tried
    (waits up to PEER_WAIT_S for one still copying). None: nothing was
    committed, falling back is safe. Raises Unavailable when that can't
    be known."""
    where = redacted(url)
    try:
        from backend import pg_cutover
    except Exception:  # no psycopg: nobody here can have migrated
        return None
    try:
        return pg_cutover.peek_marker(url, wait_s=PEER_WAIT_S)
    except pg_cutover.CutoverBusy as e:
        raise Unavailable(f"[db] Postgres ({where}) failed ({error}) while "
                          f"another process is cutting over to it ({e}) — "
                          "not starting on SQLite") from error
    except Exception as e:
        if wrote_pending:
            raise Unavailable(
                f"[db] the cutover to Postgres ({where}) may have been "
                f"committed ({error}) and Postgres can't be checked now "
                f"({e}) — not starting on SQLite; the next boot checks "
                "again") from error
        return None  # unreachable: nobody can cut over right now


def fell_back() -> bool:
    """Is this process on the SQLite fallback after a failed cutover?"""
    return _fallback is not None


def peer_cut_over() -> str | None:
    """On the SQLite fallback: has another process (worker, replica, a
    later boot) cut over to Postgres since? Then this one must stop —
    what it writes to SQLite from now on would never reach Postgres.
    Returns what shows it, or None (also when Postgres can't be asked)."""
    fb = _fallback
    if fb is None:
        return None
    if os.path.exists(fb["marker"]):
        return f"the cutover marker file {fb['marker']} exists"
    try:
        from backend import pg_cutover
        value = pg_cutover.peek_marker(fb["url"])
    except Exception:
        return None
    if value is None:
        return None
    return f"Postgres ({redacted(fb['url'])}) has the cutover marker {value}"


def _read_marker(marker: str) -> dict[str, Any] | None:
    """The marker file as a dict (None: no file). Unreadable or not JSON
    counts as a finished cutover."""
    try:
        with open(marker, encoding="utf-8") as f:
            text = f.read().strip()
    except FileNotFoundError:
        return None
    except OSError as e:
        return {"unreadable": str(e)}
    try:
        info = json.loads(text)
    except ValueError:
        return {"info": text}
    return info if isinstance(info, dict) else {"info": text}


def _with_pending(value: str) -> str:
    try:
        info = json.loads(value)
    except ValueError:
        info = {"info": value}
    if not isinstance(info, dict):
        info = {"info": value}
    return json.dumps({**info, "pending": True})


def _write_marker_file(marker: str, body: str) -> None:
    """Write the marker file durably (temp file, fsync, rename, fsync the
    directory). Raises OSError."""
    tmp = f"{marker}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, marker)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    try:
        fd = os.open(os.path.dirname(os.path.abspath(marker)), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _write_marker(marker: str, info: str | None) -> None:
    """The final marker file (after a committed cutover): written if
    missing, a "pending" one replaced. A failure is logged — the pending
    file (if any) keeps guarding, and the next boot tries again."""
    state = _read_marker(marker)
    if state is not None and not state.get("pending"):
        return
    try:
        body = info or json.dumps({
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        _write_marker_file(marker, body)
    except OSError as e:
        print(f"[db] could not write the cutover marker {marker}: {e}",
              flush=True)


def _remove_marker(marker: str) -> None:
    try:
        os.remove(marker)
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f"[db] could not remove the cutover marker {marker}: {e}",
              flush=True)


def _close_pg() -> None:
    try:
        from backend import pg
    except Exception:
        return
    try:
        pg.close()
    except Exception:
        pass


def now_iso() -> str:
    return datetime.fromtimestamp(time.time(), tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
