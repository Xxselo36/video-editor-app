# Cleo Web Backend — production image.
#
# Build from repo root:
#   docker build -f backend/Dockerfile -t cleo-backend .
#
# Run locally for parity test:
#   docker run -p 8000:8000 \
#     -e ANTHROPIC_API_KEY=... \
#     -e CLEO_CACHE_DIR=/data/cache \
#     -v $(pwd)/.cleo-data:/data \
#     cleo-backend

FROM python:3.13-slim AS base

# System deps: ffmpeg via apt (bundled imageio_ffmpeg is a fallback, but
# system ffmpeg has hardware codecs + bug fixes); libgl + libsndfile for
# opencv-python-headless / pydub.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
        libsndfile1 \
        ca-certificates \
        curl \
        fonts-dejavu-core \
        fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No torch / ultralytics layer any more: the web path never imports them
# (see backend/requirements.txt), and they were ~2 GB of every image pull.
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Project code (src/, plugins/, backend/) — everything backend.main
# transitively imports.
COPY src /app/src
COPY plugins /app/plugins
COPY backend /app/backend
# Bundled caption fonts (Bangers for Clipper; src/effects.py and the
# /caption-previews tiles look for them at src/../assets/fonts).
COPY assets/fonts /app/assets/fonts
# Noto Sans JP/KR/SC 800 (22.6 MB), subset per job for CJK transcripts
# (backend/font_subset.py), and the caption engine's script table, which
# the edit document's style choice reads (backend/doc.py).
COPY assets/caption-fonts/cjk /app/assets/caption-fonts/cjk
COPY web/src/lib/captions/script-support.json /app/web/src/lib/captions/script-support.json

# Storage layout. CLEO_CACHE_DIR is for SmartCam intermediate files
# (mounted as a persistent volume in prod). /tmp for short-lived job
# state (in-memory store is rebuilt on restart anyway).
ENV CLEO_CACHE_DIR=/data/cache \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Single worker is fine for Phase 4: Whisper + ffmpeg are CPU-bound,
# more workers just contend. Phase 3 (real queue) will add concurrency
# via separate worker processes.
#
# Bind to $PORT when set (Railway, Fly, Heroku all assign one
# dynamically); fall back to 8000 for local Docker runs.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
