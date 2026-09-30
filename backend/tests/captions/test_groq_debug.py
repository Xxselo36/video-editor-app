"""CLEO_GROQ_DEBUG=1 logs one raw verbose_json word object per Groq request
(UX2, captions.md C21): does Groq send a per-word `probability`? The word's
text (user speech) is redacted to its length."""
from __future__ import annotations

import copy
import types

import pytest

from backend import whisper_groq

PAYLOAD = {
    "text": "hello world", "language": "english", "duration": 2.0,
    "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "hello world",
                  "avg_logprob": -0.21}],
    "words": [{"word": "hello", "start": 0.1, "end": 0.4},
              {"word": "world", "start": 0.5, "end": 0.9}],
}


def _transcribe(monkeypatch, tmp_path, payload):
    import openai
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")

    class FakeClient:
        def __init__(self, **kw):
            self.audio = types.SimpleNamespace(transcriptions=self)

        def create(self, file, **kw):
            return types.SimpleNamespace(model_dump=lambda: copy.deepcopy(payload))
    monkeypatch.setattr(openai, "OpenAI", FakeClient)
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF")
    return whisper_groq._transcribe_single(str(audio), None, None)


def _debug_lines(capsys):
    return [ln for ln in capsys.readouterr().out.splitlines()
            if ln.startswith("[groq] debug")]


@pytest.mark.parametrize("flag", ["", "0"])
def test_off_by_default(monkeypatch, tmp_path, capsys, flag):
    monkeypatch.setenv("CLEO_GROQ_DEBUG", flag)
    out = _transcribe(monkeypatch, tmp_path, PAYLOAD)
    assert len(out["segments"][0]["words"]) == 2
    assert _debug_lines(capsys) == []


def test_logs_one_raw_word_without_its_text(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("CLEO_GROQ_DEBUG", "1")
    out = _transcribe(monkeypatch, tmp_path, PAYLOAD)
    assert out["segments"][0]["words"][0]["probability"] == 1.0  # defaulted
    [line] = _debug_lines(capsys)
    assert '{"word": "<5 chars>", "start": 0.1, "end": 0.4}' in line
    assert "hello" not in line and "world" not in line
    assert "per-word probability: NO" in line
    assert "'avg_logprob'" in line                     # segment keys


def test_reports_probability_when_groq_sends_it(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("CLEO_GROQ_DEBUG", "1")
    payload = copy.deepcopy(PAYLOAD)
    for w in payload["words"]:
        w["probability"] = 0.87
    out = _transcribe(monkeypatch, tmp_path, payload)
    assert out["segments"][0]["words"][0]["probability"] == 0.87
    [line] = _debug_lines(capsys)
    assert '"probability": 0.87' in line and "per-word probability: yes" in line
