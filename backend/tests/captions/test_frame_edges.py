"""A trimmed edge on frame k starts BOTH exports on frame k (UX10 review 13).

The v2 editor puts a released trim edge on a frame boundary
(web timeline/mechanics.ts frameEdge: exactly k / fps) and
/edit-segments keeps it as sent (main._edit_edge; other edges are
rounded to ms). Rendered for real here, on a generated clip whose
moving square says which source frame every output frame is:

- v1, the MoviePy burn (_multi_clip_burn, one fresh VideoFileClip per
  clip): near the start of the source it reads frame by frame —
  int(fps·t + 1e-5), so frame k needs t ≥ (k − 1e-5) / fps — further in
  it seeks with ffmpeg, which keeps frames at or after t, so frame k
  needs t ≤ k / fps. Only k / fps itself is frame k on both.
- v2 (captions_v2.render_primary, clip_plan): the nearest frame.

The old rule (k / fps − 0.5 ms, then ms) started v1 one frame early near
the start of the source; the control case pins that this test sees it.
The end of a v1 clip is not compared: its post-mux -shortest trims video
to the AAC-snapped audio, a frame or so before v2's end, whatever the
edge (a v1 property, the same before UX10).
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

import caption_media as cm
import backend.main as M
from backend import captions_v2 as C

W, H, FPS = 1600, 200, 30
SIDE = max(8, W // 30)
# both sides of MoviePy's switch from reading on to seeking (~100 frames)
KS = [10, 50, 99, 130, 250]
LEN = 12   # frames per clip


def _frame(img) -> int | None:
    """Which source frame: caption_media's square sits at x = 8 + 4·i
    (no wrap: the frame is wide enough for every frame used here)."""
    a = np.asarray(img, dtype=np.int32)
    y = int(H * .385) + SIDE // 2
    row = a[y]
    hit = np.nonzero((row[:, 0] > 200) & (row[:, 1] > 190) & (row[:, 2] < 120))[0]
    return round((int(hit[0]) - 8) / 4) if len(hit) else None


def _client_edge(t: float, fps: float) -> float:
    """web frameEdge: the nearest frame boundary, exactly k / fps."""
    k = round(t * fps)
    return k / fps


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    work = tmp_path_factory.mktemp("frame_edges")
    return cm.make_source(work / "src.mp4", w=W, h=H, fps=FPS, seconds=10.0), work


def _v1_first_frames(src: Path, segs: list, out: Path) -> list[int | None]:
    from plugins.premiere.video_editor_premiere import _multi_clip_burn
    out.mkdir(parents=True, exist_ok=True)
    res = _multi_clip_burn(str(src), segs, [], "none", str(out), merge_gap=0,
                           parallelism=2, assign_by_midpoint=True)
    assert len(res) == len(segs)
    return [_frame(cm.frame_at(Path(p), 0)) for p, _ in res]


def test_server_keeps_a_frame_edge_and_rounds_the_rest():
    for fps in (25.0, 30.0, 29.97, 59.94, 23.976):
        f = M._exact_fps(fps)
        for k in (1, 10, 99, 101, 1234, 99999):
            e = k / f
            assert M._edit_edge(e, fps) == e
            assert round(M._edit_edge(e, fps) * f) == k
    assert M._edit_edge(3.4567, 30.0) == 3.457
    assert M._edit_edge(3.4567, None) == 3.457
    assert M._edit_edge(1 / 3, None) == 0.333
    assert M._exact_fps(29.97) == 30000 / 1001
    assert M._exact_fps(30.0002) == 30.0


def test_v1_burn_and_v2_render_start_on_the_trimmed_frame(source):
    src, work = source
    # a trim released near frame k (the handle's 0.01 s value), as the
    # editor stores it, through /edit-segments' cleaning
    segs = []
    for k in KS:
        a = M._edit_edge(_client_edge(round(k / FPS + 0.004, 2), FPS), float(FPS))
        b = M._edit_edge(_client_edge(round((k + LEN) / FPS - 0.004, 2), FPS), float(FPS))
        assert round(a * FPS) == k
        segs.append((a, b))
    v1 = _v1_first_frames(src, segs, work / "v1")
    assert v1 == KS, f"v1 first frames {v1}"
    out = work / "v2.mp4"
    spec = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
            "language": "en", "words": [], "fonts": []}
    C.render_primary(str(src), str(out), segs, None, spec, work / "v2w")
    clips = C.clip_plan(segs, None, FPS)
    n0, v2 = 0, []
    for c in clips:
        v2.append(_frame(cm.frame_at(out, n0)))
        n0 += C.clip_frames(c, FPS)
    assert v2 == KS, f"v2 first frames {v2}"


def test_the_old_rule_started_v1_a_frame_early(source):
    """Control: k / fps − 0.5 ms, rounded to ms (before the fix)."""
    src, work = source
    k = KS[0]
    a = round(k / FPS - 0.0005, 3)
    b = round((k + LEN) / FPS - 0.0005, 3)
    assert math.floor(a * FPS + 1e-5) == k - 1
    assert _v1_first_frames(src, [(a, b)], work / "old") == [k - 1]
