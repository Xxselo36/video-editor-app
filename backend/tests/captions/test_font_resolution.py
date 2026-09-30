"""Caption fonts in the server images (UX2; captions.md C4, C5).

Before UX2 neither image shipped assets/, so Clipper (the TikTok default)
burned in DejaVu Sans Bold instead of Bangers, and Flash found no font at
all on Linux and rendered no captions, silently.

- The image layout is read from the image definitions themselves
  (backend/modal_render.py `add_local_dir`, backend/Dockerfile `COPY`) and
  rebuilt under a temp dir; font_probe.py runs the real burn code from it.
- Every highlight font style must have a candidate path that the images'
  apt font packages install, on Debian bookworm and on trixie (where
  fonts-liberation2 is a transitional package and the files live in
  liberation/, not liberation2/). Exact paths on purpose: Pillow would
  also find a missing path's file name under /usr/share/fonts, but only
  with the default XDG_DATA_DIRS.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import REPO

PROBE = Path(__file__).resolve().parent / "font_probe.py"
BANGERS = "assets/fonts/Bangers-Regular.ttf"

_LIB = ("/usr/share/fonts/truetype/{d}/Liberation{f}-{s}.ttf")
_LIB_FILES = lambda d: {_LIB.format(d=d, f=f, s=s)  # noqa: E731
                        for f in ("Sans", "Serif", "Mono")
                        for s in ("Regular", "Bold", "Italic", "BoldItalic")}
_DEJAVU_CORE = {f"/usr/share/fonts/truetype/dejavu/DejaVu{n}.ttf"
                for n in ("Sans", "Sans-Bold", "Serif", "Serif-Bold")}
# Files the images' font packages (fonts-dejavu-core + fonts-liberation2)
# install, per Debian release of the base image.
IMAGE_FONT_FILES = {
    "bookworm": _DEJAVU_CORE | _LIB_FILES("liberation2"),
    "trixie": _DEJAVU_CORE | _LIB_FILES("liberation"),
}


def _modal_layout() -> list[tuple[str, str]]:
    src = (REPO / "backend" / "modal_render.py").read_text()
    return re.findall(r'\.add_local_dir\(\s*"([^"]+)"\s*,\s*'
                      r'remote_path\s*=\s*"([^"]+)"', src)


def _docker_layout() -> list[tuple[str, str]]:
    src = (REPO / "backend" / "Dockerfile").read_text()
    return [(a, b) for a, b in re.findall(r"^COPY\s+(\S+)\s+(\S+)\s*$", src,
                                          re.M) if b.startswith("/app/")]


def _apt_fonts(text: str) -> set[str]:
    return set(re.findall(r"fonts-[a-z0-9-]+", text))


def test_both_images_ship_the_bundled_fonts():
    for name, layout in (("modal_render.py", _modal_layout()),
                         ("Dockerfile", _docker_layout())):
        assert ("assets/fonts", "/app/assets/fonts") in layout, name
        assert ("src", "/app/src") in layout, name
    assert (REPO / BANGERS).is_file()


def test_both_images_install_the_same_font_packages():
    modal = _apt_fonts((REPO / "backend" / "modal_render.py").read_text())
    docker = _apt_fonts((REPO / "backend" / "Dockerfile").read_text())
    assert modal == docker == {"fonts-dejavu-core", "fonts-liberation2"}


def _sim_image(root: Path, layout: list[tuple[str, str]]) -> Path:
    """The image's /app as symlinks to the repo (effects.py resolves
    src/../assets lexically, so symlinks behave like the copied tree)."""
    for local, remote in layout:
        assert remote.startswith("/app/"), remote
        dst = root / remote.lstrip("/")
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.symlink_to(REPO / local, target_is_directory=True)
    return root / "app"


def _probe(app: Path, *presets: str) -> dict:
    pytest.importorskip("moviepy")
    r = subprocess.run([sys.executable, str(PROBE), str(app), *presets],
                       cwd=str(app), capture_output=True, text=True,
                       timeout=300)
    assert r.returncode == 0, (r.stdout[-2000:], r.stderr[-2000:])
    line = [ln for ln in r.stdout.splitlines() if ln.startswith("FONT_PROBE ")]
    assert line, r.stdout[-2000:]
    return json.loads(line[-1][len("FONT_PROBE "):])


@pytest.mark.parametrize("image", ["modal", "docker"])
def test_clipper_uses_bangers_in_the_image_layout(tmp_path, image):
    layout = _modal_layout() if image == "modal" else _docker_layout()
    app = _sim_image(tmp_path, layout)
    got = _probe(app, "clipper")["clipper"]
    assert got["clips"] >= 1
    assert got["fonts"] == [str(app / BANGERS)]


def test_without_assets_clipper_falls_back_to_dejavu(tmp_path):
    """The layout before UX2 (no assets/): what production burned."""
    if os.path.isfile("/tmp/Bangers-Regular.ttf"):
        pytest.skip("effects.py's dev fallback /tmp/Bangers-Regular.ttf exists")
    app = _sim_image(tmp_path, [(a, b) for a, b in _modal_layout()
                                if a != "assets/fonts"])
    got = _probe(app, "clipper")["clipper"]
    assert got["clips"] >= 1 and got["fonts"]
    assert all("Bangers" not in f for f in got["fonts"])


def test_flash_renders_captions_in_the_image_layout(tmp_path):
    libs = [p for p in IMAGE_FONT_FILES["bookworm"] | IMAGE_FONT_FILES["trixie"]
            if p.endswith("LiberationSans-BoldItalic.ttf")]
    if not any(os.path.isfile(p) for p in libs):
        pytest.skip("no Liberation Sans Bold Italic on this machine "
                    "(apt install fonts-liberation2); the static check "
                    "below still covers the images")
    app = _sim_image(tmp_path, _modal_layout())
    got = _probe(app, "flash")["flash"]
    assert got["clips"] >= 1, "Flash rendered no captions"
    assert len(got["fonts"]) == 1, got   # one italic face, whichever


def _candidates(monkeypatch, caplog, font_style: str) -> list[str]:
    """Every font path create_highlight_phrase_subtitle tries for a style
    (made to fail them all), and check it logs that — once."""
    from PIL import ImageFont
    import src.effects as fx
    tried: list[str] = []

    def failing(font=None, size=10, index=0, *a, **k):
        tried.append(os.path.normpath(str(font)))
        raise OSError("not in this test")

    monkeypatch.setattr(ImageFont, "truetype", failing)
    monkeypatch.setattr(fx, "_MISSING_HIGHLIGHT_FONTS", set())
    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="src.effects"):
        for _ in range(2):
            clip = fx.create_highlight_phrase_subtitle(
                ["Nobody", "waits"], 0, 1.0, (540, 960),
                {"_highlight_font": font_style}, [(0.0, 0.5), (0.5, 1.0)])
            assert clip is None
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1 and "WITHOUT captions" in errors[0].getMessage()
    assert font_style in errors[0].getMessage()
    return tried[: len(tried) // 2]


@pytest.mark.parametrize("font_style", ["bangers", "impact", "avenir_italic"])
@pytest.mark.parametrize("release", sorted(IMAGE_FONT_FILES))
def test_every_highlight_style_has_a_font_in_the_images(
        monkeypatch, caplog, font_style, release):
    tried = _candidates(monkeypatch, caplog, font_style)
    bundled = {os.path.normpath(str(REPO / BANGERS))}
    available = IMAGE_FONT_FILES[release] | bundled
    assert set(tried) & available, (font_style, release, tried)
