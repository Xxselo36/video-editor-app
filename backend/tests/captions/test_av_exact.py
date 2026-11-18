"""Every web render is frame-exact and in A/V sync, whichever ffmpeg
renders it (imageio-ffmpeg 0.7 bundles ffmpeg 7, 0.8 ffmpeg 9: both give
these same frames).

On a generated source whose every frame carries its own index and whose
audio is seeded noise (av_media.py), with cuts between frames, a split,
clips near the start (MoviePy reads on) and further in (it seeks):

- Frames: the output has exactly the plan's frames — each clip's edges
  on the nearest source frame (captions_v2.clip_plan's rule), a sped-up
  clip its length in whole frames — and every frame is the source frame
  the plan puts there.
- Sync: at points in every clip the sound comes from the source time of
  the picture, to the millisecond; video and audio start at 0 and are
  equally long.
- v1 (MoviePy burn → _concat_frame_exact → effects) and v2 (one ffmpeg
  pass) cut the same frames; v2's per-clip path (one input per clip) as
  exactly as its select path, also for clips that start on a keyframe.

Before: the v1 clips ended a frame or two early (-shortest on the clip's
stream-copied audio) and started 21 ms late (AAC priming); ffmpeg 7
filled the gaps with repeated frames, ffmpeg 9 started the video a frame
late (smoke render: 128 vs 127 of 129 frames); the effects pass resampled
sped-up clips differently in each (234 vs 218 frames of 234). v2's
per-clip path seeked each input right onto its clip, and ffmpeg 9 drops
the first AAC frame after a seek: a clip starting on a keyframe of a
source without B-frames, or at 0, sounded 5-21 ms early.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import av_media as av
import pytest
import sync_sim as sim

from backend import captions_v2 as C
from backend import pipeline

SEGS = [(0.35, 2.213), (2.213, 3.1), (3.517, 5.05), (6.2071, 8.333), (9.04, 11.61)]
FX = [{}, {"speed": 1.5}, {"fadeIn": 0.3, "volume": 0.5},
      {"speed": 0.75, "fadeOut": 0.4}, {}]
# v2's per-clip path (a speed, fades, a clip out of source order) with
# clips that start where a seek used to cost ffmpeg 9 the clip's first
# AAC frame: on keyframes of the 25 fps source (no B-frames, -g 30:
# every 1.2 s) and at 0.
KF_SEGS = [(6.0, 7.4), (0.0, 1.0), (1.2, 2.213), (2.4, 3.1), (3.6, 5.05),
           (8.4, 11.61)]
KF_FX = [{}, {"fadeOut": 0.3}, {}, {"speed": 1.5}, {"volume": 0.5},
         {"fadeOut": 0.4}]
# VFR on a 60 fps grid, ~30 fps on average: 1 to 3 grid steps apart
# (2, 2, 1, 3, 2, 2, 3, 1 — every 16 grid frames).
VFR_KEEP = (16, [0, 2, 4, 5, 8, 10, 12, 15])


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    pytest.importorskip("moviepy")
    d = tmp_path_factory.mktemp("av_exact")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture(scope="module")
def src25(work):
    path = av.make_source(work / "p25.mp4", w=540, h=960, rate="25", seconds=12.0)
    return path, av.Source(path)


@pytest.fixture(scope="module")
def src2997(work):
    path = av.make_source(work / "l2997.mp4", w=960, h=540, rate="30000/1001",
                          seconds=12.0)
    return path, av.Source(path)


@pytest.fixture(scope="module")
def srcvfr(work):
    path = av.make_source(work / "vfr.mp4", w=540, h=960, rate="60", seconds=12.0,
                          keep=VFR_KEEP)
    return path, av.Source(path)


def _v1(src: Path, out: Path, effects=(), subtitles=(), preset="clipper") -> Path:
    files = pipeline.render_to_dir(str(src), str(out), SEGS, list(effects),
                                   list(subtitles), preset, "tight", "en", [], [],
                                   parallelism=2)
    return Path(files["primary"])


def _assert_streams(out: Path, frames: int, fps: float) -> None:
    s = av.streams(out)
    assert s["v"]["start"] == 0 and s["a"]["start"] == 0, s
    assert s["v"]["duration"] == pytest.approx(frames / fps, abs=1e-3), s
    assert s["a"]["duration"] == pytest.approx(s["v"]["duration"], abs=1e-3), s


def test_v1_render_is_frame_exact_and_in_sync(src25, work):
    """render_to_dir's v1 path (render_r2) with captions."""
    path, src = src25
    V = sim.load_vectors()
    out = _v1(path, work / "v1", subtitles=V["units_payload"])
    clips = av.plan(SEGS, 25)
    want = sum(c["frames"] for c in clips)
    assert want == 224
    r = av.check(out, src, clips, 25)
    assert r["frames"] == want, r
    assert r["video_err_max"] < 1e-3 and r["video_err_nan"] == 0, r
    assert r["av_points"] >= 16 and r["av_ms_max"] <= 1.0, r
    _assert_streams(out, want, 25)


def test_v2_cuts_the_same_frames_as_v1(src25, work):
    path, src = src25
    v1 = work / "v1" / "primary.mp4"
    if not v1.is_file():
        v1 = _v1(path, work / "v1")
    v2 = work / "v2.mp4"
    spec = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
            "language": "en", "words": [], "fonts": []}
    C.render_primary(str(path), str(v2), SEGS, None, spec, work / "v2w")
    clips = av.plan(SEGS, 25)
    r = av.check(v2, src, clips, 25)
    assert r["frames"] == 224 and r["video_err_max"] < 1e-3, r
    assert r["av_ms_max"] <= 1.0, r
    assert list(av.frames(v1)[1]) == list(av.frames(v2)[1])


def test_v2_per_clip_path_is_frame_exact_and_in_sync(src25, work):
    """v2's per-clip path (one input per clip) on a source without
    B-frames: clips that start on its keyframes and at 0 keep their
    sound on their picture. Seeked right onto those points, ffmpeg 9
    (not 7) drops the first AAC frame after the seek: each such clip's
    sound came 5-21 ms ahead of its picture (16 ms at 1.2 and 6.0 s,
    21 ms at 0 here), the clip only as long because of its padding."""
    path, src = src25
    v = av._probe(path, "-select_streams", "v:0", "-show_entries",
                  "stream=has_b_frames")["streams"][0]
    keys = av._probe(path, "-select_streams", "v:0", "-show_entries",
                     "packet=pts_time,flags")["packets"]
    keys = {round(float(p["pts_time"]), 3) for p in keys if "K" in p["flags"]}
    assert int(v["has_b_frames"]) == 0
    assert {0.0, 1.2, 2.4, 3.6, 6.0, 8.4} <= keys   # the clips' starts
    spec = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
            "language": "en", "words": [], "fonts": []}
    out = work / "v2_keyframes.mp4"
    info = C.render_primary(str(path), str(out), KF_SEGS, KF_FX, spec, work / "v2kw")
    assert info["path"] == "segments"
    clips = av.plan(KF_SEGS, 25, KF_FX)
    want = sum(c["frames"] for c in clips)
    assert want == 213
    r = av.check(out, src, clips, 25)
    assert r["frames"] == want, r
    assert r["video_err_max"] <= 0.5 and r["video_err_nan"] == 0, r
    assert r["av_points"] >= 20 and r["av_ms_max"] <= 1.0, r
    _assert_streams(out, want, 25)


def test_v1_local_render_at_29_97(src2997, work):
    """render_only's local path (the Modal volume path's code too) at an
    NTSC rate, landscape, no captions."""
    path, src = src2997
    res = pipeline.render_only(str(path), str(work / "local"), SEGS, [],
                               {"caption_preset": "classic"}, hooks=[],
                               use_modal=False)
    out = Path(res["outputs"]["primary"])
    fps = 30000 / 1001
    clips = av.plan(SEGS, fps)
    want = sum(c["frames"] for c in clips)
    assert want == 270
    r = av.check(out, src, clips, fps)
    assert r["frames"] == want and r["video_err_max"] < 1e-3, r
    assert r["av_ms_max"] <= 1.0, r
    _assert_streams(out, want, fps)


def test_v1_effects_keep_frames_and_sync(src25, work):
    """Speed, fades, volume (the effects pass on the v1 primary): every
    clip exactly clip_frames() long; a sped-up clip's frames are the
    nearest source frames; the clips at speed 1 stay in sync."""
    path, src = src25
    out = _v1(path, work / "fx", effects=FX)
    clips = av.plan(SEGS, 25, FX)
    want = sum(c["frames"] for c in clips)
    assert want == 234
    r = av.check(out, src, clips, 25)
    assert r["frames"] == want, r
    assert r["video_err_max"] <= 0.5 and r["video_err_nan"] == 0, r
    assert r["av_points"] >= 8 and r["av_ms_max"] <= 1.0, r
    _assert_streams(out, want, 25)


def test_vfr_source(srcvfr, work):
    """A VFR mezz (kept so: its rate can't be trusted). v2 renders it on
    its average rate's grid (30), v1 on the rate MoviePy reads it at
    (r_frame_rate, 60): both exactly their plan's frames, sound and
    picture from the same source time up to the source's own frame
    spacing (a frame shows until the next one, at most 3/60 s later)."""
    path, src = srcvfr
    spec = {"v": 1, "engine": "v2", "style": {"presetId": "none", "overrides": {}},
            "language": "en", "words": [], "fonts": []}
    v2 = work / "vfr_v2.mp4"
    info = C.render_primary(str(path), str(v2), SEGS, None, spec, work / "vfrw")
    assert info["path"] == "segments"
    v1 = _v1(path, work / "vfr_v1")
    for out, fps in ((v2, 30), (v1, 60)):
        clips = av.plan(SEGS, fps)
        want = sum(c["frames"] for c in clips)
        r = av.check(out, src, clips, fps)
        assert r["frames"] == want, (fps, r)
        assert r["video_err_max"] <= 3 / 60 * fps + 1e-6, (fps, r)
        assert r["av_ms_max"] <= 1000 * 3 / 60 + 1, (fps, r)
        _assert_streams(out, want, fps)
