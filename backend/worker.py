"""WP4 worker: one attempt of one task. The same code for the `local`
executor (a thread of the leader, backend/leader.py) and — from phase
P1 — a Modal function.

  1. Claim, fenced by the task's attempts: no row → fenced out, done.
  2. Deploy skew: a payload protocol other than WORKER_PROTOCOL − 1 / ,
     or a database schema older than taskq.REQUIRED_SCHEMA → a retryable
     failure (and an ERROR line).
  3. Heartbeat thread: renews the lease every CLEO_TASK_HEARTBEAT_S. A
     heartbeat that finds the task taken away (requeued after a lost
     lease, re-claimed, its job deleted) cancels the work; a database
     that doesn't answer is ridden out — never aborted on connectivity
     alone.
  4. Workspace <CLEO_TMP_ROOT>/jobs/{job}/a{attempt} (render:
     render-a{attempt}), wiped at the start, removed at the end.
  5. The work — ingest: fetch the upload, the length gate (charged here
     when POST /jobs couldn't know the length), analyze_only, store
     mezz / proxy / preview; render: pipeline.render_to_keys (today's
     render, on Modal when configured) with the post caption written
     next to it. The fence is checked again before every upload.
  6. Progress: at most one write a second, merged into the job row, only
     while it is 'processing' (never after a terminal status).
  7. Commit: the task succeeded AND the job's new state (awaiting_review
     / done) in one transaction, only while this attempt holds the task.
     Fenced out → nothing written, nothing deleted: every attempt writes
     the same keys, and the winner's rows point at them.
  8. Failure: the error class (backend/taskq.py) and what the finalizer
     needs (the job's message and code, refund or not, the processed
     length) — the worker never writes a job's error state; the
     finalizer decides between another attempt and the end.

The heavy steps are looked up through bind() — the local executor binds
the API process's own functions (backend/main.py), so the queue runs the
very code the WP1 path runs.
"""
from __future__ import annotations

import inspect
import json
import math
import os
import random
import shutil
import socket
import subprocess
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from backend import costs, db, errors, jobs, llm, media, taskq
from backend import doc as edit_doc
from backend import uploads as upl

WORKER_PROTOCOL = taskq.WORKER_PROTOCOL


# ── what the worker calls ────────────────────────────────────────────


def _default_analyze_only() -> Callable[..., dict]:
    from backend import pipeline
    return pipeline.analyze_only


def default_tmp_root() -> Path:
    """CLEO_TMP_ROOT, default <work root>/tmp (backend/main.py _TMP_ROOT)."""
    return Path(os.environ.get("CLEO_TMP_ROOT", "").strip()
                or str(media.work_root() / "tmp"))


def probe_duration(path: str) -> float | None:
    """Length of a local file in seconds (backend/main.py
    _probe_duration: the header, else the last packet's timestamp)."""
    from src.ffmpeg_utils import get_ffprobe_path
    ffprobe = get_ffprobe_path()

    def _run(args: list[str], timeout: float) -> str:
        try:
            r = subprocess.run([ffprobe, "-v", "error", *args, path],
                               capture_output=True, text=True,
                               timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return r.stdout if r.returncode == 0 else ""

    dur = _to_float(_run(["-show_entries", "format=duration", "-of",
                          "default=noprint_wrappers=1:nokey=1"], 30).strip())
    if dur > 0:
        return dur
    out = _run(["-show_entries", "packet=pts_time", "-of", "csv=p=0"], 180)
    dur = max((_to_float(line.strip().strip(","))
               for line in out.splitlines()), default=0.0)
    return dur if dur > 0 else None


_resolvers: dict[str, Callable[[], Any]] = {
    "analyze_only": _default_analyze_only,
    "probe_duration": lambda: probe_duration,
    "tmp_root": default_tmp_root,
}


def bind(**resolvers: Callable[[], Any]) -> None:
    """Replace what the worker calls: each value is a zero-argument
    function returning the implementation (looked up per call)."""
    _resolvers.update(resolvers)


def _get(name: str) -> Any:
    return _resolvers[name]()


def _pipeline() -> Any:
    from backend import pipeline
    return pipeline


# ── small helpers (the WP1 path has its own in backend/main.py) ──────


def _to_float(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if v == v else 0.0


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return float(default)


def _plain(n: float) -> float | int:
    return int(n) if float(n).is_integer() else n


def _max_minutes() -> float:
    return _env_float("CLEO_MAX_MINUTES", 30)


def _too_long(seconds: float | None) -> bool:
    return seconds is not None and seconds > _max_minutes() * 60 + 1


def _cap_settings(settings: dict) -> dict:
    minutes = _max_minutes()
    cap = minutes * 60 + 1 if minutes > 0 else None
    if cap is None:
        return settings
    try:
        cur = float(settings.get("_max_seconds") or 0) or None
    except (TypeError, ValueError):
        cur = None
    settings["_max_seconds"] = cap if cur is None else min(cur, cap)
    return settings


def _accepts(fn: Callable, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind is p.VAR_KEYWORD
                                 for p in params.values())


def _log(line: str) -> None:
    print(line, flush=True)


def _log_error(line: str) -> None:
    print(line, flush=True)
    import logging
    logging.getLogger("backend.worker").error(line)


def _capture(exc: BaseException, **tags: Any) -> None:
    try:
        from backend import observability
        observability.capture(exc, **tags)
    except Exception:
        pass


_DB_RETRY_S = 180.0
_DB_RETRY_DELAY_S = 1.0


def _db_retry(job_id: str, what: str, fn: Callable[..., Any], /,
              *args: Any, **kwargs: Any) -> Any:
    """fn(), tried again while the database is unavailable
    (db.is_transient) for up to _DB_RETRY_S."""
    deadline = time.monotonic() + _DB_RETRY_S
    delay = _DB_RETRY_DELAY_S
    while True:
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            left = deadline - time.monotonic()
            if not db.is_transient(e) or left <= 0:
                raise
            _log(f"[job {job_id}] {what}: database unavailable ({e}) — "
                 f"trying again for up to {left:.0f} s")
            time.sleep(min(delay, left))
            delay = min(delay * 2, 15.0)


class MediaTransferError(RuntimeError):
    """Fetching the upload / storing results failed: ours (refunded)."""


class AnalysisRefused(Exception):
    """The length gate refuses the upload before transcribing it."""

    def __init__(self, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.code = code
        self.params = extra   # the job's error_params
        self.text = (json.dumps({"detail": code, **extra},
                                separators=(",", ":"))
                     if extra else code)


class _SpendLimitHold(Exception):
    """Anthropic's spend limit during the analysis: the task waits
    (CLEO_LLM_OUTAGE_POLICY=hold) instead of committing a result without
    the LLM steps."""


class _SourceGone(FileNotFoundError):
    """The render source (mezz) is gone: rendering can't help."""


# ── progress ─────────────────────────────────────────────────────────


class ProgressWriter:
    """progress_cb of a task: at most one write per
    CLEO_PROGRESS_INTERVAL_S (1 s), the newest tick written when the
    interval ends, merged into the job (store.patch_status) only while
    it is 'processing' — so a late tick of a zombie attempt can never
    overwrite a result. close() before the commit."""

    def __init__(self, job_id: str, interval: float | None = None) -> None:
        self.job_id = job_id
        self.interval = (_env_float("CLEO_PROGRESS_INTERVAL_S", 1.0)
                         if interval is None else interval)
        self._lock = threading.Lock()
        self._last = float("-inf")
        self._pending: tuple[str, float] | None = None
        self._timer: threading.Timer | None = None
        self._closed = False

    def __call__(self, msg: str, pct: float) -> None:
        with self._lock:
            if self._closed:
                return
            self._pending = (msg, pct)
            wait = self._last + self.interval - time.monotonic()
            if wait > 0:
                if self._timer is None:
                    self._timer = threading.Timer(wait, self._flush)
                    self._timer.daemon = True
                    self._timer.start()
                return
        self._flush()

    def _flush(self) -> None:
        with self._lock:
            self._timer = None
            if self._closed or self._pending is None:
                return
            msg, pct = self._pending
            self._pending = None
            self._last = time.monotonic()
            # message, plus stage / stage_params for a StageMessage.
            fields: dict[str, Any] = errors.stage_fields(msg)
            if pct is not None and pct >= 0:
                fields["progress"] = pct
            try:
                jobs.store.patch_status(self.job_id, ("processing",),
                                        **fields)
            except Exception as e:
                _log(f"[job {self.job_id}] progress write failed: {e}")

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._pending = None
            timer, self._timer = self._timer, None
        if timer is not None:
            timer.cancel()


# ── one attempt ──────────────────────────────────────────────────────


def local_call_id() -> str:
    return (f"local:{socket.gethostname()}:{os.getpid()}:"
            f"{threading.get_ident()}")


class Attempt:
    """The claimed task of this run: fence, heartbeat, commit, failure."""

    def __init__(self, ts: Any, task: taskq.Task, call_id: str,
                 stop: threading.Event | None = None) -> None:
        self.ts = ts
        self.task = task
        self.call_id = call_id
        self.stop = stop or threading.Event()
        self.fenced = threading.Event()
        self._hb_stop = threading.Event()
        self._hb: threading.Thread | None = None
        self._db_down_logged = 0.0

    def cancelled(self) -> bool:
        """cancel_check of the pipeline: fenced out, or shutting down."""
        return self.fenced.is_set() or self.stop.is_set()

    # heartbeat / fence

    def beat(self) -> bool:
        """Renew the lease. False: fenced out (and the work is
        cancelled). A database error is not a fence: keep working."""
        t = self.task
        try:
            ok = self.ts.heartbeat(t.id, t.attempts, taskq.lease_s())
        except Exception as e:
            now = time.monotonic()
            if now - self._db_down_logged > 60:
                self._db_down_logged = now
                _log(f"[worker] task {t.id}: heartbeat failed ({e}) — "
                     "working on")
            return True
        if not ok and not self.fenced.is_set():
            self.fenced.set()
            _log(f"[worker] task {t.id} ({t.kind} of job {t.job_id}, "
                 f"attempt {t.attempts}) was taken away (lease lost, "
                 "re-dispatched or its job deleted) — stopping, "
                 "committing nothing")
        return ok

    def fence_ok(self) -> bool:
        """Before an upload: still ours?"""
        return self.beat() and not self.stop.is_set()

    def start_heartbeat(self) -> None:
        def loop() -> None:
            while not self._hb_stop.wait(taskq.heartbeat_s()):
                if not self.beat():
                    return
        self._hb = threading.Thread(target=loop, daemon=True,
                                    name=f"heartbeat-{self.task.id}")
        self._hb.start()

    def stop_heartbeat(self) -> None:
        self._hb_stop.set()
        if self._hb is not None:
            self._hb.join(5.0)

    # outcomes

    def fail(self, code: str, message: str, retryable: bool,
             result: dict[str, Any] | None = None) -> dict[str, Any]:
        t = self.task
        if self.fenced.is_set():
            return {"skipped": "fenced"}
        try:
            ok = _db_retry(t.job_id, "reporting the failure",
                           self.ts.report_failure, t.id, t.attempts, code,
                           message, retryable, result or {})
        except Exception as e:
            # The lease runs out; the reaper takes the task back.
            _log_error(f"[worker] task {t.id}: failure ({code}) could not "
                       f"be reported: {e} — the reaper retries it")
            return {"failed": code, "reported": False}
        if not ok:
            return {"skipped": "fenced"}
        return {"failed": code}

    def commit(self, result: dict[str, Any] | Callable[[], dict[str, Any]],
               job_expect: tuple[str, ...],
               job_change: dict[str, Any] | Callable[[Any], Any]) -> str:
        t = self.task
        first = [True]

        def attempt() -> str:
            out = self.ts.commit_success(t.id, t.attempts, result, t.job_id,
                                         job_expect, job_change)
            if out == "fenced" and not first[0]:
                # A retry after a commit whose answer got lost finds it.
                cur = self.ts.get(t.id)
                if (cur is not None and cur.state == "succeeded"
                        and cur.attempts == t.attempts):
                    return "ok"
            first[0] = False
            return out
        try:
            return _db_retry(t.job_id, "committing", attempt)
        except Exception as e:
            _log_error(f"[worker] task {t.id}: commit failed: {e} — the "
                       "reaper retries it")
            raise


def run(kind: str, task_id: int, job_id: str, attempt: int,
        v: int | None = None, *, call_id: str | None = None,
        stop: threading.Event | None = None) -> dict[str, Any]:
    """One attempt of task `task_id` (see the module doc). Returns what
    happened: {"committed": True}, {"failed": code} or {"skipped":
    "fenced"}."""
    ts = jobs.task_store()
    cid = call_id or local_call_id()
    task = _db_retry(job_id, "claiming", ts.worker_claim, task_id, attempt,
                     cid, taskq.lease_s())
    if task is None:
        _log(f"[worker] task {task_id} attempt {attempt}: fenced out before "
             "it started — nothing to do")
        return {"skipped": "fenced"}
    ctx = Attempt(ts, task, cid, stop)
    ctx.start_heartbeat()
    try:
        version = WORKER_PROTOCOL if v is None else int(v)
        if version not in (WORKER_PROTOCOL - 1, WORKER_PROTOCOL):
            line = (f"[worker] PROTOCOL MISMATCH: task {task_id} speaks "
                    f"v{version}, this worker v{WORKER_PROTOCOL - 1}–"
                    f"v{WORKER_PROTOCOL} (deploy skew)")
            _log_error(line)
            return ctx.fail(taskq.PROTOCOL_MISMATCH, line, True)
        schema = ts.schema_version()
        if schema < taskq.REQUIRED_SCHEMA:
            line = (f"[worker] SCHEMA BEHIND: the database is at v{schema}, "
                    f"this worker needs v{taskq.REQUIRED_SCHEMA}")
            _log_error(line)
            return ctx.fail(taskq.SCHEMA_BEHIND, line, True)
        if kind == "ingest":
            return _ingest(ctx)
        if kind == "render":
            return _render(ctx)
        return ctx.fail(taskq.INFRA, f"unknown task kind {kind!r}", False)
    except Exception as e:
        _log_error(f"[worker] task {task_id} ({kind} of job {job_id}): "
                   f"worker error {type(e).__name__}: {e}\n"
                   f"{traceback.format_exc()}")
        return ctx.fail(taskq.INFRA, f"worker error: {type(e).__name__}: {e}",
                        True)
    finally:
        ctx.stop_heartbeat()


# ── workspace ────────────────────────────────────────────────────────


def workspace(job_id: str, sub: str) -> Path:
    return Path(_get("tmp_root")) / "jobs" / job_id / sub


def _fresh(path: Path) -> Path:
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _drop(path: Path) -> None:
    """rmtree the attempt's folder, and the job's when that empties it."""
    shutil.rmtree(path, ignore_errors=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


# ── ingest ───────────────────────────────────────────────────────────


def llm_degraded(ctx: Attempt, render: bool = False) -> bool:
    """Leave the LLM steps out? While the `anthropic` breaker is open: a
    render always (hooks and captions are optional); an analysis with
    CLEO_LLM_OUTAGE_POLICY=degrade, or once it waited past
    CLEO_PROVIDER_HOLD_S. Half-open: the attempt probes normally."""
    if (ctx.task.payload or {}).get("degraded_llm"):
        return True
    try:
        b = ctx.ts.breaker("anthropic")
    except Exception:
        return False
    now = time.time()
    if b.state(now) != "open":
        return False
    if render or taskq.llm_outage_policy() == "degrade":
        return True
    return now - ctx.task.created_at > taskq.provider_hold_s()


def _fault_groq() -> None:
    """CLEO_FAULT_GROQ_429 (staging chaos, tests): 1 = every analysis,
    0.2 = one in five fails like a Groq 429 (retry-after
    CLEO_FAULT_GROQ_RETRY_AFTER, default 30 s)."""
    raw = os.environ.get("CLEO_FAULT_GROQ_429", "").strip()
    if not raw:
        return
    p = _to_float(raw)
    if p <= 0 or (p < 1 and random.random() >= p):
        return
    from backend.whisper_groq import GroqTranscriptionError
    err = GroqTranscriptionError("transcription_unavailable: Groq asked to "
                                 "retry (fault injected: CLEO_FAULT_GROQ_429)")
    err.retry_after_s = _env_float("CLEO_FAULT_GROQ_RETRY_AFTER", 30.0)
    raise err


def _length_gate(ctx: Attempt, job: Any, input_path: str,
                 progress: Callable[[str, float], None]) -> dict:
    """backend/main.py _length_gate, retry-safe: an upload POST /jobs
    couldn't measure is measured here (too long → refused), billed ones
    charged — once: an earlier attempt's charge (the usage row) counts."""
    settings = dict(job.settings or {})
    measure = bool(settings.pop("_measure_length", False))
    charge = settings.pop("_charge", None)
    changed: dict[str, Any] = {}
    if measure:
        progress(errors.stage_message("analyze.normalize",
                                      "Checking the video…"), 1)
        seconds = _get("probe_duration")(input_path)
        if _too_long(seconds):
            raise AnalysisRefused("video_too_long",
                                  max_minutes=_plain(_max_minutes()))
        if charge in ("enforce", "record") and job.owner_id:
            from backend import accounts
            enforce = charge == "enforce"
            if seconds is None and enforce:
                raise AnalysisRefused("unreadable_video")
            if accounts.get_usage(job.id) is None:
                email = None
                try:
                    email = (accounts.get_user(job.owner_id) or {}).get("email")
                except Exception:
                    pass
                try:
                    ent = accounts.charge(job.id, job.owner_id, seconds or 0.0,
                                          email=email, enforce=enforce)
                except accounts.SubscriptionRequired:
                    raise AnalysisRefused("subscription_required")
                except accounts.QuotaExceeded as e:
                    raise AnalysisRefused(
                        "quota_exceeded",
                        remaining_seconds=round(e.remaining_seconds),
                        needed_seconds=round(e.needed_seconds))
                if ent is not None:
                    changed["plan"] = ent.plan
            if enforce:
                settings["_max_seconds"] = (
                    math.ceil(max(seconds or 0.0, 0.0))
                    + accounts.TRUE_UP_TOLERANCE_S)
    _cap_settings(settings)
    if measure or charge or settings != (job.settings or {}):
        changed["settings"] = settings
    if changed:
        _db_retry(job.id, "saving the settings", jobs.store.update, job.id,
                  **changed)
    return settings


def _store_analysis(ctx: Attempt, job_id: str, res: dict,
                    progress: Callable[[str, float], None],
                    where: str) -> dict:
    """mezz / proxy / first preview into the job's store — the fence
    re-checked before every upload."""
    prefix = media.job_prefix(job_id)
    mezz = Path(res["normalized_path"])
    items = [(mezz, prefix + "mezz.mp4", "mezz_key")]
    proxy = mezz.with_name(jobs.LEGACY_PROXY_NAME)
    if proxy.is_file():
        items.append((proxy, prefix + "proxy.mp4", "proxy_key"))
    preview = res.get("preview_path")
    if preview and Path(preview).is_file():
        items.append((Path(preview), prefix + "preview/v1.mp4",
                      "preview_key"))
    fields: dict[str, Any] = {"media_bytes": {}, "media_store": where}
    for i, (path, key, field_name) in enumerate(items):
        progress(errors.stage_message("analyze.cuts", "Saving…"), 96 + i)
        if not ctx.fence_ok():
            raise InterruptedError("fenced out before storing results")
        try:
            size = media.put_file(path, key, content_type="video/mp4",
                                  store=where)
        except Exception as e:
            raise MediaTransferError(
                f"storing {key} failed: {type(e).__name__}: {e}") from e
        fields[field_name] = key
        fields["media_bytes"][key] = size

    def put(path: str, key: str, ctype: str) -> int:
        if not ctx.fence_ok():
            raise InterruptedError("fenced out before storing results")
        try:
            return media.put_file(path, key, content_type=ctype, store=where)
        except Exception as e:
            raise MediaTransferError(
                f"storing {key} failed: {type(e).__name__}: {e}") from e
    extra, sizes = _pipeline().store_analysis_extras(res, job_id, put)
    fields.update(extra)
    fields["media_bytes"].update(sizes)
    return fields


# Failure classification: the one catalogue in backend/errors.py (the
# WP1 path in backend/main.py uses the same functions).
_analysis_error_code = errors.analysis_error_code
_is_infra_failure = errors.is_infra_failure


def _refund_content_failure(exc: BaseException, code: str | None) -> bool:
    """errors.refund_content_failure with CLEO_NO_SPEECH_REFUND_S."""
    return errors.refund_content_failure(
        exc, code, _env_float("CLEO_NO_SPEECH_REFUND_S", 10.0))


def _processed_s(ws: Path) -> float | None:
    """The normalized file's length (a content failure's true-up)."""
    for name in ("normalized.mp4", "normalized_smartcam.mp4"):
        path = ws / name
        if path.exists():
            try:
                return _get("probe_duration")(str(path))
            except Exception as e:
                _log(f"[worker] duration probe failed: {e}")
                return None
    return None


def _ingest_failure(ctx: Attempt, exc: BaseException,
                    ws: Path) -> dict[str, Any]:
    t = ctx.task
    job_id = t.job_id
    if isinstance(exc, InterruptedError) and ctx.cancelled():
        if ctx.fenced.is_set():
            return {"skipped": "fenced"}
        _log(f"[job {job_id}] analysis interrupted (shutting down) — "
             "retried by the next leader")
        return ctx.fail(taskq.INTERRUPTED, "interrupted: shutting down", True,
                        {"free_retry": True})
    if isinstance(exc, AnalysisRefused):
        _log(f"[job {job_id}] refused before analysis: {exc.text}")
        return ctx.fail(f"{taskq.REFUSED}:{exc.code}", exc.text, False,
                        {"refused": exc.code, "text": exc.text,
                         "params": exc.params})
    tb = "".join(traceback.format_exception(type(exc), exc,
                                            exc.__traceback__))
    _log(f"[job {job_id}] ANALYZE FAILED (task {t.id}, attempt "
         f"{t.attempts}/{t.max_attempts}): {exc}\n{tb}")
    msg = str(exc)
    if "No space left on device" in msg:
        msg = "server_storage_full"
    job_code = _analysis_error_code(exc, msg)
    infra = _is_infra_failure(exc, msg) or isinstance(exc,
                                                      MediaTransferError)
    result: dict[str, Any] = {"message": msg[:300], "error": msg[:2000],
                              "job_code": job_code, "infra": bool(infra)}
    groq_error = None
    try:
        from backend.whisper_groq import GroqTranscriptionError
        groq_error = GroqTranscriptionError
    except Exception:
        pass
    if isinstance(exc, _SpendLimitHold):
        result.update(refund=True, infra=True, job_code=None)
        return ctx.fail(taskq.PROVIDER_ANTHROPIC,
                        f"anthropic spend limit: {exc}", True, result)
    if groq_error is not None and isinstance(exc, groq_error):
        result.update(refund=True,
                      retry_after_s=getattr(exc, "retry_after_s", None))
        return ctx.fail(taskq.PROVIDER_GROQ, msg, True, result)
    if type(exc).__name__ == "FunctionTimeoutError":
        result.update(refund=True)
        return ctx.fail(taskq.TIMEOUT, msg, False, result)
    _capture(exc, job_id=job_id, phase="analyze")
    if job_code == "no_speech":
        code, retryable = taskq.CONTENT_NO_SPEECH, False
    elif job_code == "no_audio":
        code, retryable = taskq.CONTENT_NO_AUDIO, False
    elif infra:
        code, retryable = taskq.INFRA, True
    else:
        code, retryable = taskq.CONTENT, False
    result["refund"] = bool(infra or _refund_content_failure(exc, job_code))
    if not retryable and not db.is_transient(exc):
        # Charged by what was really processed (before the files go).
        result["processed_s"] = _processed_s(ws)
    return ctx.fail(code, msg, retryable, result)


def _ingest(ctx: Attempt) -> dict[str, Any]:
    t = ctx.task
    job_id = t.job_id
    store = jobs.store
    job = _db_retry(job_id, "reading the job", store.get, job_id)
    if job is None or job.status not in ("pending", "processing"):
        # Settled meanwhile (e.g. by the WP1 boot after a rollback):
        # nothing to do for this task.
        return ctx.fail(taskq.JOB_CHANGED, "the job isn't waiting for its "
                        f"analysis ({job.status if job else 'gone'})", False)
    source_key = job.source_ref()
    input_path = (job.input_path if job.input_path
                  and Path(job.input_path).exists() else None)
    if not input_path and not source_key:
        return ctx.fail(taskq.INFRA, "the upload is gone", False,
                        {"refund": True, "infra": True,
                         "message": "Processing was interrupted. "
                                    "Please upload the video again.",
                         "error": "upload_missing"})
    where = media.store_of(job)
    _db_retry(job_id, "starting", store.update_if, job_id,
              ("pending", "processing"), status="processing",
              **errors.stage_fields(errors.stage_message(
                  "analyze.normalize", "Starting…")), progress=1.0)
    ws = _fresh(workspace(job_id, f"a{t.attempts}"))
    progress = ProgressWriter(job_id)
    degraded = llm_degraded(ctx)
    obs = llm.Observer(skip=degraded)
    work_started = time.time()
    local_copy: list[Path] = []

    def _drop_local_copy(*_a: Any, **_k: Any) -> None:
        """Right after normalizing: the workspace copy of the upload
        isn't needed any more. (The upload itself — the object, a
        legacy file on the volume — stays until the finalizer: another
        attempt may need it.)"""
        for path in local_copy:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    try:
        with costs.tracking(job_id, "analyze"):
            try:
                _fault_groq()
                if not input_path:
                    progress(errors.stage_message("analyze.normalize",
                                                  "Fetching upload…"), 1)
                    copy = ws / ("source" + upl.upload_ext(source_key))
                    local_copy.append(copy)
                    try:
                        media.get_file(source_key, copy, store=where)
                    except Exception as e:
                        raise MediaTransferError(
                            f"fetching the upload failed: "
                            f"{type(e).__name__}: {e}") from e
                    input_path = str(copy)
                if ctx.cancelled():
                    raise InterruptedError("Cancelled")
                settings = _length_gate(ctx, job, input_path, progress)
                analyze = _get("analyze_only")
                extra: dict[str, Any] = {}
                if _accepts(analyze, "on_normalized"):
                    extra["on_normalized"] = _drop_local_copy
                if _accepts(analyze, "cancel_check"):
                    extra["cancel_check"] = ctx.cancelled
                with llm.observing(obs):
                    res = analyze(input_path=input_path, output_dir=str(ws),
                                  settings=settings, progress_cb=progress,
                                  **extra)
                if ctx.cancelled():
                    raise InterruptedError("Cancelled")
                if obs.spend_limit and not degraded:
                    raise _SpendLimitHold(obs.detail or "spend limit")
                stored = _store_analysis(ctx, job_id, res, progress, where)
            except Exception as e:
                progress.close()
                return _ingest_failure(ctx, e, ws)
            progress.close()
            fields = dict(
                status="awaiting_review",
                **errors.stage("analyze.done"),
                progress=100.0,
                segments=res["segments"],
                preview_segments=[list(s) for s in res["segments"]],
                preview_version=1,
                subtitles=res["subtitles"],
                duration=res.get("duration", 0.0),
                cut_ranges=res.get("cut_ranges", []),
                language=res["language"],
                audio_warnings=res.get("audio_warnings", []),
                audio_levels=res.get("audio_levels", {}),
                scene_events=res.get("scene_events", []),
                **_pipeline().analysis_fields(res),
                **stored,
            )
            warnings = obs.warnings()
            if warnings:
                fields["processing_warnings"] = warnings
                _log(f"[job {job_id}] analysis without {', '.join(warnings)}")
            result = {"duration": float(res.get("duration") or 0.0),
                      "work_s": round(time.time() - work_started, 3),
                      "test": bool((job.settings or {}).get("_cost_test")),
                      "worker": ctx.call_id, "warnings": warnings,
                      "llm_ok": not obs.failed and not degraded}
            # The doc's style is settled against the job as stored at the
            # commit (backend.doc.commit_change), in the same transaction.
            outcome = ctx.commit(result, ("processing",), edit_doc.commit_change(
                fields, res, prefs=edit_doc.load_prefs(job.owner_id)))
        if outcome == "ok":
            return {"committed": True}
        if outcome == "job_changed":
            return ctx.fail(taskq.JOB_CHANGED,
                            "the job left 'processing' before the commit",
                            False)
        return {"skipped": "fenced"}
    finally:
        progress.close()
        _drop(ws)


# ── render ───────────────────────────────────────────────────────────

_SOCIAL_POOL = ThreadPoolExecutor(
    max_workers=max(1, int(_env_float("CLEO_SOCIAL_WORKERS", 4))),
    thread_name_prefix="task-social")
_SOCIAL_WAIT_S = 75.0
SUPERSEDED_KEEP_S = 24 * 3600.0
_NO_SOCIAL: dict = {"caption": "", "hashtags": []}


def _social_caption(subtitles: list, language: str | None, skip: bool
                    ) -> tuple[dict, dict[str, float], llm.Observer]:
    usage: dict[str, float] = {}
    social: dict = dict(_NO_SOCIAL)
    obs = llm.Observer(skip=skip)
    with costs.collecting(usage), llm.observing(obs):
        try:
            full = " ".join(
                (s.get("text") or "").strip()
                for s in subtitles
                if isinstance(s, dict) and (s.get("text") or "").strip())
            social = llm.generate_social_caption(full, language=language)
        except Exception as e:
            _log(f"[social] caption skipped: {e}")
    return social, usage, obs


def _social_result(job_id: str, future: Any) -> tuple[dict, llm.Observer]:
    try:
        social, usage, obs = future.result(timeout=_SOCIAL_WAIT_S)
    except Exception as e:
        _log(f"[job {job_id}] social-caption skipped: "
             f"{type(e).__name__}: {e}")
        return dict(_NO_SOCIAL), llm.Observer()
    costs.merge(usage)
    return (social if isinstance(social, dict) else dict(_NO_SOCIAL)), obs


def output_seconds(job: Any) -> float:
    """backend/main.py _output_seconds."""
    total = 0.0
    for seg in job.edit_segments():
        try:
            speed = max(0.05, float(seg.get("speed") or 1.0))
            total += max(0.0, float(seg["end"]) - float(seg["start"])) / speed
        except (TypeError, ValueError, KeyError):
            continue
    return total


def render_commit(cur: Any, result: dict, out_prefix: str,
                  social: dict) -> tuple[dict, list[str]]:
    """backend/main.py _render_commit."""
    output_keys = {fmt: ref["key"] for fmt, ref in result["outputs"].items()}
    sizes = {ref["key"]: int(ref["size"])
             for ref in result["outputs"].values()}
    hook_clips = []
    for h in result.get("hooks") or []:
        name = f"hook_{h['k']}"
        output_keys[name] = h["key"]
        sizes[h["key"]] = int(h["size"])
        hook_clips.append({"key": name, "title": h.get("title"),
                           "reason": h.get("reason", ""),
                           "start": h.get("start"), "end": h.get("end")})
    thumb = result.get("thumb") or None
    if thumb:
        sizes[thumb["key"]] = int(thumb["size"])
    old = set((cur.output_keys or {}).values())
    if cur.thumb_key:
        old.add(cur.thumb_key)
    superseded = sorted({media.key_prefix_of(k) for k in old
                         if not k.startswith(out_prefix)})
    media_bytes = {k: v for k, v in (cur.media_bytes or {}).items()
                   if media.key_prefix_of(k) not in superseded}
    media_bytes.update(sizes)
    return dict(
        status="done",
        **errors.stage_fields(errors.stage_message("render.finish", "Done")),
        progress=100.0,
        output_keys=output_keys,
        thumb_key=thumb["key"] if thumb else None,
        hook_clips=hook_clips,
        media_bytes=media_bytes,
        social_caption=social.get("caption", ""),
        social_hashtags=social.get("hashtags", []),
    ), superseded


def _backfill_mezz(ctx: Attempt, job: Any,
                   progress: Callable[[str, float], None],
                   where: str) -> str:
    """backend/main.py _backfill_mezz (a legacy job's first render)."""
    key = media.job_prefix(job.id) + "mezz.mp4"
    progress(errors.stage_message("render.prepare"), 2)
    if not ctx.fence_ok():
        raise InterruptedError("fenced out before storing the mezz")
    size = media.put_file(job.normalized_path, key, content_type="video/mp4",
                          store=where)

    def _set(cur: Any) -> dict | None:
        if cur.media_store and cur.media_store != where:
            return None
        return {"mezz_key": key,
                "media_store": cur.media_store or where,
                "media_bytes": {**(cur.media_bytes or {}), key: size},
                "updated_at": cur.updated_at}
    if jobs.store.modify(job.id, _set) is None:
        raise RuntimeError(f"job {job.id} is gone or its media moved "
                           "meanwhile")
    return key


_render_error_code = errors.render_error_code


def _render_failure(ctx: Attempt, exc: BaseException, gen: int,
                    out_prefix: str, where: str) -> dict[str, Any]:
    t = ctx.task
    if isinstance(exc, InterruptedError) and ctx.cancelled():
        if ctx.fenced.is_set():
            return {"skipped": "fenced"}
        _log(f"[job {t.job_id}] render interrupted (shutting down) — "
             "retried by the next leader")
        return ctx.fail(taskq.INTERRUPTED, "interrupted: shutting down", True,
                        {"free_retry": True, "gen": gen,
                         "out_prefix": out_prefix, "where": where})
    tb = "".join(traceback.format_exception(type(exc), exc,
                                            exc.__traceback__))
    _log(f"[job {t.job_id}] RENDER FAILED (task {t.id}, attempt "
         f"{t.attempts}/{t.max_attempts}): {exc}\n{tb}")
    job_code = _render_error_code(exc)
    result = {"job_code": job_code, "error": str(exc)[:500], "gen": gen,
              "out_prefix": out_prefix, "where": where}
    if type(exc).__name__ == "RenderUnavailableError":
        _capture(exc, job_id=t.job_id, phase="render")
        code = (taskq.RENDER_TIMEOUT if job_code == "render_timeout"
                else taskq.RENDER_UNAVAILABLE)
        return ctx.fail(code, str(exc), False, result)
    if isinstance(exc, FileNotFoundError):
        return ctx.fail(taskq.RENDER_FAILED, str(exc), False, result)
    if (isinstance(exc, (OSError, MediaTransferError))
            or db.is_transient(exc)):
        return ctx.fail(taskq.INFRA, str(exc), True, result)
    _capture(exc, job_id=t.job_id, phase="render")
    return ctx.fail(taskq.RENDER_FAILED, str(exc), False, result)


def _render(ctx: Attempt) -> dict[str, Any]:
    from backend import pipeline
    t = ctx.task
    job_id = t.job_id
    store = jobs.store
    job = _db_retry(job_id, "reading the job", store.get, job_id)
    if job is None or job.status != "processing":
        return ctx.fail(taskq.JOB_CHANGED, "the job isn't waiting for its "
                        f"render ({job.status if job else 'gone'})", False)
    payload = t.payload or {}
    subtitles = payload.get("subtitles") or []
    disabled_cuts = payload.get("disabled_cuts") or []
    gen = int(payload.get("gen") or max(1, int(job.render_gen or 0)))
    out_prefix = f"{media.job_prefix(job_id)}r{gen}/"
    where = media.store_of(job)
    progress = ProgressWriter(job_id)
    _db_retry(job_id, "starting the render", store.patch_status, job_id,
              ("processing",), **errors.stage_fields(errors.stage_message(
                  "render.prepare", "Rendering…")), progress=1.0)
    ws = _fresh(workspace(job_id, f"render-a{t.attempts}"))
    degraded = llm_degraded(ctx, render=True)
    obs = llm.Observer(skip=degraded)
    work_started = time.time()
    try:
        with costs.tracking(job_id, "render"):
            try:
                if not job.has_mezz():
                    raise _SourceGone("the render source is gone")
                social_future = _SOCIAL_POOL.submit(
                    _social_caption, subtitles, job.language, degraded)
                mezz_key = job.mezz_key or _backfill_mezz(ctx, job, progress,
                                                          where)
                render_fn = pipeline.render_to_keys
                extra: dict[str, Any] = {}
                if _accepts(render_fn, "cancel_check"):
                    extra["cancel_check"] = ctx.cancelled
                with llm.observing(obs):
                    result = render_fn(
                        job_id=job_id, gen=gen, mezz_key=mezz_key,
                        out_prefix=out_prefix, store=where,
                        mezz_bytes=(job.media_bytes or {}).get(mezz_key),
                        segments=job.segments,
                        subtitles=subtitles,
                        settings=job.settings,
                        language=job.language,
                        cut_ranges=job.cut_ranges,
                        disabled_cuts=disabled_cuts,
                        duration=job.duration,
                        workspace=str(ws),
                        progress_cb=progress,
                        **extra,
                    )
                if ctx.cancelled():
                    raise InterruptedError("Cancelled")
            except Exception as e:
                progress.close()
                return _render_failure(ctx, e, gen, out_prefix, where)
            social, social_obs = _social_result(job_id, social_future)
            obs.merge(social_obs)
            progress.close()
            if obs.spend_limit:
                # The render goes on without hooks / caption; later
                # tasks learn about it from the breaker.
                from backend.leader import note_provider_failure
                try:
                    note_provider_failure(ctx.ts, "anthropic",
                                          spend_limit=True,
                                          reason=obs.detail)
                except Exception as e:
                    _log(f"[worker] anthropic breaker update failed: {e}")
            warnings = obs.warnings()
            if warnings:
                _log(f"[job {job_id}] render without {', '.join(warnings)}")
            info: dict[str, Any] = {}

            def change(cur: Any) -> dict:
                done, superseded = render_commit(cur, result, out_prefix,
                                                 social)
                if warnings:
                    done["processing_warnings"] = list(dict.fromkeys(
                        [*(cur.processing_warnings or []), *warnings]))
                info["superseded"] = superseded
                info["output_s"] = round(output_seconds(cur), 3)
                info["test"] = bool((cur.settings or {}).get("_cost_test"))
                return done

            def result_fn() -> dict:
                superseded = info.get("superseded", [])
                return {"gen": gen, "out_prefix": out_prefix, "where": where,
                        "superseded": superseded,
                        # The previous render stays a day (someone may
                        # still stream it): queued in the commit itself.
                        "gc": [superseded, time.time() + SUPERSEDED_KEEP_S,
                               where],
                        "output_s": info.get("output_s"),
                        "test": info.get("test", False),
                        "work_s": round(time.time() - work_started, 3),
                        "worker": ctx.call_id, "warnings": warnings}
            outcome = ctx.commit(result_fn, ("processing",), change)
        if outcome == "ok":
            return {"committed": True}
        if outcome == "job_changed":
            return ctx.fail(taskq.JOB_CHANGED,
                            "the job left 'processing' before the commit",
                            False, {"gen": gen, "out_prefix": out_prefix,
                                    "where": where})
        return {"skipped": "fenced"}
    finally:
        progress.close()
        _drop(ws)
