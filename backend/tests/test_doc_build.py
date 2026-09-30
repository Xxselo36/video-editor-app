"""The edit document built at analysis end (UT3): words before the
caption-unit gluing, filler flags, the LLM cleanup applied as a token
diff (testdata/text_edit_vectors.json, shared with the web's
state/textEdit.ts), style precedence incl. the review-D11 paths, and the
tables shared with the web caption engine."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from backend import doc as D

REPO = Path(__file__).resolve().parents[2]
EDITS = json.loads((REPO / "testdata" / "text_edit_vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("v", EDITS["vectors"], ids=[v["name"] for v in EDITS["vectors"]])
def test_text_edit_vectors(v):
    out = D.apply_text_edit(v["words"], v["text"], v.get("taken"))
    strip = [{k: x for k, x in w.items() if k not in ("start", "end")} for w in out]
    assert strip == [{k: x for k, x in w.items() if k not in ("start", "end")}
                     for w in v["expected"]]
    for w, e in zip(out, v["expected"]):
        assert w["start"] == pytest.approx(e["start"], abs=1e-6)
        assert w["end"] == pytest.approx(e["end"], abs=1e-6)


def test_text_edit_keeps_input_and_order():
    words = [{"id": f"w{i}", "text": t, "start": i * 0.3, "end": i * 0.3 + 0.25}
             for i, t in enumerate(["so", "we", "are", "gonna", "win", "this"])]
    before = json.loads(json.dumps(words))
    for text in ["so we will win", "we are going to win this one", "", "gonna gonna gonna", "this so"]:
        out = D.apply_text_edit(words, text)
        assert [w["text"] for w in out] == D.tokenize(text)
        assert len({w["id"] for w in out}) == len(out)
        for i, w in enumerate(out):
            assert 0 <= w["start"] <= w["end"] <= 1.75
            assert i == 0 or w["start"] >= out[i - 1]["start"]
    assert words == before


# ── tables shared with web/src/lib/captions ──────────────────────────


def test_preset_order_matches_the_web():
    ts = (REPO / "web/src/lib/captions/presets.ts").read_text()
    block = ts[ts.index("export const LAUNCH_PRESETS"):]
    block = block[:block.index("]")]
    assert tuple(re.findall(r'"([a-z]+)"', block)) == D.LAUNCH_PRESETS
    assert tuple(D.support()["presets"]) == D.LAUNCH_PRESETS
    assert f'DEFAULT_PRESET: PresetId = "{D.DEFAULT_PRESET}"' in ts
    assert f'DEFAULT_LIVE_PRESETS = "{D.DEFAULT_LIVE_PRESETS}"' in ts


def test_v1_aliases_match_migrate_ts():
    ts = (REPO / "web/src/lib/captions/migrate.ts").read_text()
    rows = re.findall(r'^\s+(\w+): \{ presetId: "(\w+)", overrides: (\{[^}]*\}) \},', ts, re.M)
    web = {k: {"presetId": p, "overrides": json.loads(re.sub(r"(\w+):", r'"\1":', o))}
           for k, p, o in rows}
    assert web == D.V1_PRESETS


def test_live_list():
    assert D.live_presets("clipper,power") == ["clipper", "power", "none"]
    assert D.live_presets("all") == list(D.PRESET_IDS)
    assert D.live_presets(" Neon, bogus ") == ["neon", "none"]


# ── style precedence ─────────────────────────────────────────────────


def test_new_user_gets_power():
    # review D11: no caption_preset / hint / prefs → power (caption_preset
    # of the v1 upload screen is not read)
    s = D.resolve_style({"caption_preset": "clipper"}, None, "de", "9:16")
    assert s == {"presetId": "power", "overrides": {}}


def test_precedence_order():
    prefs = {"caption_style_by_aspect": {"9:16": {"presetId": "neon", "overrides": {"y": 0.6}},
                                         "16:9": {"presetId": "subtitle", "overrides": {}}}}
    settings = {"caption_style_hint": "clipper"}
    assert D.resolve_style(settings, prefs, "en", "9:16")["presetId"] == "neon"
    assert D.resolve_style(settings, prefs, "en", "9:16")["overrides"] == {"y": 0.6}
    assert D.resolve_style(settings, prefs, "en", "16:9")["presetId"] == "subtitle"
    # no prefs for this aspect → the hint (a browser with local jobs)
    assert D.resolve_style(settings, prefs, "en", "original")["presetId"] == "clipper"
    # picked while waiting beats everything
    picked = {**settings, "caption_style": {"presetId": "karaoke", "overrides": {}}}
    assert D.resolve_style(picked, prefs, "en", "9:16")["presetId"] == "karaoke"
    # v1 ids are migrated
    assert D.resolve_style({"caption_style_hint": "classic"}, None, "en", "9:16") == {
        "presetId": "power", "overrides": {"highlightColor": "#FFFFFF"}}
    # junk is skipped, not fatal
    assert D.resolve_style({"caption_style": "bogus", "caption_style_hint": 5}, None, "en",
                           "9:16")["presetId"] == "power"


def test_script_unavailable_takes_first_recommended():
    # clipper has no Cyrillic: ru gets a native preset, live first
    s = D.resolve_style({"caption_style_hint": "clipper"}, None, "ru", "9:16",
                        live=["clipper", "power", "none"])
    assert s["presetId"] == "power"
    # Hindi: power can't; karaoke is the first native Devanagari preset
    assert D.resolve_style({}, None, "hi", "9:16", live=D.PRESET_IDS)["presetId"] == "karaoke"
    # CJK: power has a fallback font, so it stays
    assert D.resolve_style({}, None, "ja", "9:16")["presetId"] == "power"
    assert D.resolve_style({"caption_style_hint": "mega"}, None, "ja", "9:16",
                           live=D.PRESET_IDS)["presetId"] == "power"
    # RTL: no preset at launch
    assert D.resolve_style({}, None, "ar", "9:16")["presetId"] == "none"


def test_recommended_rules():
    assert D.recommended("en", "16:9")[:2] == ["subtitle", "minimal"]
    assert D.recommended("en", "9:16", words_per_s=3.5)[:2] == ["power", "punch"]
    assert D.recommended("en", "9:16", words_per_s=1.5)[:2] == ["karaoke", "subtitle"]
    assert "clipper" not in D.recommended("ru")
    assert D.recommended("he") == ["none"]


def test_aspect():
    assert D.aspect_of({"target_aspect": "16:9"}) == "16:9"
    assert D.aspect_of({"smartcam_enabled": True, "smartcam_format": "portrait"}) == "9:16"
    assert D.aspect_of({"smartcam_enabled": False, "smartcam_format": "landscape"}) == "original"


# ── words ────────────────────────────────────────────────────────────


RAW = [  # Whisper words, before src/audio.py glues "so" + "we"
    {"word": " So", "start": 0.5, "end": 0.7, "probability": 0.91},
    {"word": " äh,", "start": 0.7, "end": 1.1, "probability": 0.5},
    {"word": " we", "start": 1.2, "end": 1.35, "probability": 1.0},
    {"word": " gonna", "start": 1.35, "end": 1.7},
    {"word": " you", "start": 1.8, "end": 1.9},
    {"word": " know", "start": 1.9, "end": 2.1},
    {"word": "...", "start": 2.2, "end": 2.6},
    {"word": " win.", "start": 2.7, "end": 3.0},
]


def test_words_keep_every_token_and_flag_fillers():
    words = D.words_from_transcript(RAW, fillers=[{"start": 1.8, "end": 2.1, "word": "you know"}])
    assert [w["text"] for w in words] == ["So", "äh,", "we", "gonna", "you", "know", "...", "win."]
    assert [w["id"] for w in words][:3] == ["w0001", "w0002", "w0003"]
    flagged = [w["text"] for w in words if w.get("filler")]
    assert flagged == ["äh,", "you", "know", "..."]
    assert all(w.get("hidden") for w in words if w.get("filler"))
    assert words[0]["conf"] == 0.91 and "conf" not in words[2]   # 1.0 = no real value


def test_sentence_punctuation_tokens_stay_visible():
    words = D.words_from_transcript([{"word": "晴れ", "start": 0, "end": 0.4},
                                     {"word": "。", "start": 0.4, "end": 0.45},
                                     {"word": "…", "start": 0.5, "end": 0.9}])
    assert [bool(w.get("hidden")) for w in words] == [False, False, True]


def test_cleanup_diff_keeps_timing():
    words = D.words_from_transcript(RAW)
    # the caption units of src/audio.py (fillers dropped, <= 3 chars glued)
    units = [{"text": "So we", "original_start": 0.5, "original_end": 1.35},
             {"text": "gonna", "original_start": 1.35, "original_end": 1.7},
             {"text": "you know", "original_start": 1.8, "original_end": 2.1},
             {"text": "... win.", "original_start": 2.2, "original_end": 3.0}]
    out = D.apply_cleanup(words, units, {0: "So we", 1: "going to", 3: "win."})
    by_text = {w["text"]: w for w in out}
    assert [w["text"] for w in out] == ["So", "äh,", "we", "going", "to", "you", "know", "win."]
    assert (by_text["So"]["start"], by_text["we"]["end"]) == (0.5, 1.35)
    assert by_text["äh,"]["start"] == 0.7            # the filler sound is left alone
    assert by_text["going"]["start"] == 1.35 and by_text["to"]["end"] == 1.7
    assert by_text["going"]["end"] == pytest.approx(1.35 + 0.35 * 5 / 7, abs=1e-3)
    assert by_text["to"]["id"].startswith(by_text["going"]["id"] + ".")
    # "..." deleted: its time went to the word after it
    assert by_text["win."]["start"] == 2.2


def test_cleanup_boundary_word_belongs_to_the_next_unit():
    words = D.words_from_transcript([{"word": "so", "start": 1.0, "end": 1.2},
                                     {"word": "good", "start": 1.25, "end": 1.6},
                                     {"word": "yes", "start": 1.6, "end": 1.6}])
    units = [{"text": "so good", "original_start": 1.0, "original_end": 1.6},
             {"text": "yes", "original_start": 1.6, "original_end": 1.6}]
    out = D.apply_cleanup(words, units, {0: "So good", 1: "Yes."})
    assert [(w["id"], w["text"], w["start"], w["end"]) for w in out] == [
        ("w0001", "So", 1.0, 1.2), ("w0002", "good", 1.25, 1.6), ("w0003", "Yes.", 1.6, 1.6)]
    # only the first unit rewritten: "yes" is left alone, not deleted
    out = D.apply_cleanup(words, units, {0: "so good!"})
    assert [w["text"] for w in out] == ["so", "good!", "yes"]


def test_cleanup_many_units_in_one_pass():
    raw = [{"word": f"w{i}", "start": i * 0.5, "end": i * 0.5 + 0.4} for i in range(3000)]
    units = [{"text": f"w{i}", "original_start": i * 0.5, "original_end": i * 0.5 + 0.4}
             for i in range(3000)]
    out = D.apply_cleanup(D.words_from_transcript(raw), units,
                          {i: f"x{i} y{i}" for i in range(0, 3000, 2)})
    assert len(out) == 4500
    assert [w["text"] for w in out[:4]] == ["x0", "y0", "w1", "x2"]
    D.check_words(out)


def test_words_from_units_fallback():
    units = [{"text": "Hi there", "start": 0.0, "end": 1.0, "original_start": 2.0, "original_end": 3.0},
             {"text": "Hi there", "start": 1.0, "end": 1.2, "original_start": 2.0, "original_end": 3.0}]
    words = D.words_from_units(units)
    assert [(w["text"], w["start"], w["end"]) for w in words] == [("Hi", 2.0, 2.5), ("there", 2.5, 3.0)]


def test_build_doc_shape():
    words = D.words_from_transcript(RAW)
    doc = D.build_doc(words, "en", {"smartcam_enabled": True, "smartcam_format": "portrait"},
                      segments=[(0.4, 3.1)])
    assert doc["v"] == 2 and doc["clips"] is None and doc["rev"] == 0
    assert doc["language"] == "en" and doc["format"] == {"aspect": "9:16"}
    assert doc["style"] == {"presetId": "power", "overrides": {}}
    assert len(doc["words"]) == len(RAW)
    json.dumps(doc)  # storable as is


def test_commit_change_reads_the_style_picked_while_processing():
    class J:
        status = "processing"
        settings = {"caption_style": "neon"}
    res = {"doc": D.build_doc(D.words_from_transcript(RAW), "en", {}), "segments": []}
    change = D.commit_change({"status": "awaiting_review"}, res)
    out = change(J())
    assert out["doc"]["style"]["presetId"] == "neon" and out["doc_rev"] == 0
    assert res["doc"]["style"]["presetId"] == "power"   # the result isn't changed
    J.status = "error"
    assert change(J()) is None
