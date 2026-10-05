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
the same way (content / provider / infra). Modal not answering —
not deployed, spend limit, a timeout, a crashed container, no result
within the deadline — is ModalIngestError: ours, retried per
CLEO_TASK_MAX_ATTEMPTS, then failed and refunded by the finalizer.

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


class ModalIngestError(RuntimeError):
    """Modal couldn't run or finish the analysis — ours (infra): retried
    per CLEO_TASK_MAX_ATTEMPTS, then the job fails and is refunded."""

    def __init__(self, reason: str, code: str = "modal_failed") -> None:
        super().__init__(f"{code}: {reason}")
        self.reason = reason
        self.modal_code = code


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
    if name in pipeline._MODAL_UNAVAILABLE or name == "NotFoundError":
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

    def close(self) -> None:
        if self.d is None:
            return
        try:
            self.d.pop(modal_analyze.progress_key(self.job_id, self.token),
                       None)
        except Exception:
            pass


def analyze(*, job_id: str, source_key: str, settings: dict[str, Any],
            token: str, degraded: bool, seconds: float | None,
            size: float | None,
            progress: Callable[[Any, float], None] | None = None,
            cancel_check: Callable[[], bool] | None = None
            ) -> dict[str, Any]:
    """One analysis on Modal: spawn analyze_r2, wait (bounded), copy its
    progress into the job. Returns the call's result (modal_analyze.run:
    `res` + `stored`, or `error`, with `usage` / `obs` / `timings`).
    Raises InterruptedError when cancel_check says so (the call is
    cancelled), ModalIngestError when Modal couldn't deliver."""
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
    ch.set_fence()
    call = None
    ok = no_bill = started = False
    stuck = probes = 0
    t0 = time.monotonic()
    try:
        fn = modal.Function.from_name(APP, FUNCTION)
        call = fn.spawn(job_id=job_id, source_key=source_key,
                        settings=settings, token=token,
                        degraded=bool(degraded),
                        env=modal_analyze.forward_env(),
                        bucket=storage.bucket())
        _log(f"[modal] analyze_r2 for job {job_id} (attempt {token}) "
             f"spawned, deadline {limit_s:.0f} s")
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
        no_bill = getattr(e, "started", None) is False
        code, reason = _give_up_reason(e)
        costs.record_event("modal_failed")
        _log_error(f"[modal] ANALYSIS {code.upper()} — job {job_id} "
                   f"(attempt {token}): {reason[:500]}")
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
