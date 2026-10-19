"""Filler words (src/filler_detection.py): a German "ähm" / English "um"
that Whisper wrote as the real word "am" (or "ham"), owner report S5
(filler-um-heard-am). It counts as a filler only where the word can't
be one — set off by breaks on both sides and heard like a hesitation —
never a real "am Ende", "I am", "am Montag".

Word lists are Whisper-like: punctuation on the tokens, mostly touching
times (Groq stretches words over pauses and gives no per-word
probability: its words read 1.0)."""
from __future__ import annotations

import pytest

from src.filler_detection import FillerDetector


def T(*items, lang="de", prob=1.0):
    """[(text, start, end[, probability]), ...] → one Whisper segment."""
    words = []
    for it in items:
        text, s, e = it[:3]
        words.append({"word": text, "start": s, "end": e,
                      "probability": it[3] if len(it) > 3 else prob})
    return {"language": lang, "segments": [{"words": words}]}


def fillers(tr):
    return [(f.word, f.start, f.end) for f in FillerDetector().detect_fillers(tr)]


HEARD_AS_AM = [
    # "…, am, …" — commas both sides, drawn out (Groq: no probability)
    ("de-commas-long", T(("Wir", 1.0, 1.2), ("haben,", 1.2, 1.5), ("am,", 1.5, 2.1),
                         ("das", 2.1, 2.3), ("gemacht.", 2.3, 2.8)), "am"),
    ("de-sentence-start-ellipsis", T(("Gut.", 1.0, 1.3), ("Am…", 1.3, 1.9),
                                     ("wir", 1.9, 2.0), ("gucken", 2.0, 2.3), ("mal.", 2.3, 2.6)), "am"),
    ("de-pause-after", T(("Also,", 1.0, 1.4), ("am", 1.4, 1.7), ("wir", 2.2, 2.4),
                         ("fangen", 2.4, 2.7), ("an.", 2.7, 3.0)), "am"),
    ("de-ham", T(("Und", 1.0, 1.2), ("dann,", 1.2, 1.5), ("ham,", 1.5, 2.0),
                 ("ging", 2.0, 2.3), ("es", 2.3, 2.4), ("los.", 2.4, 2.8)), "ham"),
    ("de-hesitation-mark-after", T(("Ja.", 1.0, 1.3), ("Am", 1.3, 1.8), ("...", 1.8, 2.2),
                                   ("genau.", 2.2, 2.6)), "am"),
    # local Whisper with real probabilities: low confidence, short
    ("de-low-prob", T(("Okay,", 1.0, 1.3, 0.9), ("am,", 1.3, 1.45, 0.31),
                      ("los", 1.45, 1.7, 0.95), ("geht's.", 1.7, 2.0, 0.9)), "am"),
    ("en-um-as-am", T(("So,", 1.0, 1.3), ("am,", 1.3, 1.8), ("we", 1.8, 1.9),
                      ("start.", 1.9, 2.3), lang="en"), "am"),
]


@pytest.mark.parametrize("cid,tr,word", HEARD_AS_AM, ids=[c[0] for c in HEARD_AS_AM])
def test_an_um_heard_as_a_word_is_a_filler(cid, tr, word):
    got = fillers(tr)
    assert [w for w, *_ in got] == [word], got


REAL_WORDS = [
    # the shapes of the real "am" in the owner's recording (no text of
    # his): touching its next word — also when Whisper stretched it
    ("am-ende", T(("sehen", 21.5, 21.73), ("uns", 21.73, 21.9), ("am", 21.9, 22.04),
                  ("Ende.", 22.04, 22.5))),
    ("i-am-stretched", T(("I", 57.8, 58.05), ("am", 58.05, 58.81), ("ready", 58.81, 59.0),
                         ("now.", 59.0, 59.4), lang="en")),
    ("am-montag", T(("Wir", 1.0, 1.2), ("treffen", 1.2, 1.5), ("uns", 1.5, 1.7),
                    ("am", 1.7, 1.85), ("Montag.", 1.85, 2.3))),
    ("am-satzanfang", T(("Gut.", 1.0, 1.3), ("Am", 1.3, 1.45), ("besten", 1.45, 1.8),
                        ("sofort.", 1.8, 2.2))),
    ("yes-i-am", T(("Yes,", 1.0, 1.3), ("I", 1.3, 1.4), ("am.", 1.4, 1.9), lang="en")),
    ("who-i-am-comma", T(("That's", 1.0, 1.3), ("who", 1.3, 1.5), ("I", 1.5, 1.6),
                         ("am,", 1.6, 2.2), ("and", 2.2, 2.4), lang="en")),
    ("i-ellipsis-am", T(("I...", 1.0, 1.4), ("am.", 1.4, 2.0), lang="en")),
    ("nine-am", T(("at", 1.0, 1.1), ("9", 1.1, 1.3), ("am.", 1.3, 1.8), lang="en")),
    # a real "am" the speaker hesitated after (or two fillers): left alone
    ("am-then-aehm", T(("Uns.", 1.0, 1.3), ("Am,", 1.3, 1.8), ("ähm,", 1.8, 2.3),
                       ("Montag.", 2.3, 2.8))),
    # set off but short and certain: no sign of a hesitation
    ("short-set-off", T(("Wann?", 1.0, 1.3), ("Am,", 1.3, 1.45), ("glaube", 1.45, 1.7),
                        ("ich,", 1.7, 1.9))),
    ("high-prob", T(("Okay,", 1.0, 1.3, 0.9), ("am,", 1.3, 1.8, 0.97),
                    ("los", 1.8, 2.0, 0.95))),
    # English "ham" is food
    ("en-ham", T(("Ham,", 1.0, 1.5), ("eggs", 1.5, 1.8), ("and", 1.8, 1.9),
                 ("bacon.", 1.9, 2.4), lang="en")),
    # German colloquial "ham" (= haben) runs on
    ("de-die-ham", T(("Die", 1.0, 1.2), ("ham", 1.2, 1.5), ("recht.", 1.5, 1.9))),
]


@pytest.mark.parametrize("cid,tr", REAL_WORDS, ids=[c[0] for c in REAL_WORDS])
def test_a_real_am_is_no_filler(cid, tr):
    got = [w for w, *_ in fillers(tr) if w in ("am", "ham")]
    assert got == [], fillers(tr)


def test_the_usual_fillers_are_unchanged():
    tr = T(("Ähm,", 1.0, 1.5), ("das", 1.5, 1.7), ("ist", 1.7, 1.9), ("eh", 1.9, 2.0),
           ("klar.", 2.0, 2.4), ("Äh,", 2.6, 3.0), ("um", 3.0, 3.2), ("fünf.", 3.2, 3.6))
    # German "um" stays a word; "eh" in a sentence too
    assert [w for w, *_ in fillers(tr)] == ["ähm", "äh"]
