"""The LLM caption cleanup on a long transcript (save-9): one call with
every unit of a 10-minute video (~500 units, ~6k output tokens) never fit
max_tokens nor the 30 s timeout, so the owner's job came back
'llm_skipped:cleanup' and his captions kept every mishearing. It now
goes out in chunks (in parallel, each its own call) and the model
answers only what it changed."""
from __future__ import annotations

import json
import threading
import types

import pytest

from backend import costs, llm


class _Resp:
    def __init__(self, text, stop_reason="end_turn"):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.usage = types.SimpleNamespace(input_tokens=100, output_tokens=10)
        self.stop_reason = stop_reason


class APITimeoutError(Exception):
    pass


def _client(answer):
    calls: list[list[dict]] = []
    lock = threading.Lock()

    class Messages:
        def create(self, **kw):
            phrases = json.loads(kw["messages"][0]["content"])["phrases"]
            with lock:
                calls.append(phrases)
            return answer(phrases)
    return types.SimpleNamespace(messages=Messages()), calls


def _phrases(n):
    return [{"id": i, "text": f"satz {i} mit klio"} for i in range(n)]


def test_a_long_transcript_goes_out_in_chunks(monkeypatch):
    def answer(phrases):
        # every third phrase needs a fix; one stray id from another chunk
        fixed = [{"id": p["id"], "cleaned": f"Satz {p['id']} mit Cleo."}
                 for p in phrases if p["id"] % 3 == 0]
        return _Resp(json.dumps({"phrases": fixed + [{"id": 10_000, "cleaned": "x"}]}))
    client, calls = _client(answer)
    monkeypatch.setattr(llm, "_client", lambda: client)
    out = llm.cleanup_transcript(_phrases(494), language="de")
    assert sorted(len(c) for c in calls) == [94, 100, 100, 100, 100]
    assert out == {i: f"Satz {i} mit Cleo." for i in range(0, 494, 3)}


def test_a_failed_chunk_keeps_the_others_and_is_reported(monkeypatch):
    def answer(phrases):
        if phrases[0]["id"] == 100:
            raise APITimeoutError("timed out")
        return _Resp(json.dumps({"phrases": [
            {"id": phrases[0]["id"], "cleaned": "Fixed."}]}))
    client, _calls = _client(answer)
    monkeypatch.setattr(llm, "_client", lambda: client)
    bucket: dict[str, float] = {}
    with llm.observing(llm.Observer()) as obs, costs.collecting(bucket):
        out = llm.cleanup_transcript(_phrases(250))
    assert out == {0: "Fixed.", 200: "Fixed."}
    # the chunk's timeout reaches the caller's observer (worker threads)
    assert obs.warnings() == ["llm_skipped:cleanup"]
    # and the chunks' usage the caller's cost bucket
    assert bucket["claude_tokens_in"] == 200 and bucket["claude_tokens_out"] == 20


def test_an_answer_cut_at_max_tokens_is_counted(monkeypatch):
    def answer(phrases):
        return _Resp('{"phrases": [{"id": 0, "cleaned": "Fix', stop_reason="max_tokens")
    client, _calls = _client(answer)
    monkeypatch.setattr(llm, "_client", lambda: client)
    bucket: dict[str, float] = {}
    with costs.collecting(bucket):
        assert llm.cleanup_transcript(_phrases(3)) == {}
    assert bucket["llm_truncated:cleanup"] == 1


def test_the_prompt_asks_only_for_changes(monkeypatch):
    seen = {}

    class Messages:
        def create(self, **kw):
            seen.update(kw)
            return _Resp('{"phrases": []}')
    monkeypatch.setattr(llm, "_client", lambda: types.SimpleNamespace(messages=Messages()))
    assert llm.cleanup_transcript(_phrases(2)) == {}
    assert "ONLY the" in seen["system"] and "phrases you changed" in seen["system"]
    assert seen["max_tokens"] == llm._MAX_TOKENS_CLEANUP


@pytest.mark.parametrize("n", [1, 100, 101])
def test_chunk_sizes(monkeypatch, n):
    client, calls = _client(lambda phrases: _Resp('{"phrases": []}'))
    monkeypatch.setattr(llm, "_client", lambda: client)
    llm.cleanup_transcript(_phrases(n))
    assert sorted(len(c) for c in calls) == sorted(
        [100] * (n // 100) + ([n % 100] if n % 100 else []))
