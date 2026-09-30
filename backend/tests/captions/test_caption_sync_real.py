"""Nightly: v1 caption sync on the owner's two real 60 s clips (UX2 gate,
PLAN_TECH §0.12): >= 95 % of the labelled words are the highlighted word at
their labelled midpoint, and no caption is burned twice. The Groq word-time
error is printed (median > 80 ms → UT6), not asserted: it is a decision.

Skipped until the data exists (see LABELLING.md):
- testdata/real_words/{de,en}.json — the hand labels (in git);
- $CLEO_REAL_CLIPS_DIR/{de,en}.analysis.json — measure_word_timing.py
  --cache output — or $CLEO_REAL_CLIPS_DIR/{de,en}.mp4 plus GROQ_API_KEY.
  The clips stay out of git (R2 test bucket, fetched by the nightly job).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

from conftest import REPO

LABELS = REPO / "testdata" / "real_words"


def _script():
    path = REPO / "backend" / "scripts" / "measure_word_timing.py"
    spec = importlib.util.spec_from_file_location("measure_word_timing", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("lang", ["de", "en"])
def test_real_clip_caption_sync(lang):
    labels = LABELS / f"{lang}.json"
    clips = os.environ.get("CLEO_REAL_CLIPS_DIR", "").strip()
    if not labels.is_file() or not clips:
        pytest.skip("waiting for the owner's labelled test clips "
                    "(backend/tests/captions/LABELLING.md)")
    mwt = _script()
    cache = Path(clips) / f"{lang}.analysis.json"
    if cache.is_file():
        analysis = json.loads(cache.read_text(encoding="utf-8"))
    else:
        clip = Path(clips) / f"{lang}.mp4"
        if not clip.is_file() or not os.environ.get("GROQ_API_KEY"):
            pytest.skip(f"no {cache.name} and no {clip.name} + GROQ_API_KEY")
        analysis = mwt.run_analysis(clip)
    rep = mwt.measure(mwt.read_labels(labels), analysis)
    print(mwt.summary(rep))
    assert rep["sync"]["burned_twice"] == {}
    assert rep["sync"]["passes"], rep["sync"]["misses"]
