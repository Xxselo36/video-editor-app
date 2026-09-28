"""Cleo Web Backend — FastAPI app.

Replaces the standalone HTTP server in plugins/premiere/ for web-app use.
Imports the same pipeline code from src/ so there is exactly one
implementation of analyze/render/SmartCam/voice-triggers across both
the desktop plugin and the web app.

Loads repo-root .env on import so ANTHROPIC_API_KEY (and other secrets)
are available to backend.llm without manual `export` per shell.

Accounts (backend/auth.py, Clerk) and billing (backend/billing.py +
backend/accounts.py, Lemon Squeezy) are off until their env vars are set;
while off, every route works anonymously exactly as before. Those three
modules are imported only here — the desktop app and the Modal image
load backend.pipeline & co. without them (and without PyJWT).

Run dev server:
    ./venv313/bin/uvicorn backend.main:app --reload --port 8000

Production:
    ./venv313/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 \\
        --workers 2
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow `from src...` imports when run from repo root
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Load repo-root .env so ANTHROPIC_API_KEY etc. are available without
# requiring an explicit `export` in every shell.
try:
    from dotenv import load_dotenv
    load_dotenv(_REPO_ROOT / ".env")
except ImportError:
    pass

import hmac
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import traceback
from pathlib import Path

from contextlib import asynccontextmanager
import time

from fastapi import (
    Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from backend import accounts, auth, billing, costs
from backend.auth import (
    User, current_user, get_owned_job, media_user, require_user,
)
from backend.jobs import DEFAULT_PLAN, new_job_id, retention_days, store
from backend.pipeline import analyze_only, render_only

# Media tokens (?t=) must not end up in the access log.
auth.install_log_filter()

# Track active worker threads so shutdown can wait for them before
# letting the container die. Deploys used to kill mid-flight jobs;
# now they wait up to _SHUTDOWN_GRACE_SEC for work in progress.
_active_jobs: set[str] = set()
_active_lock = threading.Lock()
_shutdown_grace_sec = float(os.environ.get("CLEO_SHUTDOWN_GRACE_SEC", "180"))


def _register_active(job_id: str) -> None:
    with _active_lock:
        _active_jobs.add(job_id)


def _release_active(job_id: str) -> None:
    with _active_lock:
        _active_jobs.discard(job_id)


@asynccontextmanager
async def lifespan(app_: FastAPI):
    # STARTUP: any job stuck in 'processing'/'pending' from the previous
    # container generation is unrecoverable — its worker thread died
    # with the process. Surface it as a real error so the frontend can
    # show a retry button instead of polling forever.
    stuck = store.mark_stuck_as_error()
    if stuck:
        print(f"[startup] marked {stuck} stuck job(s) as error "
              f"(container restart)", flush=True)
    _refund_interrupted()
    threading.Thread(target=_retention_loop, daemon=True).start()
    auth.install_log_filter()
    auth.log_status()
    billing.log_status()
    if billing.enabled():
        threading.Thread(target=billing.reconcile_loop, daemon=True).start()
    yield
    # SHUTDOWN: wait for in-flight worker threads to finish before
    # letting Uvicorn exit. Railway sends SIGTERM then waits
    # `RAILWAY_STOP_TIMEOUT_SEC` before SIGKILL — align our grace with
    # that (default 180s here; Railway Hobbyist caps at 300s).
    deadline = time.monotonic() + _shutdown_grace_sec
    while True:
        with _active_lock:
            remaining = len(_active_jobs)
        if remaining == 0:
            print("[shutdown] all jobs completed, exiting cleanly",
                  flush=True)
            break
        if time.monotonic() > deadline:
            print(f"[shutdown] grace period expired, "
                  f"{remaining} job(s) will be killed", flush=True)
            break
        print(f"[shutdown] waiting for {remaining} job(s) to finish "
              f"(grace {int(deadline - time.monotonic())}s left)",
              flush=True)
        time.sleep(2.0)


app = FastAPI(
    title="Cleo Web Backend",
    version="0.1.0",
    description="Voice-first AI video editor — backend for web app.",
    lifespan=lifespan,
)

# Where uploads + outputs live during processing. Phase 2: local disk.
# Phase 3: swap for S3 / Cloudflare R2.
def _default_work_root() -> Path:
    """Job files (upload, normalized source, preview, outputs).

    CLEO_WORK_ROOT wins; otherwise a mounted persistent volume at /data
    (Railway volume) is used so jobs survive redeploys; /tmp only as a
    last resort (wiped on every restart)."""
    env = os.environ.get("CLEO_WORK_ROOT")
    if env:
        return Path(env)
    data = Path("/data")
    if data.is_dir() and os.access(data, os.W_OK):
        return data / "cleo_jobs"
    return Path(tempfile.gettempdir()) / "cleo_jobs"


_WORK_ROOT = _default_work_root()
_WORK_ROOT.mkdir(parents=True, exist_ok=True)
# New uploads are refused below this much free space on the work volume.
_MIN_FREE_BYTES = float(os.environ.get("CLEO_MIN_FREE_GB", "2")) * 1e9

def _remove_upload(path: str | None) -> None:
    """Delete an uploaded source file (only inside our work root)."""
    if path and Path(path).resolve().is_relative_to(_WORK_ROOT.resolve()):
        try:
            os.remove(path)
        except OSError:
            pass


def _delete_job(job) -> None:
    """Remove a job's files (work dir, uploaded source, R2 object) and row."""
    shutil.rmtree(_WORK_ROOT / job.id, ignore_errors=True)
    _remove_upload(job.input_path)
    key = (job.settings or {}).get("_r2_storage_key")
    if key:
        from backend.storage import delete_from_r2
        delete_from_r2(key)
    store.delete(job.id)


def purge_expired_jobs(now: float | None = None) -> int:
    """Delete jobs idle longer than their plan's retention period
    (backend.jobs.PLAN_RETENTION_DAYS; the privacy page states the same).

    Legacy jobs without updated_at get stamped now, so they get the
    full retention period instead of being wiped on the first sweep.
    Returns the number of deleted jobs.
    """
    now = time.time() if now is None else now
    with _active_lock:
        active = set(_active_jobs)
    deleted = 0
    for job in store.list_all():
        if job.id in active or job.status in ("processing", "pending"):
            continue
        if not job.updated_at:
            store.update(job.id, updated_at=now)
            continue
        expires = job.expires_at()
        if expires is None or expires > now:
            continue
        _delete_job(job)
        deleted += 1
    return deleted


def _retention_loop() -> None:
    while True:
        try:
            n = purge_expired_jobs()
            if n:
                print(f"[retention] deleted {n} expired job(s)", flush=True)
        except Exception as e:
            print(f"[retention] sweep failed: {e}", flush=True)
        time.sleep(3600)


# ── Minutes quota (backend/accounts.py) ──────────────────────────────
# Charged once, at POST /jobs, from the probed length of the upload;
# trued up after analysis; refunded only when WE failed.


def _bills(user: User | None) -> bool:
    """Does this caller's upload count against a minutes quota? Not with
    auth off, not for the service user, not while billing is off."""
    return user is not None and not user.is_service and billing.enabled()


def _to_float(value: str) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if v == v else 0.0  # NaN


def _probe_duration(path: str) -> float | None:
    """Length of an upload in seconds, or None if ffprobe can't tell.

    Streamed WebM (MediaRecorder) has no duration in its header
    (format=duration is N/A), so fall back to the last packet timestamp.
    """
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


def _is_infra_failure(exc: BaseException, msg: str) -> bool:
    """Analysis failures that are our fault (full disk, IO, ffmpeg,
    restart) give the minutes back. Content problems ("No speech
    detected") don't — they already cost Groq/Claude time, and a refund
    would let the same file be retried for free forever."""
    if msg in ("server_storage_full", "container_restart"):
        return True
    if isinstance(exc, (OSError, MemoryError)):
        return True
    return msg.lower().startswith("ffmpeg")


def _true_up(job_id: str, duration: float) -> None:
    if not auth.auth_enabled():
        return
    try:
        extra = accounts.true_up(job_id, float(duration or 0))
        if extra:
            print(f"[job {job_id}] video longer than probed: charged "
                  f"{extra:.0f}s more", flush=True)
    except Exception as e:  # never fail a job over bookkeeping
        print(f"[job {job_id}] usage true-up failed: {e}", flush=True)


def _true_up_from_file(job_id: str, job_dir: Path) -> None:
    """True-up for an analysis that failed after normalizing: its result
    (with the duration) never came, so probe the normalized file."""
    if not auth.auth_enabled():
        return
    for name in ("normalized.mp4", "normalized_smartcam.mp4"):
        path = job_dir / name
        if not path.exists():
            continue
        try:
            seconds = _probe_duration(str(path))
        except Exception as e:
            print(f"[job {job_id}] duration probe failed: {e}", flush=True)
            return
        if seconds:
            _true_up(job_id, seconds)
        return


def _refund(job_id: str, note: str) -> None:
    if not auth.auth_enabled():
        return
    try:
        if accounts.refund(job_id, note):
            print(f"[job {job_id}] minutes refunded ({note[:60]})",
                  flush=True)
    except Exception as e:
        print(f"[job {job_id}] refund failed: {e}", flush=True)


def _refund_interrupted() -> None:
    """Startup: analyses killed by the last restart get their minutes
    back (mark_stuck_as_error tagged them container_restart). Idempotent."""
    if not auth.auth_enabled():
        return
    for job in store.list_all():
        if job.status == "error" and job.error == "container_restart":
            _refund(job.id, "container_restart")


def _discard_upload(input_path: str | None, storage_key: str | None) -> None:
    """Throw away a refused upload (local copy + R2 object)."""
    _remove_upload(input_path)
    if storage_key:
        from backend.storage import delete_from_r2
        delete_from_r2(storage_key)


def _clean_settings(parsed: dict, user: User | None) -> dict:
    """Drop internal keys (leading "_") from client settings — a forged
    _r2_storage_key would make us delete someone else's upload.
    _cost_test (cost_test.py tagging) stays for the service user, and
    while auth is off."""
    keep_cost_test = user is None or user.is_service
    return {k: v for k, v in parsed.items()
            if not str(k).startswith("_")
            or (k == "_cost_test" and keep_cost_test)}


def _short(value: str | None, limit: int) -> str | None:
    value = (value or "").strip()
    return value[:limit] or None


def _quota_error(code: str, **extra) -> HTTPException:
    return HTTPException(402, {"code": code, **extra})

# CORS configuration:
#   - Dev (default): allow LAN IPs on :3000 for phone/tablet testing.
#   - Prod: set CLEO_ALLOWED_ORIGINS="https://cleo.video,https://www.cleo.video"
#     and the regex falls away in favor of an explicit allow-list.
import os as _cors_os

_allowed_origins_env = _cors_os.environ.get("CLEO_ALLOWED_ORIGINS", "").strip()
if _allowed_origins_env:
    _origins = [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=(
            r"http://(localhost|127\.0\.0\.1|192\.168\.[0-9]+\.[0-9]+|"
            r"10\.[0-9]+\.[0-9]+\.[0-9]+):3000"
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# Cross-Origin-Resource-Policy on every response so the frontend
# (which runs with COEP=require-corp for ffmpeg.wasm's SharedArrayBuffer)
# can load /jobs/*/thumbnail, /jobs/*/watch, and POST uploads to us.
# Without this the browser blocks the response at the network layer
# and the upload just hangs at 0%.
@app.middleware("http")
async def add_corp_header(request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    return response


@app.get("/")
def root():
    return {
        "service": "cleo-backend",
        "version": app.version,
        "status": "ok",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


# Caption-style previews are pre-rendered as PIL images, used by the
# style picker in the configure screen so the user sees the actual
# typeface/effect rather than a CSS approximation.
CAPTION_PRESETS = [
    "clean", "classic", "clipper", "highlight",
    "flash", "punch", "elegant", "subtle", "none",
]


@app.get("/caption-previews/{preset}.png")
def caption_preview(preset: str, w: int = 280, h: int = 100):
    if preset not in CAPTION_PRESETS:
        raise HTTPException(404, "unknown caption preset")
    w = max(80, min(800, w))
    h = max(40, min(400, h))
    from src.caption_preview import render_caption_preview
    img = render_caption_preview(preset, size=(w, h))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def _run_analyze(job_id: str) -> None:
    with costs.tracking(job_id, "analyze"):
        _run_analyze_inner(job_id)


def _run_analyze_inner(job_id: str) -> None:
    """Worker: normalize + analyze. Job pauses on success awaiting render."""
    _register_active(job_id)
    try:
        job = store.get(job_id)
        if job is None or job.input_path is None:
            return

        job_dir = _WORK_ROOT / job_id
        job_dir.mkdir(parents=True, exist_ok=True)

        def _progress(msg: str, pct: float) -> None:
            cur = store.get(job_id)
            store.update(
                job_id,
                status="processing",
                message=msg,
                progress=pct if pct >= 0 else (cur.progress if cur else 0),
            )

        store.update(job_id, status="processing", message="Starting…", progress=1.0)
        try:
            res = analyze_only(
                input_path=job.input_path,
                output_dir=str(job_dir),
                settings=job.settings,
                progress_cb=_progress,
            )
            # Pause here: status "awaiting_review" tells the UI to show the
            # subtitle editor. Render starts when client POSTs /jobs/{id}/render.
            store.update(
                job_id,
                status="awaiting_review",
                message="Review subtitles",
                progress=100.0,
                normalized_path=res["normalized_path"],
                preview_path=res["preview_path"],
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
            )
            _true_up(job_id, res.get("duration", 0.0))
            # The original upload is only needed to build normalized.mp4;
            # editing and rendering work from that. Free the space now
            # instead of keeping a second full-size copy for weeks.
            _remove_upload(job.input_path)
            store.update(job_id, input_path=None)
            key = (job.settings or {}).get("_r2_storage_key")
            if key:  # the R2 copy of a big upload isn't needed either
                from backend.storage import delete_from_r2
                delete_from_r2(key)
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[job {job_id}] ANALYZE FAILED: {e}\n{tb}", flush=True)
            # A content failure ("No speech detected") comes after the
            # transcription was paid for: charge what was really
            # processed (before the files go; refunds below still win).
            _true_up_from_file(job_id, job_dir)
            # Nothing of a failed analysis can be reused (the user uploads
            # again), so free the upload + partial files right away — a
            # failed 10 min job used to leave ~1.5 GB on the volume.
            _remove_upload(job.input_path)
            shutil.rmtree(job_dir, ignore_errors=True)
            key = (job.settings or {}).get("_r2_storage_key")
            if key:
                from backend.storage import delete_from_r2
                delete_from_r2(key)
            msg = str(e)
            if "No space left on device" in msg:
                msg = "server_storage_full"
            store.update(job_id, status="error", message=msg[:300],
                         error=msg[:2000], input_path=None)
            if _is_infra_failure(e, msg):
                _refund(job_id, msg)
    finally:
        _release_active(job_id)


def _run_render(
    job_id: str,
    edited_subtitles: list,
    disabled_cuts: list[int] | None = None,
) -> None:
    with costs.tracking(job_id, "render"):
        _run_render_inner(job_id, edited_subtitles, disabled_cuts)


def _run_render_inner(
    job_id: str,
    edited_subtitles: list,
    disabled_cuts: list[int] | None = None,
) -> None:
    """Worker: render + concat into final MP4."""
    _register_active(job_id)
    job = store.get(job_id)
    if job is None or job.normalized_path is None:
        _release_active(job_id)
        return
    job_dir = _WORK_ROOT / job_id

    def _progress(msg: str, pct: float) -> None:
        cur = store.get(job_id)
        store.update(
            job_id,
            status="processing",
            message=msg,
            progress=pct if pct >= 0 else (cur.progress if cur else 0),
        )

    store.update(job_id, status="processing", message="Rendering…", progress=1.0)
    try:
        render_result = render_only(
            normalized_path=job.normalized_path,
            output_dir=str(job_dir),
            segments=job.segments,
            subtitles=edited_subtitles,
            settings=job.settings,
            language=job.language,
            cut_ranges=job.cut_ranges,
            disabled_cuts=disabled_cuts or [],
            duration=job.duration,
            progress_cb=_progress,
        )
        outputs = render_result["outputs"]
        hook_clips = render_result.get("hook_clips", [])
        # Social caption / hashtags from the (possibly edited) transcript.
        # Soft-fails if no ANTHROPIC_API_KEY is set.
        social = {"caption": "", "hashtags": []}
        try:
            from backend.llm import generate_social_caption
            full = " ".join(
                (s.get("text") or "").strip()
                for s in edited_subtitles
                if (s.get("text") or "").strip()
            )
            social = generate_social_caption(full, language=job.language)
        except Exception as e:
            print(f"[job {job_id}] social-caption skipped: {e}", flush=True)

        store.update(
            job_id,
            status="done",
            message="Done",
            progress=100.0,
            output_path=outputs.get("primary"),
            outputs=outputs,
            hook_clips=hook_clips,
            social_caption=social.get("caption", ""),
            social_hashtags=social.get("hashtags", []),
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[job {job_id}] RENDER FAILED: {e}\n{tb}", flush=True)
        # Back to review instead of a dead 'error': the user's edits and
        # the source are still on disk, so they can open the editor and
        # render again without re-uploading.
        store.update(job_id, status="awaiting_review", progress=100.0,
                     message="render_failed", error=str(e)[:500])
    finally:
        _release_active(job_id)


# /uploads/multipart/* (resumable R2 multipart upload) was never used by
# the web app and had no ownership checks — removed, so those paths 404.
# backend/storage.py still has the helpers.


@app.post("/uploads/presign")
def presign_upload_endpoint(
    payload: dict,
    user: User | None = Depends(current_user),
):
    """Return a presigned URL for direct-to-R2 upload.

    Client PUTs the video body straight to R2 (bypasses Railway edge
    for multi-GB files), then calls POST /jobs with the returned
    storage_key. Falls back with 503 if R2 isn't configured.

    With accounts on, keys are namespaced `uploads/<user id>/…` (POST
    /jobs only accepts the caller's own). With billing enforced this
    refuses early when there is no plan / no minutes left — UX only, the
    binding check is at POST /jobs. An optional `duration` (seconds, as
    the browser reads it) is compared with the minutes left.
    """
    from backend.storage import r2_available, presign_upload
    # Paywall first, also without R2: the frontend falls back to the
    # legacy upload on 503, which would send the whole file before
    # POST /jobs could say "no plan".
    if _bills(user) and billing.enforce():
        ent = accounts.entitlement(user.id, user.email)
        if ent is None:
            raise _quota_error("subscription_required")
        remaining = accounts.minutes_summary(user.id, ent)["remaining_seconds"]
        needed = math.ceil(_to_float(payload.get("duration") or 0))
        if remaining <= 0 or needed > remaining:
            raise _quota_error("quota_exceeded",
                               remaining_seconds=round(remaining),
                               needed_seconds=needed or None)
    if not r2_available():
        raise HTTPException(
            503,
            "Direct upload not available on this deployment. "
            "Contact support if you need multi-GB uploads."
        )
    filename = str(payload.get("filename") or "upload.mp4").strip()
    content_type = str(
        payload.get("content_type") or "video/mp4"
    ).strip() or "video/mp4"
    try:
        info = presign_upload(filename=filename, content_type=content_type,
                              prefix=auth.upload_prefix(user))
    except Exception as e:
        raise HTTPException(500, f"presign failed: {e}") from e
    return info


@app.post("/jobs")
async def create_job(
    file: UploadFile = File(None),
    settings: str = Form("{}"),
    storage_key: str = Form(None),
    filename: str = Form(None),
    preset_id: str = Form(None),
    preset_label: str = Form(None),
    user: User | None = Depends(current_user),
):
    """Upload + start analyze. Two paths:

    1) Small files (< ~100MB): multipart 'file' upload directly through
       Railway. Legacy path — works for everything that fits under the
       edge-router body limit.

    2) Large files: client first hits POST /uploads/presign, uploads
       the body directly to R2 with the returned URL, then calls this
       endpoint with `storage_key` set to the R2 object key. Backend
       downloads from R2 into local /tmp before starting analyze.

    `filename`, `preset_id`, `preset_label` are stored for the Library.
    With billing on, the upload's length is probed and charged against
    the caller's minutes here, once (402 subscription_required /
    quota_exceeded when enforced; 400 unreadable_video if it has no
    readable length).
    """
    try:
        parsed = json.loads(settings)
    except json.JSONDecodeError:
        raise HTTPException(400, "settings must be valid JSON")
    if not isinstance(parsed, dict):
        raise HTTPException(400, "settings must be a JSON object")
    parsed = _clean_settings(parsed, user)

    job_input_dir = _WORK_ROOT / "uploads"
    job_input_dir.mkdir(parents=True, exist_ok=True)

    # Refuse early instead of failing halfway through a multi-GB download
    # or normalization when the volume is (nearly) full.
    free = shutil.disk_usage(_WORK_ROOT).free
    if free < _MIN_FREE_BYTES:
        print(f"[jobs] refusing upload: only {free / 1e9:.1f} GB free",
              flush=True)
        raise HTTPException(507, "server_storage_full")

    if storage_key:
        # Only keys we handed this caller out (presign) — any other key
        # would be downloaded AND deleted after analysis.
        if (not storage_key.startswith(auth.upload_prefix(user))
                or ".." in storage_key):
            raise HTTPException(403, "storage_key not yours")

    bills = _bills(user)
    enforce = bills and billing.enforce()
    if enforce and accounts.entitlement(user.id, user.email) is None:
        await run_in_threadpool(_discard_upload, None, storage_key)
        raise _quota_error("subscription_required")

    input_path: str
    if storage_key:
        # Path B: pull from R2
        from backend.storage import download_from_r2
        # Preserve extension from original filename if given, else from
        # the storage_key (which we generated).
        suffix = (
            Path(filename or "").suffix.lower()
            or Path(storage_key).suffix.lower()
            or ".mp4"
        )
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, dir=str(job_input_dir)
        ) as f:
            input_path = f.name
        try:
            # In a worker thread: a multi-GB download inside this async
            # handler used to block the event loop, stalling every other
            # request (polls, previews, uploads) until it finished.
            await run_in_threadpool(download_from_r2, storage_key, input_path)
        except Exception as e:
            try:
                os.remove(input_path)
            except Exception:
                pass
            raise HTTPException(
                502, f"failed to fetch upload from storage: {e}"
            ) from e
    elif file is not None:
        # Path A: legacy multipart upload
        suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, dir=str(job_input_dir)
        ) as f:
            await run_in_threadpool(shutil.copyfileobj, file.file, f)
            input_path = f.name
    else:
        raise HTTPException(
            400, "Either 'file' (multipart) or 'storage_key' (R2) required."
        )

    # Stash storage_key on the job settings so we can clean up R2
    # after render completes.
    if storage_key:
        parsed["_r2_storage_key"] = storage_key

    job_id = new_job_id()
    plan = DEFAULT_PLAN
    if bills:
        seconds = await run_in_threadpool(_probe_duration, input_path)
        if seconds is None:
            if enforce:
                await run_in_threadpool(_discard_upload, input_path,
                                        storage_key)
                raise HTTPException(400, "unreadable_video")
            seconds = 0.0  # not enforced: the true-up after analysis fixes it
        # Synchronous on purpose: quota check + ledger insert must not be
        # interleaved with another upload of the same user.
        try:
            ent = accounts.charge(job_id, user.id, seconds,
                                  email=user.email, enforce=enforce)
        except accounts.SubscriptionRequired:
            await run_in_threadpool(_discard_upload, input_path, storage_key)
            raise _quota_error("subscription_required")
        except accounts.QuotaExceeded as e:
            await run_in_threadpool(_discard_upload, input_path, storage_key)
            raise _quota_error("quota_exceeded",
                               remaining_seconds=round(e.remaining_seconds),
                               needed_seconds=round(e.needed_seconds))
        if ent is not None:
            plan = ent.plan  # fixed per job: a downgrade never shortens retention
        if enforce:
            # The charge trusts the container's duration header, which
            # the uploader controls: analyse no more than was charged
            # (+ the true-up tolerance), or a file claiming 1 s would be
            # transcribed in full, however long it really is.
            parsed["_max_seconds"] = (math.ceil(max(seconds, 0.0))
                                      + accounts.TRUE_UP_TOLERANCE_S)

    try:
        job = store.create(
            input_path=input_path,
            settings=parsed,
            job_id=job_id,
            owner_id=user.id if user else None,
            plan=plan,
            filename=_short(filename or (file.filename if file else None),
                            255),
            preset_id=_short(preset_id, 100),
            preset_label=_short(preset_label, 200),
        )
    except Exception:
        if bills:
            _refund(job_id, "create_failed")
        raise
    threading.Thread(target=_run_analyze, args=(job.id,), daemon=True).start()
    return {"job_id": job.id, **job.to_dict()}


# Fields of GET /jobs rows (the Library's server-side list).
_LIST_FIELDS = (
    "id", "status", "message", "progress", "error", "filename", "preset_id",
    "preset_label", "created_at", "updated_at", "expires_at", "has_output",
    "outputs", "hook_clips", "social_caption", "social_hashtags", "duration",
)


@app.get("/jobs")
def list_jobs(user: User = Depends(require_user)):
    """The caller's projects, newest first (404 not_available while
    accounts are off — the frontend keeps its localStorage list then).
    Beta jobs show up once claimed, i.e. after any /jobs/{id} request."""
    rows = store.list_all() if user.is_service else store.list_by_owner(user.id)
    rows.sort(key=lambda j: j.created_at or j.updated_at, reverse=True)
    out = []
    for job in rows:
        d = job.to_dict()
        out.append({k: d.get(k) for k in _LIST_FIELDS})
    return out


@app.get("/jobs/{job_id}")
def get_job(job_id: str, user: User | None = Depends(current_user)):
    return get_owned_job(job_id, user).to_dict()


@app.get("/me")
def me(user: User | None = Depends(current_user)):
    """Who is signed in, their plan and minutes, and the media token for
    <video>/<img> URLs (`?t=`). {"auth_enabled": false} with auth off."""
    if user is None:
        return {"auth_enabled": False}
    on, reason = billing.status()
    out: dict = {
        "user": {"id": user.id, "email": None},
        "auth_enabled": True,
        "billing": {"enabled": on, "enforce": billing.enforce(),
                    "test_mode": accounts.test_mode()},
        "plan": None,
        "subscription": None,
        "minutes": None,
        "media_token": auth.media_token(user.id),
    }
    if reason:
        out["billing"]["reason"] = reason
    if user.is_service:
        return out
    email = billing.user_email(user)
    out["user"]["email"] = email
    if not on:
        return out
    billing.refresh_user(user.id)
    ent = accounts.entitlement(user.id, email)
    sub = (ent.subscription if ent and ent.subscription
           else accounts.latest_subscription(user.id))
    out["plan"] = ent.plan if ent else None
    out["subscription"] = accounts.subscription_public(sub)
    if ent is not None:
        out["minutes"] = accounts.minutes_summary(user.id, ent)
        out["comp"] = ent.source == "comp"
    return out


def _require_billing() -> None:
    if not billing.enabled():
        raise HTTPException(404, "billing_disabled")


@app.get("/billing/config")
def billing_config():
    """Public: is billing on, and the plans (price, minutes, retention)."""
    return billing.config()


@app.post("/billing/checkout")
def billing_checkout(payload: dict, user: User = Depends(require_user)):
    """{plan} → {url} of a Lemon Squeezy checkout. 409 already_subscribed
    (with a portal_url) when a subscription already grants access —
    plan changes happen in the customer portal."""
    _require_billing()
    plan = str(payload.get("plan") or "").strip().lower()
    if user.is_service or plan not in billing.variants():
        raise HTTPException(400, "unknown_plan")
    client_email = payload.get("email")
    client_email = (client_email.strip()[:254]
                    if isinstance(client_email, str) else None)
    try:
        url = billing.create_checkout(user, plan, client_email=client_email)
    except billing.TestersOnly:
        raise HTTPException(403, {"code": "test_mode_testers_only"})
    except billing.AlreadySubscribed as e:
        raise HTTPException(409, {"code": "already_subscribed",
                                  "portal_url": e.portal_url})
    except (billing.LemonSqueezyError, KeyError, TypeError) as e:
        print(f"[billing] checkout failed: {e}", flush=True)
        raise HTTPException(502, "checkout_failed")
    return {"url": url}


@app.get("/billing/portal")
def billing_portal(user: User = Depends(require_user)):
    """Fresh customer-portal URL (they are signed and expire)."""
    _require_billing()
    url = None if user.is_service else billing.portal_url(user.id)
    if not url:
        raise HTTPException(404, "no_subscription")
    return {"url": url}


@app.post("/billing/webhook")
async def billing_webhook(request: Request):
    """Lemon Squeezy webhook. Signature over the raw body; 200 once
    applied (or deliberately ignored), 400 bad signature, 500 when
    processing failed so LS retries."""
    _require_billing()
    raw = await request.body()
    if not billing.verify_signature(raw, request.headers.get("x-signature", "")):
        raise HTTPException(400, "bad signature")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "invalid json")
    if not isinstance(payload, dict):
        raise HTTPException(400, "invalid payload")
    event = (payload.get("meta") or {}).get("event_name")
    try:
        result = await run_in_threadpool(billing.process_event, payload)
    except Exception as e:
        print(f"[billing] webhook {event} FAILED: {e}\n"
              f"{traceback.format_exc()}", flush=True)
        raise HTTPException(500, "webhook processing failed")
    print(f"[billing] webhook {event}: {result}", flush=True)
    return {"ok": True, **result}


@app.get("/admin/costs")
def admin_costs(x_admin_token: str = Header(default=""),
                exclude_tests: bool = False):
    """What processing costs us — per job and per video minute.

    Protected by CLEO_ADMIN_TOKEN (send it as X-Admin-Token); disabled
    (404) while that env var is unset. Storage is estimated for keeping
    each job's files for its plan's full retention period.
    """
    token = os.environ.get("CLEO_ADMIN_TOKEN", "")
    if not token:
        raise HTTPException(404, "not found")
    if not hmac.compare_digest(x_admin_token, token):
        raise HTTPException(401, "bad admin token")
    rows = []
    for job in store.list_all():
        c = dict(job.costs or {})
        if not c:
            continue
        job_dir = _WORK_ROOT / job.id
        files = {
            str(f.relative_to(job_dir)): f.stat().st_size
            for f in job_dir.rglob("*") if f.is_file()
        } if job_dir.exists() else {}
        served = sum(files.values())
        if job.input_path and Path(job.input_path).exists():
            files["(original upload)"] = Path(job.input_path).stat().st_size
        size = sum(files.values())
        c["usd_storage"] = costs.storage_usd(size, retention_days(job.plan))
        # Everything in the job folder is sent to the browser at least
        # once (source + preview in the editor, the final downloads).
        c["usd_egress_est"] = costs.egress_usd(served)
        total = c.get("usd_total", 0.0) + c["usd_storage"] + c["usd_egress_est"]
        minutes = (job.duration or 0) / 60
        is_test = bool((job.settings or {}).get("_cost_test"))
        if exclude_tests and is_test:
            continue
        rows.append({
            "job_id": job.id,
            "owner_id": job.owner_id,
            "test": is_test,
            "status": job.status,
            "plan": job.plan,
            "video_minutes": round(minutes, 2),
            "storage_mb": round(size / 1e6, 1),
            "files_mb": {k: round(v / 1e6, 1) for k, v in
                         sorted(files.items(), key=lambda kv: -kv[1])},
            "usd": {k: round(v, 5) for k, v in c.items() if k.startswith("usd_")},
            "usd_all_in": round(total, 5),
            "usd_per_video_minute": round(total / minutes, 5) if minutes else None,
            "usage": {k: round(v, 2) for k, v in c.items() if not k.startswith("usd_")},
        })
    minutes = sum(r["video_minutes"] for r in rows)
    spent = sum(r["usd_all_in"] for r in rows)
    parts: dict[str, float] = {}
    for r in rows:
        for k, v in r["usd"].items():
            if k != "usd_total":
                parts[k] = parts.get(k, 0.0) + v
    return {
        "note": "Estimates from backend/costs.py RATES — check provider prices.",
        "jobs": len(rows),
        "video_minutes": round(minutes, 2),
        "usd_total": round(spent, 4),
        "usd_per_video_minute": round(spent / minutes, 5) if minutes else None,
        "usd_per_video_minute_by_part": {
            k: round(v / minutes, 5) for k, v in parts.items()
        } if minutes else {},
        "rows": sorted(rows, key=lambda r: -r["usd_all_in"]),
    }


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str, user: User | None = Depends(current_user)):
    """Delete a project and all its files right away (user request)."""
    job = get_owned_job(job_id, user)
    with _active_lock:
        busy = job_id in _active_jobs
    if busy or job.status in ("processing", "pending"):
        raise HTTPException(409, "job is still processing")
    _delete_job(job)
    return {"deleted": job_id}


@app.get("/jobs/{job_id}/subtitles")
def get_subtitles(job_id: str, user: User | None = Depends(current_user)):
    """Subtitles produced by analyze, for the review editor."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not ready for review (status={job.status})")
    return {
        "subtitles": job.subtitles,
        "language": job.language,
        # Transcript as edited in review, if the user changed anything.
        "phrases": job.edited_phrases,
    }


@app.get("/jobs/{job_id}/preview-video")
def preview_video(job_id: str, user: User | None = Depends(media_user)):
    """Stream the rotation-normalized source for in-browser preview.

    Starlette's FileResponse handles HTTP Range requests so the <video>
    element can seek without downloading the full file.
    """
    job = get_owned_job(job_id, user)
    # Prefer the cut preview (segments concatenated, no captions). Falls
    # back to the normalized file if the preview render isn't there yet.
    path = job.preview_path if job.preview_path else job.normalized_path
    if not path or not Path(path).exists():
        raise HTTPException(409, "preview video not ready")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        # The file is rebuilt in place on every edit; make the browser
        # revalidate instead of reusing a stale copy on re-entry.
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )


# Per-job ordering for timeline saves. Each /edit-segments request gets
# a sequence number and stores its segments under _EDIT_GUARD, so the
# newest request always wins even when FastAPI runs several in its
# threadpool. Preview rebuilds are serialized per job and skipped when
# a newer request has already arrived (it will rebuild instead).
_EDIT_GUARD = threading.Lock()
_EDIT_SEQ: dict[str, int] = {}
_PREVIEW_LOCKS: dict[str, threading.Lock] = {}


def _preview_lock(job_id: str) -> threading.Lock:
    with _EDIT_GUARD:
        lock = _PREVIEW_LOCKS.get(job_id)
        if lock is None:
            lock = _PREVIEW_LOCKS[job_id] = threading.Lock()
        return lock


def _effect(value, default: float, lo: float, hi: float) -> float:
    """Parse one effect value. Only a missing value means "default" —
    `x or default` used to turn volume 0 (mute) into 1.0."""
    if value is None or value == "":
        return default
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _rebuild_preview(job_id: str, normalized_path: str, segments) -> None:
    """Render the cut preview to a temp file and swap it in atomically,
    then record which segments it shows. Raises on ffmpeg failure; the
    old preview stays untouched in that case."""
    from backend.pipeline import _ffmpeg_cuts_preview
    job_dir = Path(_WORK_ROOT) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    final_path = job_dir / "preview.mp4"
    tmp_path = job_dir / f"preview.{threading.get_ident()}.tmp.mp4"
    try:
        _ffmpeg_cuts_preview(normalized_path, segments, str(tmp_path))
        os.replace(tmp_path, final_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    cur = store.get(job_id)
    store.update(
        job_id,
        preview_path=str(final_path),
        preview_segments=[[float(s), float(e)] for s, e in segments],
        preview_version=(cur.preview_version if cur else 0) + 1,
    )


@app.post("/jobs/{job_id}/edit-segments")
def post_edit_segments(job_id: str, payload: dict,
                       user: User | None = Depends(current_user)):
    """Accept a user-edited segment list and rebuild the preview video.

    Frontend sends the segment list (with per-segment effects) after the
    user has trimmed, split, deleted, reordered or changed effects in the
    timeline editor. We clamp against the normalized video duration,
    keep the user's ORDER, store segments + effects, then re-render the
    preview MP4 so the player reflects the edit.

    Payload:
        {"segments": [{"start", "end", "speed"?, "fadeIn"?, "fadeOut"?,
                       "volume"?}, ...]}

    Response: the job dict plus
        preview_ok  – the preview now shows exactly these segments
        superseded  – a newer save arrived; its response is authoritative
    """
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(
            409, f"job not in review state (status={job.status})"
        )
    if not job.normalized_path or not Path(job.normalized_path).exists():
        raise HTTPException(410, "normalized video no longer on disk")

    raw = payload.get("segments") or []
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, "segments must be a non-empty list")

    dur = float(job.duration or 0.0)
    cleaned: list[tuple[float, float]] = []
    effects: list[dict] = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        try:
            ss = max(0.0, float(s.get("start") or 0))
            ee = float(s.get("end") or 0)
        except (TypeError, ValueError):
            continue
        if dur > 0:
            ee = min(ee, dur)
        if ee - ss < 0.05:
            continue
        cleaned.append((round(ss, 3), round(ee, 3)))
        # Per-segment effects. Clamped to safe ranges — render step
        # applies these via ffmpeg atempo / fade / volume filters.
        effects.append({
            "speed": _effect(s.get("speed"), 1.0, 0.25, 4.0),
            "fadeIn": _effect(s.get("fadeIn"), 0.0, 0.0, 2.0),
            "fadeOut": _effect(s.get("fadeOut"), 0.0, 0.0, 2.0),
            "volume": _effect(s.get("volume"), 1.0, 0.0, 2.5),
        })
    if not cleaned:
        raise HTTPException(400, "no valid segments after cleaning")

    # Store under the guard so the request with the highest sequence
    # number is also the one whose segments end up in the store.
    with _EDIT_GUARD:
        seq = _EDIT_SEQ.get(job_id, 0) + 1
        _EDIT_SEQ[job_id] = seq
        cur = store.get(job_id) or job
        new_settings = dict(cur.settings or {})
        new_settings["segment_effects"] = effects
        extra = {}
        if not cur.preview_segments:
            # Job from before preview_segments existed: its preview.mp4
            # was built from the segments we are about to replace.
            extra["preview_segments"] = [[float(a), float(b)] for a, b in cur.segments]
        store.update(
            job_id,
            segments=[list(seg) for seg in cleaned],
            settings=new_settings,
            **extra,
        )

    preview_ok = False
    superseded = False
    with _preview_lock(job_id):
        with _EDIT_GUARD:
            superseded = _EDIT_SEQ.get(job_id) != seq
        if not superseded:
            try:
                _rebuild_preview(job_id, job.normalized_path, cleaned)
                preview_ok = True
            except Exception as e:
                print(f"[edit-segments] preview rebuild failed: {e}", flush=True)

    out = store.get(job_id).to_dict()
    out["preview_ok"] = preview_ok
    out["superseded"] = superseded
    return out


@app.post("/jobs/{job_id}/phrases")
def post_phrases(job_id: str, payload: dict,
                 user: User | None = Depends(current_user)):
    """Save the review transcript (edited text, deleted lines) so it
    survives leaving and re-entering the job. GET /subtitles returns it
    as `phrases`. The render still takes the subtitles the client sends."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(
            409, f"job not in review state (status={job.status})"
        )
    raw = payload.get("phrases")
    if not isinstance(raw, list) or len(raw) > 20000:
        raise HTTPException(400, "phrases must be a list")
    cleaned: list[dict] = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        try:
            item = {
                "start": float(p.get("start") or 0),
                "end": float(p.get("end") or 0),
                "original_start": float(p.get("original_start") or 0),
                "original_end": float(p.get("original_end") or 0),
                "confidence": float(
                    1.0 if p.get("confidence") is None else p.get("confidence")
                ),
                "text": str(p.get("text") or "")[:2000],
            }
        except (TypeError, ValueError):
            continue
        cleaned.append(item)
    # Saves can arrive out of order (slow network, flush on leave while
    # a debounced save is still in flight): keep the newest revision.
    try:
        rev = float(payload.get("rev") or 0)
    except (TypeError, ValueError):
        rev = 0.0
    with _EDIT_GUARD:
        cur = store.get(job_id)
        if cur is not None and rev and rev < (cur.edited_phrases_rev or 0):
            return {"ok": True, "count": len(cleaned), "stale": True}
        store.update(job_id, edited_phrases=cleaned, edited_phrases_rev=rev)
    return {"ok": True, "count": len(cleaned)}


@app.post("/jobs/{job_id}/recompute-scenes")
def post_recompute_scenes(job_id: str, payload: dict,
                          user: User | None = Depends(current_user)):
    """Recompute cut segments from an edited scene-event list.

    Frontend sends the user-edited event list (some toggled off, maybe
    some new ones added). We recompute the cut ranges from scratch,
    remap subtitles onto the new timeline, and update the job so the
    preview + review UI refresh.

    Payload:
        {"events": [{"type": "start"|"restart"|"keep"|"finish",
                     "start": float, "end": float}, ...]}
    """
    job = get_owned_job(job_id, user)
    if job.status not in ("awaiting_review",):
        raise HTTPException(
            409, f"job not in review state (status={job.status})"
        )
    if not job.normalized_path or not Path(job.normalized_path).exists():
        raise HTTPException(410, "normalized video no longer on disk")

    events_in = payload.get("events") or []
    try:
        clean: list[tuple[str, float, float, int]] = []
        for i, e in enumerate(events_in):
            t = str(e.get("type") or "").lower()
            if t not in ("start", "restart", "keep", "finish"):
                continue
            s = float(e.get("start") or 0)
            end = float(e.get("end") or s)
            clean.append((t, s, end, i))
        clean.sort(key=lambda x: x[1])
    except Exception as e:
        raise HTTPException(400, f"invalid events payload: {e}") from e

    # Re-apply scene semantics to compute cut ranges + kept segments.
    from src.scene_triggers import find_scene_cut_ranges
    # Trick: our scene fn expects whisper-words. We synthesize a
    # minimal word list that matches the requested command phrases so
    # the existing state-machine logic can be re-used unchanged.
    fake_words: list[dict] = []
    for (t, s, end, _i) in clean:
        # Two-token phrase: "cleo <type>"
        cleo_start = max(0.0, s)
        cleo_end = s + max(0.05, (end - s) / 2)
        cmd_start = cleo_end + 0.01
        cmd_end = max(end, cmd_start + 0.05)
        fake_words.append({"word": "cleo", "start": cleo_start, "end": cleo_end})
        fake_words.append({"word": t, "start": cmd_start, "end": cmd_end})
    cut_ranges_scene, _events_out = find_scene_cut_ranges(
        fake_words, clip_duration=job.duration or None,
    )

    # Merge with the existing full pipeline: start from the original
    # analyze segments then apply the NEW scene cuts.
    from src.filler_detection import FillerDetector
    _det = FillerDetector()
    # We need the ORIGINAL segments (pre-scene). We didn't store them
    # separately, so we rebuild from cut_ranges + duration: take
    # `job.segments` and re-expand the scene cuts we previously applied.
    # Simpler: recompute cut_ranges as inverse of current segments and
    # apply the new scene cuts on top of a "no cuts" baseline.
    # For MVP we simply add the new scene cuts to the existing segments.
    base_segments = [tuple(s) for s in job.segments]
    new_segments = _det.filter_segments(base_segments, cut_ranges_scene)

    # Update cut_ranges to include the new scene cuts alongside existing
    old_cut_ranges = list(job.cut_ranges or [])
    next_id = (max((c.get("id", 0) for c in old_cut_ranges), default=-1)) + 1
    new_cut_range_dicts = []
    for (rs, re_) in cut_ranges_scene:
        new_cut_range_dicts.append({
            "id": next_id, "start": float(rs), "end": float(re_),
            "source": "user_edit",
        })
        next_id += 1

    store.update(
        job_id,
        segments=new_segments,
        cut_ranges=old_cut_ranges + new_cut_range_dicts,
        scene_events=[
            {"type": t, "start": s, "end": end, "source": "user"}
            for (t, s, end, _i) in clean
        ],
    )

    # Segment count may have changed, so per-segment effects no longer
    # line up with it — reset them rather than apply them to wrong clips.
    if len(new_segments) != len(base_segments):
        cur = store.get(job_id)
        settings = dict((cur.settings if cur else job.settings) or {})
        settings.pop("segment_effects", None)
        store.update(job_id, settings=settings)

    # Rebuild the preview video so the review UI reflects the new cuts.
    try:
        with _preview_lock(job_id):
            _rebuild_preview(job_id, job.normalized_path, new_segments)
    except Exception as e:
        print(f"[recompute] preview rebuild failed: {e}", flush=True)

    return store.get(job_id).to_dict()


@app.post("/jobs/{job_id}/render")
def post_render(job_id: str, payload: dict,
                user: User | None = Depends(current_user)):
    """Kick off the render with (possibly edited) subtitles. Never
    blocked by billing: the minutes were charged at upload."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not in review state (status={job.status})")

    edited = payload.get("subtitles")
    if not isinstance(edited, list):
        raise HTTPException(400, "payload.subtitles must be a list")
    disabled_cuts = payload.get("disabled_cuts") or []
    if not isinstance(disabled_cuts, list):
        raise HTTPException(400, "payload.disabled_cuts must be a list")

    # Flip to processing right away (and clear a previous render error)
    # so a poll between this response and the worker start can't see
    # the old 'awaiting_review + error' state.
    store.update(job_id, status="processing", message="Rendering…",
                 progress=1.0, error=None)
    threading.Thread(
        target=_run_render,
        args=(job_id, edited, disabled_cuts),
        daemon=True,
    ).start()
    return store.get(job_id).to_dict()


@app.get("/jobs/{job_id}/download")
def download_job(job_id: str, format: str = "primary",
                 user: User | None = Depends(media_user)):
    job = get_owned_job(job_id, user)
    path = job.outputs.get(format) or (
        job.output_path if format == "primary" else None
    )
    if not path or not Path(path).exists():
        raise HTTPException(409, "requested format not ready")
    safe = format.replace(":", "-")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        filename=f"cleo_{job_id}_{safe}.mp4",
    )


@app.get("/jobs/{job_id}/watch")
def watch_job(job_id: str, format: str = "primary",
              user: User | None = Depends(media_user)):
    """Same file as /download but without the attachment header, so
    the Library modal can play it inline via <video src=...>. Supports
    HTTP Range so seeking works without downloading the whole file."""
    job = get_owned_job(job_id, user)
    path = job.outputs.get(format) or (
        job.output_path if format == "primary" else None
    )
    if not path or not Path(path).exists():
        raise HTTPException(409, "requested format not ready")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )


@app.get("/jobs/{job_id}/thumbnail")
def job_thumbnail(job_id: str, user: User | None = Depends(media_user)):
    """Serve the poster-frame JPG generated at render time. The file
    lives next to the primary output at a fixed filename so we can
    derive the path without storing it on the Job."""
    job = get_owned_job(job_id, user)
    if not job.output_path:
        raise HTTPException(409, "thumbnail not ready")
    thumb = Path(job.output_path).parent / "cleo_thumbnail.jpg"
    if not thumb.exists():
        raise HTTPException(404, "thumbnail not ready")
    return FileResponse(
        path=str(thumb),
        media_type="image/jpeg",
        # Behind a per-user token once accounts are on: no shared caches.
        headers={"Cache-Control": ("private" if auth.auth_enabled()
                                   else "public") + ", max-age=86400"},
    )
