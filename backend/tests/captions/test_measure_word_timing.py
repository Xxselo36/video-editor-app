"""backend/scripts/measure_word_timing.py without Groq: label conversion,
alignment, the UT6 rule, and the whole measurement on the audit clip (its
Whisper-shaped transcript stands in for Groq's)."""
from __future__ import annotations

import copy
import importlib.util
import json

import pytest

import sync_sim as sim
from conftest import REPO

V = sim.load_vectors()


@pytest.fixture(scope="module")
def mwt():
    path = REPO / "backend" / "scripts" / "measure_word_timing.py"
    spec = importlib.util.spec_from_file_location("measure_word_timing", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _hyp(shift_start=0.0, shift_end=0.0):
    words = copy.deepcopy([w for s in V["whisper_segments"] for w in s["words"]])
    for w in words:
        w["start"] += shift_start
        w["end"] += shift_end
    return words


def _analysis(words=None):
    segs = copy.deepcopy(V["whisper_segments"])
    if words is not None:
        it = iter(words)
        for s in segs:
            s["words"] = [next(it) for _ in s["words"]]
    return {"clip": "audit_clip", "language": "en",
            "transcription": {"segments": segs, "language": "en"},
            "segments": V["segments"], "units": V["units"]}


def test_audacity_labels(mwt, tmp_path):
    txt = tmp_path / "de_labels.txt"
    txt.write_text("1.250000\t1.600000\tHallo\n"
                   "\\\t120.0\t4000.0\n"             # frequency line
                   "0.500000\t0.910000\tAlso,\n"
                   "2.0\t2.1\t\n", encoding="utf-8")  # empty label: skipped
    assert mwt.read_labels(txt) == [
        {"text": "Also,", "start": 0.5, "end": 0.91},
        {"text": "Hallo", "start": 1.25, "end": 1.6}]
    out = tmp_path / "de.json"
    assert mwt.main(["--convert-labels", str(txt), "--language", "de",
                     "--clip-name", "de_60s.mp4", "--out", str(out)]) == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["language"] == "de" and len(doc["words"]) == 2
    assert mwt.read_labels(out) == mwt.read_labels(txt)


def test_alignment_skips_asr_errors_and_extra_words(mwt):
    labels = [{"text": t, "start": i, "end": i + .5}
              for i, t in enumerate(["Mistake", "number", "two,", "is", "dead", "air."])]
    hyp = [{"text": t, "start": i, "end": i + .5}
           for i, t in enumerate(["mistake", "number", "2", "um", "is", "dead", "air"])]
    assert mwt.align(labels, hyp) == [(0, 0), (1, 1), (3, 4), (4, 5), (5, 6)]
    # casefold: ß matches ss (Swiss spelling, Whisper's variants)
    assert mwt.norm_word("„Grüße!“") == mwt.norm_word("Grüsse") == "grüsse"


@pytest.mark.parametrize("shift_ms,ut6", [(40, False), (80, False), (100, True)])
def test_timing_errors_and_the_ut6_rule(mwt, shift_ms, ut6):
    hyp = [{"text": w["word"].strip(), "start": w["start"], "end": w["end"]}
           for w in _hyp(shift_ms / 1000, shift_ms / 1000)]
    hyp[10]["text"] = "rich"                          # an ASR error
    rep = mwt.timing_report(V["words"], hyp)
    assert rep["labels"] == 88 and rep["matched"] == 87
    assert rep["start_ms"]["median_abs"] == pytest.approx(shift_ms, abs=0.5)
    assert rep["start_ms"]["mean"] == pytest.approx(shift_ms, abs=0.5)
    assert rep["ut6"] is ut6


def test_measure_on_the_audit_clip(mwt, tmp_path, capsys):
    rep = mwt.measure(V["words"], _analysis())
    t, s = rep["timing"], rep["sync"]
    assert t["matched"] == 88 and t["start_ms"]["median_abs"] == 0.0
    assert not t["ut6"]
    # The fillers ("Um,", "uh,") are in cuts: 86 words are scored.
    assert (s["correct"], s["scored"], s["burned_twice"]) == (86, 86, {})
    assert s["passes"] and rep["groq_probability_varies"] is False
    assert "86/86 words highlighted" in mwt.summary(rep)
    # The same through the CLI, from a cached analysis.
    cache = tmp_path / "audit.analysis.json"
    cache.write_text(json.dumps(_analysis()))
    labels = tmp_path / "en.json"
    labels.write_text(json.dumps({"words": V["words"]}))
    capsys.readouterr()
    assert mwt.main(["--labels", str(labels), "--cache", str(cache),
                     "--markdown", "--json", str(tmp_path / "r.json")]) == 0
    out = capsys.readouterr().out
    assert "PASS" in out and "no UT6 needed" in out
    assert "| audit_clip | en | 88 | 88 | 0.0 / 0.0 |" in out
    assert json.loads((tmp_path / "r.json").read_text())["sync"]["correct"] == 86


def test_late_words_fail_the_sync_gate(mwt):
    """Groq words 250 ms late → units late → highlights lag the speech."""
    rep = mwt.measure(V["words"], _analysis(_hyp(0.25, 0.25)))
    assert rep["timing"]["ut6"] is True
    # Units are built from the transcript in _analysis() (unchanged), so
    # shift those too to see the burn follow the late timings.
    late = copy.deepcopy(V["units"])
    for u in late:
        u["original_start"] += 0.25
        u["original_end"] += 0.25
    analysis = _analysis(_hyp(0.25, 0.25))
    analysis["units"] = late
    s = mwt.measure(V["words"], analysis)["sync"]
    assert s["share"] < 0.95 and not s["passes"]
