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

import json
import shutil
import tempfile
import threading
import traceback
from pathlib import Path

import io

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from backend.jobs import store
from backend.pipeline import analyze_only, render_only

app = FastAPI(
    title="Cleo Web Backend",
    version="0.1.0",
    description="Voice-first AI video editor — backend for web app.",
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
        )
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[job {job_id}] ANALYZE FAILED: {e}\n{tb}", flush=True)
        store.update(job_id, status="error", message=str(e), error=str(e))


def _run_render(
    job_id: str,
    edited_subtitles: list,
    disabled_cuts: list[int] | None = None,
) -> None:
    """Worker: render + concat into final MP4."""
    job = store.get(job_id)
    if job is None or job.normalized_path is None:
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


@app.post("/jobs")
async def create_job(
    file: UploadFile = File(...),
    settings: str = Form("{}"),
):
    """Upload + start analyze. Job pauses for subtitle review."""
    try:
        parsed = json.loads(settings)
    except json.JSONDecodeError:
        raise HTTPException(400, "settings must be valid JSON")

    suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
    job_input_dir = _WORK_ROOT / "uploads"
    job_input_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        delete=False, suffix=suffix, dir=str(job_input_dir)
    ) as f:
        shutil.copyfileobj(file.file, f)
        input_path = f.name

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
