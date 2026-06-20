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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install CPU-only torch FIRST in its own layer — biggest dep, cache it
# so changes to other deps don't force a 2 GB re-download.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
        torch \
        torchvision

COPY backend/requirements.txt /tmp/requirements.txt
# Strip torch/torchvision lines from requirements.txt — already
# installed above with the right wheel-index.
RUN grep -v -E "^(torch|torchvision)" /tmp/requirements.txt > /tmp/req.txt \
    && pip install --no-cache-dir -r /tmp/req.txt

# Project code (src/, plugins/, backend/) — everything backend.main
# transitively imports.
COPY src /app/src
COPY plugins /app/plugins
COPY backend /app/backend

# Storage layout. CLEO_CACHE_DIR is for SmartCam intermediate files
# (mounted as a persistent volume in prod). /tmp for short-lived job
# state (in-memory store is rebuilt on restart anyway).
ENV CLEO_CACHE_DIR=/data/cache \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Single worker is fine for Phase 4: Whisper + ffmpeg are CPU-bound,
# more workers just contend. Phase 3 (real queue) will add concurrency
# via separate worker processes.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
