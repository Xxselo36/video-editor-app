"""UX3: a video without a sound track is refused by POST /jobs (400
no_audio) before the upload is claimed or charged — 0 minutes, no job,
the upload deleted. Unknown (the probe can't read the streams) is
accepted: only a clear "no audio stream" refuses."""
from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import pytest

import backend.main as M
from backend import accounts, storage
from backend.jobs import store
from conftest import add_sub

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(
    not FFMPEG or not shutil.which("ffprobe"),
    reason="ffmpeg/ffprobe not installed")

KEY = "uploads/user_a/00112233445566778899aabbccddeeff.mp4"


def _clip(path: Path, audio: bool) -> Path:
    args = [FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
            "testsrc=size=64x64:rate=10:duration=2"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                 "-c:a", "aac", "-shortest"]
    subprocess.run([*args, "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def _usage_rows():
    return accounts._read("SELECT * FROM usage")


# ── the probes ───────────────────────────────────────────────────────


@pytest.mark.parametrize("streams,verdict", [
    ([{"codec_type": "video"}, {"codec_type": "audio"}], True),
    ([{"codec_type": "audio"}], True),
    ([{"codec_type": "video"}], False),
    ([{"codec_type": "video"}, {"codec_type": "data"}], False),
    ([], None),
    (None, None),
    ("junk", None),
])
def test_audio_verdict(streams, verdict):
    assert M._audio_verdict(streams) is verdict


@needs_ffmpeg
def test_probes_tell_sound_from_silence(tmp_path):
    with_audio = _clip(tmp_path / "talk.mp4", audio=True)
    silent = _clip(tmp_path / "screen.mp4", audio=False)
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(b"not a video")
    assert M._probe_audio(str(with_audio)) is True
    assert M._probe_audio(str(silent)) is False
    assert M._probe_audio(str(junk)) is None
    # The remote probe is one ffprobe run for length + streams (ffprobe
    # reads a local path like a URL).
    seconds, has_audio = M._probe_remote(str(silent))
    assert seconds == pytest.approx(2.0, abs=0.2) and has_audio is False
    seconds, has_audio = M._probe_remote(str(with_audio))
    assert seconds == pytest.approx(2.0, abs=0.2) and has_audio is True
    assert M._probe_remote(str(junk)) == (None, None)


# ── POST /jobs, body upload ──────────────────────────────────────────


def _upload_body(client, headers, data: bytes):
    return client.post("/jobs", headers=headers,
                       data={"settings": "{}", "filename": "v.mp4"},
                       files={"file": ("v.mp4", data, "video/mp4")})


def _uploads_left() -> list[Path]:
    d = Path(M._WORK_ROOT) / "uploads"
    return [p for p in d.iterdir()] if d.exists() else []


@needs_ffmpeg
def test_body_upload_without_sound_is_refused_before_the_charge(
        client, enforce, bearer, tmp_path, clean_state, no_r2):
    add_sub(plan="pro", period_start=time.time() - 60)
    silent = _clip(tmp_path / "screen.mp4", audio=False).read_bytes()
    r = _upload_body(client, bearer(), silent)
    assert r.status_code == 400
    assert r.json() == {"detail": "no_audio"}
    assert store.list_all() == [] and clean_state == []   # no job, no analysis
    assert _usage_rows() == []                             # 0 minutes
    assert _uploads_left() == []                           # upload deleted
    # The same video with sound goes through and is charged.
    talk = _clip(tmp_path / "talk.mp4", audio=True).read_bytes()
    r = _upload_body(client, bearer(), talk)
    assert r.status_code == 200, r.text
    assert len(_usage_rows()) == 1


@needs_ffmpeg
def test_body_upload_without_sound_refused_with_billing_off(
        client, tmp_path, clean_state, no_r2):
    silent = _clip(tmp_path / "screen.mp4", audio=False).read_bytes()
    r = _upload_body(client, {}, silent)
    assert (r.status_code, r.json()) == (400, {"detail": "no_audio"})
    assert store.list_all() == [] and clean_state == []


def test_unreadable_body_upload_is_still_accepted(client, clean_state,
                                                  monkeypatch, no_r2):
    """The probe can't tell (junk, an exotic container): accepted — the
    analysis decides (and refunds a no-audio failure, test_no_speech)."""
    monkeypatch.setattr(M, "_probe_duration", lambda p: 10.0)
    r = _upload_body(client, {}, b"x" * 100)
    assert r.status_code == 200, r.text
    assert len(clean_state) == 1


# ── POST /jobs, upload in R2 (the browser's resumable upload) ────────


@pytest.fixture
def r2_upload(r2, monkeypatch):
    r2.put_object(Bucket=storage.bucket(), Key=KEY, Body=b"v" * 10)
    verdict = {"has_audio": False, "seconds": 60.0, "probes": 0}

    def probe(url):
        verdict["probes"] += 1
        return verdict["seconds"], verdict["has_audio"]
    monkeypatch.setattr(M, "_probe_remote", probe)
    return verdict


def _post_key(client, headers):
    return client.post("/jobs", headers=headers,
                       data={"settings": "{}", "storage_key": KEY})


def test_r2_upload_without_sound_is_refused_before_the_charge(
        client, enforce, bearer, r2_upload, clean_state):
    add_sub(plan="pro", period_start=time.time() - 60)
    r = _post_key(client, bearer())
    assert (r.status_code, r.json()) == (400, {"detail": "no_audio"})
    assert r2_upload["probes"] == 1
    assert store.list_all() == [] and clean_state == []
    assert store.find_by_key(KEY) is None                  # never claimed
    assert _usage_rows() == []                             # 0 minutes
    assert storage.head(KEY) is None                       # upload deleted


@pytest.mark.parametrize("has_audio", [True, None])
def test_r2_upload_with_sound_or_unknown_is_accepted(
        client, enforce, bearer, r2_upload, clean_state, has_audio):
    add_sub(plan="pro", period_start=time.time() - 60)
    r2_upload["has_audio"] = has_audio
    r = _post_key(client, bearer())
    assert r.status_code == 200, r.text
    assert accounts.get_usage(r.json()["job_id"])["seconds_billed"] == 60
