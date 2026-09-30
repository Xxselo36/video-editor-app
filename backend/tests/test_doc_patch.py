"""GET / PATCH /jobs/{id}/doc and PATCH /jobs/{id} {caption_style} (UT3):
revisions (409 stale_rev), state guards (409 doc_not_ready /
doc_read_only, 404 no_doc), validation (words, presets, overrides incl.
per-caption position and size), the 64 KB cap."""
from __future__ import annotations

import json

import pytest

from backend import doc as D
from backend.jobs import store

WORDS = [{"text": t, "start": i * 0.5, "end": i * 0.5 + 0.4}
         for i, t in enumerate(["we", "are", "gonna", "win", "this"])]


def _review_job(**fields):
    job = store.create(None, {})
    doc = D.build_doc(D.words_from_transcript(WORDS), "en", {})
    base = dict(status="awaiting_review", segments=[(0.0, 3.0)], duration=3.0, doc=doc)
    base.update(fields)
    store.update(job.id, **base)
    return store.get(job.id)


def _patch(client, job_id, body):
    return client.patch(f"/jobs/{job_id}/doc", content=json.dumps(body),
                        headers={"content-type": "application/json"})


def test_get_doc(client):
    job = _review_job()
    r = client.get(f"/jobs/{job.id}/doc")
    assert r.status_code == 200
    body = r.json()
    assert body["rev"] == 0 and body["read_only"] is False
    assert body["doc"]["words"][0] == {"id": "w0001", "text": "we", "start": 0.0, "end": 0.4}


def test_get_doc_states(client):
    old = store.create(None, {})
    store.update(old.id, status="awaiting_review")
    r = client.get(f"/jobs/{old.id}/doc")
    assert (r.status_code, r.json()["detail"]) == (404, "no_doc")     # a pre-UT3 job
    busy = store.create(None, {})
    store.update(busy.id, status="processing")
    assert client.get(f"/jobs/{busy.id}/doc").json()["detail"] == "doc_not_ready"
    done = _review_job(status="done")
    r = client.get(f"/jobs/{done.id}/doc")
    assert r.status_code == 200 and r.json()["read_only"] is True
    assert client.get("/jobs/000000000000/doc").status_code == 404


def test_patch_style_format_words(client):
    job = _review_job()
    r = _patch(client, job.id, {
        "base_rev": 0, "rev": 1727700000001,
        "style": {"presetId": "power", "overrides": {
            "y": 0.7, "sizeScale": 1.2, "wordsPerPage": "auto", "case": "upper",
            "textColor": "#fff", "highlightColor": "#39FF14", "animation": "pop",
            "offsetMs": -120, "captions": {"w0003": {"y": 0.3}, "w0004": {"sizeScale": 0.8}}}},
        "format": {"aspect": "16:9"},
        "words": {"upsert": [{"id": "w0003", "text": "going", "start": 1.0, "end": 1.2},
                             {"id": "w0003.1", "text": "to", "start": 1.2, "end": 1.4},
                             {"id": "w0005", "text": "this", "start": 2.0, "end": 2.4,
                              "hidden": True, "breakBefore": True}],
                  "delete": ["w0002", "nope"]}})
    assert r.status_code == 200, r.text
    assert r.json() == {"rev": 1727700000001}
    got = store.get(job.id)
    assert got.doc_rev == 1727700000001 and got.doc["rev"] == 1727700000001
    assert [w["id"] for w in got.doc["words"]] == ["w0001", "w0003", "w0003.1", "w0004", "w0005"]
    assert got.doc["words"][-1]["hidden"] is True
    assert got.doc["format"] == {"aspect": "16:9"}
    assert got.doc["style"]["overrides"]["captions"] == {"w0003": {"y": 0.3},
                                                         "w0004": {"sizeScale": 0.8}}


def test_v1_alias_is_migrated(client, monkeypatch):
    job = _review_job()
    r = _patch(client, job.id, {"base_rev": 0, "rev": 1,
                                "style": {"presetId": "classic", "overrides": {"y": 0.5}}})
    assert r.status_code == 200
    assert store.get(job.id).doc["style"] == {
        "presetId": "power", "overrides": {"highlightColor": "#FFFFFF", "y": 0.5}}


def test_stale_rev(client):
    job = _review_job()
    assert _patch(client, job.id, {"base_rev": 0, "rev": 5, "format": {"aspect": "9:16"}}).status_code == 200
    # another tab still on rev 0
    r = _patch(client, job.id, {"base_rev": 0, "rev": 6, "format": {"aspect": "16:9"}})
    assert r.status_code == 409 and r.json() == {"detail": "stale_rev", "rev": 5}
    # not newer than the stored rev
    r = _patch(client, job.id, {"base_rev": 5, "rev": 5, "format": {"aspect": "16:9"}})
    assert r.status_code == 409
    assert store.get(job.id).doc["format"] == {"aspect": "9:16"}


def test_state_guards(client):
    for status, code in (("done", "doc_read_only"), ("processing", "doc_read_only")):
        job = _review_job(status=status)
        r = _patch(client, job.id, {"base_rev": 0, "rev": 1, "format": {"aspect": "9:16"}})
        assert (r.status_code, r.json()["detail"]) == (409, code)
    busy = store.create(None, {})
    store.update(busy.id, status="processing")
    r = _patch(client, busy.id, {"base_rev": 0, "rev": 1})
    assert (r.status_code, r.json()["detail"]) == (409, "doc_not_ready")


@pytest.mark.parametrize("body,code", [
    ({"rev": 1}, "bad_rev"),
    ({"base_rev": 0, "rev": 1, "clips": []}, "clips_not_supported"),
    ({"base_rev": 0, "rev": 1, "color": 1}, "unknown_field"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "bogus"}}, "unknown_preset"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "neon"}}, "preset_not_live"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "power", "overrides": {"sizeScale": 2}}}, "bad_style"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "power", "overrides": {"offsetMs": 400}}}, "bad_style"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "power", "overrides": {"font": "x"}}}, "bad_style"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "power", "overrides": {"textColor": "red"}}}, "bad_style"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "power",
                                         "overrides": {"captions": {"w1": {"y": 2}}}}}, "bad_style"),
    ({"base_rev": 0, "rev": 1, "style": {"presetId": "power",
                                         "overrides": {"captions": {"w1": {"x": 0.2}}}}}, "bad_style"),
    ({"base_rev": 0, "rev": 1, "format": {"aspect": "1:1"}}, "bad_format"),
    ({"base_rev": 0, "rev": 1, "words": {"upsert": [{"id": "w0001", "text": "", "start": 0,
                                                     "end": 1}]}}, "bad_word"),
    ({"base_rev": 0, "rev": 1, "words": {"upsert": [{"id": "w 1", "text": "a", "start": 0,
                                                     "end": 1}]}}, "bad_word"),
    ({"base_rev": 0, "rev": 1, "words": {"upsert": [{"id": "w0001", "text": "a", "start": 1,
                                                     "end": 0.5}]}}, "bad_word"),
    ({"base_rev": 0, "rev": 1, "words": {"upsert": [{"id": "w0001", "text": "a", "start": 0,
                                                     "end": 0.2, "emoji": "x"}]}}, "bad_word"),
    # moved past its neighbours: the list must stay in start order
    ({"base_rev": 0, "rev": 1, "words": {"upsert": [{"id": "w0002", "text": "are", "start": 1.9,
                                                     "end": 2.0}]}}, "words_not_monotonic"),
    ({"base_rev": 0, "rev": 1, "words": {"upsert": [{"id": "w0009", "text": "late", "start": 9,
                                                     "end": 9.5}]}}, "word_out_of_range"),
    ({"base_rev": 0, "rev": 1, "words": {"add": []}}, "bad_words"),
])
def test_validation(client, body, code):
    job = _review_job()
    r = _patch(client, job.id, body)
    assert r.status_code == 400 and r.json()["detail"] == code, r.text
    assert store.get(job.id).doc_rev == 0


def test_word_limit(monkeypatch):
    monkeypatch.setattr(D, "MAX_WORDS", 6)
    doc = D.build_doc(D.words_from_transcript(WORDS), "en", {})
    new = [{"id": f"x{i}", "text": "x", "start": 2.5, "end": 2.6} for i in range(2)]
    with pytest.raises(D.DocError) as e:
        D.apply_patch(doc, 0, {"base_rev": 0, "rev": 1, "words": {"upsert": new}})
    assert e.value.code == "too_many_words"


def test_payload_cap(client):
    job = _review_job()
    filler = [{"id": f"n{i}", "text": "word" * 10, "start": 2.5, "end": 2.6} for i in range(1200)]
    body = {"base_rev": 0, "rev": 1, "words": {"upsert": filler}}
    assert len(json.dumps(body)) > 64 * 1024
    r = _patch(client, job.id, body)
    assert (r.status_code, r.json()["detail"]) == (413, "doc_patch_too_large")
    r = client.patch(f"/jobs/{job.id}/doc", content=b"{nope",
                     headers={"content-type": "application/json"})
    assert r.status_code == 400


def test_patch_job_caption_style(client, monkeypatch):
    busy = store.create(None, {"caption_preset": "clipper"})
    store.update(busy.id, status="processing")
    r = client.patch(f"/jobs/{busy.id}", json={"caption_style": "clipper"})
    assert r.status_code == 200 and r.json()["id"] == busy.id
    assert store.get(busy.id).settings == {"caption_preset": "clipper",
                                           "caption_style": {"presetId": "clipper", "overrides": {}}}
    assert client.patch(f"/jobs/{busy.id}", json={"caption_style": "neon"}).json()["detail"] \
        == "preset_not_live"
    assert client.patch(f"/jobs/{busy.id}", json={"title": "x"}).json()["detail"] == "unknown_field"
    # in review, a doc no editor saved yet takes the style too
    job = _review_job()
    assert client.patch(f"/jobs/{job.id}", json={"caption_style": "clipper"}).status_code == 200
    assert store.get(job.id).doc["style"]["presetId"] == "clipper"
    # ...but never over the editor's own saves
    _patch(client, job.id, {"base_rev": 0, "rev": 3, "style": {"presetId": "power"}})
    client.patch(f"/jobs/{job.id}", json={"caption_style": "clipper"})
    assert store.get(job.id).doc["style"]["presetId"] == "power"
    done = _review_job(status="done")
    r = client.patch(f"/jobs/{done.id}", json={"caption_style": "power"})
    assert (r.status_code, r.json()["detail"]) == (409, "not_editable")


def test_upload_settings_keep_hint_and_aspect():
    import backend.main as M
    out = M._clean_settings({"caption_style_hint": "clipper", "target_aspect": "16:9",
                             "caption_style": "neon"}, None)
    assert out == {"caption_style_hint": "clipper", "target_aspect": "16:9"}
    assert "target_aspect" not in M._clean_settings({"target_aspect": "4:3"}, None)


def test_font_refresh(client):
    pytest.importorskip("fontTools")
    job = _review_job()
    doc = D.build_doc(D.words_from_transcript([{"text": "今日", "start": 0, "end": 0.5}]), "ja", {})
    store.update(job.id, doc=doc)
    r = client.post(f"/jobs/{job.id}/fonts/refresh")
    assert r.status_code == 200
    first = r.json()["font_subsets"]["noto-sans-jp-800"]
    # nothing new: the same subset
    assert client.post(f"/jobs/{job.id}/fonts/refresh").json()["font_subsets"][
        "noto-sans-jp-800"] == first
    # an edit adds characters: a new subset, the old files queued for deletion
    old_keys = dict(store.get(job.id).font_subsets["noto-sans-jp-800"])
    doc["words"].append({"id": "w0002", "text": "晴れ", "start": 0.6, "end": 0.9})
    store.update(job.id, doc=doc)
    second = client.post(f"/jobs/{job.id}/fonts/refresh").json()["font_subsets"]["noto-sans-jp-800"]
    assert second["rev"] != first["rev"]
    cur = store.get(job.id)
    assert "晴" in cur.font_subsets["noto-sans-jp-800"]["chars"]
    queued = {r["prefix"] for r in store.gc_all()}
    assert {old_keys["woff2"], old_keys["ttf"], old_keys["json"]} <= queued
    assert old_keys["woff2"] not in cur.media_bytes
    r = client.get(f"/jobs/{job.id}/fonts/{second['json']}", follow_redirects=False)
    assert r.status_code in (200, 307)
    # a non-CJK doc needs none
    en = _review_job()
    assert client.post(f"/jobs/{en.id}/fonts/refresh").json() == {"font_subsets": {}}
