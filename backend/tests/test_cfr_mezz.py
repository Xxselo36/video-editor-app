"""The web mezz is constant frame rate (UT3, review C8): a VFR upload
comes out of the normalize with constant pts deltas at its snapped rate;
without the web-only cfr_rate the normalize keeps the source's timing as
before — constant at the stream's own rate, as ffmpeg 7 made it by
default (ffmpeg 9 keeps VFR unless told: -fps_mode cfr is named)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from backend import pipeline
from src.ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path

FF = get_ffmpeg_path()


def _vfr_clip(path: Path) -> Path:
    """4 s at a nominal 30 fps whose frame times wobble (0/+12/+24 ms in
    turn after the first second, like a phone under load), audio too."""
    subprocess.run([
        FF, "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=4",
        "-f", "lavfi", "-i", "sine=f=440:d=4",
        "-vf", "settb=1/90000,setpts='(N/30 + if(gt(N,30), 0.012*mod(N,3), 0))/TB'",
        "-fps_mode", "passthrough", "-video_track_timescale", "90000",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _deltas(path: Path) -> list[float]:
    out = subprocess.run([get_ffprobe_path(), "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "packet=pts_time", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    pts = sorted(float(p["pts_time"]) for p in json.loads(out)["packets"])
    return [round(b - a, 5) for a, b in zip(pts, pts[1:])]


def test_vfr_input_is_vfr(tmp_path):
    assert len(set(_deltas(_vfr_clip(tmp_path / "in.mp4")))) > 2


def test_web_normalize_makes_cfr(tmp_path):
    src = _vfr_clip(tmp_path / "in.mp4")
    rate, fps = pipeline.cfr_rate_of(str(src))
    assert (rate, round(fps, 3)) == ("30", 30.0)
    out = tmp_path / "normalized.mp4"
    proxy = tmp_path / pipeline.PROXY_NAME
    pipeline._normalize_orientation(str(src), str(out), proxy_path=str(proxy), cfr_rate=rate)
    for f in (out, proxy):
        d = _deltas(f)
        assert max(d) - min(d) < 0.0015, (f.name, sorted(set(d)))
        assert sum(d) / len(d) == pytest.approx(1 / 30, abs=1e-4)
    assert pipeline._is_cfr(str(out), fps)


def test_default_normalize_is_unchanged(tmp_path, monkeypatch):
    """Without the web-only cfr_rate no rate is forced (no -r), with and
    without the proxy: the mode ffmpeg 7 used by default is named
    (-fps_mode cfr, for every output)."""
    src = _vfr_clip(tmp_path / "in.mp4")
    calls: list[list[str]] = []
    real = subprocess.run

    def spy(cmd, *a, **kw):
        if cmd and cmd[0] == FF:
            calls.append(list(cmd))
        return real(cmd, *a, **kw)
    monkeypatch.setattr(pipeline.subprocess, "run", spy)
    pipeline._normalize_orientation(str(src), str(tmp_path / "a.mp4"))
    pipeline._normalize_orientation(str(src), str(tmp_path / "b.mp4"),
                                    proxy_path=str(tmp_path / "proxy.mp4"))
    assert len(calls) == 2
    for cmd in calls:
        assert "-r" not in cmd
        outputs = 2 if "-filter_complex" in cmd else 1
        assert cmd.count("-fps_mode") == outputs
        assert cmd[cmd.index("-fps_mode") + 1] == "cfr"
    pipeline._normalize_orientation(str(src), str(tmp_path / "c.mp4"), cfr_rate="25")
    assert calls[-1].count("-fps_mode") == 1 and calls[-1][calls[-1].index("-r") + 1] == "25"


@pytest.mark.parametrize("avg,real,rate", [
    # phone footage: the average wobbles around the nominal rate → today's snap
    (29.97, 29.97, "30000/1001"), (29.8, 30.0, "30000/1001"), (30.0, 30.0, "30"), (29.97, 600.0, "30000/1001"),
    (25.0, 25.0, "25"), (59.94, 59.94, "60000/1001"), (23.976, 24.0, "24000/1001"),
    (120.0, 120.0, "60"), (None, 30.0, "30"),
])
def test_rate_snapping(monkeypatch, avg, real, rate):
    monkeypatch.setattr(pipeline, "_video_rates", lambda p: (avg, real))
    assert pipeline.cfr_rate_of("x")[0] == rate


@pytest.mark.parametrize("avg,real", [
    (1.0, 1.0),      # a still-image podcast
    (10.0, 10.0),    # a screen capture
    (15.0, 15.0),
    (25.0, 60.0),    # a bursty VFR screen recording
    (None, None),    # unknown
    (None, 600.0),   # only a timebase artefact
])
def test_untrusted_or_low_rates_keep_the_source_timing(monkeypatch, avg, real):
    monkeypatch.setattr(pipeline, "_video_rates", lambda p: (avg, real))
    assert pipeline.cfr_rate_of("x") is None


def _bursty_clip(path: Path) -> Path:
    """4 s like a screen recording: a 60 fps grid, frames 1 to 3 steps
    apart (2, 2, 1, 3, 2, 2, 3, 1), ~30 fps on average — a rate
    cfr_rate_of doesn't snap."""
    keep = "+".join(f"eq(mod(n\\,16)\\,{r})" for r in (0, 2, 4, 5, 8, 10, 12, 15))
    subprocess.run([
        FF, "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=s=320x240:r=60:d=4",
        "-f", "lavfi", "-i", "sine=f=440:d=4",
        "-vf", f"select='{keep}'", "-fps_mode", "vfr",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def test_untrusted_rate_mezz_is_constant_at_its_own_rate(tmp_path):
    """A bursty VFR upload (no cfr_rate) and its proxy come out constant
    at the stream's own 60 fps, held frames repeated — what ffmpeg 7 made
    of it, so the analysis reports the same mezz_fps (60, constant) on
    ffmpeg 9, whose MP4 output would otherwise keep the bursts (30 fps
    average, variable)."""
    src = _bursty_clip(tmp_path / "in.mp4")
    assert pipeline.cfr_rate_of(str(src)) is None
    assert len(set(_deltas(src))) > 1
    out, proxy = tmp_path / "normalized.mp4", tmp_path / pipeline.PROXY_NAME
    assert pipeline._normalize_orientation(str(src), str(out), proxy_path=str(proxy))
    for f in (out, proxy):
        d = _deltas(f)
        assert max(d) - min(d) < 0.0015, (f.name, sorted(set(d)))
        assert sum(d) / len(d) == pytest.approx(1 / 60, abs=1e-4)
    assert pipeline._is_cfr(str(out), 60.0)
    again = tmp_path / "proxy2.mp4"
    assert pipeline._make_proxy(str(src), str(again))
    assert pipeline._is_cfr(str(again), 60.0)


def test_low_fps_upload_is_not_raised_to_24(tmp_path, monkeypatch):
    """analyze_only on a 2 fps clip: normalized without a forced rate,
    still 2 fps, reported as such."""
    from types import SimpleNamespace
    src = tmp_path / "slides.mp4"
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=2:d=4",
                    "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-preset",
                    "ultrafast", "-c:a", "aac", "-shortest", str(src)], check=True)
    monkeypatch.setattr(pipeline, "analyze_video", lambda video_path, **kw: SimpleNamespace(
        segments=[(0.0, 4.0)], subtitles=[], duration=4.0, language="en", scene_events=[]))
    import backend.llm as llm
    monkeypatch.setattr(llm, "cleanup_transcript", lambda subs, language=None: {})
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"), {})
    assert res["mezz_fps"] == pytest.approx(2.0, abs=0.05)
    assert len(_deltas(Path(res["normalized_path"]))) < 12
