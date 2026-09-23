"""Cleo Web Backend — FastAPI app.

Replaces the standalone HTTP server in plugins/premiere/ for web-app use.
Imports the same pipeline code from src/ so there is exactly one
implementation of analyze/render/SmartCam/voice-triggers across both
the desktop plugin and the web app.

Loads repo-root .env on import so ANTHROPIC_API_KEY (and other secrets)
are available to backend.llm without manual `export` per shell.

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

import io
import json
import os
import shutil
import tempfile
import threading
import traceback
from pathlib import Path

from contextlib import asynccontextmanager
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from backend.jobs import store
from backend.pipeline import analyze_only, render_only

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
_WORK_ROOT = Path(tempfile.gettempdir()) / "cleo_jobs"
_WORK_ROOT.mkdir(parents=True, exist_ok=True)

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
                subtitles=res["subtitles"],
                duration=res.get("duration", 0.0),
                cut_ranges=res.get("cut_ranges", []),
                language=res["language"],
                audio_warnings=res.get("audio_warnings", []),
                audio_levels=res.get("audio_levels", {}),
                scene_events=res.get("scene_events", []),
            )
        except Exception as e:
            tb = traceback.format_exc()
            print(f"[job {job_id}] ANALYZE FAILED: {e}\n{tb}", flush=True)
            store.update(job_id, status="error", message=str(e), error=str(e))
    finally:
        _release_active(job_id)


def _run_render(
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
        store.update(job_id, status="error", message=str(e), error=str(e))
    finally:
        _release_active(job_id)


@app.post("/uploads/multipart/init")
async def multipart_init_endpoint(payload: dict):
    """Start a resumable multipart upload. Returns upload_id +
    storage_key. Client then batches part-URL signs via
    /uploads/multipart/sign and PUT-s bytes directly to R2.
    """
    from backend.storage import r2_available, multipart_init
    if not r2_available():
        raise HTTPException(503, "Direct upload not available.")
    filename = str(payload.get("filename") or "upload.mp4").strip()
    content_type = str(
        payload.get("content_type") or "video/mp4"
    ).strip() or "video/mp4"
    try:
        return multipart_init(filename=filename, content_type=content_type)
    except Exception as e:
        raise HTTPException(500, f"multipart init failed: {e}") from e


@app.post("/uploads/multipart/sign")
async def multipart_sign_endpoint(payload: dict):
    """Batch-sign a set of part URLs. Payload:
        {"upload_id": ..., "storage_key": ..., "part_numbers": [1,2,3,...]}
    """
    from backend.storage import r2_available, multipart_sign_parts
    if not r2_available():
        raise HTTPException(503, "Direct upload not available.")
    upload_id = str(payload.get("upload_id") or "").strip()
    storage_key = str(payload.get("storage_key") or "").strip()
    parts = payload.get("part_numbers") or []
    if not upload_id or not storage_key or not parts:
        raise HTTPException(400, "upload_id + storage_key + part_numbers required")
    try:
        urls = multipart_sign_parts(
            storage_key=storage_key,
            upload_id=upload_id,
            part_numbers=[int(p) for p in parts],
        )
        return {"parts": urls}
    except Exception as e:
        raise HTTPException(500, f"multipart sign failed: {e}") from e


@app.post("/uploads/multipart/complete")
async def multipart_complete_endpoint(payload: dict):
    """Finalise the multipart upload. Payload:
        {"upload_id": ..., "storage_key": ...,
         "parts": [{"part_number": int, "etag": str}, ...]}
    """
    from backend.storage import r2_available, multipart_complete
    if not r2_available():
        raise HTTPException(503, "Direct upload not available.")
    upload_id = str(payload.get("upload_id") or "").strip()
    storage_key = str(payload.get("storage_key") or "").strip()
    parts = payload.get("parts") or []
    if not upload_id or not storage_key or not parts:
        raise HTTPException(400, "upload_id + storage_key + parts required")
    try:
        multipart_complete(
            storage_key=storage_key,
            upload_id=upload_id,
            parts=parts,
        )
        return {"storage_key": storage_key, "ok": True}
    except Exception as e:
        raise HTTPException(500, f"multipart complete failed: {e}") from e


@app.post("/uploads/multipart/abort")
async def multipart_abort_endpoint(payload: dict):
    """Cancel a multipart upload — e.g. user hit cancel or a hard
    error occurred client-side."""
    from backend.storage import r2_available, multipart_abort
    if not r2_available():
        return {"ok": True}
    upload_id = str(payload.get("upload_id") or "").strip()
    storage_key = str(payload.get("storage_key") or "").strip()
    if upload_id and storage_key:
        multipart_abort(storage_key=storage_key, upload_id=upload_id)
    return {"ok": True}


@app.post("/uploads/presign")
async def presign_upload_endpoint(payload: dict):
    """Return a presigned URL for direct-to-R2 upload.

    Client PUTs the video body straight to R2 (bypasses Railway edge
    for multi-GB files), then calls POST /jobs with the returned
    storage_key. Falls back with 503 if R2 isn't configured.
    """
    from backend.storage import r2_available, presign_upload
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
        info = presign_upload(filename=filename, content_type=content_type)
    except Exception as e:
        raise HTTPException(500, f"presign failed: {e}") from e
    return info


@app.post("/jobs")
async def create_job(
    file: UploadFile = File(None),
    settings: str = Form("{}"),
    storage_key: str = Form(None),
    filename: str = Form(None),
):
    """Upload + start analyze. Two paths:

    1) Small files (< ~100MB): multipart 'file' upload directly through
       Railway. Legacy path — works for everything that fits under the
       edge-router body limit.

    2) Large files: client first hits POST /uploads/presign, uploads
       the body directly to R2 with the returned URL, then calls this
       endpoint with `storage_key` set to the R2 object key. Backend
       downloads from R2 into local /tmp before starting analyze.
    """
    try:
        parsed = json.loads(settings)
    except json.JSONDecodeError:
        raise HTTPException(400, "settings must be valid JSON")

    job_input_dir = _WORK_ROOT / "uploads"
    job_input_dir.mkdir(parents=True, exist_ok=True)

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
            download_from_r2(storage_key, input_path)
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
            shutil.copyfileobj(file.file, f)
            input_path = f.name
    else:
        raise HTTPException(
            400, "Either 'file' (multipart) or 'storage_key' (R2) required."
        )

    # Stash storage_key on the job settings so we can clean up R2
    # after render completes.
    if storage_key:
        parsed["_r2_storage_key"] = storage_key

    job = store.create(input_path=input_path, settings=parsed)
    threading.Thread(target=_run_analyze, args=(job.id,), daemon=True).start()
    return {"job_id": job.id, **job.to_dict()}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job.to_dict()


@app.get("/jobs/{job_id}/subtitles")
def get_subtitles(job_id: str):
    """Subtitles produced by analyze, for the review editor."""
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not ready for review (status={job.status})")
    return {"subtitles": job.subtitles, "language": job.language}


@app.get("/jobs/{job_id}/preview-video")
def preview_video(job_id: str):
    """Stream the rotation-normalized source for in-browser preview.

    Starlette's FileResponse handles HTTP Range requests so the <video>
    element can seek without downloading the full file.
    """
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    # Prefer the cut preview (segments concatenated, no captions). Falls
    # back to the normalized file if the preview render isn't there yet.
    path = job.preview_path if job.preview_path else job.normalized_path
    if not path or not Path(path).exists():
        raise HTTPException(409, "preview video not ready")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )


@app.post("/jobs/{job_id}/edit-segments")
def post_edit_segments(job_id: str, payload: dict):
    """Accept a user-edited segment list and rebuild the preview video.

    Frontend sends the raw segment list after the user has trimmed,
    split, deleted, or reordered blocks in the timeline editor. We
    validate + sort + clamp against the normalized video duration,
    then re-render the preview MP4 so the player reflects the edit.

    Payload:
        {"segments": [{"start": float, "end": float}, ...]}
    """
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
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
    for s in raw:
        try:
            ss = max(0.0, float(s.get("start") or 0))
            ee = float(s.get("end") or 0)
        except Exception:
            continue
        if dur > 0:
            ee = min(ee, dur)
        if ee - ss < 0.05:
            continue
        cleaned.append((round(ss, 3), round(ee, 3)))
    if not cleaned:
        raise HTTPException(400, "no valid segments after cleaning")

    # Preserve the ORDER the user chose (drag-to-reorder is supported)
    # but merge tiny overlaps within adjacent same-ordered pairs.
    new_segments = [list(seg) for seg in cleaned]

    store.update(job_id, segments=new_segments)

    # Rebuild preview so the player reflects the edited timeline.
    try:
        preview_path = str(Path(_WORK_ROOT) / job_id / "preview.mp4")
        from backend.pipeline import _ffmpeg_cuts_preview
        _ffmpeg_cuts_preview(job.normalized_path, cleaned, preview_path)
        store.update(job_id, preview_path=preview_path)
    except Exception as e:
        print(f"[edit-segments] preview rebuild failed: {e}", flush=True)

    return store.get(job_id).to_dict()


@app.post("/jobs/{job_id}/recompute-scenes")
def post_recompute_scenes(job_id: str, payload: dict):
    """Recompute cut segments from an edited scene-event list.

    Frontend sends the user-edited event list (some toggled off, maybe
    some new ones added). We recompute the cut ranges from scratch,
    remap subtitles onto the new timeline, and update the job so the
    preview + review UI refresh.

    Payload:
        {"events": [{"type": "start"|"restart"|"keep"|"finish",
                     "start": float, "end": float}, ...]}
    """
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
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

    # Rebuild the preview video so the review UI reflects the new cuts.
    try:
        preview_path = str(Path(_WORK_ROOT) / job_id / "preview.mp4")
        from backend.pipeline import _ffmpeg_cuts_preview
        _ffmpeg_cuts_preview(job.normalized_path, new_segments, preview_path)
        store.update(job_id, preview_path=preview_path)
    except Exception as e:
        print(f"[recompute] preview rebuild failed: {e}", flush=True)

    return store.get(job_id).to_dict()


@app.post("/jobs/{job_id}/render")
def post_render(job_id: str, payload: dict):
    """Kick off the render with (possibly edited) subtitles."""
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not in review state (status={job.status})")

    edited = payload.get("subtitles")
    if not isinstance(edited, list):
        raise HTTPException(400, "payload.subtitles must be a list")
    disabled_cuts = payload.get("disabled_cuts") or []
    if not isinstance(disabled_cuts, list):
        raise HTTPException(400, "payload.disabled_cuts must be a list")

    threading.Thread(
        target=_run_render,
        args=(job_id, edited, disabled_cuts),
        daemon=True,
    ).start()
    return store.get(job_id).to_dict()


@app.get("/jobs/{job_id}/download")
def download_job(job_id: str, format: str = "primary"):
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
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
def watch_job(job_id: str, format: str = "primary"):
    """Same file as /download but without the attachment header, so
    the Library modal can play it inline via <video src=...>. Supports
    HTTP Range so seeking works without downloading the whole file."""
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
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
def job_thumbnail(job_id: str):
    """Serve the poster-frame JPG generated at render time. The file
    lives next to the primary output at a fixed filename so we can
    derive the path without storing it on the Job."""
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not job.output_path:
        raise HTTPException(409, "thumbnail not ready")
    thumb = Path(job.output_path).parent / "cleo_thumbnail.jpg"
    if not thumb.exists():
        raise HTTPException(404, "thumbnail not ready")
    return FileResponse(
        path=str(thumb),
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )
