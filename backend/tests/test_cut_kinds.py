"""UX10: every automatic cut carries its reason (backend/cut_kinds.py),
and cuts made in the v2 editor's text reach the export.

  - cut_kinds.label: the analysis log first, the doc's filler words as
    the fallback, silence otherwise; additive (ids, times, other keys
    kept; an existing kind kept);
  - analyze_only asks the analysis for its log (a web-only kwarg: the
    desktop default is no log) and stores the kinds on cut_ranges;
  - GET /jobs/{id} hands them to the editor; jobs from before UX10 (no
    kind) still load and render, disabled_cuts included;
  - a word cut in the text is a timeline save (/edit-segments): the v1
    render and the v2 render both get the clip gap, and neither draws
    the cut word (the editor leaves it out of the caption units).
"""
from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

from backend import cut_kinds as K
from backend import pipeline
from backend.jobs import store
from test_captions_v2 import _doc, _done, _job, modal_r2  # noqa: F401  (fixture)

# ── the rules ────────────────────────────────────────────────────────


def test_log_names_the_cut():
    cuts = [{"id": 0, "start": 0.0, "end": 0.4},
            {"id": 1, "start": 2.0, "end": 3.0},
            {"id": 2, "start": 5.0, "end": 9.0, "source": "user_edit"},
            {"id": 3, "start": 10.0, "end": 10.8}]
    log = [("filler", 2.2, 2.6), ("voice_cmd", 5.2, 8.8), ("filler", 10.0, 10.1)]
    out = K.label(cuts, log=log)
    assert [c["kind"] for c in out] == ["silence", "filler", "voice_cmd", "silence"]
    # additive: everything else as it was, the input untouched
    assert out[2]["source"] == "user_edit" and out[2]["id"] == 2
    assert all("kind" not in c for c in cuts)


def test_voice_command_beats_filler_and_needs_a_real_share():
    log = [("filler", 0.0, 4.0), ("voice_cmd", 1.0, 2.2)]
    assert K.kind_of(0.0, 4.0, K.sources_by_kind(log)) == "voice_cmd"   # 1.2 s ≥ 0.5 s
    log = [("voice_cmd", 0.0, 0.1)]
    assert K.kind_of(0.0, 4.0, K.sources_by_kind(log)) == "silence"     # 0.1 s: no
    # a short cut: a quarter of it is enough
    assert K.kind_of(0.0, 0.4, K.sources_by_kind([("filler", 0.25, 0.4)])) == "filler"


def test_words_are_the_fallback():
    words = [{"id": "w1", "text": "So", "start": 0.3, "end": 0.5},
             {"id": "w2", "text": "um", "start": 0.6, "end": 0.9, "filler": True, "hidden": True}]
    cuts = [{"id": 0, "start": 0.5, "end": 1.0}, {"id": 1, "start": 1.2, "end": 2.0}]
    assert [c["kind"] for c in K.label(cuts, words=words)] == ["filler", "silence"]


def test_existing_kinds_and_bad_input():
    cuts = [{"id": 0, "start": 0.0, "end": 1.0, "kind": "bad_take"},
            {"id": 1, "start": 2.0, "end": 1.0},      # inverted: kept, default kind
            "junk"]
    out = K.label(cuts, log=[("voice_cmd", 0.0, 1.0), ("nope", 0, 1), ("filler",)])
    assert [c["kind"] for c in out] == ["bad_take", "silence"]
    assert K.label(None) == [] and K.sources_by_kind(None) == {}


# ── the analysis ─────────────────────────────────────────────────────


def test_the_desktop_default_logs_nothing():
    from src import plugin_api
    assert inspect.signature(plugin_api.analyze_video).parameters["cut_kinds"].default is None
    plugin_api._log_cuts(None, "filler", [(0, 1)])          # no log, no error
    log: list = []
    plugin_api._log_cuts(log, "filler", [(0, 1), ("x",), (2.5, 3)])
    assert log == [("filler", 0.0, 1.0), ("filler", 2.5, 3.0)]


@pytest.fixture
def fake_analysis(monkeypatch):
    words = [{"text": "Hello", "start": 0.3, "end": 0.7},
             {"text": "um", "start": 1.2, "end": 1.5},
             {"text": "world.", "start": 2.0, "end": 2.4},
             {"text": "Cleo", "start": 3.0, "end": 3.3},
             {"text": "cut.", "start": 3.3, "end": 3.6},
             {"text": "Again.", "start": 4.6, "end": 5.0}]

    def analyze_video(video_path, **kw):
        log = kw.get("cut_kinds")
        if log is not None:
            log.append(("filler", 1.2, 1.5))
            log.append(("voice_cmd", 2.6, 4.4))
        return SimpleNamespace(
            segments=[(0.2, 0.9), (1.9, 2.5), (4.5, 5.2)],
            subtitles=[{"start": 0.0, "end": 0.7, "text": "Hello world.",
                        "original_start": 0.3, "original_end": 2.4}],
            duration=6.0, language="en", scene_events=[], words=words,
            fillers=[{"start": 1.2, "end": 1.5, "word": "um"}])
    monkeypatch.setattr(pipeline, "analyze_video", analyze_video)
    import backend.llm as llm
    monkeypatch.setattr(llm, "cleanup_transcript", lambda subs, language=None: {})


def test_analyze_only_labels_the_cuts(tmp_path, fake_analysis):
    from test_analysis_doc import _clip
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4", 6.0)), str(tmp_path / "job"), {})
    got = [(c["start"], c["end"], c["kind"]) for c in res["cut_ranges"]]
    assert got == [(0.0, 0.2, "silence"), (0.9, 1.9, "filler"),
                   (2.5, 4.5, "voice_cmd"), (5.2, 6.0, "silence")]
    assert [c["id"] for c in res["cut_ranges"]] == [0, 1, 2, 3]


# ── the API ──────────────────────────────────────────────────────────


def test_job_hands_kinds_to_the_editor_and_old_jobs_still_work(client, tmp_path, monkeypatch):
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", duration=6.0,
                 segments=[(0.2, 0.9), (1.9, 6.0)],
                 cut_ranges=K.label([{"id": 0, "start": 0.0, "end": 0.2},
                                     {"id": 1, "start": 0.9, "end": 1.9}],
                                    log=[("filler", 1.0, 1.4)]))
    j = client.get(f"/jobs/{job.id}").json()
    assert [c["kind"] for c in j["cut_ranges"]] == ["silence", "filler"]
    # a job from before UX10: no kind anywhere, and disabled_cuts still apply
    old = store.create(None, {})
    store.update(old.id, status="awaiting_review", duration=6.0,
                 segments=[(0.2, 0.9), (1.9, 6.0)],
                 cut_ranges=[{"id": 0, "start": 0.0, "end": 0.2},
                             {"id": 1, "start": 0.9, "end": 1.9}])
    j = client.get(f"/jobs/{old.id}").json()
    assert all("kind" not in c for c in j["cut_ranges"])
    segs = pipeline._segments_from_disabled_cuts(
        store.get(old.id).segments, store.get(old.id).cut_ranges, [1], 6.0)
    assert [tuple(s) for s in segs] == [(0.2, 6.0)]


# ── text cuts reach the export (both engines) ────────────────────────

# "ten" (0.95–1.10) cut in the text: the editor saves the clip gap and
# leaves the word out of the caption units it sends.
TEXT_CUT = [{"start": 0.0, "end": 0.93}, {"start": 1.11, "end": 1.5}, {"start": 2.0, "end": 3.0}]
UNITS_AFTER_CUT = [
    {"start": 0.0, "end": 0.66, "text": "Nobody waits", "original_start": 0.0, "original_end": 0.66},
    {"start": 0.66, "end": 1.05, "text": "seconds.", "original_start": 1.12, "original_end": 1.5},
    {"start": 1.05, "end": 1.95, "text": "Really never.", "original_start": 2.0, "original_end": 2.9},
]


@pytest.mark.parametrize("engine", ["v1", "v2"])
def test_a_text_cut_reaches_the_render(client, modal_r2, monkeypatch, engine):  # noqa: F811
    import backend.main as M
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", engine)
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    job = _job(media_store="r2", doc=_doc())
    r = client.post(f"/jobs/{job.id}/edit-segments", json={"segments": TEXT_CUT})
    assert r.status_code == 200, r.text
    r = client.post(f"/jobs/{job.id}/render", json={"subtitles": UNITS_AFTER_CUT, "disabled_cuts": []})
    assert r.status_code == 200, r.text
    assert _done(job.id)
    [kw] = modal_r2.spawns
    assert kw["segments"] == [[0.0, 0.93], [1.11, 1.5], [2.0, 3.0]]
    assert "ten" not in " ".join(u["text"] for u in kw["subtitles"])
    if engine == "v2":
        texts = [w["text"] for w in kw["captions"]["words"]]
        assert "ten" not in texts and texts[:3] == ["Nobody", "waits", "seconds."]
