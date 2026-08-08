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
)
def render_burn_concat(
    input_bytes: bytes,
    input_filename: str,
    segments: list[list[float]],
    subtitles: list[dict],
    caption_preset: str,
    cut_style: str,
    language: str | None,
    output_formats: list[str],
) -> dict[str, bytes]:
    """Run the burn + concat + multi-format-export pipeline on Modal.

    Returns {"primary": <bytes>, "9:16": <bytes>, "1:1": <bytes>, ...}
    with only the formats the user requested (plus "primary" always).
    """
    import os
    import sys
    import tempfile
    from pathlib import Path

    # Make bundled source importable
    sys.path.insert(0, "/app")

    # Write input video to disk so ffmpeg / moviepy can read it
    work_dir = Path(tempfile.mkdtemp(prefix="cleo_modal_"))
    input_path = work_dir / input_filename
    with open(input_path, "wb") as f:
        f.write(input_bytes)

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
    primary_path = str(work_dir / "cleo_output.mp4")
    _ffmpeg_concat(clip_paths, primary_path)

    thumbnail_path = str(work_dir / "cleo_thumbnail.jpg")
    _generate_thumbnail(primary_path, thumbnail_path)

    outputs: dict[str, bytes] = {}
    with open(primary_path, "rb") as f:
        outputs["primary"] = f.read()
    if os.path.exists(thumbnail_path):
        with open(thumbnail_path, "rb") as f:
            outputs["_thumbnail"] = f.read()

    # Extra formats — encode in parallel too (all read from primary)
    from concurrent.futures import ThreadPoolExecutor
    valid = [f for f in output_formats if f in EXPORT_FORMATS]
    if valid:
        def _do_export(fmt: str) -> tuple[str, bytes]:
            tw, th = EXPORT_FORMATS[fmt]
            fmt_path = str(
                work_dir / f"cleo_output_{fmt.replace(':', '-')}.mp4"
            )
            _export_format(primary_path, fmt_path, tw, th)
            with open(fmt_path, "rb") as f:
                return fmt, f.read()

        with ThreadPoolExecutor(max_workers=min(4, len(valid))) as ex:
            for fmt, data in ex.map(_do_export, valid):
                outputs[fmt] = data

    return outputs
