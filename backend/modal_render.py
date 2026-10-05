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

Two functions:
  - render_burn_concat: the volume path (the backend uploads the source
    into a Modal Volume and downloads the outputs) — the default.
  - render_r2 (WP3, opt-in: CLEO_MODAL_RENDER_FN=render_r2 on Railway,
    for jobs whose media is in R2): reads the job's mezz object from R2
    and writes every output (primary, formats, hook clips, thumbnail)
    back to R2 under the render's prefix. Needs the Modal secret
    "cleocuts-r2" (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
    R2_BUCKET — see DEPLOY.md, "Media storage"). Only deployed with
    CLEO_MODAL_R2=1 in the deploying environment (the GitHub workflow
    sets it when that secret exists): Modal resolves the secret before
    it publishes, so without it the whole deploy — render_burn_concat
    included — would fail. The backend falls back to the volume path
    while render_r2 isn't deployed.

And one for the analysis (WP4 phase P1, opt-in: CLEO_EXECUTOR_INGEST=
modal with CLEO_TASK_QUEUE=1 on Railway):
  - analyze_r2: an upload's whole analysis, R2 in and out
    (backend/modal_analyze.py; the API side is backend/executor_modal.py).
    Needs "cleocuts-r2" and "cleocuts-ai" (GROQ_API_KEY,
    ANTHROPIC_API_KEY — DEPLOY.md 11.5); only deployed with
    CLEO_MODAL_ANALYZE=1 (the workflow sets it when both secrets exist).
"""
from __future__ import annotations

import os

import modal

# render_r2 in this deploy? Decided where `modal deploy` runs; inside
# Modal's containers the module is imported again without that env var
# (only the running function is hydrated there), so it is always
# defined in the container.
WITH_R2 = (os.environ.get("CLEO_MODAL_R2", "").strip() == "1"
           or not modal.is_local())
# analyze_r2 (WP4 P1, CLEO_EXECUTOR_INGEST=modal) in this deploy? Needs
# both Modal secrets, cleocuts-r2 and cleocuts-ai (the Groq / Anthropic
# keys): the workflow sets CLEO_MODAL_ANALYZE=1 only when both exist —
# like render_r2, a missing secret would fail the whole deploy.
WITH_ANALYZE = WITH_R2 and (
    os.environ.get("CLEO_MODAL_ANALYZE", "").strip() == "1"
    or not modal.is_local())

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

# Node for the UT4 caption layer (the version the tests run on).
NODE_VERSION = "22.22.2"
NODE_SHA256 = "88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a"
CAPTIONS_ROOT = "/opt/cleo-captions"

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
        # render_r2 reads / writes R2 (backend/storage.py); same pin as
        # backend/requirements.txt (the day-aligned signer uses botocore
        # internals).
        "boto3>=1.43,<1.44",
        "botocore>=1.43,<1.44",
    )
    # UT4 caption layer (backend/captions_v2.py): Node 22 (official
    # build, checksum pinned) + backend/captions (npm ci: @napi-rs/canvas
    # prebuilt linux-x64-gnu, harfbuzzjs, esbuild) bundling the editor's
    # caption engine (web/src/lib/captions) at image build time. Built
    # in /opt/cleo-captions: the backend/ mount below would hide a build
    # inside /app/backend. Copied (copy=True), so these layers rebuild
    # only when those files change.
    .apt_install("ca-certificates", "curl", "xz-utils")
    .run_commands(
        f"curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v{NODE_VERSION}/"
        f"node-v{NODE_VERSION}-linux-x64.tar.xz",
        f"echo '{NODE_SHA256}  /tmp/node.tar.xz' | sha256sum -c -",
        "tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 "
        "--exclude='*/include' --exclude='*/share' && rm /tmp/node.tar.xz",
        "node --version",
    )
    .add_local_file("backend/captions/package.json",
                    f"{CAPTIONS_ROOT}/backend/captions/package.json", copy=True)
    .add_local_file("backend/captions/package-lock.json",
                    f"{CAPTIONS_ROOT}/backend/captions/package-lock.json", copy=True)
    .run_commands(f"cd {CAPTIONS_ROOT}/backend/captions && npm ci --no-audit --no-fund")
    .add_local_file("backend/captions/build.mjs",
                    f"{CAPTIONS_ROOT}/backend/captions/build.mjs", copy=True)
    .add_local_dir("web/src/lib/captions",
                   f"{CAPTIONS_ROOT}/web/src/lib/captions", copy=True,
                   ignore=["__tests__"])
    .run_commands(
        f"cd {CAPTIONS_ROOT}/backend/captions && node build.mjs "
        "&& npm prune --omit=dev --no-audit --no-fund")
    .env({"CLEO_CAPTION_LAYER_DIR": f"{CAPTIONS_ROOT}/backend/captions"})
    # Bundle the SmartCut source so _multi_clip_burn + _ffmpeg_concat
    # + _export_format can all run inside the Modal container without
    # network round-trips per segment.
    .add_local_dir("src", remote_path="/app/src")
    .add_local_dir("plugins", remote_path="/app/plugins")
    .add_local_dir("backend", remote_path="/app/backend",
                   ignore=["captions/node_modules", "**/__pycache__"])
    # The caption faces the editor loads (same files: woff2 / Devanagari
    # .ttf) and the script table backend/doc.py reads.
    .add_local_dir("web/public/fonts/captions",
                   remote_path="/app/web/public/fonts/captions")
    .add_local_file("web/src/lib/captions/script-support.json",
                    "/app/web/src/lib/captions/script-support.json")
    # Bundled caption fonts (Bangers for Clipper): src/effects.py looks
    # for them at src/../assets/fonts. Without this Clipper burned in
    # DejaVu Sans Bold (captions.md C4).
    .add_local_dir("assets/fonts", remote_path="/app/assets/fonts")
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
            web_burn_kwargs,
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
            # The web's caption options (one clip per caption, bounce
            # around the caption, web positions); computed here, in the
            # container, so the spawn signature doesn't change.
            **web_burn_kwargs(caption_preset),
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


if WITH_R2:
    @app.function(
        image=image,
        cpu=8.0,
        memory=8192,
        timeout=3600,      # pipeline._MODAL_FUNCTION_TIMEOUT_S follows it
        secrets=[modal.Secret.from_name("cleocuts-r2")],
    )
    def render_r2(
        job_id: str,
        gen: int,
        mezz_key: str,
        out_prefix: str,
        segments: list[list[float]],
        subtitles: list[dict],
        caption_preset: str,
        cut_style: str,
        language: str | None,
        output_formats: list[str],
        segment_effects: list[dict],
        hooks: list[dict],
        bucket: str | None = None,
        captions: dict | None = None,
    ) -> dict:
        """One render, R2 in and out: get the mezz to local SSD, then burn →
        concat → effects → thumbnail → formats → hook cuts, and put every
        output under `out_prefix` (jobs/{job_id}/r{gen}/). Same-size formats
        alias the primary's key. Returns {outputs: {fmt: {key, size}},
        thumb: {key, size} | None, hooks: [{k, key, size, title, reason,
        start, end}], timings}. Outputs are written locally and uploaded —
        never through a CloudBucketMount (faststart needs seek).

        `captions` (UT4, backend/captions_v2.py): a v2 render — the
        editor's caption engine (Node, /app/backend/captions) draws the
        captions into one cut + overlay + encode pass. None: v1."""
        import os
        import shutil
        import sys
        import tempfile
        import time
        from pathlib import Path

        sys.path.insert(0, "/app")
        os.environ.setdefault("CLEO_FFMPEG_THREADS", "0")
        if not out_prefix.startswith(f"jobs/{job_id}/r{int(gen)}/"):
            raise ValueError(f"out_prefix {out_prefix!r} doesn't belong to "
                             f"job {job_id} r{gen}")
        from backend import storage
        from backend.pipeline import render_to_dir, store_render_files
        if bucket is not None and bucket != storage.bucket():
            # The secret points at another bucket than the API's: the
            # mezz isn't there, and outputs would land where nobody
            # finds them.
            raise ValueError(f"bucket mismatch: the API uses {bucket!r}, "
                             "the Modal secret cleocuts-r2 "
                             f"{storage.bucket()!r}")

        work = Path(tempfile.mkdtemp(prefix="cleo_r2_"))
        timings: dict[str, float] = {}
        try:
            t = time.monotonic()
            mezz = work / "mezz.mp4"
            storage.get_file(mezz_key, str(mezz))
            timings["get"] = round(time.monotonic() - t, 3)
            files = render_to_dir(
                str(mezz), str(work / "out"),
                [(float(s), float(e)) for s, e in segments],
                segment_effects or [], subtitles, caption_preset, cut_style,
                language, output_formats or [], hooks or [],
                parallelism=8, timings=timings, captions=captions,
                fetch=storage.get_file)
            t = time.monotonic()
            result = store_render_files(files, out_prefix, storage.put_file)
            timings["put"] = round(time.monotonic() - t, 3)
            result["timings"] = timings
            return result
        finally:
            # One user's video: never left on a warm container.
            shutil.rmtree(work, ignore_errors=True)


# ── analysis (WP4 phase P1) ──────────────────────────────────────────
# What the API box's image (backend/Dockerfile) has for an analysis:
# Python 3.13, ffmpeg from apt, backend/requirements.txt's media and LLM
# packages (no Node / caption layer, no local Whisper — Groq does the
# transcription; CLEO_LOCAL_WHISPER=0 makes a missing GROQ_API_KEY a
# loud failure instead of a silent fallback), the caption fonts and the
# CJK faces font_subset cuts per job. Like the Dockerfile it leaves out
# assets/models (YuNet): the same SmartCam result as on Railway.
analyze_image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "libsndfile1",
                 "ca-certificates", "fonts-dejavu-core", "fonts-liberation2")
    .pip_install(
        "moviepy==1.0.3",
        "numpy>=1.21.0",
        "Pillow>=9.0.0",
        "opencv-python-headless>=4.8.0",
        "imageio_ffmpeg>=0.4.9",
        "scipy>=1.9.0",
        "pydub>=0.25.1",
        "anthropic==0.111.0",
        "openai>=1.50.0",
        # backend/font_subset.py: same pins as backend/requirements.txt
        # (the subset bytes depend on them).
        "fonttools==4.66.0",
        "brotli==1.2.0",
        "psutil>=5.9.0",
        "boto3>=1.43,<1.44",
        "botocore>=1.43,<1.44",
    )
    .env({"CLEO_LOCAL_WHISPER": "0", "CLEO_CACHE_DIR": "/tmp/cleo-cache",
          "PYTHONUNBUFFERED": "1"})
    .add_local_dir("src", remote_path="/app/src")
    .add_local_dir("plugins", remote_path="/app/plugins")
    .add_local_dir("backend", remote_path="/app/backend",
                   ignore=["captions/node_modules", "**/__pycache__",
                           "tests"])
    .add_local_dir("assets/fonts", remote_path="/app/assets/fonts")
    .add_local_dir("assets/caption-fonts/cjk",
                   remote_path="/app/assets/caption-fonts/cjk")
    .add_local_file("web/src/lib/captions/script-support.json",
                    "/app/web/src/lib/captions/script-support.json")
)


if WITH_ANALYZE:
    @app.function(
        image=analyze_image,
        # A 4K HEVC iPhone clip: decode + the mezz encode + SmartCam use
        # the cores; the audio passes hold the whole track in RAM
        # (~1.3 GB for 30 min at 44.1 kHz).
        cpu=8.0,
        memory=16384,
        # The upload, its mezz, the proxy and the previews: ~3.5 × the
        # upload (4 GB → ~14 GB); 100 GiB leaves room.
        ephemeral_disk=100 * 1024,
        # Up to CLEO_MAX_MINUTES of 4K source; the API waits at most this
        # + 5 min (backend/executor_modal.py FUNCTION_TIMEOUT_S).
        timeout=7200,
        # Idle containers are billed: hand them back soon (a cold start
        # is seconds next to a multi-minute analysis).
        scaledown_window=10,
        secrets=[modal.Secret.from_name("cleocuts-r2"),
                 modal.Secret.from_name("cleocuts-ai")],
    )
    def analyze_r2(
        job_id: str,
        source_key: str,
        settings: dict,
        token: str,
        degraded: bool = False,
        env: dict | None = None,
        bucket: str | None = None,
        gate: bool = False,
    ) -> dict:
        """One upload's analysis, R2 in and out (backend/modal_analyze.py
        run): the upload `source_key` → pipeline.analyze_only → mezz,
        proxy, preview, peaks, poster, font subsets, filmstrip under
        jobs/{job_id}/. Returns {res, stored, usage, obs, timings} or
        {error, usage, obs, timings}; the API commits it."""
        import sys
        sys.path.insert(0, "/app")
        from backend import modal_analyze
        modal_analyze.apply_env(env)
        return modal_analyze.run(job_id, source_key, settings, token=token,
                                 degraded=degraded, bucket=bucket,
                                 gate=gate)
