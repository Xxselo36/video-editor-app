"""A/V test media: a generated source whose every frame carries its own
index (a 12-bit barcode in the top band, x264-proof) and whose audio is
seeded noise, and readers that say, for every frame of a render, which
source frame it shows and from which source time its sound comes
(cross-correlation with the source's own decoded audio, to the sample).
No binary media in git: made at test time with the renderer's ffmpeg
(caption_media.ffmpeg).
"""
from __future__ import annotations

import json
import math
import subprocess
import wave
from fractions import Fraction
from pathlib import Path

import caption_media as cm
import numpy as np

BITS = 12
BAR_H = 32
SR = 48000


def _noise_wav(path: Path, seconds: float, seed: int = 11) -> None:
    n = round(seconds * SR)
    x = np.random.default_rng(seed).normal(0, 1, n + 64)
    x = np.convolve(x, np.ones(8) / 8.0, mode="same")[:n]   # AAC keeps its shape
    pcm = (0.25 * x / np.max(np.abs(x)) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())


def make_source(path: Path, *, w: int, h: int, rate: str, seconds: float,
                keep: tuple[int, list[int]] | None = None) -> Path:
    """H.264 + AAC: frame i of the `rate` grid shows i; `keep` = (period,
    residues) makes it VFR — only the grid frames i with i % period in
    residues, at their own times."""
    path = Path(path)
    n = math.floor(seconds * Fraction(rate))
    wav = path.with_suffix(".wav")
    _noise_wav(wav, seconds)
    base = np.asarray(cm.background(w, h), dtype=np.uint8)
    bw = w // BITS
    vf: list[str] = []
    if keep is not None:
        period, residues = keep
        vf = ["-vf", "select='" + "+".join(f"eq(mod(n\\,{period})\\,{r})"
                                          for r in residues) + "'",
              "-fps_mode", "vfr"]
    cmd = [cm.ffmpeg(), "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", rate,
           "-i", "-", "-i", str(wav), *vf,
           "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
           "-pix_fmt", "yuv420p", "-g", "30",
           "-c:a", "aac", "-b:a", "192k", "-shortest", str(path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for i in range(n):
            frame = base.copy()
            for b in range(BITS):
                frame[:BAR_H, b * bw:(b + 1) * bw] = 255 if (i >> (BITS - 1 - b)) & 1 else 0
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        rc = proc.wait()
        wav.unlink(missing_ok=True)
    if rc != 0:
        raise RuntimeError(f"ffmpeg failed making {path} (exit {rc})")
    return path


def _probe(path: Path, *args: str) -> dict:
    from src.ffmpeg_utils import get_ffprobe_path
    r = subprocess.run([get_ffprobe_path(), "-v", "error", *args, "-of", "json", str(path)],
                       capture_output=True, text=True, timeout=120, check=False)
    return json.loads(r.stdout or "{}")


def frames(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """(pts of every frame, the source frame index it shows)."""
    st = _probe(path, "-select_streams", "v:0", "-show_entries", "stream=width")["streams"][0]
    w = int(st["width"])
    f = _probe(path, "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time")
    pts = np.array([float(x["best_effort_timestamp_time"]) for x in f.get("frames", [])])
    raw = subprocess.run([cm.ffmpeg(), "-v", "error", "-i", str(path), "-map", "0:v:0",
                          "-fps_mode", "passthrough", "-vf", f"crop={w}:{BAR_H}:0:0",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, timeout=300, check=True).stdout
    n = len(raw) // (w * BAR_H)
    band = np.frombuffer(raw, np.uint8)[:n * w * BAR_H].reshape(n, BAR_H, w)
    bw = w // BITS
    bits = band[:, BAR_H // 2, [b * bw + bw // 2 for b in range(BITS)]] > 128
    return pts[:n], bits.astype(np.int64) @ (1 << np.arange(BITS - 1, -1, -1))


def audio(path: Path) -> tuple[float, np.ndarray]:
    """(time of the first sample, mono samples at SR)."""
    f = _probe(path, "-select_streams", "a:0", "-show_entries",
               "frame=best_effort_timestamp_time", "-read_intervals", "%+#4")
    a0 = float(f["frames"][0]["best_effort_timestamp_time"])
    raw = subprocess.run([cm.ffmpeg(), "-v", "error", "-i", str(path), "-map", "0:a:0",
                          "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, timeout=300, check=True).stdout
    return a0, np.frombuffer(raw, np.float32).astype(np.float64)


def streams(path: Path) -> dict:
    """{v: {start, duration}, a: {…}} of the first video / audio stream."""
    out = {}
    for sel, key in (("v:0", "v"), ("a:0", "a")):
        s = (_probe(path, "-select_streams", sel, "-show_entries",
                    "stream=start_time,duration").get("streams") or [None])[0]
        if s:
            out[key] = {"start": float(s["start_time"]), "duration": float(s["duration"])}
    return out


class Source:
    def __init__(self, path: Path):
        self.path = Path(path)
        pts, idx = frames(self.path)
        self.time_of = {int(i): float(t) for t, i in zip(pts, idx)}
        self.a0, self.pcm = audio(self.path)

    def sound_time(self, y: np.ndarray, guess: float, search: float = 0.15) -> float:
        """Source time the samples `y` come from (searched around `guess`)."""
        L = len(y)
        lo = max(0, round((guess - search - self.a0) * SR))
        x = self.pcm[lo:round((guess + search - self.a0) * SR) + L]
        spec = np.fft.rfft(x, len(x) + L)
        c = np.fft.irfft(spec * np.conj(np.fft.rfft(y, len(x) + L)))[:len(x) - L + 1]
        e = np.sqrt(np.maximum(np.convolve(x * x, np.ones(L), "valid"), 1e-18))
        return self.a0 + (lo + int(np.argmax(c / e))) / SR


def plan(segments, fps: float, effects=None) -> list[dict]:
    """The clips a frame-exact render makes: both edges on the nearest
    frame, clips without a frame dropped, `frames` = output frames
    (clip_frames: a sped-up clip's length rounded to whole frames)."""
    fx = effects if effects and len(effects) == len(segments) else [{}] * len(segments)
    out, t = [], 0
    for (s, e), eff in zip(segments, fx):
        a, b = round(s * fps), round(e * fps)
        if b - a < 1:
            continue
        speed = float((eff or {}).get("speed") or 1.0)
        n = max(1, math.floor((b - a) / speed + 0.5 + 1e-9))
        out.append({"first": a, "src_frames": b - a, "frames": n, "out_first": t,
                    "speed": speed, "fx": eff or {}})
        t += n
    return out


def check(out: Path, src: Source, clips: list[dict], fps: float, *,
          points: int = 4, win: float = 0.03) -> dict:
    """What a render did against its plan: frame count; for every frame
    outside fades the source frame it shows vs. the one the plan puts
    there (`video_err`, in frames); at a few points per speed-1 clip the
    source time of the sound vs. of the picture (`av_ms`)."""
    pts, idx = frames(out)
    a0, pcm = audio(out)
    video_err: list[float] = []
    av_ms: list[float] = []
    for c in clips:
        fi = float(c["fx"].get("fadeIn") or 0)
        fo = float(c["fx"].get("fadeOut") or 0)
        for j in range(c["frames"]):
            n = c["out_first"] + j
            if n >= len(idx):
                break
            if (fi and j / fps < fi) or (fo and (c["frames"] - j) / fps <= fo):
                continue           # faded: the barcode is dimmed
            want = c["first"] + j * c["src_frames"] / c["frames"]
            got = src.time_of.get(int(idx[n]), float("nan")) * fps
            video_err.append(got - want)
        # sound checked at speed 1, away from the clip's edges and fades
        lo = 2 + math.ceil(fi * fps)
        hi = c["frames"] - 3 - math.ceil(win * fps) - math.ceil(fo * fps)
        if abs(c["speed"] - 1.0) > 1e-3 or hi - lo < points:
            continue
        for k in range(points):
            j = lo + (hi - lo) * k // max(1, points - 1)
            n = c["out_first"] + j
            if n >= len(pts):
                break
            i0 = round((pts[n] - a0) * SR)
            y = pcm[i0:i0 + int(win * SR)]
            if i0 < 0 or len(y) < int(win * SR):
                continue
            picture = src.time_of[int(idx[n])]
            av_ms.append(1000 * (src.sound_time(y, picture) - picture))
    ve = np.array(video_err)
    return {"frames": len(idx),
            "video_err_max": float(np.max(np.abs(ve))) if len(ve) else 0.0,
            "video_err_nan": int(np.sum(~np.isfinite(ve))),
            "av_ms_max": float(np.max(np.abs(av_ms))) if av_ms else None,
            "av_points": len(av_ms)}
