"""The analysis of one upload inside a Modal container (WP4 phase P1,
CLEO_EXECUTOR_INGEST=modal): the body of `analyze_r2`
(backend/modal_render.py). Runs where the job's media is — R2 — so the
API box (Railway) needs no disk for it.

  1. Fetch the upload (`source_key`, R2) into the container's own disk.
  2. pipeline.analyze_only — the very function the local executor runs:
     normalize (mezz + proxy), SmartCam, loudness / peaks, Groq
     transcription, the Claude steps, cut preview, poster, CJK font
     subsets, filmstrip.
  3. Store everything under the job's keys through
     pipeline.store_analysis_outputs (the worker stores through it too:
     the same keys, the same fields).
  4. Return what the worker commits: the analysis result without its
     local paths, the stored fields, the Groq / Claude usage, the LLM
     observer's state — or a description of the failure (`error`), which
     the API side turns back into the exception the local path would
     have raised (backend/executor_modal.py).

Groq and Claude are called from here, with the keys of the Modal secret
`cleocuts-ai` (DEPLOY.md 11.5): the transcription and the LLM steps sit
in the middle of the shared analysis (src/plugin_api.analyze_video
reads the whole video for its length and audio and calls the LLM
between its passes; the cut preview and poster need the transcript), so
splitting them off would mean changing the desktop code or a copy of
analyze_only.

Progress and the fence travel through a modal.Dict (CHANNEL): the API
writes `fence:{job}` = this attempt's token (`{task}:{attempt}`) before
it spawns the call and reads `progress:{job}:{token}`; this side writes
the progress (at most once a second) and checks the fence before every
upload (and every ~15 s while analysing), so a call the API lost track
of (Railway restarted mid-analysis, the task went to a later attempt)
never overwrites what the newer attempt stored. A Dict that can't be reached is ridden out — progress is
cosmetic, and the API cancels a call it fenced out itself.

No database, no Railway-only modules: imports backend.pipeline, media,
storage, costs, llm, errors (all importable in the Modal image).
"""
from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

CHANNEL = "cleocuts-analyze"
# Analysis-relevant settings of the API box the container gets too
# (non-secret, the API sends them per call; the keys come from the
# Modal secret).
FORWARD_ENV = ("CLEO_DISFLUENT_PROMPT", "CLEO_SUSTAINED_VOWEL_CUTS",
               "CLEO_GROQ_MAX_RETRY_WAIT", "CLEO_GROQ_DEBUG",
               "CLEO_CAPTION_PRESETS_LIVE")
# The result keys of analyze_only that are local paths (stored, then
# gone with the container) — everything else goes back to the API.
LOCAL_PATH_KEYS = ("normalized_path", "preview_path", "peaks_path",
                   "poster_path", "font_files", "filmstrip_path")
_FENCE_EVERY_S = 15.0
_PROGRESS_EVERY_S = 1.0


def forward_env() -> dict[str, str]:
    """The API's values of FORWARD_ENV (what it sends with a call)."""
    return {k: os.environ[k] for k in FORWARD_ENV if k in os.environ}


def apply_env(env: dict[str, str] | None) -> None:
    """In the container, per call: FORWARD_ENV as the API has them (a
    warm container must not keep the previous call's values)."""
    env = env or {}
    for k in FORWARD_ENV:
        if k in env:
            os.environ[k] = str(env[k])
        else:
            os.environ.pop(k, None)


def attempt_token(task_id: int, attempt: int) -> str:
    """The token of one attempt: `{task id}:{attempt}` (attempts only
    grow — the task store's fencing token)."""
    return f"{int(task_id)}:{int(attempt)}"


def _token_order(token: Any) -> tuple[int, int] | None:
    try:
        a, b = str(token).split(":", 1)
        return int(a), int(b)
    except (TypeError, ValueError):
        return None


def newer(current: Any, mine: str) -> bool:
    """Is the fence `current` a later attempt than `mine`? An older or
    unreadable one is not (a fence write that failed must never stop the
    attempt that owns the job now)."""
    cur, own = _token_order(current), _token_order(mine)
    return cur is not None and own is not None and cur > own


def fence_key(job_id: str) -> str:
    return f"fence:{job_id}"


def progress_key(job_id: str, token: str) -> str:
    return f"progress:{job_id}:{token}"


class Fenced(InterruptedError):
    """A newer attempt of this job's analysis owns its keys now."""


class TransferError(OSError):
    """Fetching the upload from / storing a result in R2 failed: ours
    (the worker's MediaTransferError — retried, refunded)."""


def _log(line: str) -> None:
    print(line, flush=True)


class Channel:
    """The modal.Dict shared with the API (None: no channel, e.g. a
    local test call) — every operation best effort."""

    def __init__(self, d: Any, job_id: str, token: str) -> None:
        self.d = d
        self.job_id = job_id
        self.token = token
        self._lock = threading.Lock()
        self._last_fence = 0.0
        self._fenced = False
        self._last_progress = float("-inf")
        self._failed_logged = False

    @classmethod
    def open(cls, job_id: str, token: str) -> "Channel":
        d = None
        try:
            import modal
            d = modal.Dict.from_name(CHANNEL, create_if_missing=True)
        except Exception as e:
            _log(f"[analyze] progress channel unavailable: "
                 f"{type(e).__name__}: {e}")
        return cls(d, job_id, token)

    def _failed(self, what: str, e: BaseException) -> None:
        if not self._failed_logged:
            self._failed_logged = True
            _log(f"[analyze] channel {what} failed ({type(e).__name__}: "
                 f"{e}) — going on without it")

    def fenced(self, force: bool = False) -> bool:
        """Has another attempt taken the job's keys? Checked at most
        every _FENCE_EVERY_S unless `force`."""
        if self.d is None or self._fenced:
            return self._fenced
        now = time.monotonic()
        with self._lock:
            if not force and now - self._last_fence < _FENCE_EVERY_S:
                return False
            self._last_fence = now
        try:
            current = self.d.get(fence_key(self.job_id))
        except Exception as e:
            self._failed("fence check", e)
            return False
        if newer(current, self.token):
            self._fenced = True
            _log(f"[analyze] job {self.job_id}: attempt {self.token} was "
                 f"replaced by {current} — stopping, storing nothing")
        return self._fenced

    def progress(self, msg: Any, pct: float | None) -> None:
        if self.d is None:
            return
        now = time.monotonic()
        with self._lock:
            if now - self._last_progress < _PROGRESS_EVERY_S:
                return
            self._last_progress = now
        value = {"text": str(msg), "code": getattr(msg, "code", None),
                 "params": dict(getattr(msg, "params", None) or {}),
                 "pct": pct, "t": time.time()}
        try:
            self.d.put(progress_key(self.job_id, self.token), value)
        except Exception as e:
            self._failed("progress write", e)


def _probe_s(path: Path) -> float | None:
    """The length of a file (a content failure's true-up), or None —
    ffprobe's header duration, as backend/worker.py probe_duration (not
    imported: it pulls in the job store)."""
    import subprocess
    try:
        from src.ffmpeg_utils import get_ffprobe_path
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-show_entries",
             "format=duration", "-of", "default=noprint_wrappers=1:nokey=1",
             str(path)], capture_output=True, text=True, timeout=30)
        value = float(r.stdout.strip()) if r.returncode == 0 else 0.0
    except Exception:
        return None
    return value if value > 0 else None


def describe_error(exc: BaseException, work: Path | None) -> dict[str, Any]:
    """What the API needs to rebuild `exc` (executor_modal.rebuild_error)
    and to settle the task like the local path does."""
    out: dict[str, Any] = {
        "type": type(exc).__name__,
        "message": str(exc)[:4000],
        "oserror": isinstance(exc, (OSError, MemoryError))
        and not isinstance(exc, InterruptedError),
        "interrupted": isinstance(exc, InterruptedError),
        "fenced": isinstance(exc, Fenced),
        "traceback": "".join(traceback.format_exception(
            type(exc), exc, exc.__traceback__))[-4000:],
    }
    code = getattr(exc, "code", None)
    if isinstance(code, str):
        out["code"] = code
    for attr in ("speech_seconds", "retry_after_s"):
        value = getattr(exc, attr, None)
        if isinstance(value, (int, float)):
            out[attr] = float(value)
    if work is not None and not out["interrupted"]:
        # What was really processed (charged for a content failure).
        for name in ("normalized.mp4", "normalized_smartcam.mp4"):
            path = work / "ws" / name
            if path.exists():
                out["processed_s"] = _probe_s(path)
                break
    return out


def run(job_id: str, source_key: str, settings: dict[str, Any], *,
        token: str, degraded: bool = False, bucket: str | None = None,
        analyze: Callable[..., dict] | None = None,
        channel: Channel | None = None) -> dict[str, Any]:
    """One analysis (see the module doc). Never raises for a failure of
    the analysis itself — those come back as {"error": {...}} so the API
    classifies them exactly like the local path; Modal's own failures
    (timeout, a killed container) reach the API as exceptions."""
    from backend import costs, errors, llm, media, pipeline, storage
    from backend import uploads as upl

    os.environ.setdefault("CLEO_FFMPEG_THREADS", "0")
    if not media.valid_job_id(job_id):
        raise ValueError(f"bad job id {job_id!r}")
    if bucket is not None and bucket != storage.bucket():
        # The secret points at another bucket than the API's: the upload
        # isn't there, and results would land where nobody finds them.
        raise ValueError(f"bucket mismatch: the API uses {bucket!r}, the "
                         f"Modal secret cleocuts-r2 {storage.bucket()!r}")
    ch = channel if channel is not None else Channel.open(job_id, token)
    if analyze is None:
        analyze = pipeline.analyze_only
    usage: dict[str, float] = {}
    obs = llm.Observer(skip=degraded)
    timings: dict[str, float] = {}
    work = Path(tempfile.mkdtemp(prefix="cleo_analyze_"))
    started = time.monotonic()

    def cancelled() -> bool:
        return ch.fenced()

    def progress(msg: Any, pct: float) -> None:
        ch.progress(msg, pct)

    try:
        try:
            with costs.collecting(usage):
                t = time.monotonic()
                src = work / ("source" + upl.upload_ext(source_key))
                progress(errors.stage_message("analyze.normalize",
                                              "Fetching upload…"), 1)
                try:
                    media.get_file(source_key, src, store="r2")
                except Exception as e:
                    raise TransferError(
                        f"fetching the upload failed: {type(e).__name__}: "
                        f"{e}") from e
                timings["get"] = round(time.monotonic() - t, 3)
                if ch.fenced(force=True):
                    raise Fenced("Cancelled")

                def drop_source(*_a: Any, **_k: Any) -> None:
                    src.unlink(missing_ok=True)

                t = time.monotonic()
                with llm.observing(obs):
                    res = analyze(input_path=str(src),
                                  output_dir=str(work / "ws"),
                                  settings=dict(settings or {}),
                                  progress_cb=progress,
                                  cancel_check=cancelled,
                                  on_normalized=drop_source)
                timings["analyze"] = round(time.monotonic() - t, 3)
                if ch.fenced(force=True):
                    raise Fenced("Cancelled")

                def put(path: Any, key: str, ctype: str) -> int:
                    if ch.fenced(force=True):
                        raise Fenced("fenced out before storing results")
                    try:
                        return media.put_file(path, key, content_type=ctype,
                                              store="r2")
                    except Exception as e:
                        raise TransferError(
                            f"storing {key} failed: {type(e).__name__}: "
                            f"{e}") from e
                t = time.monotonic()
                stored = pipeline.store_analysis_outputs(res, job_id, put,
                                                         progress)
                timings["put"] = round(time.monotonic() - t, 3)
        except Exception as e:
            _log(f"[analyze] job {job_id} attempt {token} failed: "
                 f"{type(e).__name__}: {e}")
            return {"error": describe_error(e, work), "usage": usage,
                    "obs": _obs_state(obs),
                    "timings": {**timings, "total": round(
                        time.monotonic() - started, 3)}}
        out_res = {k: v for k, v in res.items() if k not in LOCAL_PATH_KEYS}
        timings["total"] = round(time.monotonic() - started, 3)
        _log(f"[analyze] job {job_id} attempt {token} done: {timings}")
        return {"res": out_res, "stored": stored, "usage": usage,
                "obs": _obs_state(obs), "timings": timings}
    finally:
        # One user's video: never left on a warm container.
        shutil.rmtree(work, ignore_errors=True)


def _obs_state(obs: Any) -> dict[str, Any]:
    return {"skipped": list(obs.skipped),
            "failed": [list(f) for f in obs.failed],
            "spend_limit": bool(obs.spend_limit), "detail": obs.detail}
