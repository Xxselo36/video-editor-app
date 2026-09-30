"""backend/timeline_map.py against the shared vectors (testdata/
timeline_vectors.json, also run by web/src/lib/captions/__tests__/
timeline.test.ts) and the invariants the web suite checks."""
from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from backend import timeline_map as tm

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "testdata"
                      / "timeline_vectors.json").read_text())["vectors"]


@pytest.mark.parametrize("v", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vectors(v):
    out = tm.map_to_output(v["clips"], v["words"], offset_ms=v.get("offsetMs", 0))
    exp = v["expected"]
    assert [w["id"] for w in out["words"]] == [w[0] for w in exp["words"]]
    for w, (_id, start, end) in zip(out["words"], exp["words"]):
        assert w["start"] == pytest.approx(start, abs=1e-6)
        assert w["end"] == pytest.approx(end, abs=1e-6)
    assert out["breaks"] == pytest.approx(exp["breaks"], abs=1e-6)
    assert out["duration"] == pytest.approx(exp["duration"], abs=1e-6)


def test_segments_as_pairs_and_include_hidden():
    words = [{"id": "a", "text": "um", "start": 0.2, "end": 0.4, "hidden": True},
             {"id": "b", "text": "yes", "start": 3.5, "end": 3.8, "breakBefore": True}]
    out = tm.map_to_output([(0.0, 1.0), (3.0, 4.0)], words, include_hidden=True)
    assert [w["id"] for w in out["words"]] == ["a", "b"]
    assert out["words"][1]["start"] == pytest.approx(1.5)
    assert out["words"][1]["breakBefore"] is True
    assert out["words"][1]["srcStart"] == 3.5 and out["words"][1]["run"] == 1


def test_invariants_random_edits():
    for seed in range(1, 41):
        rnd = random.Random(seed)
        words, t = [], 0.0
        for i in range(120):
            t += 0.05 + rnd.random() * 0.3
            d = 0.08 + rnd.random() * 0.4
            words.append({"id": f"w{i}", "text": f"w{i}", "start": t, "end": t + d})
            t += d
        clips, c = [], 0.0
        while c < t:
            ln = 0.5 + rnd.random() * 4
            clips.append({"start": c, "end": min(t, c + ln),
                          "speed": 1.5 if rnd.random() < 0.2 else 1})
            c += ln + (rnd.random() * 1.2 if rnd.random() < 0.6 else 0)
        out = tm.map_to_output(clips, words, offset_ms=round((rnd.random() - 0.5) * 600))
        ws = out["words"]
        for i, w in enumerate(ws):
            assert w["end"] >= w["start"]
            if i:
                assert w["start"] >= ws[i - 1]["start"] - 1e-9
            assert 0 <= w["start"] and w["end"] <= out["duration"] + 1e-9
            for b in out["breaks"]:
                assert not (w["start"] < b - 1e-9 and w["end"] > b + 1e-9)
        assert len({w["id"] for w in ws}) == len(ws)


def test_src_out_round_trip():
    clips = [{"start": 0, "end": 2}, {"start": 3, "end": 5, "speed": 2}]
    assert tm.output_duration(clips) == pytest.approx(3)
    assert tm.src_to_out(clips, 2.5) is None
    assert tm.src_to_out(clips, 4) == pytest.approx(2.5)
    assert tm.out_to_src(clips, 2.5) == pytest.approx(4)
    for t in (0, 0.7, 1.99, 3, 3.3, 4.9):
        o = tm.src_to_out(clips, t)
        assert o is not None
        assert tm.out_to_src(clips, o) == pytest.approx(t, abs=1e-9)
    assert tm.out_to_src([], 1.0) is None
