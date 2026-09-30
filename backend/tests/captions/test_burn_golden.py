"""Characterization golden test of the desktop / Premiere caption burn (UX2
step 0, review D2).

`_multi_clip_burn` with its default keyword arguments — what the Premiere
plugin calls — on a generated clip (golden_burn.py), presets Clipper, Clean
and Classic, 5 frames each, compared with golden/burn_v1/*.png at SSIM >=
0.995. Must stay green on every PR that touches src/ or plugins/premiere/:
web-only behaviour goes in through keyword arguments whose defaults keep this
output (PLAN_TECH §0 rule 4).

The goldens were made on Linux with fonts-dejavu-core (Clean: DejaVu Sans,
Classic: DejaVu Sans Bold) and the repo's assets/fonts (Clipper: Bangers);
elsewhere (macOS / Windows fonts) the test skips. Regenerate only in a
reviewed PR that means to change the desktop look:

    PYTHONHASHSEED=0 python backend/tests/captions/golden_burn.py --update
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import caption_media as cm
import golden_burn as gb

GOLDEN = gb.GOLDEN
MANIFEST = json.loads((GOLDEN / "manifest.json").read_text())
MIN_SSIM = 0.995
_DEJAVU = ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
           "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")


def _linux_font_env() -> str | None:
    """None when this machine resolves the fonts the goldens were made with."""
    if not sys.platform.startswith("linux"):
        return f"goldens are for Linux fonts, this is {sys.platform}"
    missing = [p for p in _DEJAVU if not os.path.isfile(p)]
    if missing:
        return f"fonts-dejavu-core not installed ({', '.join(missing)})"
    return None


@pytest.fixture(scope="module")
def burned(tmp_path_factory):
    why = _linux_font_env()
    if why:
        pytest.skip(why)
    pytest.importorskip("moviepy")
    out = tmp_path_factory.mktemp("burn_golden")
    env = {k: v for k, v in os.environ.items() if k != "CLEO_BURN_PRESET"}
    env["PYTHONHASHSEED"] = "0"
    r = subprocess.run([sys.executable, str(Path(gb.__file__)), str(out)],
                       cwd=str(gb.REPO), env=env, capture_output=True,
                       text=True, timeout=900)
    assert r.returncode == 0, (r.stdout[-3000:], r.stderr[-3000:])
    yield out, json.loads((out / "report.json").read_text())
    shutil.rmtree(out, ignore_errors=True)


def test_goldens_are_small_pngs():
    pngs = sorted(GOLDEN.glob("*.png"))
    assert len(pngs) == len(gb.PRESETS) * len(gb.FRAMES)
    # The one documented exception to "no binary fixtures": ≤ 50 KB each.
    assert max(p.stat().st_size for p in pngs) <= 50_000


@pytest.mark.parametrize("preset", gb.PRESETS)
def test_same_fonts_and_clip_lengths(burned, preset):
    _, report = burned
    want = MANIFEST["presets"][preset]
    got = report["presets"][preset]
    assert got["fonts"] == want["fonts"]
    assert got["frames_per_clip"] == want["frames_per_clip"]


@pytest.mark.parametrize("preset", gb.PRESETS)
@pytest.mark.parametrize("k", range(len(gb.FRAMES)))
def test_frame_matches_golden(burned, preset, k):
    out, _ = burned
    name = f"{preset}_{k}.png"
    got = np.asarray(Image.open(out / name).convert("RGB"))
    want = np.asarray(Image.open(GOLDEN / name).convert("RGB"))
    score = cm.ssim(got, want)
    seg, idx = gb.FRAMES[k]
    assert score >= MIN_SSIM, (
        f"{preset} clip {seg} frame {idx}: SSIM {score:.4f} < {MIN_SSIM} — "
        f"the desktop/Premiere burn changed (web-only changes need a "
        f"keyword argument whose default keeps today's output)")
