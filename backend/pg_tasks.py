"""The WP4 task queue on Postgres (backend/taskq.py): the task store and
the leader's advisory lock.

PgTaskStore has the methods of backend.jobs.SqliteTaskStore. A job
write and its task are one transaction (the job store's _write_on on the
same connection); claims use FOR UPDATE SKIP LOCKED, so any number of
dispatchers never hand out a task twice; every worker write is fenced by
the task's attempts (the claim increments it; a requeue never lowers
it), so a zombie attempt — its lease lost, its job deleted — can neither
heartbeat, commit nor report. Enqueues NOTIFY cleo_tasks inside their
transaction. Times: now() on the server, returned as Unix floats.

LeaderLock is the leader's own connection (never from the pool, never
through a transaction pooler): pg_try_advisory_lock plus LISTEN. Losing
the connection is losing leadership.

Imported only while Postgres is active (psycopg stays out of the
desktop app, the Modal image and SQLite deployments).
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable, Iterable

import psycopg

from backend import db, pg, taskq
from backend.jobs import Job, gc_clean_entries

_TIME_COLUMNS = frozenset({
    "sort_at", "run_after", "first_wait_at", "locked_until", "heartbeat_at",
    "started_at", "finished_at", "finalized_at", "created_at", "updated_at"})


def _select(prefix: str = "") -> str:
    """The task columns, times as Unix floats."""
    out = []
    for c in taskq.TASK_COLUMNS:
        col = f"{prefix}{c}"
        out.append(f"extract(epoch FROM {col})::float8 AS {c}"
                   if c in _TIME_COLUMNS else f"{col} AS {c}")
    return ", ".join(out)


_COLS = _select()
# See backend/jobs.py _NOT_A_CLAIM_SQLITE (settings is a nested JSON
# string in jobs.data; older rows may hold it as an object).
_NOT_A_CLAIM = (
    "AND coalesce((CASE jsonb_typeof(data->'settings') WHEN 'string' "
    "THEN (data->>'settings')::jsonb ELSE data->'settings' END)"
    "->>'_accepting', 'false') <> 'true'")
_T_COLS = _select("t.")


class _Rollback(Exception):
    """Internal: undo the transaction, answer normally."""


class PgTaskStore:
    """backend.jobs.SqliteTaskStore on Postgres (see the module doc)."""

    def __init__(self, jobs_store: "pg.PgJobStore") -> None:
        self._jobs = jobs_store
        self._db = jobs_store._db

    def __repr__(self) -> str:
        return f"<PgTaskStore {db.redacted(self._db.url)}>"

    # ── plumbing ─────────────────────────────────────────────────────

    @staticmethod
    def _rows(cur: psycopg.Cursor) -> list[taskq.Task]:
        names = [d.name for d in cur.description or ()]
        return [taskq.task_from_row(dict(zip(names, r)))
                for r in cur.fetchall()]

    def _tasks(self, sql: str, args: Iterable[Any] = ()) -> list[taskq.Task]:
        with self._db.connection() as conn:
            return self._rows(conn.execute(sql, tuple(args)))

    @staticmethod
    def _insert(conn: psycopg.Connection, job_id: str, kind: str,
                payload: dict[str, Any], owner_id: str | None,
                plan: str | None, sort_offset_s: float,
                max_attempts: int) -> int:
        # A UniqueViolation aborts the caller's transaction; TaskActive
        # propagates out of it, so it is rolled back as a whole.
        try:
            row = conn.execute(
                "INSERT INTO tasks (job_id, kind, state, owner_id, plan, "
                "payload, sort_at, max_attempts) VALUES (%s, %s, "
                "'queued', %s, %s, %s::jsonb, "
                "now() + make_interval(secs => %s), %s) RETURNING id",
                (job_id, kind, pg.clean_text(owner_id)
                 if owner_id else None, plan, pg.to_json(payload),
                 float(sort_offset_s), int(max_attempts))).fetchone()
        except psycopg.errors.UniqueViolation as e:
            raise taskq.TaskActive(f"job {job_id} has an active {kind} "
                                   "task") from e
        conn.execute("SELECT pg_notify('cleo_tasks', %s)", (kind,))
        return int(row[0])

    def notify(self, kind: str) -> None:
        taskq.wake(kind)
        try:
            with self._db.connection() as conn:
                conn.execute("SELECT pg_notify('cleo_tasks', %s)", (kind,))
        except Exception:
            pass

    def schema_version(self) -> int:
        return self._db.schema_version()

    # ── enqueue (with the job write, in one transaction) ─────────────

    def enqueue(self, job_id: str, kind: str,
                payload: dict[str, Any] | Callable[[dict | None], dict], *,
                owner_id: str | None = None, plan: str | None = None,
                sort_offset_s: float = 0.0, max_attempts: int = 3,
                job_expect: str | tuple[str, ...] | None = None,
                job_change: dict[str, Any] | Callable[[Job], Any] | None = None
                ) -> tuple[int | None, dict[str, Any] | None]:
        expect = ((job_expect,) if isinstance(job_expect, str)
                  else job_expect)
        with self._db.connection() as conn:
            written = None
            if job_change is not None:
                written = self._jobs._write_on(conn, job_id, expect,
                                               job_change)
                if written is None:
                    return None, None
            if callable(payload):
                payload = payload(written)
            task_id = self._insert(conn, job_id, kind, payload, owner_id,
                                   plan, sort_offset_s, max_attempts)
        taskq.wake(kind)
        return task_id, written

    def admit_ingest(self, job_id: str, *, owner_id: str | None,
                     count_user: bool, user_limit: int, queue_cap: int,
                     running_limit: int, payload: dict[str, Any],
                     plan: str | None, sort_offset_s: float,
                     max_attempts: int, job_fields: dict[str, Any]) -> str:
        """SqliteTaskStore.admit_ingest: under the advisory lock
        user:<owner> (two uploads of one account are admitted one after
        the other, in any process)."""
        try:
            with self._db.connection() as conn:
                if count_user and owner_id and user_limit > 0:
                    conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))",
                                 (f"user:{owner_id}",))
                    n = conn.execute(
                        "SELECT count(*) FROM jobs WHERE owner_id = %s AND "
                        "status IN ('pending', 'processing') AND id <> %s "
                        + _NOT_A_CLAIM,
                        (pg.clean_text(owner_id), job_id)).fetchone()[0]
                    if n >= user_limit:
                        raise _Answer("too_many_active_jobs")
                queued, active = conn.execute(
                    "SELECT count(*) FILTER (WHERE state = 'queued'), "
                    "count(*) FILTER (WHERE state IN ('dispatching', "
                    "'running')) FROM tasks WHERE kind = 'ingest' AND state "
                    "IN ('queued', 'dispatching', 'running')").fetchone()
                if queued + active + 1 - running_limit > queue_cap:
                    raise _Answer("server_busy")
                if self._jobs._write_on(conn, job_id, ("pending",),
                                        job_fields) is None:
                    raise _Answer("gone")
                self._insert(conn, job_id, "ingest", payload, owner_id, plan,
                             sort_offset_s, max_attempts)
        except _Answer as a:
            return a.code
        taskq.wake("ingest")
        return "ok"

    def admission_counts(self, owner_id: str | None) -> tuple[int, int, int]:
        with self._db.connection() as conn:
            user = 0
            if owner_id:
                user = conn.execute(
                    "SELECT count(*) FROM jobs WHERE owner_id = %s AND "
                    "status IN ('pending', 'processing') " + _NOT_A_CLAIM,
                    (pg.clean_text(owner_id),)).fetchone()[0]
            queued, active = conn.execute(
                "SELECT count(*) FILTER (WHERE state = 'queued'), "
                "count(*) FILTER (WHERE state IN ('dispatching', 'running')) "
                "FROM tasks WHERE kind = 'ingest' AND state IN ('queued', "
                "'dispatching', 'running')").fetchone()
        return int(user), int(queued or 0), int(active or 0)

    # ── dispatcher ───────────────────────────────────────────────────

    def counts(self, kind: str) -> tuple[int, int]:
        with self._db.connection() as conn:
            queued, active = conn.execute(
                "SELECT count(*) FILTER (WHERE state = 'queued'), "
                "count(*) FILTER (WHERE state IN ('dispatching', 'running')) "
                "FROM tasks WHERE kind = %s AND state IN ('queued', "
                "'dispatching', 'running')", (kind,)).fetchone()
        return int(queued or 0), int(active or 0)

    def active_count(self, kind: str) -> int:
        return self.counts(kind)[1]

    def active_by_executor(self, kind: str) -> dict[str, int]:
        with self._db.connection() as conn:
            rows = conn.execute(
                "SELECT coalesce(executor, 'local'), count(*) FROM tasks "
                "WHERE kind = %s AND state IN ('dispatching', 'running') "
                "GROUP BY 1", (kind,)).fetchall()
        return {str(r[0]): int(r[1]) for r in rows}

    def modal_orphans(self, now: float, settled_since: float
                      ) -> list[taskq.Task]:
        return self._tasks(
            f"SELECT {_COLS} FROM tasks WHERE kind = 'ingest' AND "
            "modal_call_id LIKE 'fc-%%' AND ((state IN ('dispatching', "
            "'running') AND locked_until < %s) OR (state IN ('failed', "
            "'dead', 'cancelled') AND coalesce(finished_at, updated_at) > "
            "%s)) ORDER BY id", (pg._dt(now), pg._dt(settled_since)))

    def queued(self, kind: str | None = None, limit: int | None = None
               ) -> list[taskq.Task]:
        sql = f"SELECT {_COLS} FROM tasks WHERE state = 'queued'"
        args: list[Any] = []
        if kind is not None:
            sql += " AND kind = %s"
            args.append(kind)
        sql += " ORDER BY kind, sort_at, id"
        if limit is not None:
            sql += " LIMIT %s"
            args.append(int(limit))
        return self._tasks(sql, args)

    def claim_for_dispatch(self, kind: str, limit: int, leader_id: str,
                           lease_s: float, executor: str, *,
                           created_before: float | None = None,
                           ids: list[int] | None = None
                           ) -> list[taskq.Task]:
        """The verified claim (WP4 §5.3): FOR UPDATE SKIP LOCKED over the
        tasks_queue index, attempts + 1, a start lease (only tasks of
        `ids`, when given)."""
        if limit <= 0 or ids == []:
            return []
        extra = ""
        args: list[Any] = [kind]
        if created_before is not None:
            extra = " AND created_at <= %s"
            args.append(pg._dt(created_before))
        if ids is not None:
            extra += " AND id = ANY(%s)"
            args.append([int(i) for i in ids])
        args += [int(limit), leader_id, float(lease_s), executor]
        with self._db.connection() as conn:
            cur = conn.execute(
                "WITH c AS (SELECT id FROM tasks WHERE state = 'queued' AND "
                f"kind = %s AND run_after <= now(){extra} "
                "ORDER BY sort_at, id FOR UPDATE SKIP LOCKED LIMIT %s) "
                "UPDATE tasks t SET state = 'dispatching', "
                "attempts = t.attempts + 1, locked_by = %s, "
                "locked_until = now() + make_interval(secs => %s), "
                "executor = %s, updated_at = now(), "
                "started_at = CASE WHEN t.kind = 'ingest' THEN now() "
                "ELSE t.started_at END "
                f"FROM c WHERE t.id = c.id RETURNING {_T_COLS}", tuple(args))
            rows = self._rows(cur)
        rows.sort(key=lambda t: (t.sort_at, t.id))
        return rows

    def mark_spawned(self, task_id: int, attempt: int, call_id: str) -> bool:
        with self._db.connection() as conn:
            return conn.execute(
                "UPDATE tasks SET modal_call_id = %s, updated_at = now() "
                "WHERE id = %s AND attempts = %s",
                (call_id, task_id, attempt)).rowcount == 1

    def groq_window_s(self, since: float) -> float:
        with self._db.connection() as conn:
            row = conn.execute(
                "SELECT sum((payload->>'est_audio_s')::float8) FROM tasks "
                "WHERE kind = 'ingest' AND started_at > %s",
                (pg._dt(since),)).fetchone()
        return float(row[0] or 0.0)

    # ── worker (fenced by attempts) ──────────────────────────────────

    def worker_claim(self, task_id: int, attempt: int, call_id: str,
                     lease_s: float) -> taskq.Task | None:
        with self._db.connection() as conn:
            rows = self._rows(conn.execute(
                "UPDATE tasks SET state = 'running', "
                "modal_call_id = coalesce(modal_call_id, %s), "
                "locked_by = %s, "
                "locked_until = now() + make_interval(secs => %s), "
                "heartbeat_at = now(), started_at = coalesce(started_at, "
                "now()), updated_at = now() WHERE id = %s AND attempts = %s "
                "AND state IN ('dispatching', 'running') "
                f"RETURNING {_COLS}",
                (call_id, call_id, float(lease_s), task_id, attempt)))
        return rows[0] if rows else None

    def heartbeat(self, task_id: int, attempt: int, lease_s: float) -> bool:
        with self._db.connection() as conn:
            return conn.execute(
                "UPDATE tasks SET locked_until = now() + make_interval("
                "secs => %s), heartbeat_at = now(), updated_at = now() "
                "WHERE id = %s AND attempts = %s AND state = 'running'",
                (float(lease_s), task_id, attempt)).rowcount == 1

    def commit_success(self, task_id: int, attempt: int,
                       result: dict[str, Any] | Callable[[], dict[str, Any]],
                       job_id: str, job_expect: str | tuple[str, ...] | None,
                       job_change: dict[str, Any] | Callable[[Job], Any]
                       ) -> str:
        expect = ((job_expect,) if isinstance(job_expect, str)
                  else job_expect)
        try:
            with self._db.connection() as conn:
                if conn.execute(
                        "UPDATE tasks SET state = 'succeeded', "
                        "finished_at = now(), locked_until = NULL, "
                        "error_code = NULL, retryable = NULL, "
                        "updated_at = now() WHERE id = %s AND "
                        "attempts = %s AND state = 'running'",
                        (task_id, attempt)).rowcount != 1:
                    raise _Answer("fenced")
                if self._jobs._write_on(conn, job_id, expect,
                                        job_change) is None:
                    raise _Answer("job_changed")
                value = dict((result() if callable(result) else result)
                             or {})
                gc = value.pop("gc", None)
                if gc and gc[0]:
                    self._jobs._gc_insert(conn, gc_clean_entries(gc[0]),
                                          float(gc[1]), gc[2])
                conn.execute("UPDATE tasks SET result = %s::jsonb WHERE "
                             "id = %s", (pg.to_json(value), task_id))
        except _Answer as a:
            return a.code
        taskq.wake_finalizer()
        return "ok"

    def report_failure(self, task_id: int, attempt: int, error_code: str,
                       message: str, retryable: bool,
                       result: dict[str, Any] | None = None) -> bool:
        with self._db.connection() as conn:
            ok = conn.execute(
                "UPDATE tasks SET state = 'failed', finished_at = now(), "
                "error_code = %s, last_error = %s, retryable = %s, "
                "result = %s::jsonb, locked_until = NULL, updated_at = now() "
                "WHERE id = %s AND attempts = %s AND state = 'running'",
                (error_code, pg.clean_text(message or "")[:2000],
                 bool(retryable), pg.to_json(result or {}), task_id,
                 attempt)).rowcount == 1
        if ok:
            taskq.wake_finalizer()
        return ok

    # ── reaper / finalizer ───────────────────────────────────────────

    def expired(self, now: float | None = None) -> list[taskq.Task]:
        bound = "now()" if now is None else "%s"
        args = () if now is None else (pg._dt(now),)
        return self._tasks(
            f"SELECT {_COLS} FROM tasks WHERE state IN ('dispatching', "
            f"'running') AND locked_until < {bound} ORDER BY locked_until",
            args)

    def requeue(self, task_id: int, *, expect_states: tuple[str, ...],
                attempts: int, delay_s: float = 0.0, free: bool = False,
                provider_wait: bool = False, error_code: str | None = None,
                last_error: str | None = None,
                expired_before: float | None = None,
                dead: bool = False) -> str | None:
        """SqliteTaskStore.requeue, under the row lock."""
        with self._db.connection() as conn:
            rows = self._rows(conn.execute(
                f"SELECT {_COLS} FROM tasks WHERE id = %s FOR UPDATE",
                (task_id,)))
            if not rows:
                return None
            t = rows[0]
            if (t.state not in expect_states or t.attempts != attempts
                    or t.finalized_at is not None
                    or (expired_before is not None
                        and not (t.locked_until is not None
                                 and t.locked_until < expired_before))):
                return None
            code = error_code or t.error_code
            text = last_error if last_error is not None else t.last_error
            if dead or (not free and t.attempts >= t.max_attempts):
                conn.execute(
                    "UPDATE tasks SET state = 'dead', finished_at = now(), "
                    "locked_by = NULL, locked_until = NULL, error_code = %s, "
                    "last_error = %s, retryable = false, updated_at = now() "
                    "WHERE id = %s",
                    (code if dead else taskq.ATTEMPTS_EXHAUSTED,
                     pg.clean_text((text or "") if dead else
                                   (f"{code}: {text}" if code
                                    else (text or "")))[:2000], task_id))
                new_state = "dead"
            else:
                conn.execute(
                    "UPDATE tasks SET state = 'queued', "
                    "run_after = now() + make_interval(secs => %s), "
                    "max_attempts = max_attempts + %s, "
                    "provider_waits = provider_waits + %s, "
                    "first_wait_at = CASE WHEN %s THEN coalesce("
                    "first_wait_at, now()) ELSE first_wait_at END, "
                    "locked_by = NULL, locked_until = NULL, "
                    "heartbeat_at = NULL, modal_call_id = NULL, "
                    "finished_at = NULL, result = NULL, error_code = %s, "
                    "last_error = %s, retryable = NULL, updated_at = now() "
                    "WHERE id = %s",
                    (max(0.0, float(delay_s)), 1 if free else 0,
                     1 if provider_wait else 0, bool(provider_wait), code,
                     pg.clean_text((text or "")[:2000]) or None, task_id))
                conn.execute("SELECT pg_notify('cleo_tasks', %s)", (t.kind,))
                new_state = "queued"
        if new_state == "queued":
            taskq.wake(t.kind)
        else:
            taskq.wake_finalizer()
        return new_state

    def expire_held(self, kind: str, older_than: float, error_code: str,
                    message: str) -> list[taskq.Task]:
        with self._db.connection() as conn:
            rows = self._rows(conn.execute(
                "UPDATE tasks SET state = 'dead', finished_at = now(), "
                "error_code = %s, last_error = %s, retryable = false, "
                "updated_at = now() WHERE state = 'queued' AND kind = %s AND "
                "coalesce(first_wait_at, created_at) < %s "
                f"RETURNING {_COLS}",
                (error_code, pg.clean_text(message)[:2000], kind,
                 pg._dt(older_than))))
        if rows:
            taskq.wake_finalizer()
        return rows

    def unfinalized(self, limit: int = 50) -> list[taskq.Task]:
        return self._tasks(
            f"SELECT {_COLS} FROM tasks WHERE finalized_at IS NULL AND "
            "state IN ('succeeded', 'failed', 'dead', 'cancelled') "
            "ORDER BY finished_at, id LIMIT %s", (int(limit),))

    def mark_finalized(self, task_id: int,
                       event: tuple[str, str | None, dict[str, Any]] | None
                       = None) -> bool:
        with self._db.connection() as conn:
            if conn.execute(
                    "UPDATE tasks SET finalized_at = now(), "
                    "updated_at = now() WHERE id = %s AND finalized_at IS "
                    "NULL AND state IN ('succeeded', 'failed', 'dead', "
                    "'cancelled')", (task_id,)).rowcount != 1:
                return False
            if event is not None:
                kind, job_id, data = event
                conn.execute(
                    "INSERT INTO job_events (at, kind, job_id, data) "
                    "VALUES (now(), %s, %s, %s::jsonb)",
                    (pg.clean_text(kind),
                     pg.clean_text(job_id) if job_id else None,
                     pg.to_json(data or {})))
        return True

    # ── queue positions ──────────────────────────────────────────────

    def write_positions(self, rows: list[tuple[str, str, int, str | None]]
                        ) -> None:
        """TRUNCATE + INSERT in one transaction (WP4 §3.5)."""
        with self._db.connection() as conn:
            conn.execute("TRUNCATE queue_positions")
            if rows:
                with conn.cursor() as cur:
                    cur.executemany(
                        "INSERT INTO queue_positions (job_id, kind, pos, "
                        "hint, updated_at) VALUES (%s, %s, %s, %s, now()) "
                        "ON CONFLICT (job_id) DO UPDATE SET kind = "
                        "EXCLUDED.kind, pos = EXCLUDED.pos, hint = "
                        "EXCLUDED.hint, updated_at = EXCLUDED.updated_at",
                        rows)

    def position(self, job_id: str) -> tuple[int | None, str | None]:
        with self._db.connection() as conn:
            row = conn.execute(
                "SELECT pos, hint FROM queue_positions WHERE job_id = %s",
                (job_id,)).fetchone()
        return (int(row[0]), row[1]) if row else (None, None)

    def rank(self, task_id: int) -> int | None:
        with self._db.connection() as conn:
            row = conn.execute(
                "SELECT count(*) FROM tasks q, tasks t WHERE t.id = %s AND "
                "t.state = 'queued' AND q.state = 'queued' AND "
                "q.kind = t.kind AND (q.sort_at, q.id) <= (t.sort_at, t.id)",
                (task_id,)).fetchone()
        n = int(row[0] or 0)
        return n or None

    # ── lookups ──────────────────────────────────────────────────────

    def get(self, task_id: int) -> taskq.Task | None:
        rows = self._tasks(f"SELECT {_COLS} FROM tasks WHERE id = %s",
                           (task_id,))
        return rows[0] if rows else None

    def for_job(self, job_id: str) -> list[taskq.Task]:
        return self._tasks(f"SELECT {_COLS} FROM tasks WHERE job_id = %s "
                           "ORDER BY id", (job_id,))

    def active_task(self, job_id: str, kind: str | None = None
                    ) -> taskq.Task | None:
        sql = (f"SELECT {_COLS} FROM tasks WHERE job_id = %s AND state IN "
               "('queued', 'dispatching', 'running')")
        args: list[Any] = [job_id]
        if kind is not None:
            sql += " AND kind = %s"
            args.append(kind)
        rows = self._tasks(sql + " ORDER BY id", args)
        return rows[0] if rows else None

    def job_ids(self, kind: str) -> list[str]:
        with self._db.connection() as conn:
            rows = conn.execute("SELECT job_id FROM tasks WHERE kind = %s "
                                "ORDER BY id", (kind,)).fetchall()
        return [r[0] for r in rows]

    def unsettled_job_ids(self) -> set[str]:
        with self._db.connection() as conn:
            rows = conn.execute(
                "SELECT DISTINCT job_id FROM tasks WHERE state IN "
                "('queued', 'dispatching', 'running') OR finalized_at IS "
                "NULL").fetchall()
        return {r[0] for r in rows}

    def running_jobs_without_tasks(self) -> list[str]:
        with self._db.connection() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE status IN ('pending', "
                "'processing') AND NOT EXISTS (SELECT 1 FROM tasks t WHERE "
                "t.job_id = jobs.id AND (t.state IN ('queued', "
                "'dispatching', 'running') OR t.finalized_at IS NULL))"
            ).fetchall()
        return [r[0] for r in rows]

    # ── provider breakers ────────────────────────────────────────────

    _BREAKER_COLS = ("provider, extract(epoch FROM open_until)::float8, "
                     "reason, failures, extract(epoch FROM window_start)"
                     "::float8, opens, extract(epoch FROM updated_at)::float8")

    @staticmethod
    def _breaker_row(row: Any) -> dict[str, Any] | None:
        if row is None:
            return None
        return {"provider": row[0], "open_until": row[1], "reason": row[2],
                "failures": row[3], "window_start": row[4], "opens": row[5],
                "updated_at": row[6]}

    def breaker(self, provider: str) -> taskq.Breaker:
        with self._db.connection() as conn:
            row = conn.execute(
                f"SELECT {self._BREAKER_COLS} FROM provider_state "
                "WHERE provider = %s", (provider,)).fetchone()
        return taskq.breaker_from_row(provider, self._breaker_row(row))

    def update_breaker(self, provider: str,
                       fn: Callable[[taskq.Breaker], taskq.Breaker | None]
                       ) -> taskq.Breaker:
        with self._db.connection() as conn:
            conn.execute("INSERT INTO provider_state (provider) VALUES (%s) "
                         "ON CONFLICT (provider) DO NOTHING", (provider,))
            row = conn.execute(
                f"SELECT {self._BREAKER_COLS} FROM provider_state "
                "WHERE provider = %s FOR UPDATE", (provider,)).fetchone()
            cur = taskq.breaker_from_row(provider, self._breaker_row(row))
            new = fn(cur)
            if new is None:
                return cur
            conn.execute(
                "UPDATE provider_state SET open_until = %s, reason = %s, "
                "failures = %s, window_start = %s, opens = %s, "
                "updated_at = %s WHERE provider = %s",
                (pg._dt(new.open_until), new.reason, new.failures,
                 pg._dt(new.window_start), new.opens,
                 pg._dt(new.updated_at or time.time()), provider))
        return new

    def _truncate_for_tests(self) -> None:
        with self._db.connection() as conn:
            conn.execute("TRUNCATE tasks, provider_state, queue_positions")


class _Answer(Exception):
    """Internal: leave the transaction (rolled back) with this answer."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# ── leader election ──────────────────────────────────────────────────

LEADER_KEY = "cleo:leader"


def direct_url() -> str:
    """DATABASE_DIRECT_URL (a session-mode connection, not through a
    transaction pooler: advisory locks and LISTEN need one), default
    DATABASE_URL."""
    return (os.environ.get("DATABASE_DIRECT_URL", "").strip()
            or db.database_url())


class LeaderLock:
    """The leader's own connection: pg_try_advisory_lock on
    hashtext('cleo:leader') and LISTEN cleo_tasks. Session-level: the
    lock lives exactly as long as this connection."""

    def __init__(self, url: str | None = None) -> None:
        self.url = url or direct_url()
        self.conn: psycopg.Connection | None = None

    def _connect(self) -> psycopg.Connection:
        return psycopg.connect(
            self.url, autocommit=True, prepare_threshold=None,
            connect_timeout=pg.CONNECT_TIMEOUT_S,
            application_name="cleo-leader", keepalives=1,
            keepalives_idle=30, keepalives_interval=10, keepalives_count=3)

    def try_acquire(self) -> bool:
        """True once this connection holds the lock (and listens)."""
        try:
            if self.conn is None or self.conn.closed:
                self.conn = self._connect()
            got = self.conn.execute(
                "SELECT pg_try_advisory_lock(hashtext(%s))",
                (LEADER_KEY,)).fetchone()[0]
            if got:
                self.conn.execute("LISTEN cleo_tasks")
            return bool(got)
        except Exception:
            self.release()
            raise

    def alive(self) -> bool:
        """Is the connection (and with it the lock) still there?"""
        conn = self.conn
        if conn is None or conn.closed:
            return False
        try:
            conn.execute("SELECT 1").fetchone()
            return True
        except Exception:
            self.release()
            return False

    def wait(self, timeout: float) -> list[str]:
        """Notifications (their payloads: task kinds) within `timeout`
        seconds. Raises when the connection is gone."""
        conn = self.conn
        if conn is None or conn.closed:
            raise psycopg.OperationalError("leader connection closed")
        return [n.payload for n in conn.notifies(timeout=timeout,
                                                 stop_after=1)]

    def release(self) -> None:
        conn, self.conn = self.conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def open_leader_lock() -> LeaderLock:
    return LeaderLock()
