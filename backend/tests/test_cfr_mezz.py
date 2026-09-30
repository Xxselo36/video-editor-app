"""The web mezz is constant frame rate (UT3, review C8): a VFR upload
comes out of the normalize with constant pts deltas at its snapped rate;
without the web-only cfr_rate the normalize keeps the source's timing as
before."""
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
    """Without the web-only cfr_rate the ffmpeg calls are what they
    always were (no -fps_mode, no -r), with and without the proxy."""
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
        assert "-fps_mode" not in cmd and "-r" not in cmd
    pipeline._normalize_orientation(str(src), str(tmp_path / "c.mp4"), cfr_rate="25")
    assert calls[-1].count("-fps_mode") == 1 and calls[-1][calls[-1].index("-r") + 1] == "25"


@pytest.mark.parametrize("fps,rate", [(29.97, "30000/1001"), (25.0, "25"), (59.94, "60000/1001"),
                                      (23.976, "24000/1001"), (120.0, "60"), (15.0, "24000/1001")])
def test_rate_snapping(monkeypatch, fps, rate):
    monkeypatch.setattr(pipeline, "_video_rates", lambda p: (fps, fps))
    assert pipeline.cfr_rate_of("x")[0] == rate


def test_unknown_rate_defaults_to_30(monkeypatch):
    monkeypatch.setattr(pipeline, "_video_rates", lambda p: (None, None))
    assert pipeline.cfr_rate_of("x") == ("30", 30.0)
