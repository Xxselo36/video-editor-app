"""Audio measurements of the web mezz at analysis time (UT3; reviews C10,
D10): the integrated loudness for the v2 render's loudnorm, and a peaks
envelope for snapping cut edges to the quietest spot.

One ffmpeg call decodes the audio once and feeds both:
  - loudnorm=I=-14:TP=-1:LRA=11:print_format=json (measurement only, the
    output is discarded) → {I, TP, LRA, thresh, offset} (job.audio_loudness;
    UT4 passes them as measured_* to a linear loudnorm);
  - mono 16 kHz float → RMS per 10 ms frame (PEAKS_RATE = 100 Hz), stored
    as one int8 per frame (peaks.bin, job.peaks_key):

        v = round((dBFS + 96) × 127 / 96), clamped to 0..127

    i.e. 0 = −96 dBFS or quieter (digital silence), 127 = full scale,
    ≈ 0.76 dB per step. ≈ 6 KB per minute.

snap_edge(t, peaks) returns the centre of the quietest frame within
±window of t — mirrored by the web's state/snap.ts (UX10) through the
shared testdata/snap_vectors.json.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import tempfile
from typing import Sequence

PEAKS_RATE = 100          # frames per second (10 ms)
PEAKS_SR = 16000          # decode rate for the envelope
PEAKS_FLOOR_DB = -96.0    # value 0
SNAP_WINDOW_S = 0.12
LOUDNORM = "loudnorm=I=-14:TP=-1:LRA=11:print_format=json"

_FRAME = PEAKS_SR // PEAKS_RATE
_LOUDNESS_KEYS = {"input_i": "I", "input_tp": "TP", "input_lra": "LRA",
                  "input_thresh": "thresh", "target_offset": "offset"}


def _ffmpeg() -> str:
    from src.ffmpeg_utils import get_ffmpeg_path
    return get_ffmpeg_path()


def parse_loudnorm(stderr: str) -> dict | None:
    """{I, TP, LRA, thresh, offset} from loudnorm's JSON report (the last
    {...} block of ffmpeg's stderr); None without one. Non-finite values
    (-inf for digital silence) become None."""
    blocks = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr or "")
    if not blocks:
        return None
    try:
        raw = json.loads(blocks[-1])
    except json.JSONDecodeError:
        return None
    out: dict[str, float | None] = {}
    for src, dst in _LOUDNESS_KEYS.items():
        try:
            v = float(raw.get(src))
        except (TypeError, ValueError):
            v = None
        out[dst] = round(v, 2) if v is not None and math.isfinite(v) else None
    return out


def encode_frame_rms(rms: Sequence[float]):
    """int8 peaks values of per-frame RMS amplitudes (full scale = 1)."""
    import numpy as np
    r = np.maximum(np.asarray(rms, dtype=np.float64), 1e-12)
    db = 20.0 * np.log10(r)
    v = np.rint((db - PEAKS_FLOOR_DB) * 127.0 / -PEAKS_FLOOR_DB)
    return np.clip(v, 0, 127).astype(np.int8)


def analyze_audio(path: str, *, loudness: bool = True, peaks: bool = True,
                  timeout: float | None = None
                  ) -> tuple[dict | None, bytes | None]:
    """(loudness, peaks.bin bytes) of the first audio stream of `path`,
    from one decode. Either is None when not asked for or when ffmpeg
    fails (no audio stream, unreadable file): the analysis goes on
    without it."""
    if not (loudness or peaks):
        return None, None
    import numpy as np
    labels = (["[l]"] if loudness else []) + (["[p]"] if peaks else [])
    chains = [f"[0:a:0]asplit={len(labels)}{''.join(labels)}"
              if len(labels) > 1 else f"[0:a:0]anull{labels[0]}"]
    maps: list[str] = []
    if loudness:
        chains.append(f"[l]{LOUDNORM}[lo]")
        maps += ["-map", "[lo]", "-f", "null", "-"]
    if peaks:
        chains.append(f"[p]aresample={PEAKS_SR},"
                      "aformat=sample_fmts=flt:channel_layouts=mono[po]")
        maps += ["-map", "[po]", "-f", "f32le", "pipe:1"]
    cmd = [_ffmpeg(), "-nostdin", "-hide_banner", "-nostats", "-v", "info",
           "-i", path, "-vn", "-sn", "-dn",
           "-filter_complex", ";".join(chains), *maps]
    frames: list = []
    carry = np.zeros(0, dtype=np.float32)
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err,
                                stdin=subprocess.DEVNULL)
        try:
            if peaks and proc.stdout is not None:
                block = _FRAME * 4 * 1000  # 10 s of samples per read
                while True:
                    chunk = proc.stdout.read(block)
                    if not chunk:
                        break
                    buf = np.frombuffer(chunk[: len(chunk) - len(chunk) % 4],
                                        dtype=np.float32)
                    buf = np.concatenate([carry, buf]) if carry.size else buf
                    n = buf.size // _FRAME * _FRAME
                    if n:
                        sq = buf[:n].astype(np.float64).reshape(-1, _FRAME) ** 2
                        frames.append(np.sqrt(sq.mean(axis=1)))
                    carry = buf[n:].copy()
            proc.wait(timeout=timeout)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        finally:
            if proc.stdout is not None:
                proc.stdout.close()
        err.seek(0)
        stderr = err.read().decode("utf-8", "replace")
    if proc.returncode != 0:
        print(f"[audio] measurement failed (rc={proc.returncode}): "
              f"{stderr[-400:]}", flush=True)
        return None, None
    loud = parse_loudnorm(stderr) if loudness else None
    blob = None
    if peaks:
        if carry.size:
            frames.append(np.sqrt(np.array(
                [float((carry.astype(np.float64) ** 2).mean())])))
        rms = np.concatenate(frames) if frames else np.zeros(0)
        blob = encode_frame_rms(rms).tobytes()
    return loud, blob


def measure_loudness(path: str, timeout: float | None = None) -> dict | None:
    return analyze_audio(path, peaks=False, timeout=timeout)[0]


def compute_peaks(path: str, timeout: float | None = None) -> bytes | None:
    return analyze_audio(path, loudness=False, timeout=timeout)[1]


def write_peaks(path: str, out_path: str,
                timeout: float | None = None) -> tuple[dict | None, bool]:
    """analyze_audio into files: peaks.bin at `out_path` (written only
    when there are peaks). Returns (loudness, peaks written)."""
    loud, blob = analyze_audio(path, timeout=timeout)
    if blob is None:
        return loud, False
    tmp = out_path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(blob)
    os.replace(tmp, out_path)
    return loud, True


def decode_peaks(blob: bytes) -> list[int]:
    """peaks.bin → values 0..127."""
    return [b if b < 128 else b - 256 for b in blob]


def snap_edge(t: float, peaks: Sequence[int], window: float = SNAP_WINDOW_S,
              rate: int = PEAKS_RATE) -> float:
    """The centre of the quietest peaks frame within ±`window` s of `t`
    (frame i covers [i, i + 1) / rate; its centre is (i + 0.5) / rate).
    Ties go to the frame closest to t, then to the earlier one. `t`
    unchanged when no frame centre is in reach (no peaks, t outside the
    audio)."""
    n = len(peaks)
    if n == 0 or not math.isfinite(t) or rate <= 0:
        return t
    lo = max(0, math.floor((t - window) * rate - 0.5))
    hi = min(n - 1, math.ceil((t + window) * rate - 0.5))
    best = -1
    best_key: tuple[float, float, int] | None = None
    for i in range(lo, hi + 1):
        c = (i + 0.5) / rate
        d = abs(c - t)
        if d > window + 1e-9:
            continue
        key = (peaks[i], d, i)
        if best_key is None or key < best_key:
            best, best_key = i, key
    return t if best < 0 else (best + 0.5) / rate
