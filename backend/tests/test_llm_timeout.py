"""UX3 (T18): every Claude call gives up after 30 s and one retry (the
SDK default was 10 min × 3 attempts inside an analysis / render slot),
and the post caption is written while the video renders, not after it."""
from __future__ import annotations

import socket
import threading
import time
from types import SimpleNamespace

import pytest

import backend.main as M
from backend import costs, llm
from backend.jobs import store


def test_client_has_a_timeout_and_one_retry(monkeypatch):
    pytest.importorskip("anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")
    client = llm._client()
    assert client is not None
    assert client.timeout == 30.0
    assert client.max_retries == 1


def test_no_key_no_client(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert llm._client() is None


@pytest.fixture
def silent_api(monkeypatch):
    """An "API" that accepts connections and never answers; counts the
    connection attempts."""
    pytest.importorskip("anthropic")
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(8)
    state = {"accepts": 0, "conns": []}

    def serve():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            state["accepts"] += 1
            state["conns"].append(conn)   # held open, never answered
    threading.Thread(target=serve, daemon=True).start()
    port = server.getsockname()[1]
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{port}")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    yield state
    server.close()
    for conn in state["conns"]:
        conn.close()


def test_a_hanging_api_is_given_up_after_one_retry(silent_api, monkeypatch):
    """Soft step: the caption comes back empty — after the per-attempt
    timeout and exactly one retry, never the SDK's 10-minute default."""
    monkeypatch.setattr(llm, "_TIMEOUT_S", 0.3)
    t0 = time.monotonic()
    out = llm.generate_social_caption("Three mistakes that kill your reach.")
    took = time.monotonic() - t0
    assert out == {"caption": "", "hashtags": []}
    assert silent_api["accepts"] == 2          # 1 attempt + 1 retry
    assert took < 10


# ── post caption next to the render ─────────────────────────────────


def _review_job():
    job = store.create(None, {})
    store.update(job.id, status="processing", render_gen=1,
                 segments=[(0.0, 4.0)], mezz_key=f"jobs/{job.id}/mezz.mp4")
    return store.get(job.id)


def _ok(kw) -> dict:
    return {"outputs": {"primary": {"key": kw["out_prefix"] + "p.mp4",
                                    "size": 1}},
            "thumb": None, "hooks": []}


def test_caption_is_written_while_the_video_renders(monkeypatch):
    job = _review_job()
    caption_started = threading.Event()

    def caption(text, language=None):
        caption_started.set()
        assert text == "hello world"
        costs.record_claude("claude-haiku-4-5", SimpleNamespace(
            input_tokens=1000, output_tokens=100))
        return {"caption": "cap", "hashtags": ["x"]}
    monkeypatch.setattr(llm, "generate_social_caption", caption)

    def render(**kw):
        # The caption call has started while the render still runs (it
        # used to start only after the render returned).
        assert caption_started.wait(5)
        return _ok(kw)
    monkeypatch.setattr(M.pipeline, "render_to_keys", render)
    with costs.tracking(job.id, "render"):
        M._run_render_inner(job.id, [{"text": "hello"}, {"text": " world "}])
    got = store.get(job.id)
    assert (got.status, got.social_caption, got.social_hashtags) == (
        "done", "cap", ["x"])
    # The caption's Claude usage is booked on the render like before.
    assert got.costs["claude_tokens_in"] == 1000
    assert got.costs["claude_tokens_out"] == 100


def test_a_slow_caption_does_not_hold_the_render(monkeypatch):
    job = _review_job()
    release = threading.Event()

    def caption(text, language=None):
        release.wait(10)
        return {"caption": "late", "hashtags": []}
    monkeypatch.setattr(llm, "generate_social_caption", caption)
    monkeypatch.setattr(M.pipeline, "render_to_keys", lambda **kw: _ok(kw))
    monkeypatch.setattr(M, "_SOCIAL_WAIT_S", 0.2)
    t0 = time.monotonic()
    try:
        M._run_render_inner(job.id, [{"text": "hi"}])
    finally:
        release.set()
    assert time.monotonic() - t0 < 3
    got = store.get(job.id)
    assert (got.status, got.social_caption) == ("done", "")


def test_caption_failure_is_soft(monkeypatch):
    job = _review_job()

    def caption(text, language=None):
        raise RuntimeError("anthropic down")
    monkeypatch.setattr(llm, "generate_social_caption", caption)
    monkeypatch.setattr(M.pipeline, "render_to_keys", lambda **kw: _ok(kw))
    M._run_render_inner(job.id, [{"text": "hi"}])
    got = store.get(job.id)
    assert (got.status, got.social_caption, got.social_hashtags) == (
        "done", "", [])
