"""UX3: "no speech" is a coded job error (error_code no_speech) the web
app can word, and its minutes go back when less than 10 s of speech was
detected (owner decision, PLAN 6.1 #10). Render failures carry a code
too; the next render clears it."""
from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import backend.main as M
from backend import accounts, pipeline
from backend.jobs import store

FFMPEG = shutil.which("ffmpeg")


def _job(owner=None, seconds=100.0):
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    job = store.create(str(f), {}, owner_id=owner)
    if owner:
        accounts.charge(job.id, owner, seconds, enforce=False)
    return job


def _fail_with(monkeypatch, exc):
    def analyze(**kw):
        raise exc
    monkeypatch.setattr(M, "analyze_only", analyze)


def test_no_speech_is_coded_and_refunded(auth_on, monkeypatch):
    job = _job(owner="user_a")
    _fail_with(monkeypatch, pipeline.NoSpeechError())
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "error"
    assert got.error_code == "no_speech" and got.refunded is True
    # Old clients still get the English sentence.
    assert got.error == "No speech detected in the video."
    assert accounts.get_usage(job.id)["refunded"] == 1
    d = got.to_dict()
    assert (d["error_code"], d["refunded"]) == ("no_speech", True)


@pytest.mark.parametrize("speech,refunded", [(0.0, True), (9.9, True),
                                             (10.0, False), (40.0, False)])
def test_refund_threshold_is_ten_seconds_of_speech(auth_on, monkeypatch,
                                                   speech, refunded):
    assert M.NO_SPEECH_REFUND_S == 10.0
    job = _job(owner="user_a")
    _fail_with(monkeypatch, pipeline.NoSpeechError(speech_seconds=speech))
    M._run_analyze_inner(job.id)
    assert store.get(job.id).error_code == "no_speech"
    assert bool(accounts.get_usage(job.id)["refunded"]) is refunded
    assert store.get(job.id).refunded is (True if refunded else None)


def test_no_speech_without_accounts(monkeypatch):
    """Anonymous beta: nothing was charged, nothing to refund."""
    job = _job()
    _fail_with(monkeypatch, pipeline.NoSpeechError())
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert (got.status, got.error_code, got.refunded) == (
        "error", "no_speech", None)


def test_other_content_failures_have_no_code(monkeypatch):
    job = _job()
    _fail_with(monkeypatch, ValueError("nothing to apply"))
    M._run_analyze_inner(job.id)
    assert store.get(job.id).error_code is None


def test_video_without_sound_track_is_coded_no_audio(auth_on, monkeypatch):
    """An upload POST /jobs couldn't probe fails in transcription
    (src/audio.py): coded no_audio, and never charged."""
    job = _job(owner="user_a")
    _fail_with(monkeypatch, ValueError("Video has no audio track"))
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert (got.error_code, got.refunded) == ("no_audio", True)
    assert accounts.get_usage(job.id)["refunded"] == 1


def test_error_code_in_the_dashboard_poll_and_the_list(client, monkeypatch):
    job = _job()
    _fail_with(monkeypatch, pipeline.NoSpeechError())
    M._run_analyze_inner(job.id)
    rows = client.get(f"/jobs/status?ids={job.id}").json()["jobs"]
    assert rows[0]["error_code"] == "no_speech"
    assert rows[0]["refunded"] is None
    assert client.get(f"/jobs/{job.id}").json()["error_code"] == "no_speech"
    assert "error_code" in M._LIST_FIELDS and "refunded" in M._LIST_FIELDS


@pytest.mark.skipif(not FFMPEG or not shutil.which("ffprobe"),
                    reason="ffmpeg/ffprobe not installed")
def test_pipeline_raises_no_speech_for_silence(tmp_path, monkeypatch):
    """analyze_only: no speech segments at all → NoSpeechError (0 s)."""
    src = tmp_path / "silent.mp4"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    "testsrc=size=64x64:rate=10:duration=2", "-f", "lavfi",
                    "-i", "anullsrc=r=44100:cl=mono", "-t", "2",
                    "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", str(src)],
                   check=True)
    monkeypatch.setattr(pipeline, "analyze_video", lambda **kw: SimpleNamespace(
        segments=[], subtitles=[], duration=2.0, language="en",
        scene_events=[]))
    with pytest.raises(pipeline.NoSpeechError) as info:
        pipeline.analyze_only(str(src), str(tmp_path / "job"), {})
    assert info.value.code == "no_speech"
    assert info.value.speech_seconds == 0.0
    assert str(info.value) == "No speech detected in the video."
    assert isinstance(info.value, RuntimeError)   # old `except RuntimeError`


# ── renders ──────────────────────────────────────────────────────────


def _review_job():
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", segments=[(0.0, 4.0)],
                 mezz_key=f"jobs/{job.id}/mezz.mp4", render_gen=0)
    return store.get(job.id)


@pytest.mark.parametrize("exc,code", [
    (RuntimeError("Render produced no output clips."), "render_failed"),
    (pipeline.RenderUnavailableError("gave up", code="render_timeout"),
     "render_timeout"),
    (pipeline.RenderUnavailableError("spend limit",
                                     code="render_unavailable"),
     "render_unavailable"),
    (pipeline.RenderUnavailableError("modal package not installed"),
     "render_unavailable"),
])
def test_render_failure_codes(monkeypatch, exc, code):
    job = _review_job()

    def render(**kw):
        raise exc
    monkeypatch.setattr(M.pipeline, "render_to_keys", render)
    store.update(job.id, status="processing", render_gen=1)
    M._run_render_inner(job.id, [])
    got = store.get(job.id)
    assert (got.status, got.message, got.error_code) == (
        "awaiting_review", "render_failed", code)


def test_next_render_clears_the_code(client, monkeypatch):
    job = _review_job()
    store.update(job.id, message="render_failed", error="boom",
                 error_code="render_failed")
    monkeypatch.setattr(M, "_run_render", lambda *a, **k: None)
    r = client.post(f"/jobs/{job.id}/render", json={"subtitles": []})
    assert r.status_code == 200, r.text
    got = store.get(job.id)
    assert (got.status, got.error, got.error_code) == (
        "processing", None, None)
