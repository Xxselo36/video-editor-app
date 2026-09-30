"""Media helpers for the caption tests: a generated source clip, exact frame
extraction and SSIM. No binary media in git: every clip is made at test time
from numpy + PIL + ffmpeg (the same ffmpeg the renderer uses,
src.ffmpeg_utils.get_ffmpeg_path, i.e. imageio-ffmpeg's static build).
"""
from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[3]


def ffmpeg() -> str:
    import sys
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from src.ffmpeg_utils import get_ffmpeg_path
    return get_ffmpeg_path()


def background(w: int, h: int) -> Image.Image:
    """Flat colour blocks (PNG- and x264-friendly) behind every caption
    band, so a caption drawn without its mask shows up as a box."""
    img = Image.new("RGB", (w, h), (74, 92, 118))
    d = ImageDraw.Draw(img)
    d.rectangle([0, int(h * .44), int(w * .55), int(h * .56)], fill=(196, 120, 64))
    d.rectangle([int(w * .45), int(h * .68), w, int(h * .80)], fill=(52, 150, 132))
    d.rectangle([0, int(h * .82), int(w * .6), int(h * .92)], fill=(222, 214, 196))
    return img


def make_source(path: Path, *, w: int, h: int, fps: int, seconds: float,
                marker: bool = True, seed: int = 7) -> Path:
    """H.264 (lossless) + AAC clip: the background above plus a small square
    that moves 4 px per frame (pins which source frame each output frame
    shows), and a quiet tone with seeded noise as audio."""
    path = Path(path)
    n = int(round(seconds * fps))
    base = np.asarray(background(w, h), dtype=np.uint8)
    wav = path.with_suffix(".wav")
    sr = 48000
    t = np.arange(int(seconds * sr)) / sr
    rng = np.random.default_rng(seed)
    a = 0.08 * np.sin(2 * np.pi * 220 * t) + rng.normal(0, 0.01, t.size)
    pcm = (np.clip(a, -1, 1) * 32767).astype("<i2")
    with wave.open(str(wav), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())
    cmd = [ffmpeg(), "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
           "-r", str(fps), "-i", "-", "-i", str(wav),
           "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0",
           "-pix_fmt", "yuv420p", "-g", str(fps),
           "-c:a", "aac", "-b:a", "128k", "-shortest", str(path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        side = max(8, w // 30)
        y0 = int(h * .385)
        for i in range(n):
            frame = base.copy()
            if marker:
                x0 = (8 + 4 * i) % (w - side)
                frame[y0:y0 + side, x0:x0 + side] = (250, 236, 60)
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        rc = proc.wait()
        wav.unlink(missing_ok=True)
    if rc != 0:
        raise RuntimeError(f"ffmpeg failed making {path} (exit {rc})")
    return path


def frame_at(video: Path, index: int, out: Path | None = None) -> Image.Image:
    """Frame number `index` (0-based, by decode order, not by seeking)."""
    cmd = [ffmpeg(), "-loglevel", "error", "-i", str(video),
           "-vf", f"select=eq(n\\,{int(index)})", "-frames:v", "1",
           "-f", "image2pipe", "-vcodec", "png", "-"]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"no frame {index} in {video}: "
                           f"{r.stderr.decode(errors='replace')[-300:]}")
    import io
    img = Image.open(io.BytesIO(r.stdout)).convert("RGB")
    if out is not None:
        img.save(out)
    return img


def probe_frames(video: Path) -> int:
    """Number of video frames (decoded count)."""
    cmd = [ffmpeg(), "-loglevel", "error", "-progress", "pipe:1",
           "-i", str(video), "-map", "0:v:0", "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    frames = [ln.split("=", 1)[1] for ln in r.stdout.splitlines()
              if ln.startswith("frame=")]
    return int(frames[-1]) if frames else 0


def ssim(a: np.ndarray, b: np.ndarray, win: int = 7) -> float:
    """Mean SSIM of two uint8 images (HxW or HxWxC; channels averaged),
    uniform 7x7 window, data range 255 (skimage's defaults)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.shape != b.shape:
        raise ValueError(f"shape mismatch {a.shape} vs {b.shape}")
    if a.ndim == 3:
        return float(np.mean([ssim(a[..., c], b[..., c], win)
                              for c in range(a.shape[2])]))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    n = win * win

    def box(x: np.ndarray) -> np.ndarray:
        c = np.pad(x, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        return (c[win:, win:] - c[:-win, win:] - c[win:, :-win]
                + c[:-win, :-win]) / n

    mu_a, mu_b = box(a), box(b)
    cov = n / (n - 1)
    s_aa = (box(a * a) - mu_a ** 2) * cov
    s_bb = (box(b * b) - mu_b ** 2) * cov
    s_ab = (box(a * b) - mu_a * mu_b) * cov
    s = ((2 * mu_a * mu_b + c1) * (2 * s_ab + c2)) / (
        (mu_a ** 2 + mu_b ** 2 + c1) * (s_aa + s_bb + c2))
    return float(s.mean())
