"""Caption sync of the v1 burn on the audit clip (UX2; captions.md §1.2).

For every spoken word: is it the highlighted word at its midpoint? And is
any caption group burned in two clips? The render path is the real one
(_multi_clip_burn → _subs_for → _render_segment_with_standalone_captions,
Clipper); only decoding and drawing are faked (sync_sim.record_render).

- The UX2 payload (word units from phrasesToUnits, units_payload in the
  shared vectors — the web test asserts that is what the editor sends):
  86/86, no duplicates, with and without the web's burn options.
- The payload before UX2 (one subtitle per sentence) on the server before
  UX2: 74/86 and 2 groups burned twice — xfail, documenting the defect.
"""
from __future__ import annotations

import pytest

import sync_sim as sim
from backend import pipeline
from plugins.premiere.video_editor_premiere import _home_segments

V = sim.load_vectors()
TRUTH = sim.spoken_words(V["words"], V["segments"])
SERVER = {"before UX2": {}, "UX2 web": pipeline.web_burn_kwargs("clipper")}


def test_vectors_are_what_the_analysis_code_builds():
    """units / phrases / units_payload in testdata/captions/audit_clip.json
    come from the real analysis code and the editor's buildPhrases."""
    units = sim.build_units(V["whisper_segments"], V["segments"])
    assert units == V["units"]
    assert sim.build_phrases(units) == V["phrases"]
    assert sim.expected_units_payload(units) == V["units_payload"]
    assert len(TRUTH) == 86


@pytest.mark.parametrize("server", sorted(SERVER))
def test_units_payload_highlights_every_spoken_word(monkeypatch, server):
    events = sim.record_render(monkeypatch, V["units_payload"],
                               V["segments"], "clipper", **SERVER[server])
    r = sim.score(events, TRUTH)
    wrong = [row for row in r["rows"] if row[1] is None
             or sim._norm(row[0]) not in map(sim._norm, row[1].split())]
    assert (r["correct"], r["words"]) == (86, 86), wrong
    assert r["missing"] == 0
    assert r["duplicates"] == {}


@pytest.mark.xfail(strict=True, reason=(
    "the payload before UX2 (one subtitle per sentence) on the server "
    "before UX2: 74/86 words highlighted right, 'Mistake number two,' and "
    "'is dead air.' burned in both clips (captions.md §1.2)"))
def test_legacy_sentence_payload(monkeypatch):
    events = sim.record_render(monkeypatch, sim.legacy_payload(V["phrases"]),
                               V["segments"], "clipper")
    r = sim.score(events, TRUTH)
    assert (r["correct"], r["duplicates"]) == (86, {}), (
        f"{r['correct']}/{r['words']}, burned twice: {r['duplicates']}")


def test_legacy_numbers_are_the_audits(monkeypatch):
    """Pins the baseline the xfail above documents (PLAN_TECH §0.12)."""
    events = sim.record_render(monkeypatch, sim.legacy_payload(V["phrases"]),
                               V["segments"], "clipper")
    r = sim.score(events, TRUTH)
    assert r["correct"] == 74
    assert sorted(r["duplicates"]) == ["IS DEAD AIR.", "MISTAKE NUMBER TWO,"]


def test_stale_client_on_the_new_server_gets_no_duplicates(monkeypatch):
    """A browser tab from before the deploy still sends sentences: the
    web's assign_by_midpoint at least stops the double burn."""
    events = sim.record_render(monkeypatch, sim.legacy_payload(V["phrases"]),
                               V["segments"], "clipper",
                               **SERVER["UX2 web"])
    r = sim.score(events, TRUTH)
    assert r["duplicates"] == {}
    assert r["correct"] < 86


def test_web_options_reach_the_highlight_renderer(monkeypatch):
    events = sim.record_render(monkeypatch, V["units_payload"][:6],
                               V["segments"], "clipper", **SERVER["UX2 web"])
    assert events and all(ev["kwargs"] == {"bounce_anchor": "caption"}
                          for ev in events)
    events = sim.record_render(monkeypatch, V["units_payload"][:6],
                               V["segments"], "clipper")
    assert all(ev["kwargs"] == {"bounce_anchor": "frame"} for ev in events)


# A unit spanning a cut, as _map_subtitles_to_segments maps it: twice.
_SEGS = [(0.0, 2.0), (3.0, 5.0)]
_SPANNING = [
    {"start": 0.2, "end": 1.0, "text": "Hello",
     "original_start": 0.2, "original_end": 1.0},
    {"start": 1.2, "end": 2.0, "text": "I want",
     "original_start": 1.2, "original_end": 3.4},
    {"start": 2.0, "end": 2.4, "text": "I want",
     "original_start": 1.2, "original_end": 3.4},
    {"start": 2.5, "end": 3.0, "text": "more.",
     "original_start": 3.5, "original_end": 4.0},
]


def test_a_unit_spanning_a_cut_is_burned_once(monkeypatch):
    def wants(**kw):
        """Clips in which the word 'want' is drawn, once per drawing."""
        events = sim.record_render(monkeypatch, _SPANNING, _SEGS, "clipper",
                                   **kw)
        return [ev["seg"] for ev in events for w in ev["words"] if w == "want"]
    # Default (desktop / Premiere): each copy in both clips.
    assert wants() == [0, 0, 1, 1]
    # Web: once, in the clip holding its midpoint (2.3 s is in the cut:
    # the clip it overlaps most, 0.8 s vs 0.4 s).
    assert wants(**SERVER["UX2 web"]) == [0]


def test_home_segments():
    subs = [
        {"text": "a", "original_start": 0.1, "original_end": 0.5},   # seg 0
        {"text": "b", "original_start": 1.7, "original_end": 3.2},   # mid 2.45 in the cut → most overlap: seg 0 (0.3 s vs 0.2 s)
        {"text": "c", "original_start": 2.9, "original_end": 3.9},   # mid 3.4 → seg 1
        {"text": "c", "original_start": 2.9, "original_end": 3.9},   # repeat → nowhere
        {"text": " ", "original_start": 0.0, "original_end": 1.0},   # empty → nowhere
        {"text": "d", "original_start": 9.0, "original_end": 9.5},   # outside → nowhere
        {"text": "e", "start": 4.0, "end": 4.4},                      # no original_*: start/end
        {"text": "f", "original_start": None, "original_end": 1.0},  # malformed → nowhere
        "not a dict",                                                  # malformed → nowhere
    ]
    segs = [(0.0, 2.0), (3.0, 5.0), (3.0, 5.0)]   # the last repeats a range
    assert _home_segments(subs, segs) == [
        {0}, {0}, {1, 2}, set(), set(), set(), {1, 2}, set(), set()]
