"""WP4 phase P1: the `modal` executor for ingest (CLEO_EXECUTOR_INGEST=
modal, with CLEO_TASK_QUEUE=1).

What runs where:

  Railway (this module, called by backend/worker.py in a thread of the
  leader — the same Attempt as the local executor: claim, heartbeat,
  fence, commit, failure report, the finalizer's refunds) — the length
  gate and the charge (database), then one Modal call per attempt, its
  progress copied into the job, and the commit. No local disk: the
  upload never comes here.
  Modal (`analyze_r2`, backend/modal_render.py → backend/modal_analyze.py)
  — download from R2, pipeline.analyze_only (incl. Groq and Claude, keys
  from the Modal secret `cleocuts-ai`), every artifact stored under the
  job's keys in R2; the result comes back as the call's return value.

A failure of the analysis itself (no speech, Groq down, an unreadable
file, …) comes back described and is rebuilt here into the exception
the local path would have raised, so backend/worker.py classifies it
the same way (content / provider / infra). Modal not answering — spend
limit, a crashed or preempted container — is ModalIngestError: ours,
retried per CLEO_TASK_MAX_ATTEMPTS, then failed and refunded by the
finalizer. Modal's function timeout or no result within the deadline
(code analyze_timeout) fail at once, refunded, like the local
executor's timeout: the same input would hit it again. analyze_r2 not
deployed (NotFoundError) is no failure of the job: the attempt goes
back to the queue for free and this process analyses locally (local
limits, local disk check) until a later lookup finds the function
(MISSING_RECHECK_S) — with a loud log line.

Orphans: the call id is stored on the task (tasks.modal_call_id). An
attempt settled without its waiting thread — the reaper (lease ran
out: a restart, a hang), the finalizer (task dead / failed), the job
deleted, the boot pass of a new leader — cancels that call and writes a
stop fence (stop_task / stop_job / stop_orphans), so the container
exits before its next upload.

Settings (Railway → Variables; defaults fit):
  CLEO_MODAL_ANALYZE_DEADLINE_S_BASE / _PER_S / _PER_GB / _MAX
      (900 / 3 / 120 / 7500): the wait for one call — 900 s + 3 × the
      charged length + 120 s per GB of upload, at most Modal's 2 h
      function timeout + 5 min; past it the call is cancelled and the
      attempt fails (retried).
  CLEO_MODAL_POLL_S (10), CLEO_MODAL_START_TIMEOUT_S (120): shared with
      the render path (DEPLOY.md 9.3).
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable

from backend import costs, errors, media, modal_analyze, storage

KINDS = ("ingest",)
APP = "cleocuts-render"
FUNCTION = "analyze_r2"
# backend/modal_render.py analyze_r2 timeout= (Modal's hard cap).
FUNCTION_TIMEOUT_S = 7200.0
# After a NotFoundError: analyse locally for this long, then look again.
MISSING_RECHECK_S = 600.0
_missing_until = 0.0


def mark_missing() -> None:
    """analyze_r2 isn't deployed: local analyses for MISSING_RECHECK_S."""
    global _missing_until
    _missing_until = time.monotonic() + MISSING_RECHECK_S


def available() -> bool:
    """False while a recent call found analyze_r2 not deployed."""
    return time.monotonic() >= _missing_until


def is_modal_call(call_id: str | None) -> bool:
    """A Modal FunctionCall id (the column also holds a local worker's
    id while it claims)."""
    return bool(call_id) and str(call_id).startswith("fc-")


class ModalIngestError(RuntimeError):
    """Modal couldn't run or finish the analysis — ours (infra): retried
    per CLEO_TASK_MAX_ATTEMPTS, then the job fails and is refunded."""

    def __init__(self, reason: str, code: str = "modal_failed") -> None:
        super().__init__(f"{code}: {reason}")
        self.reason = reason
        self.modal_code = code

    @property
    def timeout(self) -> bool:
        return self.modal_code == "analyze_timeout"

    @property
    def missing(self) -> bool:
        return self.modal_code == "analyze_missing"


class RemoteAnalysisError(RuntimeError):
    """An analysis failure on Modal with no closer local class (the
    message and `code` as raised there)."""


def _log(line: str) -> None:
    print(line, flush=True)


def _log_error(line: str) -> None:
    print(line, flush=True)
    import logging
    logging.getLogger("backend.executor_modal").error(line)


def _env_s(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.environ.get(name, "").strip() or default))
    except ValueError:
        return default


# ── configuration ────────────────────────────────────────────────────


def check_config() -> None:
    """CLEO_EXECUTOR_INGEST=modal needs the media of new jobs in R2 (the
    container reads the upload from there and writes every artifact
    back) and Modal credentials. Raises ValueError otherwise."""
    try:
        backend = media.backend()
    except media.ConfigError as e:
        raise ValueError(str(e)) from e
    if backend != "r2":
        raise ValueError("CLEO_EXECUTOR_INGEST=modal needs "
                         "CLEO_MEDIA_BACKEND=r2 (the Modal analysis reads "
                         "and writes R2)")
    if not os.environ.get("MODAL_TOKEN_ID", "").strip():
        raise ValueError("CLEO_EXECUTOR_INGEST=modal needs MODAL_TOKEN_ID "
                         "/ MODAL_TOKEN_SECRET")


def eligible(where: str, source_key: str | None,
             input_path: str | None) -> bool:
    """Can this job's analysis run on Modal? Its media in R2 and its
    upload an R2 object (not a file on this box: a job from before the
    switch to R2 is analysed locally, as before)."""
    return where == "r2" and bool(source_key) and not input_path


def job_eligible(job: Any) -> bool:
    """eligible() for a job as the worker sees it (its upload a file on
    this box only while that file exists)."""
    if job is None:
        return False
    from pathlib import Path
    input_path = (job.input_path if job.input_path
                  and Path(job.input_path).exists() else None)
    return eligible(media.store_of(job), job.source_ref(), input_path)


def stop_call(job_id: str, call_id: str | None, fence: str,
              why: str) -> bool:
    """Stop a Modal analysis nobody waits for any more: the stop fence
    `fence` (modal_analyze.stop_token) — the container stores nothing
    after it — then cancel the call. Best effort; True if `call_id` is a
    Modal call."""
    if not is_modal_call(call_id):
        return False
    try:
        import modal
    except ImportError:
        return False
    try:
        d = modal.Dict.from_name(modal_analyze.CHANNEL,
                                 create_if_missing=True)
        key = modal_analyze.fence_key(job_id)
        cur = d.get(key)
        if not modal_analyze.newer(cur, fence):
            d.put(key, fence)
    except Exception as e:
        _log(f"[modal] stop fence for job {job_id} failed: "
             f"{type(e).__name__}: {e}")
    try:
        modal.FunctionCall.from_id(str(call_id)).cancel()
    except Exception as e:
        _log(f"[modal] cancelling {call_id} (job {job_id}) failed: "
             f"{type(e).__name__}: {e}")
    _log(f"[modal] analysis {call_id} of job {job_id} stopped ({why})")
    return True


def stop_task(t: Any, why: str, settled: bool) -> bool:
    """stop_call for a task's stored call: `settled` (dead / failed /
    cancelled: every attempt of it) or only its current attempt (a lease
    that ran out — the next attempt's own fence still wins)."""
    if getattr(t, "kind", None) not in KINDS:
        return False
    fence = (modal_analyze.stop_token(t.id) if settled
             else modal_analyze.stop_token(t.id, t.attempts))
    return stop_call(t.job_id, t.modal_call_id, fence, why)


def stop_job(ts: Any, job_id: str) -> bool:
    """The job is being deleted: stop every Modal call of its tasks
    (before the rows go — the ids go with them). True if one was."""
    stopped = False
    try:
        tasks = ts.for_job(job_id)
    except Exception:
        return False
    for t in tasks:
        if t.kind in KINDS and is_modal_call(t.modal_call_id) and t.state in (
                "dispatching", "running", "failed", "dead"):
            stopped = stop_call(job_id, t.modal_call_id,
                                modal_analyze.stop_token(), "job deleted"
                                ) or stopped
    return stopped


def stop_orphans(ts: Any) -> int:
    """A new leader's boot pass: stop the stored calls of ingest tasks
    no longer leased (lease ran out, or settled within Modal's function
    timeout). Returns how many."""
    now = time.time()
    n = 0
    for t in ts.modal_orphans(now, now - FUNCTION_TIMEOUT_S - 300.0):
        settled = t.state not in ("dispatching", "running")
        if stop_task(t, "boot: " + ("task settled" if settled
                                    else "lease ran out"), settled):
            n += 1
    if n:
        _log(f"[modal] boot: stopped {n} orphaned analysis call(s)")
    return n


def deadline_s(seconds: float | None, size_bytes: float | None) -> float:
    """The longest wait for one call (see the module doc)."""
    cap_default = FUNCTION_TIMEOUT_S + 300.0
    cap = _env_s("CLEO_MODAL_ANALYZE_DEADLINE_S_MAX", cap_default) or cap_default
    base = _env_s("CLEO_MODAL_ANALYZE_DEADLINE_S_BASE", 900.0) or 900.0
    per_s = _env_s("CLEO_MODAL_ANALYZE_DEADLINE_S_PER_S", 3.0)
    per_gb = _env_s("CLEO_MODAL_ANALYZE_DEADLINE_S_PER_GB", 120.0)
    s = max(0.0, float(seconds or 0.0))
    gb = max(0.0, float(size_bytes or 0.0)) / 1e9
    return min(base + per_s * s + per_gb * gb, cap)


# ── failures ─────────────────────────────────────────────────────────


def rebuild_error(err: dict[str, Any]) -> BaseException:
    """The exception the local path would have raised for a failure the
    Modal analysis described (modal_analyze.describe_error) — so
    backend/worker.py classifies it the same way. The content failure's
    processed length rides along as `_cleo_processed_s`."""
    kind = str(err.get("type") or "")
    msg = str(err.get("message") or kind or "analysis failed")
    exc: BaseException
    if kind == "GroqTranscriptionError":
        from backend.whisper_groq import GroqTranscriptionError
        exc = GroqTranscriptionError(msg)
        if err.get("retry_after_s") is not None:
            exc.retry_after_s = float(err["retry_after_s"])
    elif kind == "NoSpeechError" or err.get("code") == "no_speech":
        from backend.pipeline import NoSpeechError
        exc = NoSpeechError(msg, speech_seconds=float(
            err.get("speech_seconds") or 0.0))
    elif err.get("refused"):
        exc = InterruptedError(msg)
        exc._cleo_refused = True
    elif err.get("interrupted"):
        exc = InterruptedError(msg)
    elif err.get("oserror"):
        exc = OSError(msg)
    else:
        exc = RemoteAnalysisError(msg)
        if isinstance(err.get("code"), str):
            exc.code = err["code"]
    if err.get("processed_s") is not None:
        exc._cleo_processed_s = float(err["processed_s"])
    exc._cleo_remote_tb = str(err.get("traceback") or "")
    return exc


def _give_up_reason(exc: BaseException) -> tuple[str, str]:
    """(code, reason) of a Modal failure."""
    from backend import pipeline
    name = type(exc).__name__
    if isinstance(exc, pipeline._ModalGiveUp):
        return exc.code.replace("render_", "analyze_"), str(exc)
    if name == "FunctionTimeoutError":
        return "analyze_timeout", f"{name}: {exc}"
    if name == "NotFoundError":
        return "analyze_missing", f"{name}: {exc}"
    if name in pipeline._MODAL_UNAVAILABLE:
        return "analyze_unavailable", f"{name}: {exc}"
    return "modal_failed", f"{name}: {exc}"


# ── one call ─────────────────────────────────────────────────────────


class _Channel:
    """The API side of modal_analyze's Dict: the fence and progress."""

    def __init__(self, job_id: str, token: str) -> None:
        self.job_id = job_id
        self.token = token
        self.d = None
        self._last_t: float | None = None
        try:
            import modal
            self.d = modal.Dict.from_name(modal_analyze.CHANNEL,
                                          create_if_missing=True)
        except Exception as e:
            _log(f"[modal] analyze channel unavailable ({type(e).__name__}: "
                 f"{e}) — no progress, no remote fence for job {job_id}")

    def set_fence(self) -> None:
        if self.d is None:
            return
        try:
            self.d.put(modal_analyze.fence_key(self.job_id), self.token)
        except Exception as e:
            _log(f"[modal] fence write for job {self.job_id} failed: {e}")

    def relay(self, progress: Callable[[Any, float], None] | None) -> None:
        if self.d is None or progress is None:
            return
        try:
            v = self.d.get(modal_analyze.progress_key(self.job_id,
                                                      self.token))
        except Exception:
            return
        if not isinstance(v, dict) or v.get("t") == self._last_t:
            return
        self._last_t = v.get("t")
        text = str(v.get("text") or "")
        code = v.get("code")
        msg: Any = text
        if code in errors.STAGES:
            msg = errors.StageMessage(text, code, v.get("params") or {})
        pct = v.get("pct")
        progress(msg, float(pct) if isinstance(pct, (int, float)) else -1)

    def read_gate(self) -> dict | None:
        """The container's measured length, once it is there."""
        if self.d is None:
            return None
        try:
            v = self.d.get(modal_analyze.gate_key(self.job_id, self.token))
        except Exception:
            return None
        return v if isinstance(v, dict) else None

    def verdict(self, value: dict) -> None:
        if self.d is None:
            raise ModalIngestError("analyze channel unavailable for the "
                                   "length gate's verdict")
        self.d.put(modal_analyze.verdict_key(self.job_id, self.token), value)

    def close(self) -> None:
        if self.d is None:
            return
        # (gate / verdict: the container drops them once it has read the
        # verdict.)
        for key in (modal_analyze.progress_key(self.job_id, self.token),):
            try:
                self.d.pop(key, None)
            except Exception:
                pass


def analyze(*, job_id: str, source_key: str, settings: dict[str, Any],
            token: str, degraded: bool, seconds: float | None,
            size: float | None,
            progress: Callable[[Any, float], None] | None = None,
            cancel_check: Callable[[], bool] | None = None,
            gate: Callable[[float | None], dict[str, Any]] | None = None,
            on_spawned: Callable[[str], None] | None = None
            ) -> dict[str, Any]:
    """One analysis on Modal: spawn analyze_r2, wait (bounded), copy its
    progress into the job. Returns the call's result (modal_analyze.run:
    `res` + `stored`, or `error`, with `usage` / `obs` / `timings`).
    Raises InterruptedError when cancel_check says so (the call is
    cancelled), ModalIngestError when Modal couldn't deliver.

    `gate` (an upload of unknown length): the container measures its
    copy and waits; gate(seconds) runs the API's length gate and returns
    the settings to analyse with — what it raises (a refusal) is raised
    here, the call cancelled. `on_spawned(call_id)` stores the call's id
    on the task (orphan cleanup)."""
    from backend import pipeline
    pipeline._bound_modal_throttling()
    try:
        import modal
    except ImportError as e:
        raise ModalIngestError("modal package not installed",
                               "analyze_unavailable") from e
    poll_s = max(0.01, _env_s("CLEO_MODAL_POLL_S", 10.0))
    start_s = _env_s("CLEO_MODAL_START_TIMEOUT_S", 120.0)
    limit_s = deadline_s(seconds, size)
    ch = _Channel(job_id, token)
    if gate is not None and ch.d is None:
        raise ModalIngestError("analyze channel unavailable: the length of "
                               "this upload can't be checked")
    ch.set_fence()
    call = None
    ok = no_bill = started = False
    stuck = probes = 0
    gate_exc: BaseException | None = None
    gated = gate is None
    t0 = time.monotonic()
    try:
        fn = modal.Function.from_name(APP, FUNCTION)
        kw: dict[str, Any] = dict(
            job_id=job_id, source_key=source_key, settings=settings,
            token=token, degraded=bool(degraded),
            env=modal_analyze.forward_env(), bucket=storage.bucket())
        if gate is not None:
            kw["gate"] = True
        call = fn.spawn(**kw)
        call_id = getattr(call, "object_id", None)
        if on_spawned is not None and call_id:
            try:
                on_spawned(str(call_id))
            except Exception as e:
                _log(f"[modal] storing the call id of job {job_id} failed: "
                     f"{e}")
        _log(f"[modal] analyze_r2 for job {job_id} (attempt {token}) "
             f"spawned ({call_id}), deadline {limit_s:.0f} s")
        while True:
            if cancel_check is not None and cancel_check():
                raise InterruptedError("Cancelled")
            remaining = t0 + limit_s - time.monotonic()
            if remaining <= 0:
                raise pipeline._ModalGiveUp(
                    "render_timeout",
                    f"no result from Modal within {limit_s:.0f} s")
            wait_s = min(poll_s, remaining)
            t_poll = time.monotonic()
            try:
                out = call.get(timeout=wait_s)
                break
            except Exception as e:
                # As pipeline._await_modal_call: only a builtin
                # TimeoutError after the whole wait means "not yet".
                if not (pipeline._is_poll_timeout(e)
                        and time.monotonic() - t_poll >= wait_s / 2):
                    raise
            ch.relay(progress)
            if not gated:
                asked = ch.read_gate()
                if asked is not None:
                    gated = True
                    try:
                        verdict = gate(asked.get("seconds"))
                    except BaseException as e:
                        gate_exc = e
                        try:
                            ch.verdict({"refused": True})
                            ch.d.put(modal_analyze.fence_key(job_id),
                                     f"{token}:stop")
                        except Exception:
                            pass
                        raise
                    ch.verdict({"settings": verdict})
            elapsed = time.monotonic() - t0
            if start_s > 0 and not started and elapsed >= start_s:
                state = pipeline._modal_call_state(fn, call,
                                                   log=probes % 30 == 0)
                probes += 1
                started = state == "started"
                stuck = stuck + 1 if state == "stuck" else 0
                if stuck >= 2:
                    raise pipeline._ModalGiveUp(
                        "render_unavailable",
                        f"Modal hasn't started the analysis after "
                        f"{elapsed:.0f} s and runs no container for it "
                        "(spend limit, quota or capacity?)",
                        started=False)
        ok = True
    except InterruptedError:
        raise
    except Exception as e:
        if gate_exc is not None and e is gate_exc:
            raise
        no_bill = getattr(e, "started", None) is False
        code, reason = _give_up_reason(e)
        costs.record_event("modal_failed")
        _log_error(f"[modal] ANALYSIS {code.upper()} — job {job_id} "
                   f"(attempt {token}): {reason[:500]}")
        if code == "analyze_missing":
            mark_missing()
            _log_error(f"[modal] analyze_r2 IS NOT DEPLOYED (app {APP}) — "
                       "analyses run on this box (local limits) for the "
                       f"next {MISSING_RECHECK_S:.0f} s; run 'Deploy Modal "
                       "render' with the secret cleocuts-ai (DEPLOY.md 11.5)")
        raise ModalIngestError(reason, code) from e
    finally:
        if not ok and call is not None:
            pipeline._cancel_modal_call(call)
        if call is not None and not no_bill:
            costs.record_modal(time.monotonic() - t0,
                               costs.RATES["modal_analyze_cores"],
                               costs.RATES["modal_analyze_gib"])
        ch.close()
    if not isinstance(out, dict) or not (
            isinstance(out.get("error"), dict) or "res" in out):
        raise ModalIngestError(f"analyze_r2 returned {out!r}"[:300])
    return out
