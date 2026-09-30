"""Media pipeline with real ffmpeg: order-safe preview build (memory +
A/V sync), 720p proxy, analyze_only's hand-offs (on_normalized, SmartCam
output isolation, temp cleanup) and the ffmpeg thread cap.

Transcription / LLM are stubbed; everything else runs for real on small
generated clips (the memory test uses a 60 s 1080x1920 one, like the
scale audit). Run from the repo root:
    python -m pytest backend/tests/test_pipeline_media.py -q
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend import pipeline

FF = pipeline.get_ffmpeg_path()
FP = pipeline.get_ffprobe_path()


def _ffmpeg(*args: str) -> None:
    subprocess.run([FF, "-y", "-v", "error", *args], check=True)


def _make_clip(path: Path, size: str, seconds: float, rate: int = 30,
               color: str | None = None) -> Path:
    """H.264 + AAC test clip with a 1 s GOP (like normalized.mp4)."""
    video = (f"color=c={color}:size={size}:rate={rate}:duration={seconds}"
             if color else f"testsrc2=size={size}:rate={rate}:duration={seconds}")
    _ffmpeg("-f", "lavfi", "-i", video,
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", str(rate),
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path))
    return path


def _streams(path) -> dict:
    """{'video': {...}, 'audio': {...}} of the first stream of each kind."""
    import json
    r = subprocess.run(
        [FP, "-v", "error", "-show_entries",
         "stream=codec_type,width,height,r_frame_rate,duration,start_time",
         "-of", "json", str(path)], capture_output=True, text=True, check=True)
    out: dict = {}
    for st in json.loads(r.stdout)["streams"]:
        out.setdefault(st["codec_type"], st)
    return out


def _duration(path) -> float:
    r = subprocess.run([FP, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=nw=1:nk=1", str(path)],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


class _MeasuredRun:
    """Stands in for subprocess.run: same result, plus each child's own
    peak RSS (wait4) and argv — RUSAGE_CHILDREN would also count every
    ffmpeg this pytest process ran before."""

    def __init__(self):
        self.calls: list[tuple[list[str], int]] = []  # (argv, maxrss KiB)
        self._popen = subprocess.Popen

    def __call__(self, cmd, capture_output=False, text=False, timeout=None,
                 check=False, **kw):
        p = self._popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        bufs: dict[str, bytes] = {}
        readers = [threading.Thread(target=lambda n=n, f=f: bufs.__setitem__(n, f.read()))
                   for n, f in (("out", p.stdout), ("err", p.stderr))]
        for t in readers:
            t.start()
        _, status, ru = os.wait4(p.pid, 0)
        for t in readers:
            t.join()
        p.returncode = os.waitstatus_to_exitcode(status)
        self.calls.append((list(cmd), ru.ru_maxrss))
        out, err = bufs.get("out", b""), bufs.get("err", b"")
        if text:
            out, err = out.decode(errors="replace"), err.decode(errors="replace")
        return subprocess.CompletedProcess(cmd, p.returncode, out, err)

    @property
    def peak_mb(self) -> float:
        return max(rss for _c, rss in self.calls) / 1024


# ── order-safe preview ───────────────────────────────────────────────


def test_ascending_runs():
    runs = pipeline._ascending_runs
    asc = [(0, 1), (2, 3), (3, 4.5)]
    assert runs(asc) == [[(0, 1), (2, 3), (3, 4.5)]]
    # last clip moved to the front → the moved clip + the rest
    assert runs([(8, 9)] + asc) == [[(8, 9)], [(0, 1), (2, 3), (3, 4.5)]]
    # overlap beyond the slack starts a new run; float noise doesn't
    assert runs([(0, 2), (1, 3)]) == [[(0, 2)], [(1, 3)]]
    assert runs([(0, 2), (1.95, 3)]) == [[(0, 2), (1.95, 3)]]
    assert len(runs([(4, 5), (2, 3), (0, 1)])) == 3


@pytest.fixture(scope="module")
def clip60(tmp_path_factory):
    """60 s 1080x1920 30p — the size the audit measured (4.6 GB peak
    for this reorder with the old single-pass build)."""
    return _make_clip(tmp_path_factory.mktemp("clip60") / "normalized.mp4",
                      "1080x1920", 60)


def test_reordered_preview_memory_is_bounded(clip60, tmp_path, monkeypatch):
    segs = [(i * 4.0, i * 4.0 + 2.9) for i in range(15)]
    moved = [segs[-1]] + segs[:-1]          # last clip to the front
    run = _MeasuredRun()
    monkeypatch.setattr(pipeline.subprocess, "run", run)
    out = tmp_path / "preview.mp4"
    pipeline._ffmpeg_cuts_preview(str(clip60), moved, str(out))
    print(f"reordered preview: {len(run.calls)} ffmpeg calls, "
          f"peak child RSS {run.peak_mb:.0f} MB")
    # The old single-pass build peaked at 4.6 GB. x264 frame threads grow
    # with the core count: ~450 MB here, ~650 MB on a 4-vCPU CI runner.
    assert run.peak_mb < 1000
    # One pass through the concat demuxer (+ the start-time probe).
    assert [Path(c[0]).name.startswith("ffprobe") for c, _ in run.calls] \
        == [True, False]
    assert _duration(out) == pytest.approx(15 * 2.9, abs=0.1)
    st = _streams(out)
    assert (int(st["video"]["width"]), int(st["video"]["height"])) == (406, 720)
    assert float(st["audio"]["duration"]) == pytest.approx(15 * 2.9, abs=0.1)
    # The in-order timeline still takes the single-pass path.
    run.calls.clear()
    pipeline._ffmpeg_cuts_preview(str(clip60), segs, str(out))
    assert len(run.calls) == 1 and run.peak_mb < 600


def _event_clip(path: Path, seconds: int = 20) -> Path:
    """Black video with a white flash and a 1 kHz beep, both during
    [2k+1.0, 2k+1.1) — each event marks the same instant in both streams."""
    cond = "between(mod(t,2),1.0,1.1)"
    _ffmpeg("-f", "lavfi", "-i", f"color=c=black:size=320x240:rate=30:duration={seconds}",
            "-f", "lavfi", "-i",
            f"aevalsrc='if({cond},0.5*sin(2*PI*1000*t),0)':s=48000:d={seconds}",
            "-vf", f"drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='{cond}'",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path))
    return path


def _onsets(times_values, threshold, min_gap):
    out, last = [], None
    for t, v in times_values:
        if v > threshold and (last is None or t - last > min_gap):
            out.append(t)
        if v > threshold:
            last = t
    return out


def _flash_onsets(path) -> list[float]:
    r = subprocess.run(
        [FP, "-v", "error", "-f", "lavfi", "-i", f"movie={path},signalstats",
         "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG",
         "-of", "csv=p=0"], capture_output=True, text=True, check=True)
    rows = []
    for line in r.stdout.split():
        t, y = line.split(",")[:2]
        rows.append((float(t), float(y)))
    return _onsets(rows, 128, 0.5)


def _beep_onsets(path) -> list[float]:
    import numpy as np
    raw = subprocess.run([FF, "-v", "error", "-i", str(path), "-vn", "-ac", "1",
                          "-ar", "48000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    x = np.abs(np.frombuffer(raw, dtype=np.int16).astype(np.int32))
    hop = 48  # 1 ms
    env = x[: len(x) // hop * hop].reshape(-1, hop).max(axis=1)
    start = float(_streams(path)["audio"].get("start_time") or 0.0)
    return _onsets([(start + i / 1000.0, v) for i, v in enumerate(env)], 3000, 0.5)


@pytest.mark.parametrize("order", [
    list(range(10)),                          # in order: single pass
    [9, 0, 5, 1, 8, 2, 7, 3, 6, 4],           # shuffled: many runs
    list(range(9, -1, -1)),                   # reversed
    list(range(30)),                          # in order, many segments
    [k for p in zip(range(15), range(29, 14, -1)) for k in p],
])
def test_preview_keeps_av_sync_and_timeline(tmp_path, order):
    src = _event_clip(tmp_path / "events.mp4", 2 * len(order))
    base = [(2 * k + 0.3, 2 * k + 1.7) for k in range(len(order))]  # event at +0.7
    segs = [base[k] for k in order]
    out = tmp_path / "preview.mp4"
    pipeline._ffmpeg_cuts_preview(str(src), segs, str(out))
    expected = [1.4 * j + 0.7 for j in range(len(segs))]
    flashes, beeps = _flash_onsets(out), _beep_onsets(out)
    assert len(flashes) == len(beeps) == len(segs), (flashes, beeps)
    for f, b, e in zip(flashes, beeps, expected):
        # The editor maps preview time with the plain segment lengths:
        # no drift across joins, and sound stays on its picture.
        assert abs(b - e) < 0.05, (b, e)
        assert abs(f - b) < 0.07, (f, b)


def test_many_reordered_segments_take_one_pass(tmp_path, monkeypatch):
    """A save with hundreds of out-of-order clips is still one ffmpeg
    pass (it used to be one ffmpeg per clip, holding a rebuild worker
    for minutes), and the preview has exactly the edit's length."""
    src = _make_clip(tmp_path / "src.mp4", "320x240", 90)
    segs = [(i * 0.3, i * 0.3 + 0.2) for i in range(300)][::-1]
    run = _MeasuredRun()
    monkeypatch.setattr(pipeline.subprocess, "run", run)
    out = tmp_path / "preview.mp4"
    pipeline._ffmpeg_cuts_preview(str(src), segs, str(out))
    assert sum(not Path(c[0]).name.startswith("ffprobe")
               for c, _ in run.calls) == 1
    st = _streams(out)
    assert _duration(out) == pytest.approx(60.0, abs=0.1)
    assert float(st["audio"]["duration"]) == pytest.approx(60.0, abs=0.1)
    # The segment list is written next to the output and removed.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["preview.mp4",
                                                          "src.mp4"]


def test_source_audio_cuts_ignore_sparse_keyframes(tmp_path):
    """The local render rebuilds the audio from the source by stream-
    copying each kept range. A source with keyframes only every 10 s (the
    SmartCam mux) used to give each range all the audio from the keyframe
    before it: 28 s of audio under 18 s of video."""
    src = tmp_path / "smartcam.mp4"
    _ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=20",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "300",
            "-sc_threshold", "0", "-force_key_frames", "0,10",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src))
    segs = [(0.15, 4.6), (5.15, 9.6), (10.15, 14.6), (15.15, 19.6)]
    clips = []
    for i, (s, e) in enumerate(segs):
        clip = tmp_path / f"clip{i}.mp4"
        _ffmpeg("-ss", f"{s}", "-to", f"{e}", "-i", str(src), "-an",
                "-c:v", "libx264", "-preset", "ultrafast", str(clip))
        clips.append(str(clip))
    out = tmp_path / "out.mp4"
    pipeline._ffmpeg_concat(clips, str(out), source_audio_path=str(src),
                            audio_segments=segs)
    st = _streams(out)
    video, audio = float(st["video"]["duration"]), float(st["audio"]["duration"])
    assert audio == pytest.approx(17.8, abs=0.1)     # AAC-frame rounding
    assert abs(audio - video) < 0.25, (audio, video)


# ── proxy ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("size,proxy_size", [
    ("640x360", (640, 360)),      # below the cap: not upscaled
    ("1920x1080", (720, 406)),    # landscape
    ("1080x1920", (406, 720)),    # portrait
    ("1080x1080", (720, 720)),    # square is capped too
])
def test_normalize_writes_proxy(tmp_path, size, proxy_size):
    src = _make_clip(tmp_path / "in.mp4", size, 4)
    norm, proxy = tmp_path / "normalized.mp4", tmp_path / pipeline.PROXY_NAME
    assert pipeline._normalize_orientation(
        str(src), str(norm), max_seconds=3.0, proxy_path=str(proxy)) is True
    n, p = _streams(norm), _streams(proxy)
    w, h = map(int, size.split("x"))
    assert (int(n["video"]["width"]), int(n["video"]["height"])) == (w, h)
    assert (int(p["video"]["width"]), int(p["video"]["height"])) == proxy_size
    assert p["video"]["r_frame_rate"] == n["video"]["r_frame_rate"] == "30/1"
    assert "audio" in p and "audio" in n
    # Same timeline as the normalized file (-t cap on both outputs).
    assert _duration(proxy) == pytest.approx(_duration(norm), abs=0.05)
    assert _duration(norm) == pytest.approx(3.0, abs=0.1)
    assert not list(tmp_path.glob("*.tmp.mp4"))
    assert pipeline.preview_source(str(norm)) == str(proxy)


def test_proxy_failure_never_fails_normalize(tmp_path, monkeypatch):
    src = _make_clip(tmp_path / "in.mp4", "320x240", 2)
    norm, proxy = tmp_path / "normalized.mp4", tmp_path / pipeline.PROXY_NAME
    # A bogus stream map makes the combined call fail → plain normalize.
    monkeypatch.setattr(pipeline, "_default_streams", lambda p: (7, None))
    assert pipeline._normalize_orientation(
        str(src), str(norm), proxy_path=str(proxy)) is False
    assert norm.is_file() and not proxy.exists()
    assert not list(tmp_path.glob("*.tmp.mp4"))
    assert pipeline.preview_source(str(norm)) == str(norm)


def test_preview_source_falls_back_for_old_jobs(tmp_path):
    norm = tmp_path / "normalized.mp4"
    norm.write_bytes(b"x")
    assert pipeline.preview_source(str(norm)) == str(norm)
    (tmp_path / pipeline.PROXY_NAME).write_bytes(b"y")
    assert pipeline.preview_source(str(norm)) == str(tmp_path / "proxy.mp4")
    sc = tmp_path / "normalized_smartcam.mp4"
    assert pipeline.preview_source(str(sc)) == str(tmp_path / "proxy.mp4")


# ── analyze_only hand-offs ───────────────────────────────────────────


@pytest.fixture
def fake_analysis(monkeypatch):
    """Stub transcription + LLM: analyze_only's own steps run for real."""
    seen: list[str] = []

    def analyze_video(video_path, **kw):
        seen.append(video_path)
        dur = _duration(video_path)
        return SimpleNamespace(
            segments=[(0.2, dur / 2), (dur / 2 + 0.2, dur - 0.1)],
            subtitles=[{"start": 0.3, "end": 0.8, "text": "hi"}],
            duration=dur, language="en", scene_events=[])
    monkeypatch.setattr(pipeline, "analyze_video", analyze_video)
    import backend.llm as llm
    monkeypatch.setattr(llm, "cleanup_transcript", lambda subs, language=None: {})
    return seen


@pytest.fixture
def private_tmp(tmp_path, monkeypatch):
    """Own tempdir, so leaked temp files of *this* test are visible."""
    d = tmp_path / "systmp"
    d.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(d))
    return d


def test_on_normalized_runs_once_before_analysis(tmp_path, fake_analysis,
                                                 private_tmp):
    src = _make_clip(tmp_path / "upload.mp4", "480x270", 3)
    job = tmp_path / "job"
    events: list[str] = []

    def on_normalized():
        assert (job / "normalized.mp4").is_file()
        assert (job / pipeline.PROXY_NAME).is_file()
        assert not fake_analysis          # before the analysis
        events.append("normalized")
        src.unlink()                      # what the web backend does

    res = pipeline.analyze_only(str(src), str(job), {}, on_normalized=on_normalized)
    assert events == ["normalized"]
    assert res["normalized_path"] == str(job / "normalized.mp4")
    assert Path(res["preview_path"]).is_file()
    assert int(_streams(res["preview_path"])["video"]["width"]) == 720
    assert not list(private_tmp.iterdir())


def test_on_normalized_error_does_not_fail_analysis(tmp_path, fake_analysis):
    src = _make_clip(tmp_path / "upload.mp4", "320x240", 2)

    def boom():
        raise OSError("r2 delete failed")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"), {},
                                on_normalized=boom)
    assert Path(res["preview_path"]).is_file()


def _mean_rgb(path) -> tuple[int, int, int]:
    raw = subprocess.run([FF, "-v", "error", "-ss", "1", "-i", str(path),
                          "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True,
                         check=True).stdout
    return tuple(raw[:3])


def test_concurrent_smartcam_jobs_never_share_output(tmp_path, fake_analysis,
                                                     private_tmp, monkeypatch):
    """Two web jobs starting SmartCam in the same second each get their
    own reframed video (the old shared name was normalized_smartcam_<s>)."""
    monkeypatch.setattr(time, "time", lambda: 1_700_000_000.0)
    cache = tmp_path / "cache"
    monkeypatch.setenv("CLEO_CACHE_DIR", str(cache))
    srcs = {"red": _make_clip(tmp_path / "red.mp4", "640x360", 3, color="red"),
            "blue": _make_clip(tmp_path / "blue.mp4", "640x360", 3, color="blue")}
    settings = {"smartcam_enabled": True, "smartcam_format": "portrait",
                "resolution": "720"}
    results, errors = {}, []

    def job(name):
        try:
            results[name] = pipeline.analyze_only(
                str(srcs[name]), str(tmp_path / f"job_{name}"), dict(settings))
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)
    threads = [threading.Thread(target=job, args=(n,)) for n in srcs]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    for name, res in results.items():
        job_dir = tmp_path / f"job_{name}"
        assert res["normalized_path"] == str(job_dir / "normalized_smartcam.mp4")
        assert not (job_dir / "normalized.mp4").exists()
        r, _g, b = _mean_rgb(res["normalized_path"])
        assert (r > b) if name == "red" else (b > r), (name, r, b)
        # Proxy made from the reframed video (portrait), not the source.
        p = _streams(job_dir / pipeline.PROXY_NAME)["video"]
        assert (int(p["width"]), int(p["height"])) == (406, 720)
    assert not cache.exists() or not list(cache.iterdir())
    # SmartCam intermediates (input_cfr.mp4, video.mp4) are gone.
    assert not list(private_tmp.iterdir())


def test_smartcam_failure_keeps_normalized_and_its_proxy(tmp_path, fake_analysis,
                                                         monkeypatch):
    calls = []

    def failing(**kw):
        calls.append(kw)
        Path(kw["output_path"]).write_bytes(b"partial")
        return None
    monkeypatch.setattr(pipeline, "_run_smartcam_preprocess", failing)
    src = _make_clip(tmp_path / "in.mp4", "640x360", 2)
    job = tmp_path / "job"
    res = pipeline.analyze_only(str(src), str(job), {"smartcam_enabled": True})
    assert calls and calls[0]["output_path"] == str(job / "normalized_smartcam.mp4")
    assert calls[0]["threads"] == 4
    assert res["normalized_path"] == str(job / "normalized.mp4")
    assert not (job / "normalized_smartcam.mp4").exists()
    p = _streams(job / pipeline.PROXY_NAME)["video"]
    assert (int(p["width"]), int(p["height"])) == (640, 360)


def test_smartcam_plugin_default_path_unchanged(tmp_path, monkeypatch, private_tmp):
    """Premiere keeps its cache-dir output when no output_path is given,
    and the temp dir is removed there too."""
    import plugins.premiere.video_editor_premiere as plugin
    monkeypatch.setenv("CLEO_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(time, "time", lambda: 1_700_000_123.0)
    src = _make_clip(tmp_path / "clip.mp4", "640x360", 2)
    out = plugin._run_smartcam_preprocess(str(src), "portrait", "720")
    assert out == str(tmp_path / "cache" /
                      f"clip_smartcam_{1_700_000_123 % 1000000}.mp4")
    assert Path(out).is_file()
    assert not list(private_tmp.iterdir())


# ── thread cap ───────────────────────────────────────────────────────


def _record_runs(monkeypatch):
    cmds: list[list[str]] = []

    def fake_run(cmd, *a, **kw):
        cmds.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    return cmds


def _encodes(cmds):
    return [c for c in cmds if "libx264" in c or "-frames:v" in c or "-q:v" in c]


@pytest.mark.parametrize("env,expect", [(None, "4"), ("2", "2"), ("0", None)])
def test_ffmpeg_thread_cap(tmp_path, monkeypatch, env, expect):
    if env is None:
        monkeypatch.delenv("CLEO_FFMPEG_THREADS", raising=False)
    else:
        monkeypatch.setenv("CLEO_FFMPEG_THREADS", env)
    cmds = _record_runs(monkeypatch)
    monkeypatch.setattr(pipeline, "_probe_hdr", lambda p: False)
    monkeypatch.setattr(pipeline, "_default_streams", lambda p: (0, 1))
    monkeypatch.setattr(pipeline, "_video_size", lambda p: (1, 1))
    f = str(tmp_path / "x.mp4")
    pipeline._normalize_orientation(f, f, proxy_path=str(tmp_path / "p.mp4"))
    pipeline._make_proxy(f, str(tmp_path / "p.mp4"))
    pipeline._ffmpeg_cuts_preview(f, [(0, 1), (2, 3)], f)
    pipeline._ffmpeg_cuts_preview(f, [(2, 3), (0, 1)], f)
    pipeline._export_format(f, f, 1080, 1080)
    pipeline._extract_hook_clip(f, f, 0, 5)
    pipeline._apply_segment_effects(f, f, [(0, 1)], [{"speed": 2.0}])
    pipeline._generate_thumbnail_simple(f, f)
    pipeline._ffmpeg_concat([f], f)
    enc = _encodes(cmds)
    assert len(enc) >= 10
    for c in enc:
        if expect is None:
            assert "-threads" not in c, c
        else:
            # every encoder and decoder carries the cap
            idx = [i for i, a in enumerate(c) if a == "-threads"]
            assert idx and all(c[i + 1] == expect for i in idx), c
            assert idx[0] < c.index("-i"), c
