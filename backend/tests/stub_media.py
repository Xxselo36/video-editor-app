"""Test media for the stub backend (backend/tests/stub_server.py),
generated at test time — no binary media in git.

Two clips:

grid    30 s, 320x180 testsrc + a 440 Hz tone. The editor e2e suites
        assert on its fixed timing: four automatic clips [0,6] [7,14]
        [15,22] [23,30] (cuts 6–7, 14–15, 22–23) and one transcript line
        "Satz N hier." per clip at +0.5 … +2.5 s (grid_data()).
speech  a talking-head clip for screenshots and upload flows: an English
        espeak-ng monologue with pauses and two fillers ("Um", "uh"),
        and a drawn "person in a room" whose mouth follows the audio
        (PIL), portrait and landscape (speech_data(): Whisper-like word
        subtitles, automatic cuts around the speech).

Each clip comes as src.mp4 (H.264/AAC — what the backend stores),
proxy.webm (VP8/Vorbis — Playwright's Chromium plays no H.264/AAC) and
thumb.jpg. Rendered outputs and previews the stub serves are VP8 too
(webm()); Chromium sniffs the container, so they may be stored and
served under .mp4 keys like the real ones.

Cached in $STUB_MEDIA_DIR (default ~/.cache/cleocuts-stub/<VERSION>),
built once under a file lock — two stub processes may start together.
Needs ffmpeg (on PATH, else imageio-ffmpeg) and, for the speech clip,
espeak-ng, numpy and Pillow (CI: apt-get install ffmpeg espeak-ng).

    python backend/tests/stub_media.py [grid|speech|all]    # prebuild
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path
from typing import Any, Iterator

# Bump when the generated media changes (a new cache directory).
VERSION = "v1"

GRID_DURATION = 30.0
GRID_CLIPS: list[tuple[float, float]] = [(0.0, 6.0), (7.0, 14.0),
                                         (15.0, 22.0), (23.0, 30.0)]

SPEECH_SCRIPT: list[tuple[str, Any]] = [
    ("s", "Hey, so today I want to show you the three mistakes that kill "
          "your reach on TikTok."),
    ("p", 1.4),
    ("f", "Um,"),
    ("p", 0.7),
    ("s", "Mistake number one: you start way too slow."),
    ("p", 0.35),
    ("s", "Nobody waits ten seconds for you to get to the point."),
    ("p", 1.8),
    ("s", "Mistake number two,"),
    ("p", 0.3),
    ("f", "uh,"),
    ("p", 0.3),
    ("s", "is dead air."),
    ("p", 0.3),
    ("s", "Every pause you leave in, people swipe away."),
    ("p", 1.2),
    ("s", "And mistake number three: no captions."),
    ("p", 0.35),
    ("s", "Most people watch with the sound off, so if there are no "
          "subtitles, they are gone."),
    ("p", 1.0),
    ("s", "Fix these three things and your watch time goes up."),
    ("p", 0.3),
    ("s", "Follow for part two."),
    ("p", 0.6),
]
SPEECH_SIZES = {"portrait": (360, 640), "landscape": (640, 360)}
_SR = 22050          # espeak-ng's sample rate
_MOUTH_FPS = 15


def media_dir() -> Path:
    env = os.environ.get("STUB_MEDIA_DIR", "").strip()
    root = Path(env) if env else Path.home() / ".cache" / "cleocuts-stub"
    d = root / VERSION
    d.mkdir(parents=True, exist_ok=True)
    return d


def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover - environment problem
        raise RuntimeError("stub media needs ffmpeg (PATH or imageio-ffmpeg)") from e


def has_espeak() -> bool:
    return shutil.which("espeak-ng") is not None


def _run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({r.returncode}): {r.stderr[-800:]}")


@contextlib.contextmanager
def _locked(name: str) -> Iterator[None]:
    with open(media_dir() / f".{name}.lock", "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def webm(src: str | Path, dst: str | Path, *, width: int | None = None) -> Path:
    """VP8/Vorbis copy of `src` (fast realtime encode, a keyframe every
    second — the editor seeks a lot)."""
    dst = Path(dst)
    tmp = dst.with_name(f".{dst.name}.tmp")
    vf = ["-vf", f"scale={width}:-2"] if width else []
    _run([ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), *vf,
          "-c:v", "libvpx", "-b:v", "600k", "-g", "30", "-deadline", "realtime",
          "-cpu-used", "16", "-threads", "2", "-c:a", "libvorbis", "-f", "webm", str(tmp)])
    os.replace(tmp, dst)
    return dst


def _thumb(src: Path, dst: Path, at: float) -> None:
    _run([ffmpeg(), "-y", "-loglevel", "error", "-ss", str(at), "-i", str(src),
          "-frames:v", "1", "-vf", "scale=320:-2", str(dst)])


def _files(d: Path) -> dict[str, Path]:
    return {"src": d / "src.mp4", "proxy": d / "proxy.webm", "thumb": d / "thumb.jpg"}


# ── grid ─────────────────────────────────────────────────────────────


def grid() -> dict[str, Path]:
    """The grid clip's files (built on first use)."""
    d = media_dir() / "grid"
    out = _files(d)
    if (d / ".done").exists():
        return out
    with _locked("grid"):
        if (d / ".done").exists():
            return out
        d.mkdir(parents=True, exist_ok=True)
        _run([ffmpeg(), "-y", "-loglevel", "error",
              "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=30:duration={GRID_DURATION:g}",
              "-f", "lavfi", "-i", f"sine=frequency=440:duration={GRID_DURATION:g}",
              "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
              "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", str(out["src"])])
        webm(out["src"], out["proxy"])
        _thumb(out["src"], out["thumb"], 3.0)
        (d / ".done").write_text("ok")
    return out


def grid_data() -> dict[str, Any]:
    """Analysis result of the grid clip: segments, cuts, one line per clip."""
    subs, acc = [], 0.0
    for i, (s, e) in enumerate(GRID_CLIPS):
        subs.append({"start": acc + 0.5, "end": acc + 2.5,
                     "original_start": s + 0.5, "original_end": s + 2.5,
                     "text": f"Satz {i + 1} hier.", "confidence": 1})
        acc += e - s
    cuts = [{"id": i, "start": a[1], "end": b[0]}
            for i, (a, b) in enumerate(zip(GRID_CLIPS, GRID_CLIPS[1:]))]
    return {"duration": GRID_DURATION, "segments": [list(c) for c in GRID_CLIPS],
            "cut_ranges": cuts, "subtitles": subs, "language": "de"}


# ── speech ───────────────────────────────────────────────────────────


def _speak(text: str, tmp: Path):
    import numpy as np
    _run(["espeak-ng", "-v", "en-us+m3", "-s", "168", "-p", "45", "-w", str(tmp), text])
    with wave.open(str(tmp)) as w:
        if w.getframerate() != _SR:
            raise RuntimeError(f"espeak-ng wrote {w.getframerate()} Hz, expected {_SR}")
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    tmp.unlink()
    idx = np.where(np.abs(a) > 400)[0]     # trim leading / trailing silence
    return a[idx[0]: idx[-1] + 1] if len(idx) else a


def _speech_audio(d: Path) -> None:
    """speech.wav, words.json (word timings, source seconds) and
    chunks.json (speech / filler chunks)."""
    import numpy as np
    audio = [np.zeros(int(0.5 * _SR), np.float32)]
    t = 0.5
    chunks, words = [], []
    for kind, v in SPEECH_SCRIPT:
        if kind == "p":
            audio.append(np.zeros(int(v * _SR), np.float32))
            t += v
            continue
        a = _speak(v, d / "tmp.wav")
        dur = len(a) / _SR
        chunks.append({"kind": "speech" if kind == "s" else "filler", "text": v,
                       "start": round(t, 3), "end": round(t + dur, 3)})
        ws = v.split()
        weights = np.array([len(w) + 2 for w in ws], float)
        edges = np.concatenate([[0], np.cumsum(weights)]) / weights.sum() * dur
        for i, w in enumerate(ws):
            words.append({"text": w, "start": round(t + edges[i], 3),
                          "end": round(t + edges[i + 1] - 0.03, 3), "filler": kind == "f"})
        audio.append(a)
        t += dur
    full = np.concatenate(audio)
    # A little room tone, so the waveform isn't dead flat.
    full = full + np.random.default_rng(1).normal(0, 60, len(full))
    full = np.clip(full, -32767, 32767).astype(np.int16)
    with wave.open(str(d / "speech.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(_SR)
        w.writeframes(full.tobytes())
    (d / "words.json").write_text(json.dumps(words, indent=1))
    (d / "chunks.json").write_text(json.dumps({"duration": len(full) / _SR, "chunks": chunks}, indent=1))


def _mouth_states(wav: Path) -> list[int]:
    import numpy as np
    with wave.open(str(wav)) as w:
        full = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    hop = _SR // _MOUTH_FPS
    rms = np.array([np.sqrt(np.mean(full[i:i + hop] ** 2)) for i in range(0, len(full), hop)])
    state = np.digitize(rms, [300, 2500])  # 0 closed, 1 half, 2 open
    for i in range(len(state)):            # alternate while talking
        if state[i] == 2 and i % 3 == 0:
            state[i] = 1
    return [int(s) for s in state]


def _frame(W: int, H: int, mouth: int, blink: bool):
    from PIL import Image, ImageDraw, ImageFilter
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):  # warm wall gradient
        k = y / H
        d.line([(0, y), (W, y)], fill=(int(214 - 60 * k), int(196 - 58 * k), int(178 - 56 * k)))
    # window (left), shelf + books + plant (right)
    d.rounded_rectangle([int(W * .04), int(H * .06), int(W * .34), int(H * .42)], 12, fill=(238, 232, 222))
    d.line([(int(W * .19), int(H * .06)), (int(W * .19), int(H * .42))], fill=(200, 190, 178), width=6)
    d.rectangle([int(W * .66), int(H * .30), int(W * .98), int(H * .315)], fill=(120, 86, 60))
    for i, c in enumerate([(70, 110, 160), (180, 80, 60), (230, 190, 90), (90, 140, 100)]):
        x0 = int(W * .68) + i * int(W * .055)
        d.rectangle([x0, int(H * .22), x0 + int(W * .04), int(H * .30)], fill=c)
    for cx, cy, r in [(.86, .50, .09), (.80, .56, .07), (.92, .57, .08), (.86, .62, .06)]:
        d.ellipse([int(W * (cx - r)), int(H * cy - W * r), int(W * (cx + r)), int(H * cy + W * r)],
                  fill=(70, 120, 70))
    d.rectangle([int(W * .82), int(H * .64), int(W * .90), int(H * .74)], fill=(150, 100, 70))
    img = img.filter(ImageFilter.GaussianBlur(radius=max(W, H) / 120))
    d = ImageDraw.Draw(img)
    cx = W // 2
    s = min(W, H * 0.62)  # person scale
    hy = int(H * 0.45) if H > W else int(H * 0.42)
    d.ellipse([cx - int(s * .62), hy + int(s * .42), cx + int(s * .62), hy + int(s * 1.5)], fill=(38, 52, 84))
    d.polygon([(cx - int(s * .12), hy + int(s * .40)), (cx + int(s * .12), hy + int(s * .40)),
               (cx, hy + int(s * .56))], fill=(30, 40, 66))
    d.rectangle([cx - int(s * .09), hy + int(s * .22), cx + int(s * .09), hy + int(s * .46)], fill=(196, 150, 120))
    d.ellipse([cx - int(s * .22), hy - int(s * .30), cx + int(s * .22), hy + int(s * .32)], fill=(222, 178, 145))
    d.chord([cx - int(s * .235), hy - int(s * .36), cx + int(s * .235), hy + int(s * .02)], 180, 360,
            fill=(58, 40, 30))
    d.ellipse([cx - int(s * .235), hy - int(s * .20), cx - int(s * .17), hy + int(s * .05)], fill=(58, 40, 30))
    d.ellipse([cx + int(s * .17), hy - int(s * .20), cx + int(s * .235), hy + int(s * .05)], fill=(58, 40, 30))
    ey = hy + int(s * .02)
    for ex in (cx - int(s * .085), cx + int(s * .085)):
        if blink:
            d.line([ex - int(s * .03), ey, ex + int(s * .03), ey], fill=(50, 35, 30), width=max(2, int(s * .008)))
        else:
            d.ellipse([ex - int(s * .028), ey - int(s * .02), ex + int(s * .028), ey + int(s * .02)],
                      fill=(255, 255, 255))
            d.ellipse([ex - int(s * .014), ey - int(s * .016), ex + int(s * .014), ey + int(s * .016)],
                      fill=(60, 42, 30))
        d.line([ex - int(s * .04), ey - int(s * .055), ex + int(s * .04), ey - int(s * .06)],
               fill=(58, 40, 30), width=max(2, int(s * .012)))
    d.line([cx, ey + int(s * .03), cx - int(s * .015), ey + int(s * .10)], fill=(190, 140, 110),
           width=max(2, int(s * .008)))
    my = hy + int(s * .19)
    mw = int(s * .07)
    if mouth == 0:
        d.line([cx - mw, my, cx + mw, my], fill=(140, 70, 70), width=max(2, int(s * .01)))
    else:
        h = int(s * (.025 if mouth == 1 else .05))
        d.ellipse([cx - mw, my - h, cx + mw, my + h], fill=(110, 40, 45))
        d.rectangle([cx - int(mw * .7), my - h + 1, cx + int(mw * .7), my - h + max(2, h // 3)],
                    fill=(245, 240, 235))
    return img


def _speech_video(d: Path, orientation: str) -> None:
    W, H = SPEECH_SIZES[orientation]
    out = d / orientation
    frames = out / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    cache: dict[tuple[int, bool], Path] = {}
    lines = []
    key = (0, False)
    for i, st in enumerate(_mouth_states(d / "speech.wav")):
        key = (st, (i % 60) in (0, 1))
        if key not in cache:
            p = frames / f"f_{key[0]}_{int(key[1])}.png"
            _frame(W, H, *key).save(p)
            cache[key] = p
        lines.append(f"file '{cache[key]}'\nduration {1 / _MOUTH_FPS:.6f}")
    lines.append(f"file '{cache[key]}'")
    (frames / "list.txt").write_text("\n".join(lines))
    files = _files(out)
    _run([ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
          "-i", str(frames / "list.txt"), "-i", str(d / "speech.wav"),
          "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
          "-g", "30", "-c:a", "aac", "-b:a", "96k", "-shortest", str(files["src"])])
    webm(files["src"], files["proxy"])
    _thumb(files["src"], files["thumb"], 8.0)
    shutil.rmtree(frames, ignore_errors=True)


def speech(orientation: str = "portrait") -> dict[str, Path]:
    """The speech clip's files for `orientation` (built on first use;
    raises RuntimeError without espeak-ng)."""
    if orientation not in SPEECH_SIZES:
        raise ValueError(f"orientation {orientation!r}")
    d = media_dir() / "speech"
    out = _files(d / orientation)
    out.update(words=d / "words.json", chunks=d / "chunks.json")
    if (d / f".{orientation}.done").exists():
        return out
    with _locked("speech"):
        if (d / f".{orientation}.done").exists():
            return out
        if not has_espeak():
            raise RuntimeError("the speech clip needs espeak-ng (apt-get install espeak-ng)")
        d.mkdir(parents=True, exist_ok=True)
        if not (d / ".audio.done").exists():
            _speech_audio(d)
            (d / ".audio.done").write_text("ok")
        _speech_video(d, orientation)
        (d / f".{orientation}.done").write_text("ok")
    return out


def speech_words() -> list[dict[str, Any]]:
    """The speech clip's words as a transcription gives them (SOURCE
    times, fillers included): what the edit document is built from."""
    words = json.loads((media_dir() / "speech" / "words.json").read_text())
    return [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in words]


def speech_data() -> dict[str, Any]:
    """Analysis result of the speech clip: automatic cuts around the
    speech (fillers and pauses removed) and Whisper-like word subtitles
    (output times, with the source times as original_*)."""
    d = media_dir() / "speech"
    words = json.loads((d / "words.json").read_text())
    meta = json.loads((d / "chunks.json").read_text())
    dur = round(meta["duration"], 3)
    segs: list[list[float]] = []
    for c in (c for c in meta["chunks"] if c["kind"] == "speech"):
        s, e = max(0.0, c["start"] - 0.15), min(dur, c["end"] + 0.15)
        if segs and s - segs[-1][1] < 0.5:
            segs[-1][1] = e
        else:
            segs.append([s, e])
    segs = [[round(s, 3), round(e, 3)] for s, e in segs]
    cuts, prev = [], 0.0
    for s, e in segs:
        if s - prev > 0.05:
            cuts.append({"id": len(cuts), "start": round(prev, 3), "end": round(s, 3)})
        prev = e
    if dur - prev > 0.05:
        cuts.append({"id": len(cuts), "start": round(prev, 3), "end": dur})
    subs, acc = [], 0.0
    for s, e in segs:
        for w in words:
            if w["filler"] or w["start"] < s or w["end"] > e:
                continue
            subs.append({"start": round(acc + w["start"] - s, 3), "end": round(acc + w["end"] - s, 3),
                         "original_start": w["start"], "original_end": w["end"],
                         "text": w["text"], "confidence": 0.93})
        acc += e - s
    return {"duration": dur, "segments": segs, "cut_ranges": cuts, "subtitles": subs,
            "language": "en", "out_duration": round(acc, 3)}


def long_video() -> Path:
    """A 31-minute WebM (64x36, 1 fps, silent; a few hundred KB): longer
    than the 30-minute upload cap, which the browser checks before
    uploading (lib/chunkedUpload uploadLimitHit)."""
    out = media_dir() / "long" / "long.webm"
    if out.exists():
        return out
    with _locked("long"):
        if out.exists():
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(".long.tmp.webm")
        _run([ffmpeg(), "-y", "-loglevel", "error",
              "-f", "lavfi", "-i", "color=c=0x202020:s=64x36:r=1",
              "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1860",
              "-c:v", "libvpx", "-b:v", "8k", "-c:a", "libvorbis", str(tmp)])
        os.replace(tmp, out)
    return out


# Uploads POST /jobs refuses before any charge (§1.7 rows 2–4): name →
# (ffmpeg inputs and codecs, what the refusal is).
REFUSED_MEDIA: dict[str, list[str]] = {
    # An audio file: no picture → 400 no_video.
    "audio.m4a": ["-f", "lavfi", "-i", "sine=frequency=440:duration=6",
                  "-c:a", "aac"],
    # A screen recording without a mic: no sound track → 400 no_audio.
    "silent.mp4": ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=6",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p"],
    # Under the 3-second minimum → 400 video_too_short.
    "short.mp4": ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1.5",
                  "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
                  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"],
}


def refused_media(name: str) -> Path:
    """One of REFUSED_MEDIA (a few KB, built once)."""
    out = media_dir() / "refused" / name
    if out.exists():
        return out
    with _locked("refused"):
        if out.exists():
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f".tmp.{name}")
        _run([ffmpeg(), "-y", "-loglevel", "error", *REFUSED_MEDIA[name], str(tmp)])
        os.replace(tmp, out)
    return out


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("grid", "all"):
        print("grid:", grid()["src"])
    if what in ("speech", "all"):
        for o in SPEECH_SIZES:
            print(f"speech {o}:", speech(o)["src"])
        d = speech_data()
        print(f"speech: {d['duration']} s, {len(d['segments'])} clips, {len(d['subtitles'])} words")
