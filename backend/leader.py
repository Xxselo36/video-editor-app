"""WP4 leader: one process at a time dispatches and settles tasks.

Election: on Postgres a dedicated connection (backend/pg_tasks.py
LeaderLock, DATABASE_DIRECT_URL or DATABASE_URL) holding
pg_try_advisory_lock(hashtext('cleo:leader')) and LISTENing on
cleo_tasks — retried every 5 s while another process leads; losing the
connection is losing leadership (every loop stops, then contends again).
On SQLite the one process leads (a process-local lock, so two Leader
objects in one process still elect one).

Loops, each only while leading, each wrapped so one failure doesn't stop
the others:

  dispatcher  NOTIFY / in-process wake, else every 1 s: per kind the free
              slots (CLEO_MAX_RUNNING_*), the gates (Groq breaker and
              audio budget, Anthropic hold, local disk), the claim
              (SKIP LOCKED), the spawn outside the transaction — the
              `local` executor: a thread of this process running
              backend/worker.py — and the queue positions.
  reaper      every 15 s, once the leader has led CLEO_REAPER_GRACE_S:
              leases that ran out (a worker that died, a dispatch nobody
              claimed) → requeue with backoff, or dead; tasks held past
              CLEO_PROVIDER_HOLD_S → dead.
  finalizer   every 2 s / woken: terminal tasks → the job's state,
              refunds and true-ups, media GC and the job event
              (LeaderOps, backend/main.py), then finalized_at — the event
              in the same transaction, so exactly once.
  periodic    the maintenance jobs of LeaderOps (retention, media GC,
              orphan sweep, backfill, Postgres backup, Lemon Squeezy
              reconcile) on their schedules.

stdlib only (psycopg lives in backend/pg_tasks.py).
"""
from __future__ import annotations

import os
import socket
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from backend import db, jobs, taskq

DISPATCH_PERIOD_S = 1.0
REAPER_PERIOD_S = 15.0
FINALIZER_PERIOD_S = 2.0
ELECTION_RETRY_S = 5.0
KINDS = ("ingest", "render")


class ConfigError(RuntimeError):
    """The queue's settings can't work (e.g. an executor this release
    doesn't have): don't start."""


def check_config() -> None:
    """Refuse CLEO_EXECUTOR_*=modal where this release has no Modal
    executor (phase P1 has one for ingest only — renders already run on
    Modal from the local executor, pipeline.render_to_keys) or its
    prerequisites are missing (backend/executor_modal.py check_config:
    media in R2, Modal credentials). The local executor is no silent
    fallback."""
    for kind in KINDS:
        if taskq.executor(kind) != "modal":
            continue
        kinds = _modal_kinds()
        if kind not in kinds:
            raise ConfigError(
                f"CLEO_EXECUTOR_{kind.upper()}=modal, but this release runs "
                f"only {', '.join(kinds) or 'nothing'} as Modal tasks "
                "(WP4 phase P1) — use local")
        from backend import executor_modal
        try:
            executor_modal.check_config()
        except ValueError as e:
            raise ConfigError(str(e)) from e


def _modal_kinds() -> tuple[str, ...]:
    """The task kinds the Modal executor runs (none without it)."""
    try:
        from backend import executor_modal
    except ImportError:
        return ()
    return tuple(executor_modal.KINDS)


class LeaderOps(Protocol):
    """What the leader needs from the API side (backend/main.py)."""

    def on_leadership(self) -> None: ...
    def finalize_success(self, task: taskq.Task) -> tuple | None: ...
    def finalize_terminal(self, task: taskq.Task) -> tuple | None: ...
    def run_local(self, task: taskq.Task,
                  stop: threading.Event) -> None: ...
    def local_room(self, tasks: list[taskq.Task]) -> int: ...
    def periodic(self) -> list["Periodic"]: ...


@dataclass
class Periodic:
    """A maintenance job: fn() every period_s, the first run first_s
    after leadership began."""
    name: str
    period_s: float
    fn: Callable[[], Any]
    first_s: float = 0.0


def _log(line: str) -> None:
    print(line, flush=True)


def _log_error(line: str) -> None:
    print(line, flush=True)
    import logging
    logging.getLogger("backend.leader").error(line)


# ── election ─────────────────────────────────────────────────────────


class _ProcessLock:
    """SQLite: one process, so it leads; two Leader objects in it still
    elect exactly one."""
    _held = threading.Lock()

    def __init__(self) -> None:
        self._mine = False
        self._ev = threading.Event()

    def try_acquire(self) -> bool:
        if not self._mine:
            self._mine = _ProcessLock._held.acquire(blocking=False)
        return self._mine

    def wait(self, timeout: float) -> list[str]:
        self._ev.wait(timeout)
        return []

    def alive(self) -> bool:
        return self._mine

    def release(self) -> None:
        if self._mine:
            self._mine = False
            try:
                _ProcessLock._held.release()
            except RuntimeError:
                pass
        self._ev.set()


def default_lock() -> Any:
    if db.is_postgres():
        from backend import pg_tasks
        return pg_tasks.open_leader_lock()
    return _ProcessLock()


# ── local executor ───────────────────────────────────────────────────


class LocalExecutor:
    """Runs task attempts in threads of this process (one per task; the
    dispatcher keeps the count under CLEO_MAX_RUNNING_*)."""

    def __init__(self, kind: str,
                 run: Callable[[taskq.Task, threading.Event], None]) -> None:
        self.kind = kind
        self._run_fn = run
        self._lock = threading.Lock()
        self._running: dict[int, tuple[threading.Thread, threading.Event]] = {}
        self._closed = False

    def spawn(self, task: taskq.Task) -> None:
        stop = threading.Event()
        th = threading.Thread(target=self._run, args=(task, stop),
                              name=f"task-{self.kind}-{task.id}", daemon=True)
        with self._lock:
            if self._closed:
                raise RuntimeError("executor is shutting down")
            self._running[task.id] = (th, stop)
        try:
            th.start()
        except BaseException:
            with self._lock:
                self._running.pop(task.id, None)
            raise

    def _run(self, task: taskq.Task, stop: threading.Event) -> None:
        try:
            self._run_fn(task, stop)
        except Exception as e:
            _log(f"[worker] task {task.id} ({task.kind} of job "
                 f"{task.job_id}) crashed: {type(e).__name__}: {e}\n"
                 f"{traceback.format_exc()}")
        finally:
            with self._lock:
                self._running.pop(task.id, None)

    def running(self) -> int:
        with self._lock:
            return len(self._running)

    def shutdown(self, grace_s: float) -> int:
        """No new tasks; wait up to grace_s for the running ones, then
        ask them to stop (they report `interrupted` and are retried by
        the next leader). Returns how many were still running."""
        with self._lock:
            self._closed = True
        deadline = time.monotonic() + max(0.0, grace_s)
        while self.running() and time.monotonic() < deadline:
            time.sleep(0.05)
        with self._lock:
            left = list(self._running.values())
        for _th, stop in left:
            stop.set()
        end = time.monotonic() + 10.0
        for th, _stop in left:
            th.join(max(0.0, end - time.monotonic()))
        return len(left)


# ── the leader ───────────────────────────────────────────────────────


class Leader:
    def __init__(self, ops: LeaderOps, *, name: str | None = None,
                 lock: Any = None,
                 kinds: Callable[[], tuple[str, ...]] | None = None) -> None:
        self.ops = ops
        # The kinds this leader dispatches (and shows positions for);
        # default all. The tests use it to leave analyses queued, like
        # the WP1 path's stubbed analysis thread.
        self.kinds = kinds or (lambda: KINDS)
        self.id = name or (f"leader:{socket.gethostname()}:{os.getpid()}:"
                           f"{uuid.uuid4().hex[:6]}")
        self._lock = lock
        self._stop = threading.Event()
        self._leading = threading.Event()
        self._dispatch_wake = threading.Event()
        self._finalize_wake = threading.Event()
        self._threads: list[threading.Thread] = []
        self.leader_since: float | None = None   # monotonic
        self._pos_sig: tuple | None = None
        self._holding: dict[str, str] = {}
        self._disk_held = False
        self._executors: dict[str, LocalExecutor] = {
            kind: LocalExecutor(kind, ops.run_local) for kind in KINDS}
        self._errors: dict[str, float] = {}
        self._periodic_due: dict[str, float] = {}

    # ── lifecycle ────────────────────────────────────────────────────

    def start(self) -> "Leader":
        if self._lock is None:
            self._lock = default_lock()
        taskq.add_wakers(self._on_wake, self._on_finalize_wake)
        for name, fn in (("election", self._elect_loop),
                         ("dispatcher", self._dispatch_loop),
                         ("reaper", self._reap_loop),
                         ("finalizer", self._finalize_loop),
                         ("periodic", self._periodic_loop)):
            th = threading.Thread(target=fn, name=f"leader-{name}",
                                  daemon=True)
            th.start()
            self._threads.append(th)
        return self

    def stop(self, grace_s: float = 0.0) -> int:
        """Stop leading: no dispatch any more, running local tasks get
        grace_s to finish (then they are interrupted and retried by the
        next leader), the lock is released. Returns how many local tasks
        were still running at the deadline."""
        self._stop.set()
        self._dispatch_wake.set()
        self._finalize_wake.set()
        left = 0
        for ex in self._executors.values():
            left += ex.shutdown(grace_s)
        # One last pass: what the interrupted workers reported is
        # settled (requeued) now rather than by the next leader.
        if self._leading.is_set():
            try:
                self.finalize_once()
            except Exception:
                pass
        self._leading.clear()
        taskq.remove_wakers(self._on_wake, self._on_finalize_wake)
        # Releasing the lock also wakes the election thread's wait.
        if self._lock is not None:
            self._lock.release()
        for th in self._threads:
            th.join(5.0)
        return left

    @property
    def leading(self) -> bool:
        return self._leading.is_set()

    def wait_leading(self, timeout: float) -> bool:
        return self._leading.wait(timeout)

    def _on_wake(self, kind: str) -> None:
        self._dispatch_wake.set()

    def _on_finalize_wake(self) -> None:
        self._finalize_wake.set()

    def _once_per(self, key: str, period_s: float) -> bool:
        now = time.monotonic()
        if now - self._errors.get(key, float("-inf")) < period_s:
            return False
        self._errors[key] = now
        return True

    def _guard(self, what: str, fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except Exception as e:
            if self._once_per(what, 60.0):
                _log(f"[leader] {what} failed: {type(e).__name__}: {e}\n"
                     f"{traceback.format_exc()}")
            return None

    # ── election ─────────────────────────────────────────────────────

    def _elect_loop(self) -> None:
        while not self._stop.is_set():
            if not self._leading.is_set():
                try:
                    got = self._lock.try_acquire()
                except Exception as e:
                    got = False
                    if self._once_per("election", 60.0):
                        _log(f"[leader] can't reach the database to "
                             f"contend for leadership: {e}")
                if not got:
                    self._stop.wait(ELECTION_RETRY_S)
                    continue
                if self._stop.is_set():   # stop() raced with this
                    self._lock.release()
                    break
                self.leader_since = time.monotonic()
                self._periodic_due.clear()
                self._pos_sig = None
                self._leading.set()
                _log(f"[leader] {self.id} leads (dispatcher, reaper, "
                     f"finalizer, maintenance); executors ingest="
                     f"{taskq.executor('ingest')} render="
                     f"{taskq.executor('render')}")
                self._guard("taking over (stuck jobs)",
                            self.ops.on_leadership)
                self._dispatch_wake.set()
                self._finalize_wake.set()
            try:
                if self._lock.wait(DISPATCH_PERIOD_S):
                    self._dispatch_wake.set()
            except Exception as e:
                if self._stop.is_set():
                    break
                _log_error(f"[leader] LEADERSHIP LOST ({self.id}): "
                           f"{type(e).__name__}: {e} — loops stopped, "
                           "contending again")
                self._leading.clear()
                self.leader_since = None
                try:
                    self._lock.release()
                except Exception:
                    pass
                self._stop.wait(ELECTION_RETRY_S)

    # ── dispatcher ───────────────────────────────────────────────────

    def _dispatch_loop(self) -> None:
        while not self._stop.is_set():
            self._dispatch_wake.wait(DISPATCH_PERIOD_S)
            self._dispatch_wake.clear()
            if self._stop.is_set() or not self._leading.is_set():
                continue
            self._guard("dispatch", self.dispatch_once)

    def dispatch_once(self) -> dict[str, int]:
        """One tick: dispatch what the limits and gates allow, per kind,
        then refresh the queue positions. Returns {kind: dispatched}."""
        ts = jobs.task_store()
        now = time.time()
        out: dict[str, int] = {}
        holds: dict[str, str] = {}
        self._disk_held = False
        for kind in self.kinds():
            n, hint = self._dispatch_kind(ts, kind, now)
            out[kind] = n
            if hint:
                holds[kind] = hint
        self._holding = holds
        self.update_positions(ts, holds)
        return out

    def _dispatch_kind(self, ts: Any, kind: str,
                       now: float) -> tuple[int, str | None]:
        executor = taskq.executor(kind)
        queued, active = ts.counts(kind)
        if queued == 0:
            return 0, None
        free = taskq.running_limit(kind) - active
        if free <= 0:
            return 0, None
        hint: str | None = None
        created_before: float | None = None
        if kind == "ingest":
            groq = ts.breaker("groq").state(now)
            if groq == "open":
                return 0, "capacity"
            if groq == "half_open":
                free = min(free, 1 if active == 0 else 0)
            llm = ts.breaker("anthropic").state(now)
            if llm == "open" and taskq.llm_outage_policy() == "hold":
                # Only analyses that waited past the hold go on (without
                # the LLM steps, backend/worker.py); the others wait.
                created_before = now - taskq.provider_hold_s()
                hint = "capacity"
            elif llm == "half_open":
                free = min(free, 1 if active == 0 else 0)
            if free <= 0:
                return 0, "capacity"
            head = ts.queued(kind, limit=free)
            budget = taskq.groq_budget_s()
            if budget > 0 and head:
                used = ts.groq_window_s(now - 3600.0)
                allowed = 0
                for t in head:
                    est = float(t.payload.get("est_audio_s") or 0.0)
                    # (one task always fits an empty window, however big)
                    if used + est > budget and (allowed or used > 0):
                        break
                    used += est
                    allowed += 1
                if allowed < len(head):
                    hint = "capacity"
                    if self._once_per("groq-budget", 300.0):
                        _log(f"[groq] audio budget: {used:.0f} of "
                             f"{budget:.0f} audio-s used in the last hour — "
                             "analyses wait (CLEO_GROQ_ASH_BUDGET)")
                free = min(free, allowed)
                head = head[:allowed]
            if executor == "local" and head:
                room = self.ops.local_room(head)
                if room < len(head):
                    hint = "capacity"
                    self._disk_held = True
                free = min(free, room)
        if free <= 0:
            return 0, hint
        claimed = ts.claim_for_dispatch(kind, free, self.id,
                                        taskq.start_timeout_s(), executor,
                                        created_before=created_before)
        for task in claimed:
            self._spawn(ts, task)
        return len(claimed), hint

    def _spawn(self, ts: Any, task: taskq.Task) -> None:
        """Outside the claim's transaction. A spawn that fails never ran:
        back to the queue without spending the attempt (attempts itself
        is never lowered — it is the fencing token)."""
        try:
            self._executors[task.kind].spawn(task)
        except Exception as e:
            _log(f"[leader] starting task {task.id} ({task.kind} of job "
                 f"{task.job_id}) failed: {type(e).__name__}: {e} — "
                 "back to the queue")
            ts.requeue(task.id, expect_states=("dispatching",),
                       attempts=task.attempts, delay_s=10.0, free=True,
                       error_code=taskq.INFRA,
                       last_error=f"spawn failed: {e}")

    def update_positions(self, ts: Any,
                         holds: dict[str, str] | None = None) -> bool:
        """queue_positions = the queued tasks' places per kind (1-based,
        dispatch order), with hint 'capacity' where a gate holds them.
        Written only when something changed. True if written."""
        holds = holds or {}
        rows: list[tuple[str, str, int, str | None]] = []
        seen: dict[str, int] = {}
        kinds = self.kinds()
        for t in ts.queued():
            if t.kind not in kinds:
                continue
            seen[t.kind] = seen.get(t.kind, 0) + 1
            rows.append((t.job_id, t.kind, seen[t.kind], holds.get(t.kind)))
        sig = tuple(rows)
        if sig == self._pos_sig:
            return False
        ts.write_positions(rows)
        self._pos_sig = sig
        return True

    # ── reaper ───────────────────────────────────────────────────────

    def _reap_loop(self) -> None:
        while not self._stop.wait(REAPER_PERIOD_S):
            if self._leading.is_set():
                self._guard("reaper", self.reap_once)

    def reap_once(self, force: bool = False) -> int:
        """Requeue (or bury) tasks whose lease ran out, and give up tasks
        held longer than their hold. Not within CLEO_REAPER_GRACE_S of
        taking over (unless force): running workers get a full lease to
        heartbeat again. Returns how many tasks it moved."""
        since = self.leader_since
        if not force and (since is None or time.monotonic() - since
                          < taskq.reaper_grace_s()):
            return 0
        ts = jobs.task_store()
        moved = 0
        now = time.time()
        for t in ts.expired(now):
            what = ("never claimed by a worker" if t.state == "dispatching"
                    else "no heartbeat")
            new = ts.requeue(
                t.id, expect_states=("dispatching", "running"),
                attempts=t.attempts,
                delay_s=taskq.retry_backoff_s(t.attempts),
                error_code="lease_expired",
                last_error=f"lease expired ({what}; {t.locked_by})",
                expired_before=now)
            if new is None:
                continue
            moved += 1
            line = (f"[reaper] task {t.id} ({t.kind} of job {t.job_id}, "
                    f"attempt {t.attempts}/{t.max_attempts}): lease expired "
                    f"({what}) → {new}")
            (_log_error if new == "dead" else _log)(line)
        moved += self._expire_held(ts, now)
        return moved

    def _expire_held(self, ts: Any, now: float) -> int:
        hold = taskq.provider_hold_s()
        n = 0
        if ts.breaker("groq").state(now) == "open":
            for t in ts.expire_held("ingest", now - hold,
                                    taskq.PROVIDER_HOLD,
                                    "waited for Groq (breaker open) longer "
                                    f"than {hold:.0f} s"):
                n += 1
                _log_error(f"[groq] task {t.id} (job {t.job_id}) given up "
                           f"after waiting {hold:.0f} s for Groq")
        if self._disk_held:
            for t in ts.expire_held("ingest", now - hold,
                                    taskq.PROVIDER_HOLD,
                                    "server_storage_full: waited for disk "
                                    f"space longer than {hold:.0f} s"):
                n += 1
                _log_error(f"[leader] task {t.id} (job {t.job_id}) given "
                           f"up after waiting {hold:.0f} s for disk space")
        return n

    # ── finalizer ────────────────────────────────────────────────────

    def _finalize_loop(self) -> None:
        while not self._stop.is_set():
            self._finalize_wake.wait(FINALIZER_PERIOD_S)
            self._finalize_wake.clear()
            if self._stop.is_set() or not self._leading.is_set():
                continue
            self._guard("finalizer", self.finalize_once)

    def finalize_once(self, limit: int = 50) -> int:
        """Settle the terminal tasks (oldest first). A task whose
        side effects fail stays unfinalized and is tried again next
        tick (they are idempotent). Returns how many were settled."""
        ts = jobs.task_store()
        n = 0
        for t in ts.unfinalized(limit):
            try:
                if self._finalize(ts, t):
                    n += 1
            except Exception as e:
                if self._once_per(f"finalize:{t.id}", 60.0):
                    _log(f"[finalizer] task {t.id} ({t.kind} of job "
                         f"{t.job_id}) not settled yet: "
                         f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
        return n

    def _finalize(self, ts: Any, t: taskq.Task) -> bool:
        if t.state == "succeeded":
            event = self.ops.finalize_success(t)
            return ts.mark_finalized(t.id, event=event)
        if t.state == "failed" and t.retryable:
            if taskq.is_provider(t.error_code):
                return self._provider_wait(ts, t)
            new = ts.requeue(t.id, expect_states=("failed",),
                             attempts=t.attempts,
                             delay_s=taskq.retry_backoff_s(t.attempts),
                             free=(t.result or {}).get("free_retry") is True)
            if new is not None:
                _log(f"[finalizer] task {t.id} ({t.kind} of job {t.job_id}) "
                     f"failed ({t.error_code}: {(t.last_error or '')[:200]})"
                     f" → {new}"
                     + (f", attempt {t.attempts + 1} in "
                        f"{taskq.retry_backoff_s(t.attempts):.0f} s"
                        if new == "queued" else ""))
            return new is not None
        event = self.ops.finalize_terminal(t)
        return ts.mark_finalized(t.id, event=event)

    def _provider_wait(self, ts: Any, t: taskq.Task) -> bool:
        """A provider failure: the breaker learns about it, the task
        waits (run_after = now + max(retry_after, 60 s)) without spending
        an attempt — or, waiting past CLEO_PROVIDER_HOLD_S, is given up
        (dead: the finalizer then refunds)."""
        now = time.time()
        provider = (t.error_code or "provider:").split(":", 1)[1] or "?"
        provider = "anthropic" if provider.startswith("anthropic") else provider
        retry_after = float((t.result or {}).get("retry_after_s") or 0.0)
        note_provider_failure(ts, provider, retry_after_s=retry_after,
                              reason=t.last_error or t.error_code or "",
                              spend_limit=provider == "anthropic")
        waited_since = t.first_wait_at or now
        if now - waited_since > taskq.provider_hold_s():
            new = ts.requeue(t.id, expect_states=("failed",),
                             attempts=t.attempts, dead=True,
                             error_code=taskq.PROVIDER_HOLD,
                             last_error=(f"gave up waiting for {provider} "
                                         f"after {now - waited_since:.0f} s: "
                                         f"{t.last_error or ''}"))
            if new is not None:
                _log_error(f"[{provider}] task {t.id} (job {t.job_id}) given "
                           f"up after waiting {now - waited_since:.0f} s")
            return new is not None
        wait = max(retry_after, taskq.provider_retry_min_s())
        new = ts.requeue(t.id, expect_states=("failed",),
                         attempts=t.attempts, delay_s=wait, free=True,
                         provider_wait=True)
        if new is not None:
            _log(f"[{provider}] task {t.id} (job {t.job_id}) waits "
                 f"{wait:.0f} s for {provider} "
                 f"({(t.last_error or '')[:160]})")
        return new is not None

    # ── maintenance ──────────────────────────────────────────────────

    def _periodic_loop(self) -> None:
        while not self._stop.wait(1.0):
            if not self._leading.is_set() or self.leader_since is None:
                continue
            now = time.monotonic()
            for job in self.ops.periodic():
                due = self._periodic_due.get(job.name)
                if due is None:
                    due = self.leader_since + job.first_s
                    self._periodic_due[job.name] = due
                if now < due or self._stop.is_set():
                    continue
                self._periodic_due[job.name] = now + job.period_s
                self._guard(job.name, job.fn)


# ── provider breakers ────────────────────────────────────────────────


def note_provider_failure(ts: Any, provider: str, *,
                          retry_after_s: float | None = None,
                          reason: str = "", spend_limit: bool = False
                          ) -> taskq.Breaker:
    """Count a failure of `provider` (provider_state) and open its
    breaker by taskq.breaker_failure's rules; an Anthropic spend limit
    opens it for an hour. Logs the opening at ERROR."""
    opened = [False]
    now = time.time()

    def fn(b: taskq.Breaker) -> taskq.Breaker:
        new, did = taskq.breaker_failure(
            b, now, retry_after_s=retry_after_s,
            open_for_s=3600.0 if spend_limit else None, reason=reason)
        opened[0] = did
        return new
    b = ts.update_breaker(provider, fn)
    if opened[0]:
        until = time.strftime("%H:%M:%SZ", time.gmtime(b.open_until or now))
        if provider == "anthropic":
            _log_error(f"[llm] SPEND LIMIT REACHED — breaker open until "
                       f"{until}: analyses wait (CLEO_LLM_OUTAGE_POLICY="
                       f"{taskq.llm_outage_policy()}), renders skip hooks "
                       f"and captions ({reason[:200]})")
        elif provider == "modal":
            _log_error(f"[modal] UNAVAILABLE — breaker open until {until} "
                       f"({reason[:200]})")
        else:
            _log_error(f"[{provider}] BREAKER OPEN until {until} (open "
                       f"#{b.opens}; {reason[:200]})")
    return b


def note_provider_success(ts: Any, provider: str) -> None:
    """A task the provider served: its breaker closes, backoff reset."""
    now = time.time()

    def fn(b: taskq.Breaker) -> taskq.Breaker | None:
        if b.opens == 0 and b.failures == 0 and b.open_until is None:
            return None
        if b.state(now) == "open":
            return None   # an older task: doesn't prove it is back
        _log(f"[{provider}] breaker closed (the provider served a task)")
        return taskq.breaker_success(b, now)
    ts.update_breaker(provider, fn)
