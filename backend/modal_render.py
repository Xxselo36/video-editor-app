"""Modal.com function for the heavy render step.

Deploy with:
    modal deploy backend/modal_render.py

Then set MODAL_TOKEN_ID + MODAL_TOKEN_SECRET on Railway so the backend
can invoke this function. pipeline.py renders locally only when Modal
isn't configured (or CLEO_LOCAL_RENDER_FALLBACK=1); a failed Modal call
is retried and then fails the render.

Cost model: pay-per-second CPU time only when a job is running.
Idle = $0. A 10-min video render at ~2-3 min on 8-CPU worker ≈ $0.05.
Compared to ~$0.50 on Railway shared tier.

The function takes the pre-normalized video + all cut/caption info and
returns the finished primary + extra-format MP4s as raw bytes.
"""
from __future__ import annotations

import modal

app = modal.App("cleocuts-render")

# Modal Volume for large-file transfer between Railway and Modal.
# The backend writes normalized.mp4 into the volume (streamed, no
# Railway RAM spike); the function reads it from the mounted path
# and writes outputs back. Volumes persist across function calls
# so cleanup is a separate step.
render_volume = modal.Volume.from_name(
    "cleocuts-render-volume", create_if_missing=True,
)
VOLUME_MOUNT = "/vol"

image = (
    modal.Image.debian_slim(python_version="3.13")
    # Fonts: caption burn-in looks for DejaVu/Liberation on Linux; without
    # them Pillow falls back to its tiny bitmap font (same as Dockerfile).
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "libsndfile1",
                 "fonts-dejavu-core", "fonts-liberation2")
    .pip_install(
        "moviepy==1.0.3",
        "numpy>=1.21.0",
        "Pillow>=9.0.0",
        "opencv-python-headless>=4.8.0",
        "imageio_ffmpeg>=0.4.9",
        "scipy>=1.9.0",
        # No faster-whisper / ultralytics (torch): the render path never
        # uses them (src/audio.py imports faster_whisper lazily now;
        # checked by running this function's calls with both blocked).
        "pydub>=0.25.1",
        "anthropic==0.111.0",
        "openai>=1.50.0",
    )
    # Bundle the SmartCut source so _multi_clip_burn + _ffmpeg_concat
    # + _export_format can all run inside the Modal container without
    # network round-trips per segment.
    .add_local_dir("src", remote_path="/app/src")
    .add_local_dir("plugins", remote_path="/app/plugins")
    .add_local_dir("backend", remote_path="/app/backend")
)


@app.function(
    image=image,
    # 8 cores: a live test with 16 (10 min video) rendered slower and
    # cost 2.5x as much on Modal, so more cores don't pay off here.
    cpu=8.0,
    memory=8192,
    timeout=1800,      # 30 min hard cap per render
    volumes={VOLUME_MOUNT: render_volume},
)
def render_burn_concat(
    job_id: str,
    input_filename: str,
    segments: list[list[float]],
    subtitles: list[dict],
    caption_preset: str,
    cut_style: str,
    language: str | None,
    output_formats: list[str],
) -> dict[str, str]:
    """Run the burn + concat + multi-format-export pipeline on Modal.

    Reads input from /vol/<job_id>/<input_filename>, writes outputs to
    /vol/<job_id>/output.mp4 (+ extra formats + thumbnail). Returns a
    dict mapping format-name → filename inside the job's volume dir.
    Backend downloads them afterwards via the Volume SDK.
    """
    import os
    import shutil
    import sys
    import tempfile
    from pathlib import Path

    # Make bundled source importable
    sys.path.insert(0, "/app")
    # pipeline.py caps ffmpeg at 4 threads for the shared API box; this
    # container's 8 cores are all ours.
    os.environ.setdefault("CLEO_FFMPEG_THREADS", "0")

    # Read input from Modal Volume — no bytes-through-Python transfer,
    # so Railway never has to hold the whole file in memory.
    job_dir = Path(VOLUME_MOUNT) / job_id
    input_path = job_dir / input_filename
    # A warm container (previous render, or the ops-watch probe) still
    # sees the volume as it was when it started: without a reload the
    # input the backend just committed is missing, and every retry lands
    # on the same container.
    try:
        render_volume.reload()
    except Exception as e:  # never worse than before: check the file anyway
        print(f"[modal] volume reload failed: {e}", flush=True)
    if not input_path.exists():
        raise FileNotFoundError(f"input not found at {input_path}")
    work_dir = Path(tempfile.mkdtemp(prefix="cleo_modal_"))
    # The burned clips are one user's video: never leave them on a
    # warm container that serves the next render.
    try:
        from plugins.premiere.video_editor_premiere import _multi_clip_burn
        from backend.pipeline import (
            _ffmpeg_concat,
            _export_format,
            _generate_thumbnail,
            _video_size,
            EXPORT_FORMATS,
        )

        burn_dir = work_dir / "burn"
        burn_dir.mkdir()

        # Convert segments back from JSON-friendly list-of-lists to tuples
        seg_tuples = [(float(s), float(e)) for s, e in segments]

        clip_outputs = _multi_clip_burn(
            input_video=str(input_path),
            segments=seg_tuples,
            subtitles=subtitles,
            caption_preset=caption_preset,
            output_dir=str(burn_dir),
            cut_style=cut_style,
            language=language,
            # One clip per core — dedicated CPU, not shared
            parallelism=8,
            # render_only already merged tiny gaps (keeping per-segment
            # effects aligned); don't merge again here.
            merge_gap=0.0,
        )

        if not clip_outputs:
            raise RuntimeError("Modal render produced no output clips.")

        clip_paths = [p for p, _dur in clip_outputs]
        # Write outputs directly into the volume — backend downloads them
        # via the Volume SDK afterwards, no bytes-through-Python return.
        primary_out = job_dir / "output.mp4"
        # Old-signature concat call — bit-perfect audio rebuild happens on
        # Railway's local fallback path only until Modal issue is diagnosed.
        _ffmpeg_concat(clip_paths, str(primary_out))

        thumbnail_out = job_dir / "thumbnail.jpg"
        _generate_thumbnail(str(primary_out), str(thumbnail_out))

        result_map: dict[str, str] = {"primary": "output.mp4"}
        if thumbnail_out.exists():
            result_map["_thumbnail"] = "thumbnail.jpg"

        # Extra formats — parallel encode from primary
        from concurrent.futures import ThreadPoolExecutor
        valid = [f for f in output_formats if f in EXPORT_FORMATS]
        if valid:
            primary_size = _video_size(str(primary_out))

            def _do_export(fmt: str) -> tuple[str, str]:
                tw, th = EXPORT_FORMATS[fmt]
                if primary_size == (tw, th):
                    # Primary already has this size: point at it, so the
                    # backend downloads and stores it only once.
                    return fmt, "output.mp4"
                fname = f"output_{fmt.replace(':', '-')}.mp4"
                _export_format(str(primary_out), str(job_dir / fname), tw, th)
                return fmt, fname

            with ThreadPoolExecutor(max_workers=min(4, len(valid))) as ex:
                for fmt, fname in ex.map(_do_export, valid):
                    result_map[fmt] = fname

        render_volume.commit()  # persist writes so backend can read them
        return result_map
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
