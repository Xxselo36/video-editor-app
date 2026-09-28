"""Per-job cost tracking — what one video costs us to process.

Every paid step records its usage against the job that is running in
the current worker thread:

    with costs.tracking(job_id, "analyze"):
        ...  # Groq, Claude, CPU, Modal calls inside record themselves

Usage is summed into Job.costs (raw units + USD), so GET /admin/costs
can report cost per job and per video minute — the basis for pricing.

All rates are ESTIMATES in USD and can be overridden without a deploy
via CLEO_COST_RATES='{"railway_vcpu_s": 0.0000077, ...}'. Check them
against the providers' current price pages before relying on them.
"""
from __future__ import annotations

import json
import os
import resource
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

RATES: dict[str, float] = {
    # Claude, $ per token (input, output; cache write 1.25x, read 0.1x)
    "claude-haiku-4-5:in": 1.00 / 1e6,
    "claude-haiku-4-5:out": 5.00 / 1e6,
    "claude-sonnet-4-6:in": 3.00 / 1e6,
    "claude-sonnet-4-6:out": 15.00 / 1e6,
    # Groq Whisper, $ per audio second (whisper-large-v3: $0.111 / hour)
    "groq_whisper_s": 0.111 / 3600,
    # Railway: $20 per vCPU-month, $10 per GB-month (RAM), $0.15 per
    # GB-month (volume)
    "railway_vcpu_s": 20.0 / (30 * 86400),
    "railway_ram_gb_s": 10.0 / (30 * 86400),
    "railway_volume_gb_month": 0.15,
    # Modal: per physical core-second and GiB-second; the render
    # function asks for cpu=16, memory=16 GiB (backend/modal_render.py)
    "modal_core_s": 0.0000131,
    "modal_gib_s": 0.00000222,
    "modal_cores": 16,
    "modal_gib": 16,
}
try:
    RATES.update(json.loads(os.environ.get("CLEO_COST_RATES", "") or "{}"))
except ValueError:
    print("[costs] CLEO_COST_RATES is not valid JSON — using defaults",
          flush=True)

_local = threading.local()


def _cpu_seconds() -> float:
    """Process + child-process CPU time (ffmpeg runs as a subprocess)."""
    own = resource.getrusage(resource.RUSAGE_SELF)
    kids = resource.getrusage(resource.RUSAGE_CHILDREN)
    return own.ru_utime + own.ru_stime + kids.ru_utime + kids.ru_stime


def _add(bucket: dict[str, float], key: str, value: float) -> None:
    bucket[key] = bucket.get(key, 0.0) + float(value)


def _current() -> dict[str, float] | None:
    return getattr(_local, "bucket", None)


def record_claude(model: str, usage: Any) -> None:
    """Add one messages.create() usage block (tokens + USD)."""
    bucket = _current()
    if bucket is None or usage is None:
        return
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    c_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    c_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    rate_in = RATES.get(f"{model}:in", RATES["claude-sonnet-4-6:in"])
    rate_out = RATES.get(f"{model}:out", RATES["claude-sonnet-4-6:out"])
    _add(bucket, "claude_tokens_in", inp + c_write + c_read)
    _add(bucket, "claude_tokens_out", out)
    _add(bucket, "usd_claude",
         inp * rate_in + c_write * rate_in * 1.25 + c_read * rate_in * 0.1
         + out * rate_out)


def record_groq(audio_seconds: float) -> None:
    """Add one Groq transcription request (billed min. 10 s each)."""
    bucket = _current()
    if bucket is None:
        return
    billed = max(10.0, float(audio_seconds or 0))
    _add(bucket, "groq_audio_s", billed)
    _add(bucket, "usd_groq", billed * RATES["groq_whisper_s"])


def record_modal(wall_seconds: float) -> None:
    """Add one Modal render call (container time ≈ call wall time)."""
    bucket = _current()
    if bucket is None:
        return
    per_s = (RATES["modal_core_s"] * RATES["modal_cores"]
             + RATES["modal_gib_s"] * RATES["modal_gib"])
    _add(bucket, "modal_s", wall_seconds)
    _add(bucket, "usd_modal", wall_seconds * per_s)


def storage_usd(total_bytes: int, days: float) -> float:
    """Volume cost of keeping `total_bytes` for `days`."""
    gb = total_bytes / 1e9
    return gb * RATES["railway_volume_gb_month"] * days / 30


def dir_bytes(path: Path) -> int:
    total = 0
    if path.exists():
        for f in path.rglob("*"):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


@contextmanager
def tracking(job_id: str, stage: str):
    """Collect this thread's usage for `stage` and save it on the job.

    CPU time is measured for the whole process, so jobs that run at
    the same time share their numbers — fine for averages, not exact
    per job. RAM is estimated as 2 GB while the stage runs.
    """
    from backend.jobs import store

    bucket: dict[str, float] = {}
    _local.bucket = bucket
    cpu0, t0 = _cpu_seconds(), time.monotonic()
    try:
        yield bucket
    finally:
        _local.bucket = None
        cpu_s = max(0.0, _cpu_seconds() - cpu0)
        wall_s = time.monotonic() - t0
        _add(bucket, "railway_cpu_s", cpu_s)
        _add(bucket, f"wall_s_{stage}", wall_s)
        _add(bucket, "usd_railway",
             cpu_s * RATES["railway_vcpu_s"]
             + wall_s * 2 * RATES["railway_ram_gb_s"])
        try:
            job = store.get(job_id)
            if job is not None:
                merged = dict(job.costs or {})
                for k, v in bucket.items():
                    _add(merged, k, v)
                merged["usd_total"] = sum(
                    v for k, v in merged.items()
                    if k.startswith("usd_") and k != "usd_total")
                store.update(job_id, costs=merged, updated_at=job.updated_at)
        except Exception as e:  # never break a job over bookkeeping
            print(f"[costs] save failed for {job_id}: {e}", flush=True)
