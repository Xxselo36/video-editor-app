"""Characterization render of the desktop / Premiere caption burn (UX2 step 0).

`_multi_clip_burn` (plugins/premiere/video_editor_premiere.py) is shared by
the SmartCut desktop app's Premiere plugin and the web render. Every UX2
change reaches it as a web-only keyword argument whose default is today's
behaviour, so this render uses NO web keyword: it is exactly what the plugin
burns. test_burn_golden.py compares its frames with the PNGs in
golden/burn_v1/ (SSIM >= 0.995).

The clip is generated (caption_media.make_source): 540x960 @ 25 fps, two
kept segments with a cut between them, word-level subtitles like the ones
the plugin passes, one of which ("to get") spans the cut — by default it is
burned in both clips, and the golden frames pin that.

Deterministic only with PYTHONHASHSEED fixed (Clean seeds its per-line size
jitter with hash(tuple(words)), src/effects.py create_clean_phrase_subtitle)
and one worker thread (the jitter uses the process-global `random`, shared by
the burn threads — captions.md C16). Hence `parallelism=1`; it changes the
scheduling, not what a segment looks like.

    PYTHONHASHSEED=0 python backend/tests/captions/golden_burn.py OUT_DIR
    PYTHONHASHSEED=0 python backend/tests/captions/golden_burn.py --update

--update rewrites golden/burn_v1/ (only in a reviewed PR that means to
change the desktop/Premiere look).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
GOLDEN = HERE / "golden" / "burn_v1"
for p in (str(REPO), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

W, H, FPS = 540, 960, 25
SECONDS = 6.0
# Kept source ranges (frame-aligned at 25 fps); the cut is 2.92-3.52.
SEGMENTS = [(0.40, 2.92), (3.52, 5.80)]
# Word units as the plugin gets them: source times in original_*, the
# cut timeline in start/end. "to get" crosses the cut.
_WORDS = [
    ("Nobody", 0.50, 0.86), ("waits", 0.90, 1.20), ("ten", 1.26, 1.50),
    ("seconds", 1.56, 2.04), ("for you", 2.10, 2.56), ("to get", 2.62, 3.60),
    ("point.", 3.66, 4.08), ("Mistake", 4.20, 4.60), ("number", 4.66, 5.02),
    ("two.", 5.08, 5.52),
]


def _cut_time(t: float) -> float:
    off = 0.0
    for s, e in SEGMENTS:
        if t < e:
            return round(off + max(0.0, t - s), 3)
        off += e - s
    return round(off, 3)


SUBTITLES = [{"start": _cut_time(s), "end": _cut_time(e), "text": text,
              "original_start": s, "original_end": e}
             for text, s, e in _WORDS]
PRESETS = ("clipper", "clean", "classic")
# (segment, frame index): Clipper's bounce-in (frame-centred today), two
# mid-group frames, the "to get" copy at the start of clip 2, a late frame.
FRAMES = [(0, 3), (0, 25), (0, 57), (1, 1), (1, 30)]
# Caption band that holds every preset's text (Clean 0.50, Clipper 0.75,
# Classic 0.85 of the height) — the golden PNGs are this crop, full size.
CROP_Y = (0.36, 0.97)


def _crop(img):
    y0, y1 = int(H * CROP_Y[0]), int(H * CROP_Y[1])
    return img.crop((0, y0, W, y1))


def render(out_dir: Path) -> dict:
    """Burn every preset, save the golden frames as PNGs in `out_dir`, and
    return (and write) report.json: fonts opened, frames per segment."""
    from PIL import ImageFont
    import caption_media as cm
    from plugins.premiere.video_editor_premiere import _multi_clip_burn

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="burn_golden_", dir=out_dir))
    opened: list[tuple[str, int]] = []
    orig_truetype = ImageFont.truetype

    def spy(font=None, size=10, index=0, *a, **k):
        f = orig_truetype(font, size, index, *a, **k)
        # f.path: the file really loaded (Pillow searches the font dirs by
        # file name when a path is missing).
        path = getattr(f, "path", None) or font
        opened.append((os.path.basename(str(path)), int(index)))
        return f

    ImageFont.truetype = spy
    report: dict = {"presets": {}, "frames": FRAMES, "crop_y": CROP_Y,
                    "size": [W, H], "fps": FPS,
                    "pythonhashseed": os.environ.get("PYTHONHASHSEED")}
    try:
        src = cm.make_source(work / "src.mp4", w=W, h=H, fps=FPS,
                             seconds=SECONDS)
        for preset in PRESETS:
            opened.clear()
            seg_dir = work / preset
            seg_dir.mkdir()
            clips = _multi_clip_burn(str(src), SEGMENTS, SUBTITLES, preset,
                                     str(seg_dir), parallelism=1)
            if len(clips) != len(SEGMENTS):
                raise RuntimeError(f"{preset}: {len(clips)} clips burned, "
                                   f"expected {len(SEGMENTS)}")
            for k, (seg, idx) in enumerate(FRAMES):
                img = cm.frame_at(Path(clips[seg][0]), idx)
                _crop(img).save(out_dir / f"{preset}_{k}.png", optimize=True)
            report["presets"][preset] = {
                "fonts": sorted({f"{b}#{i}" for b, i in opened}),
                "frames_per_clip": [cm.probe_frames(Path(p)) for p, _ in clips],
            }
            shutil.rmtree(seg_dir, ignore_errors=True)
    finally:
        ImageFont.truetype = orig_truetype
        shutil.rmtree(work, ignore_errors=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=1))
    return report


def main(argv: list[str]) -> int:
    if os.environ.get("PYTHONHASHSEED") != "0":
        print("set PYTHONHASHSEED=0 (Clean's layout depends on it)",
              file=sys.stderr)
        return 2
    if argv[1:] == ["--update"]:
        tmp = Path(tempfile.mkdtemp(prefix="burn_golden_update_"))
        try:
            rep = render(tmp)
            GOLDEN.mkdir(parents=True, exist_ok=True)
            for old in GOLDEN.glob("*.png"):
                old.unlink()
            for png in sorted(tmp.glob("*.png")):
                shutil.copy2(png, GOLDEN / png.name)
            (GOLDEN / "manifest.json").write_text(json.dumps(rep, indent=1))
            print(f"goldens written to {GOLDEN}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        return 0
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    render(Path(argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
