"""The Vorschau (PR2): "Fertigstellen" exports a project without the
editor open, and the job tells which analysis steps it skips.

  - POST /jobs/{id}/render {"client": "v2", "source": "stored"} without
    subtitles renders the captions the v2 editor would send for the job
    as stored (exports.stored_units): the edit doc's words that play,
    without a doc the analysis' units. Everything around it is the
    export as before: the instant export of a finished speculative
    render, the opt-in to the v2 captions, a v1 export's own payload.
  - GET /jobs/{id} no_cuts ("Nur Untertitel") and captions_off ("Ohne
    Untertitel"): the steps the processing list leaves out.

Renders are faked at pipeline.render_to_keys (test_ux11_exports'
FakeRender) around the real render paths."""
from __future__ import annotations

import pytest

import backend.main as M
from backend import captions_v2, exports
from backend.jobs import store
from test_ux11_exports import (  # noqa: F401  (fixtures)
    UNITS, _env, _review_job, _settled, _spec_done, render, spec_on)

STORED = {"client": "v2", "source": "stored", "disabled_cuts": []}

# The edit doc of _review_job's timeline, which keeps 0–4 s and 5–10 s:
# a hidden filler, then a word in the cut between two that play.
WORDS = [
    {"id": "w1", "text": "Hello", "start": 0.2, "end": 0.6},
    {"id": "w2", "text": "um", "start": 0.6, "end": 0.8, "filler": True,
     "hidden": True},
    {"id": "w3", "text": "world.", "start": 0.8, "end": 1.0},
    {"id": "w4", "text": "So", "start": 3.5, "end": 3.7},
    {"id": "w5", "text": "uh", "start": 4.3, "end": 4.6},
    {"id": "w6", "text": "great", "start": 5.2, "end": 5.6},
]


def _doc(preset="power"):
    return {"v": 2, "language": "en", "words": [dict(w) for w in WORDS],
            "clips": None, "style": {"presetId": preset, "overrides": {}},
            "format": {"aspect": "9:16"}, "rev": 0}


def _finish(client, job_id, **extra):
    """Fertigstellen as the Vorschau sends it."""
    r = client.post(f"/jobs/{job_id}/render", json={**STORED, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def _texts(units):
    return [u["text"] for u in units]


# ── the stored source ───────────────────────────────────────────────


def test_stored_source_renders_the_words_that_play(client, render):
    job = _review_job(doc=_doc())
    out = _finish(client, job.id)
    assert out["instant"] is False and out["gen"] == 1
    assert _settled(job.id, "done")
    [call] = render.calls
    # The editor's export source: no hidden filler, no word of the cut,
    # no unit across it ("So uh" would be one without the cut).
    assert _texts(call["subtitles"]) == ["Hello", "world.", "So", "great"]
    assert call["subtitles"] == exports.doc_units(WORDS, [(4.0, 5.0)])
    assert call["subtitles"] == exports.stored_units(store.get(job.id))
    assert store.get(job.id).export_client == "v2"


def test_stored_source_without_a_doc_renders_the_analysis_units(client, render):
    job = _review_job()                  # analysed before the edit doc (UT3)
    _finish(client, job.id)
    assert _settled(job.id, "done")
    [call] = render.calls
    assert _texts(call["subtitles"]) == _texts(UNITS)
    assert call["subtitles"] == exports.analysis_units(store.get(job.id))


def test_stored_source_follows_the_last_saves(client, render):
    """A text edit (the doc) and a moved cut (the timeline), as the
    editor saved them."""
    job = _review_job(doc=_doc())
    words = [dict(w) for w in WORDS]
    words[5]["text"] = "brilliant"
    store.update(job.id, doc={**job.doc, "words": words}, doc_rev=5,
                 segments=[(0.0, 1.2), (5.0, 10.0)])
    _finish(client, job.id)
    assert _settled(job.id, "done")
    assert _texts(render.calls[0]["subtitles"]) == ["Hello", "world.", "brilliant"]


def test_subtitles_in_the_payload_win(client, render):
    job = _review_job(doc=_doc())
    _finish(client, job.id, subtitles=UNITS)
    assert _settled(job.id, "done")
    assert render.calls[0]["subtitles"] == UNITS


@pytest.mark.parametrize("body", [
    {"client": "v2"},                                  # no captions at all
    {"client": "v2", "source": "editor"},              # no such source
    {"client": "v2", "source": "stored", "subtitles": "all"},  # not a list
    {"source": "stored"},                              # a v1 export
    {"client": "v1", "source": "stored"},
])
def test_without_subtitles_only_the_v2_stored_source_renders(client, render,
                                                             body):
    """A v1 export sends its own captions, as before."""
    job = _review_job(doc=_doc())
    r = client.post(f"/jobs/{job.id}/render", json=body)
    assert r.status_code == 400
    assert r.json()["detail"] == "payload.subtitles must be a list"
    cur = store.get(job.id)
    assert (cur.status, cur.render_gen, render.calls) == ("awaiting_review", 0, [])


def test_the_stored_source_needs_the_review_state(client, render):
    job = _review_job(doc=_doc(), status="processing")
    r = client.post(f"/jobs/{job.id}/render", json=STORED)
    assert r.status_code == 409 and render.calls == []


# ── what stays as it was around it ──────────────────────────────────


def test_an_untouched_job_comes_back_instant(client, render, spec_on):
    """The finished speculative render of the job as analysed is taken:
    the stored units are among the captions it accepts."""
    job = _review_job(doc=_doc())
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    assert client.get(f"/jobs/{job.id}").json()["spec_ready"] is True
    out = _finish(client, job.id)
    assert out["instant"] is True and out["status"] == "done"
    assert out["cost_seconds"] == 0
    cur = store.get(job.id)
    assert cur.spec["status"] == "promoted" and cur.renders_ok == 0
    assert cur.output_keys["primary"] == f"jobs/{job.id}/r1/primary.mp4"
    assert len(render.calls) == 1                    # the speculative one


def test_an_edit_after_the_speculative_render_is_rendered(client, render,
                                                          spec_on):
    job = _review_job(doc=_doc())
    assert M._maybe_speculate(job.id) and _spec_done(job.id)
    words = [dict(w) for w in WORDS]
    words[5]["text"] = "brilliant"
    store.update(job.id, doc={**job.doc, "words": words}, doc_rev=5)
    out = _finish(client, job.id)
    assert out["instant"] is False and out["gen"] == 2
    assert _settled(job.id, "done")
    assert _texts(render.calls[-1]["subtitles"]) == ["Hello", "world.", "So",
                                                     "brilliant"]
    assert store.get(job.id).spec["status"] == "stale"


@pytest.mark.parametrize("field, engine", [("v2", "v2"), (None, "v1")])
def test_the_opt_in_to_v2_captions_is_kept(client, render, monkeypatch,
                                            field, engine):
    """CLEO_CAPTION_ENGINE=optin: Fertigstellen in a browser opted in to
    the v2 captions asks for them as the editor's export does."""
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "optin")
    job = _review_job(doc=_doc())
    _finish(client, job.id, **({"caption_engine": field} if field else {}))
    assert _settled(job.id, "done")
    cur = store.get(job.id)
    assert cur.caption_engine == engine
    assert (cur.settings.get(captions_v2.OPTIN_KEY) == "v2") is (field == "v2")
    [call] = render.calls
    assert ("captions" in call) is (engine == "v2")
    if engine == "v2":
        # the stored units on the doc's words
        assert _texts(call["captions"]["words"]) == ["Hello", "world.", "So",
                                                     "great"]


# ── the steps a job skips ───────────────────────────────────────────

POWER = {"presetId": "power", "overrides": {}}
NONE = {"presetId": "none", "overrides": {}}


@pytest.mark.parametrize("settings, no_cuts, captions_off", [
    ({}, False, False),
    # the start screen: the pace (read as the pipeline reads it) and the
    # picked style with its preset as the hint
    ({"style": "tight", "caption_style": POWER, "caption_style_hint": "power"},
     False, False),
    ({"style": " None ", "caption_style": POWER}, True, False),
    ({"style": "bogus", "caption_style": NONE, "caption_style_hint": "none"},
     False, True),
    ({"style": "none", "caption_style": NONE}, True, True),
    # older clients: the hint alone, a v1 caption preset (before the hint)
    ({"caption_style_hint": "none"}, False, True),
    ({"style": "smooth", "caption_preset": "none"}, False, True),
    ({"caption_preset": "clean", "caption_style_hint": "none"}, False, False),
])
def test_flags_of_the_upload(client, settings, no_cuts, captions_off):
    """While the analysis runs (no doc yet): what the upload asked for."""
    job = store.create(None, settings, filename="clip.mp4")
    store.update(job.id, status="processing", progress=40.0)
    body = client.get(f"/jobs/{job.id}").json()
    assert (body["no_cuts"], body["captions_off"]) == (no_cuts, captions_off)


def test_captions_off_follows_the_style_once_analysed():
    """With the edit doc: the style the export draws (captions_v2.style_for)."""
    job = _review_job(settings={"caption_style": NONE}, doc=_doc(preset="none"))
    assert job.to_dict()["captions_off"] is True
    # the editor picked a style afterwards (a doc save)
    store.update(job.id, doc=_doc(preset="karaoke"), doc_rev=3)
    assert store.get(job.id).to_dict()["captions_off"] is False
    # the analysis found no captionable script for the pick: none
    other = _review_job(settings={"caption_style": POWER}, doc=_doc(preset="none"))
    assert other.to_dict()["captions_off"] is True
    # a v1 upload: its caption preset, whatever the doc started with
    v1 = _review_job(settings={"caption_preset": "none"}, doc=_doc())
    assert v1.to_dict()["captions_off"] is True
