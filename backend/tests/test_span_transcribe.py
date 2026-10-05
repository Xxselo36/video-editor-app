"""POST /jobs/{id}/transcribe-span (backlog #20).

Groq is faked (whisper_groq.transcribe_via_groq, as the whisper tests
do) and so is the ffmpeg cut, except in the one test that runs ffmpeg
on a real file. Covers: owner / state rules like the doc routes, the
span cap, the merge into the doc (ids, order, rev rule), idempotency
(called twice: no second Groq call, the same answer), the rate limit,
R2 sources (a presigned URL, never a download)."""
from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from backend import doc as D
from backend import media, span_transcribe as S, whisper_groq
from backend.jobs import store

WORDS = [{"text": t, "start": s, "end": e} for t, s, e in [
    ("we", 0.0, 0.4), ("are", 0.5, 0.9),            # then 4 s without words
    ("back", 5.0, 5.4), ("again", 5.5, 5.9)]]


def _review_job(owner=None, **fields):
    job = store.create(None, {}, **({"owner_id": owner} if owner else {}))
    doc = D.build_doc(D.words_from_transcript(WORDS), "en", {})
    base = dict(status="awaiting_review", segments=[(0.0, 1.0), (5.0, 6.0)],
                duration=6.0, doc=doc, mezz_key=media.job_prefix(job.id) + "mezz.mp4")
    base.update(fields)
    store.update(job.id, **base)
    return store.get(job.id)


@pytest.fixture
def groq(monkeypatch):
    """Groq answers `state.words` (times within the cut audio); ffmpeg is
    faked (it records the source)."""
    class State:
        words = [{"word": " hello", "start": 0.7, "end": 1.0, "probability": 0.9},
                 {"word": " there", "start": 1.1, "end": 1.5, "probability": 0.8}]
        calls: list = []
        sources: list = []
        languages: list = []

    state = State()
    state.calls, state.sources, state.languages = [], [], []

    def fake_groq(path, initial_prompt=None, language=None):
        state.calls.append(path)
        state.languages.append(language)
        return {"language": language or "en",
                "segments": [{"words": list(state.words)}]}

    def fake_extract(source, start, duration, out):
        state.sources.append((source, start, duration))
        with open(out, "wb") as f:
            f.write(b"audio")

    monkeypatch.setattr(whisper_groq, "transcribe_via_groq", fake_groq)
    monkeypatch.setattr(S, "extract_audio", fake_extract)
    S_rate = __import__("backend.main", fromlist=["_SPAN_RATE"])._SPAN_RATE
    S_rate._events.clear()
    return state


def _span(client, job_id, start=1.2, end=4.6, base=0.0, rev=1727700000001, **kw):
    return client.post(f"/jobs/{job_id}/transcribe-span", headers=kw.get("headers"),
                       json={"start": start, "end": end,
                                           "base_rev": base, "rev": rev})


def test_transcribes_and_merges_into_the_doc(client, groq):
    job = _review_job()
    r = _span(client, job.id)
    assert r.status_code == 200, r.text
    body = r.json()
    # the audio from 0.6 s before the span: Groq's 0.7 → 1.3 s source
    assert groq.sources[0][1] == pytest.approx(0.6)
    assert [w["text"] for w in body["words"]] == ["hello", "there"]
    assert body["words"][0]["id"] == "t1300" and body["words"][0]["start"] == pytest.approx(1.3)
    assert body["rev"] == 1727700000001 and body["changed"] is True
    got = store.get(job.id)
    assert got.doc_rev == 1727700000001 and got.doc["rev"] == 1727700000001
    assert [w["text"] for w in got.doc["words"]] == ["we", "are", "hello", "there", "back", "again"]
    assert got.doc["spans"] == [[1.2, 4.6, 0.0, 1727700000001]]
    # the doc stays valid for the editor's next PATCH (its own rule)
    r = client.patch(f"/jobs/{job.id}/doc", content=json.dumps(
        {"base_rev": 1727700000001, "rev": 1727700000002,
         "words": {"upsert": [{**body["words"][0], "text": "Hello"}], "delete": []}}),
        headers={"content-type": "application/json"})
    assert r.status_code == 200, r.text
    # the analysis language goes along (one pass in it)
    assert groq.languages == ["en"]


def test_called_twice_is_idempotent(client, groq):
    job = _review_job()
    first = _span(client, job.id).json()
    # the same request again (its answer was lost): no second Groq call,
    # the same words, and it is still this client's change
    again = _span(client, job.id)
    assert again.status_code == 200
    assert again.json() == first
    assert len(groq.calls) == 1
    # another client on another rev: the words, but not its change
    other = _span(client, job.id, base=5.0, rev=1727700000009).json()
    assert other["changed"] is False and other["words"] == first["words"]
    assert len(groq.calls) == 1 and store.get(job.id).doc_rev == 1727700000001


def test_silence_is_remembered(client, groq):
    groq.words = []
    job = _review_job()
    r = _span(client, job.id)
    assert r.json() == {"words": [], "rev": 1727700000001, "changed": True}
    _span(client, job.id, start=1.5, end=4.0, base=1727700000001, rev=1727700000002)
    assert len(groq.calls) == 1     # inside a span Whisper found empty


def test_words_overlapping_the_doc_are_dropped_and_hallucinations_hidden(client, groq):
    job = _review_job()
    # "are" ends at 0.9: a word in the context audio before the span is not taken
    groq.words = [{"word": "are", "start": 0.0, "end": 0.3},
                  {"word": "Thanks", "start": 1.0, "end": 1.3},
                  {"word": "for", "start": 1.3, "end": 1.5},
                  {"word": "watching", "start": 1.5, "end": 2.0}]
    body = _span(client, job.id).json()
    assert [w["text"] for w in body["words"]] == ["Thanks", "for", "watching"]
    assert all(w["hidden"] and w["nospeech"] for w in body["words"])


def test_span_with_words_is_not_transcribed(client, groq):
    job = _review_job()
    r = _span(client, job.id, start=4.8, end=6.0)
    assert r.json()["changed"] is False
    assert [w["text"] for w in r.json()["words"]] == ["back", "again"]
    assert groq.calls == []


@pytest.mark.parametrize("body,status", [
    ({"start": 1.0, "end": 62.0, "base_rev": 0, "rev": 1}, 400),     # > 60 s
    ({"start": 2.0, "end": 2.1, "base_rev": 0, "rev": 1}, 400),      # too short
    ({"start": 3.0, "end": 2.0, "base_rev": 0, "rev": 1}, 400),
    ({"start": 1.0, "end": 2.0}, 400),                               # no revs
    ({"start": 1.0, "end": 2.0, "base_rev": 0, "rev": 1, "x": 1}, 400),
    ([1, 2], 400),
])
def test_refuses_bad_spans(client, groq, body, status):
    job = _review_job(duration=120.0)
    r = client.post(f"/jobs/{job.id}/transcribe-span", json=body)
    assert r.status_code == status
    assert groq.calls == []


def test_the_cap_is_sixty_seconds(client, groq):
    job = _review_job(duration=120.0)
    r = _span(client, job.id, start=6.0, end=66.0)
    assert r.status_code == 200, r.text
    r = _span(client, job.id, start=66.0, end=126.5, base=1727700000001, rev=1727700000002)
    assert r.status_code == 400 and r.json()["detail"] == "invalid_payload"


def test_stale_rev_and_states(client, groq):
    job = _review_job(doc_rev=5.0)
    r = _span(client, job.id, base=4.0, rev=6.0)
    assert (r.status_code, r.json()["detail"]) == (409, "stale_rev")
    assert store.get(job.id).doc_rev == 5.0 and "spans" not in store.get(job.id).doc
    done = _review_job(status="done")
    assert _span(client, done.id).json()["detail"] == "doc_read_only"
    old = store.create(None, {})
    store.update(old.id, status="awaiting_review")
    assert _span(client, old.id).json()["detail"] == "no_doc"
    assert _span(client, "000000000000").status_code == 404
    gone = _review_job(mezz_key=None)
    assert _span(client, gone.id).status_code == 409


def test_owner_only(client, groq, auth_on, bearer):
    job = _review_job(owner="user_a")
    assert _span(client, job.id, headers=bearer("user_b")).status_code == 404
    assert _span(client, job.id).status_code in (401, 404)
    assert groq.calls == []
    r = _span(client, job.id, headers=bearer("user_a"))
    assert r.status_code == 200, r.text


def test_rate_limited(client, groq, monkeypatch):
    from backend import main as M
    monkeypatch.setattr(M._SPAN_RATE, "limit", 2)
    job = _review_job()
    assert _span(client, job.id).status_code == 200
    assert _span(client, job.id).status_code == 200
    r = _span(client, job.id)
    assert (r.status_code, r.json()["detail"]) == (429, "too_many_requests")


def test_groq_off_and_failing(client, monkeypatch, groq):
    job = _review_job()
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq", lambda *a, **k: None)
    r = _span(client, job.id)
    assert (r.status_code, r.json()["detail"]) == (503, "transcription_unavailable")

    def boom(*a, **k):
        raise whisper_groq.GroqTranscriptionError("down")
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq", boom)
    assert _span(client, job.id).status_code == 502
    assert "spans" not in store.get(job.id).doc       # nothing recorded


def test_a_hidden_hallucination_does_not_block_real_words(client, groq):
    # the only word in the gap is a hidden "Thank you." over the pause:
    # a real word there replaces nothing, but it is not dropped either
    job = _review_job()
    doc = dict(store.get(job.id).doc)
    ghost = {"id": "w9000", "text": "Thanks.", "start": 1.9, "end": 2.6,
             "hidden": True, "nospeech": True}
    doc["words"] = sorted(doc["words"] + [ghost], key=lambda w: w["start"])
    store.update(job.id, doc=doc)
    groq.words = [{"word": " right", "start": 1.4, "end": 2.0, "probability": 0.9}]
    body = _span(client, job.id).json()
    assert [w["text"] for w in body["words"] if not w.get("hidden")] == ["right"]
    assert body["changed"] is True


def test_busy_job_is_refused_at_once(client, groq):
    from backend import main as M
    job = _review_job()
    lock = M._span_lock(job.id)
    assert lock.acquire(blocking=False)
    try:
        r = _span(client, job.id)
    finally:
        lock.release()
    assert (r.status_code, r.json()["detail"]) == (409, "busy")
    assert r.headers.get("retry-after") == "5"
    assert groq.calls == []
    assert _span(client, job.id).status_code == 200      # free again


def test_groq_gets_one_short_attempt(client, groq, monkeypatch):
    seen = []
    groq_fake = whisper_groq.transcribe_via_groq

    def spy(*a, **k):
        seen.append(whisper_groq._REQUEST_POLICY.get())
        return groq_fake(*a, **k)
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq", spy)
    assert _span(client, _review_job().id).status_code == 200
    assert seen == [(1, S.GROQ_TIMEOUT_S)]
    assert whisper_groq._REQUEST_POLICY.get() is None


SIGNED = "https://r2.example/jobs/abc/mezz.mp4?X-Amz-Signature=deadbeef&X-Amz-Credential=key"


def test_redact():
    assert S.redact(f"Opening '{SIGNED}' failed: 403") == "Opening '<url> failed: 403"
    assert S.redact("no url here") == "no url here"


@pytest.mark.parametrize("how", ["stderr", "timeout"])
def test_presigned_url_never_logged(monkeypatch, capsys, how):
    def fake_run(cmd, **kw):
        assert kw["timeout"] == S.FFMPEG_TIMEOUT_S == 45
        # over a URL a stalled read fails after RW_TIMEOUT_S, before the -i
        i = cmd.index("-rw_timeout")
        assert cmd[i + 1] == "15000000" and i < cmd.index("-i")
        if how == "timeout":
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])
        return subprocess.CompletedProcess(cmd, 1, "", f"{SIGNED}: Server returned 403 Forbidden")
    monkeypatch.setattr(S.subprocess, "run", fake_run)
    with pytest.raises(S.SpanError) as ei:
        S.transcribe(SIGNED, {"start": 1.0, "end": 2.0}, "en", 10.0)
    assert ei.value.status == 502
    out = capsys.readouterr()
    logged = out.out + out.err
    assert "[span]" in logged
    assert "X-Amz-Signature" not in logged and "r2.example" not in logged


def test_local_source_has_no_rw_timeout(monkeypatch, tmp_path):
    cmds = []

    def fake_run(cmd, **kw):
        cmds.append(cmd)
        with open(cmd[-1], "wb") as f:
            f.write(b"audio")
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(S.subprocess, "run", fake_run)
    S.extract_audio(str(tmp_path / "mezz.mp4"), 1.0, 2.0, str(tmp_path / "o.m4a"))
    assert "-rw_timeout" not in cmds[0]


def test_r2_reads_a_presigned_url(client, groq, monkeypatch):
    job = _review_job(proxy_key=None)
    monkeypatch.setattr(media, "store_of", lambda j: "r2")
    from backend import storage
    monkeypatch.setattr(storage, "r2_available", lambda: True)
    monkeypatch.setattr(media, "presign_get", lambda key, **k: f"https://r2.example/{key}?sig=1")
    got = []
    monkeypatch.setattr(media, "get_file", lambda *a, **k: got.append(a))
    assert _span(client, job.id).status_code == 200
    assert groq.sources[0][0].startswith("https://r2.example/jobs/")
    assert got == []                                   # never downloaded whole


@pytest.mark.local_media_only
def test_real_ffmpeg_cut(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("no ffmpeg")
    src = tmp_path / "tone.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=6", "-c:a", "aac", str(src)], check=True)
    out = tmp_path / "span.m4a"
    S.extract_audio(str(src), 1.0, 2.0, str(out))
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", str(out)], capture_output=True,
                               text=True).stdout)
    assert dur == pytest.approx(2.0, abs=0.1)

