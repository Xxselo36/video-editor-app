"""WP4 task queue: the switch, its settings, the task row, the error
classes and the retry / circuit-breaker rules.

Shared by the task stores (backend/jobs.py SqliteTaskStore,
backend/pg_tasks.py PgTaskStore), the leader (backend/leader.py:
dispatcher, reaper, finalizer) and the worker (backend/worker.py).
stdlib only.

CLEO_TASK_QUEUE (default off) picks the path of a deployment:

  off  today's WP1 in-process path (analysis / render threads behind
       backend/main.py _SlotQueue / _Inflight), unchanged.
  on   POST /jobs and POST /render insert a durable task (Postgres or
       SQLite, in the same transaction as the job), one leader process
       (pg_try_advisory_lock; on SQLite the one process) dispatches it
       to an executor — `local`: a thread pool of the leader running
       backend/worker.py — and a reaper / finalizer settle what the
       workers report or leave behind (lease expiry after a crash).
"""
from __future__ import annotations

import json
import math
import os
import threading
from dataclasses import dataclass, field, fields
from typing import Any, Callable

KINDS = ("ingest", "render", "preview")
ACTIVE_STATES = ("queued", "dispatching", "running")
TERMINAL_STATES = ("succeeded", "failed", "dead", "cancelled")
STATES = ACTIVE_STATES + TERMINAL_STATES

# Payload / DB contract between whoever enqueues and the worker. A change
# bumps it; the worker accepts this and the previous one for a release
# (deploy skew, backend/worker.py).
WORKER_PROTOCOL = 1
# The Postgres schema version (backend/pg.py MIGRATIONS) that created the
# task tables; a worker on an older database fails retryably.
REQUIRED_SCHEMA = 5

PROVIDERS = ("groq", "anthropic", "modal")


# ── settings ─────────────────────────────────────────────────────────


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _float(name: str, default: float) -> float:
    try:
        return float(_env(name) or default)
    except ValueError:
        return float(default)


def _int(name: str, default: int) -> int:
    return int(_float(name, default))


def enabled() -> bool:
    """CLEO_TASK_QUEUE=1: the durable task queue instead of the WP1
    in-process path. Read on every call (a deployment sets it once; the
    tests switch it per test)."""
    return _env("CLEO_TASK_QUEUE").lower() in ("1", "true", "yes", "on")


def executor(kind: str) -> str:
    """CLEO_EXECUTOR_INGEST / _RENDER / _PREVIEW: `local` (default, also
    with MODAL_TOKEN_ID set — WP4 phase P0) or `modal` (phase P1: the
    Modal app backend/modal_app.py; refused while it isn't there)."""
    value = _env(f"CLEO_EXECUTOR_{kind.upper()}").lower() or "local"
    return value if value in ("local", "modal") else "local"


def running_limit(kind: str) -> int:
    """How many tasks of `kind` may be dispatched or running at once
    (CLEO_MAX_RUNNING_INGEST / _RENDER / _PREVIEW). The local executor
    defaults to the WP1 slot counts (CLEO_MAX_ANALYZE, default 2;
    CLEO_MAX_RENDER, default 4 with MODAL_TOKEN_ID else 2) so switching
    the queue on changes nothing about how much runs on this box."""
    override = _env(f"CLEO_MAX_RUNNING_{kind.upper()}")
    local = executor(kind) == "local"
    if kind == "ingest":
        default = _int("CLEO_MAX_ANALYZE", 2) if local else 16
    elif kind == "render":
        default = (_int("CLEO_MAX_RENDER",
                        4 if _env("MODAL_TOKEN_ID") else 2)
                   if local else 20)
    else:
        default = 8
    try:
        value = int(float(override)) if override else default
    except ValueError:
        value = default
    return max(1, value)


def max_queue() -> int:
    """CLEO_MAX_QUEUE: analyses that may wait beyond the running ones
    before POST /jobs answers 503 server_busy (default 20 with the local
    executor, 200 with Modal)."""
    return _int("CLEO_MAX_QUEUE", 200 if executor("ingest") == "modal" else 20)


def max_active_per_user() -> int:
    """CLEO_MAX_ACTIVE_PER_USER (default 2; 0 = no limit)."""
    return _int("CLEO_MAX_ACTIVE_PER_USER", 2)


_DEFAULT_OFFSETS = {"studio": -120.0, "pro": -60.0, "starter": 0.0,
                    "service": 600.0}


def priority_offset_s(plan: str | None, service: bool = False) -> float:
    """sort_at = now + this (CLEO_PRIORITY_OFFSETS_S, JSON): a time
    credit per plan — Studio jobs line up as if uploaded 2 min earlier,
    the service user (cost / load tests) yields by 10 min. Bounded, so
    nothing starves."""
    offsets = dict(_DEFAULT_OFFSETS)
    raw = _env("CLEO_PRIORITY_OFFSETS_S")
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for k, v in parsed.items():
                    offsets[str(k)] = float(v)
        except (ValueError, TypeError):
            pass
    key = "service" if service else (plan or "starter")
    try:
        return float(offsets.get(key, 0.0))
    except (TypeError, ValueError):
        return 0.0


def max_attempts() -> int:
    """CLEO_TASK_MAX_ATTEMPTS (default 3): counted attempts of a task
    (lease lost, infra failure) before it is dead."""
    return max(1, _int("CLEO_TASK_MAX_ATTEMPTS", 3))


def retry_backoff_s(attempts: int) -> float:
    """Wait before the next attempt after `attempts` counted ones
    (CLEO_TASK_RETRY_BACKOFF_S, default 30,120,600)."""
    raw = _env("CLEO_TASK_RETRY_BACKOFF_S") or "30,120,600"
    try:
        steps = [max(0.0, float(x)) for x in raw.split(",") if x.strip()]
    except ValueError:
        steps = [30.0, 120.0, 600.0]
    if not steps:
        return 0.0
    return steps[min(max(1, int(attempts)), len(steps)) - 1]


def start_timeout_s() -> float:
    """CLEO_START_TIMEOUT_S (300): a dispatched task no worker claimed
    within this is taken back by the reaper."""
    return max(1.0, _float("CLEO_START_TIMEOUT_S", 300.0))


def lease_s() -> float:
    """CLEO_TASK_LEASE_S (180): a running task without a heartbeat for
    this long is taken back by the reaper."""
    return max(1.0, _float("CLEO_TASK_LEASE_S", 180.0))


def heartbeat_s() -> float:
    """CLEO_TASK_HEARTBEAT_S (30): how often a worker renews its lease."""
    return max(0.05, _float("CLEO_TASK_HEARTBEAT_S", 30.0))


def reaper_grace_s() -> float:
    """CLEO_REAPER_GRACE_S (200): after taking over, the leader reaps
    nothing for this long — running workers get a full lease to
    heartbeat again after a database or leader outage."""
    return max(0.0, _float("CLEO_REAPER_GRACE_S", 200.0))


def provider_hold_s() -> float:
    """CLEO_PROVIDER_HOLD_S (1800): longest a task waits for a provider
    (Groq, Anthropic's spend limit, local disk) before it is given up."""
    return max(0.0, _float("CLEO_PROVIDER_HOLD_S", 1800.0))


def provider_retry_min_s() -> float:
    """CLEO_PROVIDER_RETRY_MIN_S (60): shortest wait of a task after a
    provider failure (the provider's retry-after when longer)."""
    return max(0.0, _float("CLEO_PROVIDER_RETRY_MIN_S", 60.0))


def render_hold_s() -> float:
    """CLEO_RENDER_HOLD_S (600): longest a render waits while the Modal
    breaker is open (modal executor only)."""
    return max(0.0, _float("CLEO_RENDER_HOLD_S", 600.0))


def llm_outage_policy() -> str:
    """CLEO_LLM_OUTAGE_POLICY: `hold` (default) — analyses wait for
    Anthropic's spend limit to lift, up to CLEO_PROVIDER_HOLD_S, then
    run without the LLM steps; `degrade` — run without them at once."""
    value = _env("CLEO_LLM_OUTAGE_POLICY").lower()
    return value if value in ("hold", "degrade") else "hold"


def groq_budget_s() -> float:
    """CLEO_GROQ_ASH_BUDGET (160000): audio-seconds per hour the ingest
    tasks started in the last hour may be estimated at (80 % of the
    Groq Developer tier's 200k)."""
    return max(0.0, _float("CLEO_GROQ_ASH_BUDGET", 160_000.0))


def est_audio_s(charged_s: float | None) -> float:
    """Estimated Groq audio-seconds of an analysis (two passes until the
    language is known, 10 s minimum per request, a request per 5 min)."""
    s = max(0.0, float(charged_s or 0.0))
    return float(math.ceil(s) * 2 + 10 * math.ceil(s / 300.0))


# ── in-process wake-ups ──────────────────────────────────────────────
# The stores call wake() after a task became queued and wake_finalizer()
# after one ended, once their transaction committed; a leader in this
# process (backend/leader.py) registers itself, so a new task doesn't
# wait for the next poll. Postgres also NOTIFYs other processes.

_wake_lock = threading.Lock()
_wakers: list[Callable[[str], None]] = []
_finalizer_wakers: list[Callable[[], None]] = []


def add_wakers(dispatch: Callable[[str], None],
               finalize: Callable[[], None]) -> None:
    with _wake_lock:
        _wakers.append(dispatch)
        _finalizer_wakers.append(finalize)


def remove_wakers(dispatch: Callable[[str], None],
                  finalize: Callable[[], None]) -> None:
    with _wake_lock:
        if dispatch in _wakers:
            _wakers.remove(dispatch)
        if finalize in _finalizer_wakers:
            _finalizer_wakers.remove(finalize)


def wake(kind: str) -> None:
    with _wake_lock:
        fns = list(_wakers)
    for fn in fns:
        try:
            fn(kind)
        except Exception:
            pass


def wake_finalizer() -> None:
    with _wake_lock:
        fns = list(_finalizer_wakers)
    for fn in fns:
        try:
            fn()
        except Exception:
            pass


# ── the task row ─────────────────────────────────────────────────────


@dataclass
class Task:
    """One row of `tasks`. Times are Unix floats on both databases."""
    id: int
    job_id: str
    kind: str
    state: str
    owner_id: str | None = None
    plan: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    sort_at: float = 0.0
    run_after: float = 0.0
    attempts: int = 0
    max_attempts: int = 3
    provider_waits: int = 0
    first_wait_at: float | None = None
    executor: str | None = None
    locked_by: str | None = None
    locked_until: float | None = None
    heartbeat_at: float | None = None
    modal_call_id: str | None = None
    started_at: float | None = None
    finished_at: float | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    last_error: str | None = None
    retryable: bool | None = None
    finalized_at: float | None = None
    created_at: float = 0.0
    updated_at: float = 0.0

    @property
    def active(self) -> bool:
        return self.state in ACTIVE_STATES


TASK_COLUMNS = tuple(f.name for f in fields(Task))


def _json(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        out = json.loads(value)
    except (TypeError, ValueError):
        return default
    return out if out is not None else default


def task_from_row(row: dict[str, Any]) -> Task:
    d = {k: row.get(k) for k in TASK_COLUMNS}
    d["payload"] = _json(d.get("payload"), {})
    if not isinstance(d["payload"], dict):
        d["payload"] = {}
    result = _json(d.get("result"), None)
    d["result"] = result if isinstance(result, dict) else None
    if d.get("retryable") is not None:
        d["retryable"] = bool(d["retryable"])
    for k in ("attempts", "max_attempts", "provider_waits"):
        d[k] = int(d.get(k) or 0)
    for k in ("sort_at", "run_after", "created_at", "updated_at"):
        d[k] = float(d.get(k) or 0.0)
    return Task(**d)


class TaskActive(Exception):
    """An active task of this (job, kind) exists already (the unique
    index tasks_one_active)."""


# ── error classes (task.error_code, task.retryable) ──────────────────
# The worker classifies a failure; the finalizer (backend/main.py via
# backend/leader.py) decides between another attempt, a provider wait
# and the job's terminal state. The job keeps today's client-facing
# codes (job.error_code); these are the task's.

CONTENT = "content"                  # the video's fault: no retry
CONTENT_NO_SPEECH = "content:no_speech"
CONTENT_NO_AUDIO = "content:no_audio"
REFUSED = "refused"                  # refused:<code> — the length gate
PROVIDER_GROQ = "provider:groq"
PROVIDER_ANTHROPIC = "provider:anthropic_spend"
TIMEOUT = "timeout"                  # the same input hits it again
INTERRUPTED = "interrupted"          # fenced out, cancelled, shut down
INFRA = "infra"                      # ours: OSError, R2 / DB, ffmpeg
SCHEMA_BEHIND = "schema_behind"
PROTOCOL_MISMATCH = "protocol_mismatch"
JOB_CHANGED = "job_changed"          # the job left 'processing' meanwhile
ATTEMPTS_EXHAUSTED = "attempts_exhausted"
PROVIDER_HOLD = "provider_hold"      # waited past CLEO_PROVIDER_HOLD_S
# Render outcomes keep the job codes they have today.
RENDER_FAILED = "render_failed"
RENDER_UNAVAILABLE = "render_unavailable"
RENDER_TIMEOUT = "render_timeout"

RETRYABLE_CODES = frozenset({INFRA, INTERRUPTED, SCHEMA_BEHIND,
                             PROTOCOL_MISMATCH, PROVIDER_GROQ,
                             PROVIDER_ANTHROPIC})


def is_provider(code: str | None) -> bool:
    return bool(code) and str(code).startswith("provider:")


# ── circuit breakers (provider_state) ────────────────────────────────


@dataclass
class Breaker:
    """One provider_state row."""
    provider: str
    open_until: float | None = None
    reason: str | None = None
    failures: int = 0
    window_start: float | None = None
    opens: int = 0
    updated_at: float = 0.0

    def state(self, now: float) -> str:
        """closed / open / half_open. Half-open: the open period is over
        but no success since — one task at a time probes the provider."""
        if self.open_until is not None and now < self.open_until:
            return "open"
        if self.opens > 0:
            return "half_open"
        return "closed"


BREAKER_WINDOW_S = 120.0
BREAKER_THRESHOLD = 5
BREAKER_BASE_S = 60.0
BREAKER_MAX_EXP = 4


def breaker_failure(b: Breaker, now: float, *,
                    retry_after_s: float | None = None,
                    open_for_s: float | None = None,
                    reason: str = "") -> tuple[Breaker, bool]:
    """Count one failure; returns (new state, opened now). Opens when
    `open_for_s` is given (a spend limit: that long), the provider asked
    for more than a minute (retry_after_s > 60 — Groq's hourly audio
    quota), BREAKER_THRESHOLD failures fell into BREAKER_WINDOW_S, or a
    half-open probe failed. Open for max(retry_after, 60 s × 2^opens),
    so repeated opens back off up to 16 min."""
    b = Breaker(**{f.name: getattr(b, f.name) for f in fields(Breaker)})
    half_open = b.state(now) == "half_open"
    if b.window_start is None or now - b.window_start > BREAKER_WINDOW_S:
        b.window_start, b.failures = now, 0
    b.failures += 1
    b.updated_at = now
    wait = float(retry_after_s or 0.0)
    should = (open_for_s is not None or wait > 60.0 or half_open
              or b.failures >= BREAKER_THRESHOLD)
    if not should:
        return b, False
    if b.state(now) == "open" and open_for_s is None and wait <= 60.0:
        return b, False  # already open: nothing to extend
    if open_for_s is not None:
        duration = float(open_for_s)
    else:
        duration = max(wait, BREAKER_BASE_S * 2 ** min(b.opens,
                                                        BREAKER_MAX_EXP))
    b.open_until = max(b.open_until or 0.0, now + duration)
    b.opens += 1
    b.failures = 0
    b.window_start = now
    b.reason = (reason or b.reason or "")[:500]
    return b, True


def breaker_success(b: Breaker, now: float) -> Breaker:
    """A task the provider served: closed again, backoff reset."""
    return Breaker(provider=b.provider, open_until=None, reason=None,
                   failures=0, window_start=None, opens=0, updated_at=now)


def breaker_from_row(provider: str, row: dict[str, Any] | None) -> Breaker:
    if not row:
        return Breaker(provider=provider)
    return Breaker(
        provider=provider,
        open_until=(float(row["open_until"])
                    if row.get("open_until") is not None else None),
        reason=row.get("reason"),
        failures=int(row.get("failures") or 0),
        window_start=(float(row["window_start"])
                      if row.get("window_start") is not None else None),
        opens=int(row.get("opens") or 0),
        updated_at=float(row.get("updated_at") or 0.0))
