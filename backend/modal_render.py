"""Modal.com function for the heavy render step.

Deploy with:
    modal deploy backend/modal_render.py

Then set MODAL_TOKEN_ID + MODAL_TOKEN_SECRET on Railway so the backend
can invoke this function. pipeline.py falls back to local rendering if
Modal isn't configured.

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
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "libsndfile1")
    .pip_install(
        "moviepy==1.0.3",
        "numpy>=1.21.0",
        "Pillow>=9.0.0",
        "opencv-python-headless>=4.8.0",
        "imageio_ffmpeg>=0.4.9",
        "scipy>=1.9.0",
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
    cpu=8.0,           # 8 vCPUs — enough parallelism for per-segment burn
    memory=8192,       # 8 GB RAM — MoviePy + ffmpeg for 4K sources
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
    import sys
    import tempfile
    from pathlib import Path

    # Make bundled source importable
    sys.path.insert(0, "/app")

    # Read input from Modal Volume — no bytes-through-Python transfer,
    # so Railway never has to hold the whole file in memory.
    job_dir = Path(VOLUME_MOUNT) / job_id
    input_path = job_dir / input_filename
    if not input_path.exists():
        raise FileNotFoundError(f"input not found at {input_path}")
    work_dir = Path(tempfile.mkdtemp(prefix="cleo_modal_"))

    from plugins.premiere.video_editor_premiere import _multi_clip_burn
    from backend.pipeline import (
        _ffmpeg_concat,
        _export_format,
        _generate_thumbnail,
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
        # More parallelism on Modal — we have dedicated CPU, not shared
        parallelism=8,
    )

    if not clip_outputs:
        raise RuntimeError("Modal render produced no output clips.")

    clip_paths = [p for p, _dur in clip_outputs]
    # Write outputs directly into the volume — backend downloads them
    # via the Volume SDK afterwards, no bytes-through-Python return.
    primary_out = job_dir / "output.mp4"
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
        def _do_export(fmt: str) -> tuple[str, str]:
            tw, th = EXPORT_FORMATS[fmt]
            fname = f"output_{fmt.replace(':', '-')}.mp4"
            _export_format(str(primary_out), str(job_dir / fname), tw, th)
            return fmt, fname

        with ThreadPoolExecutor(max_workers=min(4, len(valid))) as ex:
            for fmt, fname in ex.map(_do_export, valid):
                result_map[fmt] = fname

    render_volume.commit()  # persist writes so backend can read them
    return result_map
