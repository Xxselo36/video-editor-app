"""Options that changed between the ffmpeg of imageio-ffmpeg 0.7 (7.0)
and 0.8 (9.0), with the renderer's real ffmpeg (src.ffmpeg_utils):

- A filter graph too long for one argv string goes to ffmpeg in a file:
  -/filter_complex FILE from ffmpeg 7 on — ffmpeg 9 no longer has
  -filter_complex_script (the effects pass and a v2 render of a long
  timeline failed outright), ffmpeg 6 doesn't have -/filter_complex yet.
- ffmpeg 9's expression parser refuses a flat sum of more than ~300
  terms: the v2 render's select of the kept frames (one term per clip)
  is a balanced tree.
(The thumbnail's colours: test_thumbnail.py; frame-exact renders:
captions/test_av_exact.py; the mezz's frame rate mode: test_cfr_mezz.py;
SmartCam's -fps_mode: test_pipeline_media.py.)
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from backend import captions_v2, pipeline
from src import ffmpeg_utils as fu

FF = pipeline.get_ffmpeg_path()


def _clip(path: Path, seconds: float = 4.0, size: str = "320x240") -> Path:
    subprocess.run([FF, "-y", "-v", "error",
                    "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
                   check=True)
    return path


def _frames_and_durations(path: Path) -> tuple[int, float, float]:
    r = subprocess.run([pipeline.get_ffprobe_path(), "-v", "error", "-count_packets",
                        "-show_entries", "stream=codec_type,duration,nb_read_packets",
                        "-of", "json", str(path)], capture_output=True, text=True,
                       check=True)
    st = {s["codec_type"]: s for s in json.loads(r.stdout)["streams"]}
    return (int(st["video"]["nb_read_packets"]), float(st["video"]["duration"]),
            float(st["audio"]["duration"]))


def test_the_renderers_ffmpeg_has_a_version():
    assert isinstance(fu.ffmpeg_major_version(FF), int)
    assert fu.ffmpeg_major_version("/nonexistent/ffmpeg") is None


@pytest.mark.parametrize("major,option", [(6, "-filter_complex_script"),
                                          (7, "-/filter_complex"),
                                          (9, "-/filter_complex"),
                                          (None, "-/filter_complex")])
def test_a_long_graph_goes_in_a_file(monkeypatch, tmp_path, major, option):
    assert fu.filter_complex_args("null") == (["-filter_complex", "null"], None)
    monkeypatch.setattr(fu, "FILTER_GRAPH_ARG_MAX", 3)
    monkeypatch.setattr(fu, "ffmpeg_major_version", lambda ff: major)
    args, path = fu.filter_complex_args("null", tmp_path)
    assert args == [option, path] and Path(path).parent == tmp_path
    assert Path(path).read_text() == "null"


def test_long_graphs_render(monkeypatch, tmp_path):
    """The effects pass and the v2 render read their graph from a file
    (limit lowered here) — and the file is gone afterwards."""
    monkeypatch.setattr(fu, "FILTER_GRAPH_ARG_MAX", 10)
    src = _clip(tmp_path / "in.mp4")
    out = tmp_path / "fx.mp4"
    pipeline._apply_segment_effects(str(src), str(out), [(0.0, 1.0), (1.0, 2.0)],
                                    [{"speed": 2.0}, {}])
    frames, v, a = _frames_and_durations(out)
    assert frames == 15 + 30 and v == pytest.approx(1.5, abs=1e-3)
    assert a == pytest.approx(v, abs=1e-3)
    spec = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
            "language": "en", "words": [], "fonts": []}
    out2 = tmp_path / "v2.mp4"
    work = tmp_path / "w"
    captions_v2.render_primary(str(src), str(out2), [(0.5, 1.5), (2.0, 3.0)], None,
                               spec, work)
    frames, v, a = _frames_and_durations(out2)
    assert frames == 60 and a == pytest.approx(v, abs=1e-3)
    assert not list(work.glob("*.ffgraph"))


def test_the_select_of_hundreds_of_clips_parses():
    """v2's one-pass path keeps the frames of every clip with one select
    expression: 400 clips (a long talk with many cuts), exactly their
    frames. A flat sum of 400 terms failed on ffmpeg 9 ("Cannot allocate
    memory")."""
    terms = [f"t{i}" for i in range(1000)]
    expr = captions_v2._any_of(terms)
    depth = max_depth = 0
    for ch in expr:
        depth += {"(": 1, ")": -1}.get(ch, 0)
        max_depth = max(max_depth, depth)
    assert max_depth <= 10 and expr.count("+") == 999
    assert captions_v2._any_of(["x"]) == "x"


def test_a_v2_render_of_400_clips(tmp_path):
    src = _clip(tmp_path / "in.mp4", seconds=30.0, size="160x90")
    segs = [(i * 0.07, i * 0.07 + 0.05) for i in range(400)]   # 2 frames each
    spec = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
            "language": "en", "words": [], "fonts": []}
    out = tmp_path / "v2.mp4"
    info = captions_v2.render_primary(str(src), str(out), segs, None, spec, tmp_path / "w")
    assert info["path"] == "select" and info["clips"] == 400
    frames, v, a = _frames_and_durations(out)
    want = captions_v2.output_frames(captions_v2.clip_plan(segs, None, 30.0), 30.0)
    assert frames == info["frames"] == want
    assert a == pytest.approx(v, abs=1e-3)
