"""Owner decision 4 (UX3, PLAN 2.9 A): the web app never zooms into a
video that is already vertical. A 9:16 recording is kept exactly as
recorded (no SmartCam at all); another portrait frame is only reframed
to 9:16 (zoom 1.0); landscape → 9:16 is unchanged (zoom 1.1). The
plugin's own default — desktop / Premiere — stays 1.3 ("Speaker Focus")."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import plugins.premiere.video_editor_premiere as plugin
from backend import pipeline

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(
    not FFMPEG or not shutil.which("ffprobe"),
    reason="ffmpeg/ffprobe not installed")


@pytest.mark.parametrize("orient,fmt,same_aspect_zoom,expected", [
    # The plugin as the desktop app and Premiere use it: unchanged.
    ("portrait", "portrait", None, 1.3),
    ("landscape", "landscape", None, 1.3),
    ("square", "landscape", None, 1.3),
    ("landscape", "portrait", None, 1.1),
    ("square", "portrait", None, 1.1),
    # What the web passes for a 9:16 target.
    ("portrait", "portrait", 1.0, 1.0),
    ("landscape", "portrait", 1.0, 1.1),
])
def test_smartcam_zoom(orient, fmt, same_aspect_zoom, expected):
    assert plugin._smartcam_zoom(orient, fmt, same_aspect_zoom) == expected


@pytest.mark.parametrize("size,vertical", [
    ((1080, 1920), True), ((720, 1280), True), ((2160, 3840), True),
    ((1080, 1918), True),                 # odd encoders round a little
    ((1080, 1440), False),                # 3:4
    ((1170, 2532), False),                # a phone screen recording
    ((1920, 1080), False), ((1080, 1080), False), (None, False),
])
def test_is_vertical_9x16(size, vertical):
    assert pipeline.is_vertical_9x16(size) is vertical


def _clip(path: Path, size: str, *pre: str) -> Path:
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"testsrc=size={size}:rate=10:duration=1.5",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
                    "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(path)], check=True)
    return path


@needs_ffmpeg
def test_display_size_honours_rotation(tmp_path):
    assert pipeline._display_size(str(_clip(tmp_path / "p.mp4", "90x160"))) \
        == (90, 160)
    land = _clip(tmp_path / "l.mp4", "160x90")
    assert pipeline._display_size(str(land)) == (160, 90)
    # A phone recording stored landscape with a 90° display rotation.
    rotated = tmp_path / "r.mp4"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-display_rotation", "90",
                    "-i", str(land), "-c", "copy", str(rotated)], check=True)
    if pipeline._display_size(str(rotated)) == (160, 90):
        pytest.skip("this ffmpeg doesn't write the display matrix")
    assert pipeline._display_size(str(rotated)) == (90, 160)
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"not a video")
    assert pipeline._display_size(str(junk)) is None


@pytest.fixture
def analysis(monkeypatch):
    """Stub transcription + LLM; the SmartCam plugin call recorded (and
    'failing', so the normalized file is kept)."""
    import backend.llm as llm

    def analyze_video(video_path, **kw):
        return SimpleNamespace(segments=[(0.1, 1.2)],
                               subtitles=[{"start": 0.2, "end": 1.0,
                                           "text": "hi"}],
                               duration=1.5, language="en", scene_events=[])
    monkeypatch.setattr(pipeline, "analyze_video", analyze_video)
    monkeypatch.setattr(llm, "cleanup_transcript",
                        lambda subs, language=None: {})
    calls: list[dict] = []

    def smartcam(**kw):
        calls.append(kw)
        return None
    monkeypatch.setattr(pipeline, "_run_smartcam_preprocess", smartcam)
    return calls


TIKTOK = {"smartcam_enabled": True, "smartcam_format": "portrait"}


@needs_ffmpeg
def test_vertical_9x16_is_kept_as_recorded(tmp_path, analysis):
    src = _clip(tmp_path / "phone.mp4", "90x160")
    job = tmp_path / "job"
    res = pipeline.analyze_only(str(src), str(job), dict(TIKTOK))
    assert analysis == []                       # no SmartCam, no zoom
    assert res["normalized_path"] == str(job / "normalized.mp4")
    # The proxy came out of the normalize pass itself.
    assert (job / pipeline.PROXY_NAME).is_file()


@needs_ffmpeg
@pytest.mark.parametrize("size", ["120x160", "160x90"])   # 3:4, landscape
def test_other_sources_are_reframed_without_speaker_zoom(tmp_path, analysis,
                                                         size):
    src = _clip(tmp_path / "in.mp4", size)
    pipeline.analyze_only(str(src), str(tmp_path / "job"), dict(TIKTOK))
    [call] = analysis
    assert call["smartcam_format"] == "portrait"
    assert call["same_aspect_zoom"] == 1.0


@needs_ffmpeg
def test_landscape_target_keeps_the_plugin_default(tmp_path, analysis):
    """SmartCam to 16:9 (the Custom workflow) is not the TikTok case:
    unchanged, no zoom override."""
    src = _clip(tmp_path / "in.mp4", "160x90")
    pipeline.analyze_only(str(src), str(tmp_path / "job"),
                          {"smartcam_enabled": True,
                           "smartcam_format": "landscape"})
    [call] = analysis
    assert "same_aspect_zoom" not in call


@needs_ffmpeg
def test_smartcam_off_stays_off(tmp_path, analysis):
    src = _clip(tmp_path / "in.mp4", "160x90")
    pipeline.analyze_only(str(src), str(tmp_path / "job"), {})
    assert analysis == []
