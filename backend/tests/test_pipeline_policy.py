"""No silent fallbacks: Modal render retries and the local-render switch,
Groq retries (retry-after) and failures, and the local-Whisper switch.
Everything external is mocked — no network, no Modal, no Groq.
"""
from __future__ import annotations

import os
import sys
import time
import types
from pathlib import Path

import pytest

from backend import pipeline, whisper_groq

# ── Modal render ─────────────────────────────────────────────────────


class FakeModal:
    """Minimal `modal` module: Volume + Function.from_name. `plan` is the
    list of outcomes of the spawned calls' get(): an exception or a
    result map. `cancel_fails` makes FunctionCall.cancel raise."""

    def __init__(self, plan):
        self.plan = list(plan)
        self.remote_calls = 0
        self.cancelled = 0
        self.cancel_fails = False
        self.uploads: list[tuple[str, str]] = []
        self.removed: list[str] = []
        self.missing: set[str] = set()   # remove_file → NotFoundError
        self.job_ids: list[str] = []     # volume folder of each call
        self.files = {"output.mp4": b"primary", "thumbnail.jpg": b"jpg",
                      "output_1-1.mp4": b"square"}
        fake = self

        class _Batch:
            def __init__(self, force):
                self.force = force

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def put_file(self, local, remote):
                fake.uploads.append((local, remote))

        class _Volume:
            @staticmethod
            def from_name(name):
                return _Volume()

            def batch_upload(self, force=False):
                return _Batch(force)

            def read_file(self, remote):
                yield fake.files[remote.rsplit("/", 1)[1]]

            def remove_file(self, path, recursive=False):
                if path in fake.missing:
                    raise NotFoundError(path)
                fake.removed.append(path)

        class _Call:
            def __init__(self, outcome):
                self.outcome = outcome

            def get(self, timeout=None):
                if isinstance(self.outcome, BaseException):
                    raise self.outcome
                return self.outcome

            def cancel(self):
                if fake.cancel_fails:
                    raise ConnectionError("cancel failed")
                fake.cancelled += 1

        class _Fn:
            def spawn(self, **kw):
                fake.remote_calls += 1
                fake.job_ids.append(kw["job_id"])
                return _Call(fake.plan.pop(0))

        class _Function:
            @staticmethod
            def from_name(app, name):
                return _Fn()

        self.module = types.SimpleNamespace(Volume=_Volume, Function=_Function)


OK_RESULT = {"primary": "output.mp4", "_thumbnail": "thumbnail.jpg",
             "1:1": "output_1-1.mp4"}


class FunctionTimeoutError(Exception):
    """Same class name as modal.exception.FunctionTimeoutError."""


class NotFoundError(Exception):
    """Same class name as modal.exception.NotFoundError."""


@pytest.fixture
def modal_env(monkeypatch, tmp_path):
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    monkeypatch.setattr(pipeline, "MODAL_LEDGER_DIR", str(tmp_path / "ledger"))
    monkeypatch.delenv("CLEO_LOCAL_RENDER_FALLBACK", raising=False)
    monkeypatch.delenv("CLEO_MODAL_RETRY_DELAYS", raising=False)
    sleeps: list[float] = []
    monkeypatch.setattr(pipeline.time, "sleep", lambda s: sleeps.append(s))

    def install(plan):
        fake = FakeModal(plan)
        monkeypatch.setitem(sys.modules, "modal", fake.module)
        return fake
    install.sleeps = sleeps
    install.ledger = tmp_path / "ledger"
    return install


@pytest.fixture
def local_burn(monkeypatch):
    """Records whether the local MoviePy render was reached."""
    calls = []

    class LocalRender(Exception):
        pass

    def fake_burn(**kw):
        calls.append(kw)
        raise LocalRender("local render reached")
    monkeypatch.setattr(pipeline, "_multi_clip_burn", fake_burn)
    fake_burn.calls = calls
    fake_burn.exc = LocalRender
    return fake_burn


def _render(tmp_path, **settings):
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"x")
    return pipeline.render_only(
        normalized_path=str(src), output_dir=str(tmp_path / "out"),
        segments=[(0.0, 1.0)], subtitles=[],
        settings={"output_formats": ["1:1"], **settings},
    )


def test_modal_retries_then_succeeds(tmp_path, modal_env, local_burn):
    fake = modal_env([ConnectionError("modal down"), RuntimeError("oom"),
                      OK_RESULT])
    res = _render(tmp_path)
    assert fake.remote_calls == 3
    assert modal_env.sleeps == [1.0] * 10 + [1.0] * 30   # 10 s, then 30 s
    assert len(fake.uploads) == 1          # the mezzanine goes up once
    assert len(fake.removed) == 1          # and is cleaned up
    # Each failed call was cancelled before the retry (same folder).
    assert fake.cancelled == 2 and len(set(fake.job_ids)) == 1
    # Nothing can write into the folder any more: out of the ledger.
    assert list(modal_env.ledger.iterdir()) == []
    out = tmp_path / "out"
    assert (out / "cleo_output.mp4").read_bytes() == b"primary"
    assert (out / "cleo_output_1-1.mp4").read_bytes() == b"square"
    assert res["outputs"]["1:1"] == str(out / "cleo_output_1-1.mp4")
    assert not list(out.glob("*.part"))
    assert not local_burn.calls


def test_modal_failure_fails_render_without_local_fallback(
        tmp_path, modal_env, local_burn):
    fake = modal_env([ConnectionError("down")] * 3)
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="after 3 attempt"):
        _render(tmp_path)
    assert fake.remote_calls == 3
    assert not local_burn.calls            # no silent MoviePy render
    assert fake.removed                     # volume cleaned after failure too


def test_uncancelled_call_keeps_its_folder_for_the_sweep(
        tmp_path, modal_env, local_burn):
    """A failed call that couldn't be cancelled may still write into the
    folder after we removed it: its ledger marker stays until the sweep
    finds it old enough, and the sweep removes the folder again."""
    fake = modal_env([ConnectionError("lost"), OK_RESULT])
    fake.cancel_fails = True
    _render(tmp_path)
    folder = fake.job_ids[0]
    assert fake.removed == [f"/{folder}"]
    marker = modal_env.ledger / folder
    assert marker.is_file()
    now = marker.stat().st_mtime
    # Young: removed again, marker kept.
    assert pipeline.sweep_modal_folders(now=now + 60) == 0
    assert fake.removed == [f"/{folder}"] * 2 and marker.is_file()
    # Older than any call can run: gone for good (NotFound counts too).
    fake.missing.add(f"/{folder}")
    assert pipeline.sweep_modal_folders(
        now=now + pipeline._MODAL_ORPHAN_AGE_S + 1) == 1
    assert not marker.exists()


def test_sweep_removes_folders_left_by_a_restart(tmp_path, modal_env,
                                                 monkeypatch):
    """Markers without a running render (the process was killed mid-
    render) are removed from the volume at the next sweep; a folder a
    render of this process is using is left alone."""
    fake = modal_env([])
    ledger = modal_env.ledger
    ledger.mkdir()
    (ledger / "deadbeef0001").touch()
    (ledger / "livejob00001").touch()
    monkeypatch.setattr(pipeline, "_MODAL_ACTIVE", {"livejob00001"})
    pipeline.sweep_modal_folders()
    assert fake.removed == ["/deadbeef0001"]
    old = time.time() - pipeline._MODAL_ORPHAN_AGE_S - 5
    os.utime(ledger / "deadbeef0001", (old, old))
    assert pipeline.sweep_modal_folders() == 1
    assert sorted(p.name for p in ledger.iterdir()) == ["livejob00001"]
    # Without Modal configured the sweep does nothing.
    monkeypatch.delenv("MODAL_TOKEN_ID")
    assert pipeline.sweep_modal_folders() == 0


def test_modal_failure_with_explicit_local_fallback(
        tmp_path, modal_env, local_burn, monkeypatch):
    monkeypatch.setenv("CLEO_LOCAL_RENDER_FALLBACK", "1")
    monkeypatch.setenv("CLEO_MODAL_RETRY_DELAYS", "0")
    fake = modal_env([ConnectionError("down")] * 2)
    with pytest.raises(local_burn.exc):
        _render(tmp_path)
    assert fake.remote_calls == 2
    assert len(local_burn.calls) == 1


def test_modal_timeout_is_not_retried(tmp_path, modal_env, local_burn):
    fake = modal_env([FunctionTimeoutError("1800 s")])
    with pytest.raises(pipeline.RenderUnavailableError):
        _render(tmp_path)
    assert fake.remote_calls == 1 and modal_env.sleeps == []


def test_failed_download_keeps_previous_outputs(tmp_path, modal_env, local_burn):
    out = tmp_path / "out"
    out.mkdir()
    (out / "cleo_output.mp4").write_bytes(b"old render")
    fake = modal_env([OK_RESULT] * 3)
    del fake.files["output.mp4"]           # every download breaks
    with pytest.raises(pipeline.RenderUnavailableError):
        _render(tmp_path)
    assert (out / "cleo_output.mp4").read_bytes() == b"old render"
    assert not list(out.glob("*.part"))


def test_no_modal_renders_locally_by_default(tmp_path, monkeypatch, local_burn):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.delenv("CLEO_LOCAL_RENDER_FALLBACK", raising=False)
    with pytest.raises(local_burn.exc):
        _render(tmp_path)


def test_no_modal_and_local_off_fails(tmp_path, monkeypatch, local_burn):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.setenv("CLEO_LOCAL_RENDER_FALLBACK", "0")
    with pytest.raises(pipeline.RenderUnavailableError, match="no render worker"):
        _render(tmp_path)
    assert not local_burn.calls


def test_local_fallback_switch_defaults(monkeypatch):
    monkeypatch.delenv("CLEO_LOCAL_RENDER_FALLBACK", raising=False)
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    assert pipeline.local_render_fallback_enabled() is False
    monkeypatch.delenv("MODAL_TOKEN_ID")
    assert pipeline.local_render_fallback_enabled() is True
    monkeypatch.setenv("CLEO_LOCAL_RENDER_FALLBACK", "0")
    assert pipeline.local_render_fallback_enabled() is False


# ── Groq ─────────────────────────────────────────────────────────────


def _rate_limit(retry_after: str | None = "7"):
    import httpx
    import openai
    headers = {"retry-after": retry_after} if retry_after else {}
    resp = httpx.Response(429, headers=headers, request=httpx.Request(
        "POST", "https://api.groq.com/openai/v1/audio/transcriptions"))
    return openai.RateLimitError(
        "Rate limit reached on audio seconds per hour (ASH)",
        response=resp, body=None)


def _bad_request():
    import httpx
    import openai
    resp = httpx.Response(400, request=httpx.Request("POST", "https://x"))
    return openai.BadRequestError("bad audio", response=resp, body=None)


GROQ_OK = types.SimpleNamespace(model_dump=lambda: {
    "text": "hello world", "language": "english", "duration": 2.0,
    "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "hello world"}],
    "words": [{"word": "hello", "start": 0.1, "end": 0.4},
              {"word": "world", "start": 0.5, "end": 0.9}],
})


@pytest.fixture
def groq(monkeypatch, tmp_path):
    """Fake openai.OpenAI whose transcription call follows `plan`."""
    import openai
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    monkeypatch.delenv("CLEO_GROQ_MAX_RETRY_WAIT", raising=False)
    state = types.SimpleNamespace(plan=[], calls=0, sleeps=[], clients=[])
    monkeypatch.setattr(whisper_groq.time, "sleep", lambda s: state.sleeps.append(s))

    class FakeClient:
        def __init__(self, **kw):
            state.clients.append(kw)
            self.audio = types.SimpleNamespace(transcriptions=self)

        def create(self, file, **kw):
            state.calls += 1
            outcome = state.plan.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
    monkeypatch.setattr(openai, "OpenAI", FakeClient)
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF")
    state.audio = str(audio)
    return state


def test_groq_retries_honoring_retry_after(groq):
    groq.plan = [_rate_limit("7"), GROQ_OK]
    out = whisper_groq._transcribe_single(groq.audio, None, None)
    assert groq.calls == 2 and groq.sleeps == [7.0]
    assert out["language"] == "en" and len(out["segments"][0]["words"]) == 2
    # our retries only — the SDK's own would stack on top
    assert groq.clients[0]["max_retries"] == 0


def test_groq_fails_after_three_attempts(groq):
    groq.plan = [_rate_limit(None)] * 3
    with pytest.raises(whisper_groq.GroqTranscriptionError) as ei:
        whisper_groq._transcribe_single(groq.audio, None, None)
    assert groq.calls == 3 and len(groq.sleeps) == 2
    err = ei.value
    # OSError → the web backend's infra-failure rule refunds the minutes
    assert isinstance(err, OSError)
    msg = str(err)
    assert msg.startswith("transcription_unavailable:")
    # No provider text in the user-visible message (the web UI maps
    # "audio", "404", "413" … to unrelated error texts).
    assert "audio" not in msg.lower() and "429" not in msg


def test_groq_non_retryable_error_fails_at_once(groq):
    groq.plan = [_bad_request()]
    with pytest.raises(whisper_groq.GroqTranscriptionError):
        whisper_groq._transcribe_single(groq.audio, None, None)
    assert groq.calls == 1 and groq.sleeps == []


def test_groq_long_retry_after_fails_fast(groq):
    groq.plan = [_rate_limit("900")]
    with pytest.raises(whisper_groq.GroqTranscriptionError, match="retry in"):
        whisper_groq._transcribe_single(groq.audio, None, None)
    assert groq.calls == 1 and groq.sleeps == []


def test_groq_failed_chunk_is_not_skipped(groq, monkeypatch, tmp_path):
    monkeypatch.setattr(whisper_groq, "_probe_duration", lambda p: 700.0)
    chunks = []

    def extract(path, start, dur):
        c = tmp_path / f"chunk{len(chunks)}.m4a"
        c.write_bytes(b"x")
        chunks.append(c)
        return str(c)
    monkeypatch.setattr(whisper_groq, "_extract_chunk", extract)
    groq.plan = [GROQ_OK] + [_rate_limit("1")] * 3
    with pytest.raises(whisper_groq.GroqTranscriptionError):
        whisper_groq.transcribe_via_groq(groq.audio)
    assert len(chunks) == 2                       # stopped at the bad chunk
    assert not any(c.exists() for c in chunks)    # chunk files removed

    monkeypatch.setattr(whisper_groq, "_extract_chunk", lambda *a: None)
    with pytest.raises(whisper_groq.GroqTranscriptionError, match="chunk 1/3"):
        whisper_groq.transcribe_via_groq(groq.audio)


def test_groq_failed_english_pass_is_not_skipped(monkeypatch):
    calls = []

    def fake(path, initial_prompt=None, language=None):
        calls.append(language)
        if language == "en":
            raise whisper_groq.GroqTranscriptionError(
                "transcription_unavailable: x")
        return {"text": "hallo", "segments": [], "language": "de"}
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq", fake)
    with pytest.raises(whisper_groq.GroqTranscriptionError):
        whisper_groq.transcribe_via_groq_multilang("a.wav")
    assert calls == [None, "en"]


def test_groq_not_configured_returns_none(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert whisper_groq._transcribe_single("a.wav", None, None) is None


# ── AudioAnalyzer: WAV cleanup + local-Whisper switch ────────────────


@pytest.fixture
def analyzer(tmp_path, monkeypatch):
    from src import audio
    monkeypatch.delenv("CLEO_LOCAL_WHISPER", raising=False)
    wavs: list[Path] = []

    def extract_audio(self, target_sr=16000):
        p = tmp_path / f"extract{len(wavs)}.wav"
        p.write_bytes(b"RIFF")
        wavs.append(p)
        return str(p)
    monkeypatch.setattr(audio.AudioAnalyzer, "extract_audio", extract_audio)
    local = []

    class FakeWhisper:
        def transcribe(self, path, **kw):
            local.append(path)
            info = types.SimpleNamespace(duration=1.0, language="en")
            return iter([]), info
    monkeypatch.setattr(audio.AudioAnalyzer, "whisper_model",
                        property(lambda self: FakeWhisper()))
    a = audio.AudioAnalyzer("video.mp4")
    a.wavs, a.local = wavs, local
    return a


def _groq_returns(monkeypatch, outcome):
    def fake(path, initial_prompt=None, initial_prompt_en=None):
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq_multilang", fake)


def test_groq_success_removes_the_wav(analyzer, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk")
    _groq_returns(monkeypatch, {"text": "", "segments": [], "language": "en"})
    analyzer.transcribe()
    assert analyzer.wavs and not analyzer.wavs[0].exists()
    assert not analyzer.local


def test_groq_failure_fails_instead_of_local_whisper(analyzer, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk")
    err = whisper_groq.GroqTranscriptionError("transcription_unavailable: x")
    _groq_returns(monkeypatch, err)
    with pytest.raises(whisper_groq.GroqTranscriptionError):
        analyzer.transcribe()
    assert not analyzer.local
    assert not analyzer.wavs[0].exists()


def test_local_whisper_when_allowed(analyzer, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk")
    monkeypatch.setenv("CLEO_LOCAL_WHISPER", "1")
    _groq_returns(monkeypatch,
                  whisper_groq.GroqTranscriptionError("transcription_unavailable"))
    analyzer.transcribe()
    assert analyzer.local and not analyzer.wavs[0].exists()


def test_desktop_without_groq_key_uses_local_whisper(analyzer, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    analyzer.transcribe()
    assert analyzer.local


def test_no_backend_at_all_is_a_clear_infra_error(analyzer, monkeypatch):
    from src import audio
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setenv("CLEO_LOCAL_WHISPER", "0")
    with pytest.raises(audio.TranscriptionUnavailableError) as ei:
        analyzer.transcribe()
    assert isinstance(ei.value, OSError)
    assert not analyzer.local and not analyzer.wavs[0].exists()


@pytest.fixture
def private_tmpdir(tmp_path, monkeypatch):
    import tempfile
    d = tmp_path / "tmp"
    d.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(d))
    return d


def test_video_without_audio_leaves_no_wav(tmp_path, private_tmpdir):
    """extract_audio fails for a video with no audio track: its temp WAV
    must not stay behind (it used to, as an empty file per call)."""
    import subprocess
    from src import audio
    src = tmp_path / "silent.mp4"
    subprocess.run([pipeline.get_ffmpeg_path(), "-y", "-v", "error", "-f",
                    "lavfi", "-i", "color=c=black:size=64x64:rate=10:duration=1",
                    "-c:v", "libx264", "-preset", "ultrafast", "-an", str(src)],
                   check=True)
    a = audio.AudioAnalyzer(str(src))
    with pytest.raises(ValueError, match="no audio"):
        a.transcribe()
    with pytest.raises(ValueError, match="no audio"):
        a.get_audio_data()
    assert list(private_tmpdir.iterdir()) == []


def test_failed_audio_write_removes_the_partial_wav(private_tmpdir,
                                                    monkeypatch):
    """A write that dies half-way (full disk, ffmpeg error) must not
    leave a partial copy of the speech in /tmp; the clip is closed."""
    from src import audio
    closed = []

    class _Audio:
        def write_audiofile(self, path, **kw):
            Path(path).write_bytes(b"RIFF" + b"\0" * 1000)
            raise OSError(28, "No space left on device")

    class _Clip:
        def __init__(self, path):
            self.audio = _Audio()

        def close(self):
            closed.append(True)
    monkeypatch.setattr(audio, "VideoFileClip", _Clip)
    with pytest.raises(OSError):
        audio.AudioAnalyzer("video.mp4").extract_audio()
    assert closed == [True]
    assert list(private_tmpdir.iterdir()) == []


def test_faster_whisper_is_not_imported_on_the_web_path():
    """The API process (backend.main → pipeline → plugin) loads neither
    local Whisper nor torch/ultralytics (dropped from the image). Runs in
    a fresh interpreter; the DB env of conftest is inherited."""
    import subprocess
    code = ("import sys, backend.main, backend.pipeline, "
            "plugins.premiere.video_editor_premiere; "
            "bad = [m for m in ('faster_whisper', 'ctranslate2', 'torch', "
            "'torchvision', 'ultralytics') if m in sys.modules]; "
            "print(bad); sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], capture_output=True,
                       text=True, cwd=str(Path(__file__).resolve().parents[2]))
    assert r.returncode == 0, r.stdout + r.stderr[-2000:]
