"""Spoken commands (src/scene_triggers.py, src/voice_triggers.py,
src/phonetic_wake_detection.py, src/command_gate.py; owner report S4/S5):
what counts as a command, how Whisper's tokens are read, and what each
command cuts.

Word lists are Whisper-like (punctuation on the tokens, touching words);
where timings matter they are the owner's job's timings (no transcript
text) or the synthetic recordings of test_command_edges.py.
"""
from __future__ import annotations

import json
import types

import pytest

from src.scene_triggers import find_scene_cut_ranges
from src.voice_triggers import (apply_voice_triggers_to_segments,
                                collect_whisper_words, detect_voice_triggers)


def W(*items):
    """[(text, start, end), ...] → a Whisper transcription (one segment)."""
    return {"segments": [{"words": [
        {"word": t, "start": s, "end": e, "probability": 0.9}
        for (t, s, e) in items]}], "language": "de"}


def scene(items, dur=60.0):
    return find_scene_cut_ranges(collect_whisper_words(W(*items)),
                                 clip_duration=dur)


def stopgo(items, silence=None):
    return detect_voice_triggers(collect_whisper_words(W(*items)),
                                 silence_ranges=silence)


def covered(cuts, a, b):
    """Is [a, b] inside the cut ranges (merged)?"""
    t = a
    for x, y in sorted(cuts):
        if x <= t + 1e-6 and y > t:
            t = y
    return t >= b - 1e-6


def lost(cuts, a, b):
    """Seconds of [a, b] the cut ranges remove."""
    return sum(max(0.0, min(b, y) - max(a, x)) for x, y in cuts)


START = [("Hallo", 0.5, 0.8), ("Cleo", 1.0, 1.3), ("start.", 1.3, 1.7)]
TAKE = [("Das", 2.0, 2.2), ("ist", 2.2, 2.4), ("Take", 2.4, 2.8), ("eins.", 2.8, 3.2)]
TAIL = [("Ende", 30.0, 30.4), ("vom", 30.4, 30.6), ("Video.", 30.6, 31.0)]


# ── everyday speech is no command (commands-5) ──────────────────────

# Said in a sentence around 20 s, after a real "Cleo start": none of
# these may fire (each used to cut a take, or — "fertig" — the rest of
# the video).
NOT_COMMANDS = [
    ("ich-finde-cleo-gut", [("Ich", 20.0, 20.2), ("finde", 20.2, 20.5), ("Cleo", 20.5, 20.9), ("gut,", 20.9, 21.2), ("weil", 21.2, 21.5)]),
    ("wenn-cleo-fertig", [("Wenn", 20.0, 20.2), ("Cleo", 20.2, 20.6), ("fertig", 20.6, 21.0), ("ist,", 21.0, 21.2)]),
    ("cleo-startet", [("Dann", 20.0, 20.2), ("Cleo", 20.2, 20.6), ("startet", 20.6, 21.0), ("das", 21.0, 21.2)]),
    ("cleo-noch-mal", [("Wir", 20.0, 20.2), ("müssen", 20.2, 20.4), ("Cleo", 20.4, 20.8), ("noch", 20.8, 21.0), ("mal", 21.0, 21.2), ("testen.", 21.2, 21.6)]),
    ("cleo-ist-auf", [("Cleo", 20.0, 20.4), ("ist", 20.4, 20.6), ("auf", 20.6, 20.8), ("jeden", 20.8, 21.0), ("Fall", 21.0, 21.3)]),
    ("teste-cleo-nochmal", [("Ich", 20.0, 20.2), ("teste", 20.2, 20.5), ("Cleo", 20.5, 20.9), ("nochmal.", 20.9, 21.3)]),
    ("product-name", [("mit", 20.0, 20.2), ("CleoCuts", 20.2, 20.9), ("geschnitten.", 20.9, 21.5)]),
    ("product-name-own-sentence", [("Das", 19.0, 19.2), ("Tool:", 19.2, 19.6), ("CleoCuts.", 20.2, 20.9)]),
    ("cleo-cuts-the-pauses", [("and", 20.0, 20.2), ("Cleo", 20.2, 20.5), ("cuts", 20.5, 20.8), ("the", 20.8, 20.9), ("pauses.", 20.9, 21.4)]),
    ("a-clean-cut", [("That", 19.6, 19.8), ("was", 19.8, 20.0), ("a", 20.0, 20.1), ("clean", 20.1, 20.4), ("cut.", 20.4, 20.7)]),
    ("a-cool-cut", [("a", 20.0, 20.1), ("cool", 20.1, 20.4), ("cut", 20.4, 20.7), ("here", 20.7, 21.0)]),
    ("cleo-is-that-right", [("Cleo,", 20.0, 20.3), ("is", 20.3, 20.4), ("that", 20.4, 20.6), ("right?", 20.6, 20.9)]),
    ("cleo-is-left-out", [("Cleo", 20.0, 20.3), ("is", 20.3, 20.4), ("left", 20.4, 20.6), ("out.", 20.6, 20.9)]),
    ("cleo-schneiden-lassen", [("Cleo", 20.0, 20.3), ("schneiden", 20.3, 20.8), ("lassen.", 20.8, 21.2)]),
    ("cleo-neu-starten", [("Cleo", 20.0, 20.3), ("neu", 20.3, 20.5), ("starten.", 20.5, 21.0)]),
    ("cleo-check-ich", [("Cleo", 20.0, 20.3), ("check", 20.3, 20.6), ("ich", 20.6, 20.8)]),
    ("kann-cleo-speichern", [("Kann", 20.0, 20.3), ("Cleo", 20.3, 20.6), ("speichern?", 20.6, 21.1)]),
    # phonetic: Kl-/Cl- words and K…l skeletons are other words
    ("klaus-kam", [("Klaus", 20.0, 20.4), ("kam", 20.4, 20.7), ("rein.", 20.7, 21.0)]),
    ("kollege-kam", [("Kollege", 20.0, 20.5), ("kam", 20.5, 20.8), ("spät.", 20.8, 21.2)]),
    ("klick-startet", [("Ein", 20.0, 20.2), ("Klick", 20.2, 20.5), ("startet", 20.5, 20.9), ("das", 20.9, 21.0)]),
    ("klasse-startet", [("Die", 20.0, 20.2), ("Klasse", 20.2, 20.6), ("startet.", 20.6, 21.0)]),
    ("a-close-finish", [("a", 20.0, 20.1), ("close", 20.1, 20.5), ("finish.", 20.5, 21.0)]),
    ("the-class-finished", [("the", 20.0, 20.1), ("class", 20.1, 20.5), ("finished", 20.5, 21.0)]),
    ("a-clean-start", [("a", 20.0, 20.1), ("clean", 20.1, 20.4), ("start", 20.4, 20.8)]),
]


@pytest.mark.parametrize("cid,words", NOT_COMMANDS, ids=[c[0] for c in NOT_COMMANDS])
def test_everyday_speech_is_no_command(cid, words):
    cuts, events = scene(START + TAKE + words + TAIL, dur=40.0)
    assert [t for (t, s, e) in events if 18.9 <= s <= 21.5] == [], events
    # nothing after the opening "Cleo start" is cut: no take, no tail
    assert lost(cuts, 1.8, 40.0) == 0.0, cuts


def test_a_phonetic_guess_never_switches_the_scene_commands_on():
    # "Kleeo, Stard." is only a phonetic guess at "Cleo start": it must
    # not cut everything before it (commands-5 (4)).
    words = TAKE + [("Satz.", 19.0, 19.5), ("Kleeo,", 20.2, 20.5), ("Stard.", 20.6, 20.9),
                    ("Video.", 21.5, 22.0)]
    cuts, events = scene(words, dur=30)
    assert [t for t, *_ in events] == ["start"]
    assert cuts == []


def test_a_phonetic_finish_cuts_only_its_phrase():
    words = START + TAKE + [("Satz.", 19.0, 19.5), ("Kleeo,", 20.2, 20.5),
                            ("Finisch.", 20.6, 21.0), ("Weiter", 21.5, 21.8),
                            ("geht's.", 21.8, 22.2)] + TAIL
    cuts, events = scene(words, dur=40.0)
    assert [t for t, *_ in events] == ["start", "finish"]
    assert covered(cuts, 20.2, 21.0)
    assert lost(cuts, 21.5, 40.0) == 0.0


# Said as commands (their own sentence): still found.
COMMANDS = [
    ("plain", [("Cleo", 4.0, 4.3), ("cut.", 4.3, 4.6)], "restart"),
    ("punct", [("Cleo,", 4.0, 4.3), ("cut.", 4.3, 4.6)], "restart"),
    ("upper", [("CLEO", 4.0, 4.3), ("CUT!", 4.3, 4.6)], "restart"),
    ("question", [("Cleo?", 4.0, 4.3), ("Cut?", 4.3, 4.6)], "restart"),
    ("kleo", [("Kleo", 4.0, 4.3), ("Cut.", 4.3, 4.6)], "restart"),
    ("clio-pause-after", [("Clio", 4.0, 4.3), ("cut", 4.3, 4.6)], "restart"),
    ("merged", [("CleoCut.", 4.0, 4.6)], "restart"),
    ("merged-keep", [("Cleokeep.", 4.0, 4.6)], "keep"),
    ("filler-between", [("Cleo,", 4.0, 4.25), ("äh,", 4.25, 4.35), ("cut.", 4.35, 4.6)], "restart"),
    ("cleo-accent", [("Cléo", 4.0, 4.3), ("keep.", 4.3, 4.6)], "keep"),
    ("klio-kat-phonetic", [("Klio", 4.0, 4.3), ("Kat.", 4.3, 4.6)], "restart"),
    ("keep-kipp", [("Cleo", 4.0, 4.3), ("Kipp.", 4.3, 4.6)], "keep"),
    ("finish-fertig", [("Cleo,", 4.0, 4.3), ("fertig.", 4.3, 4.6)], "finish"),
    ("start-stadt", [("Cleo", 4.0, 4.3), ("Stadt.", 4.3, 4.6)], "start"),
    ("clear-finish", [("Clear", 4.0, 4.3), ("finish.", 4.3, 4.6)], "finish"),
    ("is-what", [("Cleo,", 4.0, 4.2), ("is", 4.2, 4.3), ("what.", 4.3, 4.6)], "restart"),
    # Groq's own glued tokens and hesitation marks (commands-6)
    ("hyphen", [("Cleo-Cut.", 4.0, 4.6)], "restart"),
    ("hyphen-keep", [("Cleo-Keep.", 4.0, 4.6)], "keep"),
    ("endash", [("Cleo–cut.", 4.0, 4.6)], "restart"),
    ("comma-glued", [("Cleo,cut.", 4.0, 4.6)], "restart"),
    ("ellipsis-token", [("Cleo", 4.0, 4.25), ("...", 4.25, 4.35), ("cut.", 4.35, 4.6)], "restart"),
    ("ellipsis-u2026", [("Cleo", 4.0, 4.25), ("…", 4.25, 4.35), ("cut.", 4.35, 4.6)], "restart"),
    ("dash-token", [("Cleo", 4.0, 4.25), ("-", 4.25, 4.35), ("cut.", 4.35, 4.6)], "restart"),
    ("chloe", [("Chloe", 4.0, 4.3), ("cut.", 4.3, 4.6)], "restart"),
    ("leo", [("Leo,", 4.0, 4.3), ("cut.", 4.3, 4.6)], "restart"),
    ("cleo-apostrophe", [("Cleo's", 4.0, 4.3), ("cut.", 4.3, 4.6)], "restart"),
]
AFTER = [("Neuer", 5.5, 5.8), ("Satz.", 5.8, 6.2)]


@pytest.mark.parametrize("cid,cmd,expect", COMMANDS, ids=[c[0] for c in COMMANDS])
def test_commands_said_as_a_sentence_are_found(cid, cmd, expect):
    _cuts, events = scene(START + TAKE + cmd + AFTER)
    assert [t for (t, s, e) in events if s >= 3.9][:1] == [expect], events


def _said(*tokens, at=19.0, step=0.25, gap=0.0):
    """Touching Whisper tokens from `at` on (`gap` s before the last
    group: see _after)."""
    out, t = [], at
    for tok in tokens:
        out.append((tok, round(t, 3), round(t + step, 3)))
        t += step
    return out


def _after(sentence, phrase, gap=0.0):
    """`phrase` said right after `sentence` (touching, or `gap` s later)."""
    first = _said(*sentence)
    t = first[-1][2] + gap
    return first + _said(*phrase, at=t)


# F8 (commands-weak-own-sentence): a weak form — a mishearing of "Cleo"
# or of the command word, a German stand-in, a phonetic guess — said as a
# sentence of its own straight after a full sentence of speech is speech:
# Whisper writes a sentence, the speaker goes on. Each of these used to
# fire ("Cleo is tough." = "Cleo start": everything before it cut).
WEAK_IN_SPEECH = [
    ("cleo-is-tough", ["Das", "war", "echt", "hart."], ["Cleo", "is", "tough."]),
    ("leo-is-tough", ["Ich", "kenne", "ihn", "gut."], ["Leo", "is", "tough."]),
    ("cleo-ist-ab", ["Also", "das", "ist", "so."], ["Cleo,", "ist", "ab."]),
    ("cleo-is-auf", ["Das", "Fenster", "geht", "nicht."], ["Cleo", "is", "auf."]),
    ("clear-gut", ["Das", "Video", "ist", "fertig."], ["Clear,", "gut."]),
    ("cleo-is-what", ["So", "machen", "wir", "das."], ["Cleo", "is", "what?"]),
    ("kilo-ende", ["Wir", "sind", "am", "Ziel."], ["Kilo,", "Ende."]),
    ("chloe-check", ["Das", "hat", "gut", "geklappt."], ["Chloe,", "check."]),
    ("leo-fertig", ["Er", "ist", "jetzt", "da."], ["Leo,", "fertig!"]),
    ("clean-cut", ["That", "was", "the", "plan."], ["Clean", "cut."]),
    # a short breath Whisper left (under BREAK_GAP_S) changes nothing
    ("cleo-is-tough-0.1s", ["Das", "war", "echt", "hart."], ["Cleo", "is", "tough."], 0.1),
    # a comma is no new sentence
    ("comma-clause", ["Und", "dann,", "naja,"], ["Leo,", "gut."]),
]


@pytest.mark.parametrize("case", WEAK_IN_SPEECH, ids=[c[0] for c in WEAK_IN_SPEECH])
def test_a_weak_form_after_a_full_sentence_is_speech(case):
    _cid, sentence, phrase, *gap = case
    words = START + TAKE + _after(sentence, phrase, *gap) + TAIL
    cuts, events = scene(words, dur=40.0)
    assert [t for t, *_ in events] == ["start"], events
    assert lost(cuts, 1.8, 40.0) == 0.0, cuts


def test_a_weak_start_after_a_full_sentence_is_no_opening_start():
    # the scene commands stay off: nothing before it is thrown away
    words = TAKE + _after(["Das", "war", "echt", "hart."], ["Cleo", "is", "tough."]) + TAIL
    cuts, events = scene(words, dur=40.0)
    assert cuts == [] and events == []


def test_a_weak_stop_after_a_full_sentence_opens_no_cut():
    words = (TAKE + _after(["Wir", "warten", "auf", "ihn."], ["Leo,", "stop!"])
             + [("Er", 21.5, 21.8), ("kommt", 21.8, 22.1), ("gleich.", 22.1, 22.5),
                ("Cleo", 23.0, 23.3), ("go.", 23.3, 23.6), ("Weiter.", 24.2, 24.6)])
    pairs = stopgo(words)
    # no stop … go pair: only the lone "Cleo go." phrase goes, the speech
    # between stays
    assert [p.kind for p in pairs] == ["go"], pairs
    segs = apply_voice_triggers_to_segments([(2.0, 25.0)], pairs)
    kept = [(a, b) for a, b in segs]
    assert lost([(b, c) for (_a, b), (c, _d) in zip(kept, kept[1:])], 19.0, 22.5) == 0.0, segs
    assert not any(a < 23.15 < b for a, b in kept), segs


# Real commands keep firing, as said (the owner's are all strong: Groq
# writes "Cleo keep." straight after the sentence before, no gap).
STILL_COMMANDS = [
    # strong forms right after a full sentence, as Groq tokenises them
    ("cleo-keep", ["Das", "war", "richtig", "gut."], ["Cleo", "keep."], 0.0, "keep"),
    ("cleo-comma-cut", ["Das", "war", "nix", "jetzt."], ["Cleo,", "cut."], 0.0, "restart"),
    ("cleostart-glued", ["Ich", "fange", "neu", "an."], ["CleoStart."], 0.0, "start"),
    ("cleo-hyphen-start", ["Ich", "fange", "neu", "an."], ["Cleo-Start."], 0.0, "start"),
    ("clio-start", ["Ich", "fange", "neu", "an."], ["Clio", "Start!"], 0.0, "start"),
    ("kleo-starts", ["Ich", "fange", "neu", "an."], ["Kleo", "starts."], 0.0, "start"),
    ("cleo-ellipsis-start", ["Ich", "fange", "neu", "an."], ["Cleo", "…", "start."], 0.0, "start"),
    ("cleo-finish", ["Das", "war", "das", "Video."], ["Cleo", "finish."], 0.0, "finish"),
    # weak forms with a reason to be commands
    ("weak-after-pause", ["Das", "war", "echt", "hart."], ["Cleo", "is", "tough."], 0.5, "start"),
    ("weak-after-short", ["Okay."], ["Cleo,", "ist", "ab."], 0.0, "start"),
    ("weak-after-two-words", ["Ja,", "genau."], ["Leo,", "cut."], 0.0, "restart"),
    ("weak-after-a-command", ["Cleo", "keep."], ["Clear", "start."], 0.0, "start"),
]


@pytest.mark.parametrize("case", STILL_COMMANDS, ids=[c[0] for c in STILL_COMMANDS])
def test_commands_still_fire_after_speech(case):
    _cid, sentence, phrase, gap, want = case
    words = START + TAKE + _after(sentence, phrase, gap) + TAIL
    _cuts, events = scene(words, dur=40.0)
    assert [t for t, s, e in events if s >= 18.9][-1:] == [want], events


def test_a_weak_cleo_start_opens_the_recording():
    # said first thing (no sentence before it): the opening start
    words = [("Cleo", 0.0, 0.35), ("is", 0.35, 0.5), ("tough.", 0.5, 0.9)] + TAKE
    cuts, events = scene(words)
    assert events[0][0] == "start" and cuts == [(0.0, 0.9)]


def test_the_llm_fix_still_counts_after_speech():
    words = START + TAKE + _after(["Das", "war", "echt", "hart."], ["Cleo", "is", "tough."])
    ww = collect_whisper_words(W(*words))
    for w in ww:
        if w["start"] >= 20.0:
            w["cmd_fix"] = True
    _cuts, events = find_scene_cut_ranges(ww, clip_duration=40.0)
    assert [t for t, *_ in events] == ["start", "start"]


def test_a_strong_command_needs_no_pause_before_it():
    # Owner job (his timings): "… <word> Cleo cut." with the word before
    # unpunctuated and touching "Cleo" — still the restart he said.
    words = START + [("und", 243.9, 244.468), ("Cleo", 244.468, 245.2),
                     ("cut.", 245.2, 246.448), ("Neu.", 246.9, 247.4)]
    _cuts, events = scene(words, dur=300)
    assert [t for t, *_ in events] == ["start", "restart"]


def test_owner_like_transcript_keeps_every_command():
    # 1 start, keeps and restarts, a finish — each punctuated, mostly
    # touching the word before (the owner's 29 scene commands all have
    # this shape) — interleaved with sentences naming the product.
    words, t = [], 0.0

    def say(text, dur=0.3, gap=0.0):
        nonlocal t
        words.append((text, round(t, 3), round(t + dur, 3)))
        t += dur + gap

    for x in ("Okay,", "kurz", "das", "Setup."):
        say(x)
    say("Cleo", 0.4), say("start.", 0.5, 0.6)
    plan = ["keep", "cut", "keep", "keep", "cut", "keep", "finish"]
    for cmd in plan:
        for x in ("Ich", "finde", "Cleo", "gut,", "weil", "CleoCuts", "schneidet."):
            say(x)
        say("Cleo", 0.4), say(cmd + ".", 0.5, 0.4)
    _cuts, events = scene(words, dur=t + 5)
    assert [e[0] for e in events] == ["start"] + [
        {"cut": "restart"}.get(c, c) for c in plan]


# ── what the scene commands cut ─────────────────────────────────────

def test_cleo_start_at_time_zero_is_cut():
    # The recording starts with the command; Whisper gives the first
    # word 0.0 (commands-2).
    cuts, events = scene([("Cleo", 0.0, 0.35), ("start.", 0.35, 0.8)] + TAKE)
    assert events[0][0] == "start"
    assert cuts == [(0.0, 0.8)]


@pytest.mark.parametrize("cmd,gap", [("cut.", 0.6), ("cut.", 0.9), ("keep.", 0.4)])
def test_a_command_said_twice_cuts_both_copies(cmd, gap):
    # "…Cleo cut. Cleo cut. Heute…" (unsure the first was heard): one
    # command, but the repeat's words must not open the next take
    # (commands-3).
    second = 4.6 + gap
    words = START + TAKE + [("Cleo", 4.0, 4.3), (cmd, 4.3, 4.6),
                            ("Cleo", second, second + 0.3), (cmd, second + 0.3, second + 0.6),
                            ("Heute", second + 1.2, second + 1.5), ("geht's.", second + 1.5, second + 1.9)]
    cuts, events = scene(words)
    assert [t for t, *_ in events].count({"cut.": "restart"}.get(cmd, "keep")) == 1
    assert covered(cuts, 4.0, second + 0.6)
    assert lost(cuts, second + 1.2, second + 1.9) == 0.0
    if cmd == "keep.":
        assert lost(cuts, 2.0, 3.2) == 0.0     # the take itself stays


def test_a_repeat_whose_times_drift_is_cut_only_up_to_the_next_word():
    # A hallucinated second copy stretched over the next sentence: its
    # cut ends where the next word starts.
    words = START + TAKE + [("Cleo", 4.0, 4.3), ("keep.", 4.3, 4.6),
                            ("Cleo", 4.9, 5.2), ("keep.", 5.2, 8.0),
                            ("Heute", 5.6, 5.9), ("geht's.", 5.9, 6.3)]
    cuts, _ = scene(words)
    assert covered(cuts, 4.0, 5.6)
    assert lost(cuts, 5.6, 6.3) == 0.0


# ── stop … go (voice_triggers) ──────────────────────────────────────

def test_a_double_stop_cuts_from_the_first_one():
    # Owner job: "Cleo stop." 131.08-132.58, again 132.58-133.60,
    # "Cleo go." 143.68-144.92 (his timings; commands-3).
    words = [("eins", 129.0, 129.5), ("zwei.", 129.5, 130.6),
             ("Cleo", 131.08, 131.60), ("stop.", 131.60, 132.58),
             ("Cleo", 132.58, 132.86), ("stop.", 132.86, 133.60),
             ("weg", 135.62, 136.0), ("damit.", 136.0, 138.1),
             ("Cleo", 143.68, 143.98), ("go.", 143.98, 144.92),
             ("Weiter", 145.56, 145.84), ("geht's.", 145.84, 146.1)]
    pairs = stopgo(words)
    assert [p.kind for p in pairs] == ["pair"]
    segs = apply_voice_triggers_to_segments([(129.0, 147.0)], pairs)
    assert segs[0] == (129.0, pytest.approx(130.62))   # "zwei." kept
    assert segs[1][0] == pytest.approx(145.54)          # from "Weiter"
    assert len(segs) == 2


@pytest.mark.parametrize("cmd,kind", [("stop.", "stop"), ("go.", "go")])
def test_a_lone_stop_or_go_cuts_just_its_phrase(cmd, kind):
    # No go after the stop (or no stop before the go): the spoken
    # command must not stay in the video (commands-4).
    words = TAKE + [("Cleo", 4.0, 4.3), (cmd, 4.3, 4.6),
                    ("schlechter", 5.0, 5.5), ("Satz.", 5.5, 6.0), ("Gut.", 7.0, 7.4)]
    pairs = stopgo(words)
    assert [p.kind for p in pairs] == [kind]
    segs = apply_voice_triggers_to_segments([(2.0, 7.5)], pairs)
    # like a pair's edges: from just after "eins." to just before the
    # next word
    assert segs == [(2.0, pytest.approx(3.22)), (pytest.approx(4.98), 7.5)]


def test_a_forgotten_go_never_deletes_minutes():
    words = TAKE + [("und", 29.0, 29.4), ("so.", 29.4, 29.8),
                    ("Cleo", 30.0, 30.3), ("stop.", 30.3, 30.6),
                    ("Schlechter", 31.0, 31.5), ("Satz.", 31.5, 32.0)]
    t = 33.0
    for i in range(200):
        words.append((f"w{i}", t, t + 0.3))
        t += 1.3
    words += [("damit", 300.0, 300.3), ("Cleo", 300.3, 300.6), ("weiter", 300.6, 300.9),
              ("lernt.", 300.9, 301.3)]
    pairs = stopgo(words)
    assert [p.kind for p in pairs] == ["stop"]
    assert pairs[0].continue_end - pairs[0].cut_start < 1.5


def test_a_go_long_after_the_stop_must_be_a_clear_go():
    # 25 s after the stop: "Clio, los" (weak) does not close the pair;
    # a clear "Cleo go." does (the rule for pairs over LONG_PAIR_S).
    base = TAKE + [("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6), ("schlecht.", 5.0, 5.5)]
    weak = base + [("Clio,", 29.0, 29.3), ("los.", 29.3, 29.6), ("Gut.", 30.0, 30.4)]
    assert [p.kind for p in stopgo(weak)] == ["stop", "go"]
    clear = base + [("Cleo,", 29.0, 29.3), ("go.", 29.3, 29.6), ("Gut.", 30.0, 30.4)]
    pairs = stopgo(clear)
    assert [p.kind for p in pairs] == ["pair"]
    assert pairs[0].continue_end == pytest.approx(29.98)


def test_a_scene_command_ends_an_open_stop():
    words = TAKE + [("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6), ("schlecht.", 5.0, 5.5),
                    ("Cleo", 6.0, 6.3), ("cut.", 6.3, 6.6), ("Neu.", 7.0, 7.4),
                    ("Cleo", 8.0, 8.3), ("go.", 8.3, 8.6), ("Gut.", 9.0, 9.4)]
    assert [p.kind for p in stopgo(words)] == ["stop", "go"]


STOPGO_TOKENS = [
    ("plain", [("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6)], [("Cleo", 6.5, 6.8), ("go.", 6.8, 7.1)]),
    ("stopp-weiter", [("Kleo", 4.0, 4.3), ("Stopp!", 4.3, 4.6)], [("Kleo", 6.5, 6.8), ("weiter.", 6.8, 7.1)]),
    ("hyphen-stop", [("Cleo-Stop.", 4.0, 4.6)], [("Cleo", 6.5, 6.8), ("go.", 6.8, 7.1)]),
    ("stob", [("Cleo", 4.0, 4.3), ("Stob.", 4.3, 4.6)], [("Cleo", 6.5, 6.8), ("go.", 6.8, 7.1)]),
    ("stoppt", [("Cleo", 4.0, 4.3), ("stoppt.", 4.3, 4.6)], [("Cleo", 6.5, 6.8), ("go.", 6.8, 7.1)]),
    ("goo", [("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6)], [("Cleo", 6.5, 6.8), ("Goo.", 6.8, 7.1)]),
    ("geh", [("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6)], [("Cleo", 6.5, 6.8), ("geh.", 6.8, 7.1)]),
    ("ellipsis-tok", [("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6)], [("Cleo", 6.5, 6.75), ("…", 6.75, 6.85), ("go.", 6.85, 7.1)]),
]


@pytest.mark.parametrize("cid,stop,go", STOPGO_TOKENS, ids=[c[0] for c in STOPGO_TOKENS])
def test_stop_go_tokenisations(cid, stop, go):
    words = TAKE + stop + [("schlecht", 5.0, 5.4), ("gesagt.", 5.4, 5.8)] + go + [("Gut.", 7.6, 8.0)]
    pairs = stopgo(words)
    assert [p.kind for p in pairs] == ["pair"], pairs
    assert pairs[0].cut_start < 4.0 and pairs[0].continue_end > 7.1


def test_silence_snap_never_swallows_a_word():
    # (a) "Cleo go," + 80 ms + "yes" + pause: the silence after "yes"
    # must not become the end of the cut; (b) a silence ending shortly
    # before "Cleo" with "so," in between must not become its start
    # (wordcuts-2; real pipeline rec1 fast: "yes" was cut entirely).
    words = [("I", 9.0, 9.3), ("really", 9.3, 9.8), ("so,", 10.75, 10.95),
             ("Cleo", 11.0, 11.3), ("stop.", 11.3, 11.6), ("wrong.", 12.0, 12.5),
             ("Cleo", 25.14, 25.58), ("go,", 25.58, 25.86), ("yes.", 25.94, 26.32),
             ("Soft", 27.24, 27.68), ("light.", 27.68, 28.08)]
    silences = [(9.9, 10.7), (26.35, 27.2)]
    pairs = stopgo(words, silence=silences)
    assert len(pairs) == 1
    # "so," kept (Whisper's edge, 100 ms before "Cleo"; the analysis
    # then snaps it to the audio) and "yes." kept
    assert pairs[0].cut_start == pytest.approx(10.9)
    assert pairs[0].continue_end == pytest.approx(25.92)
    # with nothing in between the silence still gives the tight edge
    words2 = [w for w in words if w[0] not in ("so,", "yes.")]
    p2 = stopgo(words2, silence=silences)[0]
    assert p2.cut_start == pytest.approx(9.92)
    assert p2.continue_end == pytest.approx(27.18)


# ── the LLM command fix (commands-7) ────────────────────────────────

class _Resp:
    def __init__(self, text):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.usage = None


def _fake_client(corrections):
    class Messages:
        def create(self, **kw):
            return _Resp(json.dumps({"corrections": corrections}))
    return types.SimpleNamespace(messages=Messages())


@pytest.mark.parametrize("tokens,corr,expect", [
    # one merged token → two words: crammed into one slot ("cleo keep")
    ([("CleoKip.", 4.0, 4.6)], {"start_index": 7, "end_index": 7, "corrected_to": "cleo keep"}, "keep"),
    ([("Kleokat.", 4.0, 4.6)], {"start_index": 7, "end_index": 7, "corrected_to": "cleo cut"}, "restart"),
    ([("CleoKey.", 4.0, 4.6)], {"start_index": 7, "end_index": 7, "corrected_to": "Cleo keep"}, "keep"),
    # three tokens → two (the rest blanked); no punctuation, the LLM's
    # word is taken as said
    ([("Clio", 4.0, 4.2), ("is", 4.2, 4.3), ("what", 4.3, 4.6)], {"start_index": 7, "end_index": 9, "corrected_to": "cleo cut"}, "restart"),
], ids=["kip-cram", "kat-cram", "cleokey-cram", "three-to-two"])
def test_the_llm_command_fix_is_read_back(monkeypatch, tokens, corr, expect):
    from backend import llm
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setattr(llm, "_client", lambda: _fake_client([corr]))
    monkeypatch.setattr(llm.costs, "record_claude", lambda *a, **k: None)
    tr = W(*(START + TAKE + tokens + [("weiter", 4.6, 5.0), ("geht's.", 5.0, 5.4)]))
    llm.correct_voice_commands(tr, language="de")
    _cuts, events = find_scene_cut_ranges(collect_whisper_words(tr), clip_duration=10)
    assert [t for (t, s, e) in events if s >= 3.9][:1] == [expect]


# ── /recompute-scenes (its own command words) ───────────────────────

def test_recompute_scenes_still_cuts_and_bumps_the_timeline(client, monkeypatch):
    import backend.main as M
    from backend.jobs import store
    job = store.create("/in.mp4", {})
    store.update(job.id, status="awaiting_review", duration=30.0,
                 segments=[(0.0, 30.0)], mezz_key=f"jobs/{job.id}/mezz.mp4")
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    events = [{"type": "start", "start": 2.0, "end": 2.6},
              {"type": "keep", "start": 10.0, "end": 10.6}]
    r = client.post(f"/jobs/{job.id}/recompute-scenes", json={"events": events})
    assert r.status_code == 200, r.text
    got = store.get(job.id)
    assert [list(s) for s in got.segments] == [[2.6, 10.0], [10.6, 30.0]]
    assert got.edit_rev > 0


def _recompute_job(words, **fields):
    from backend.jobs import store
    job = store.create("/in.mp4", {})
    doc = {"v": 2, "words": [{"id": f"w{k:04d}", "text": t, "start": s, "end": e}
                             for k, (t, s, e) in enumerate(words, 1)]}
    store.update(job.id, status="awaiting_review", duration=30.0,
                 segments=[(0.0, 30.0)], mezz_key=f"jobs/{job.id}/mezz.mp4",
                 doc=doc, **fields)
    return job


# Whisper's words around two commands: touching, drifted against the
# events' own times ("Cleo start." said 2.0-2.6, but "Hallo" from 2.55).
RECOMPUTE_WORDS = [("Setup.", 0.4, 1.6), ("Cleo", 2.0, 2.3), ("start.", 2.3, 2.55),
                   ("Hallo", 2.55, 3.0), ("Leute", 3.0, 3.4), ("und", 9.2, 9.6),
                   ("weiter.", 9.6, 10.08), ("Cleo", 10.08, 10.35), ("keep.", 10.35, 10.55),
                   ("Nächster", 10.7, 11.2), ("Satz.", 11.2, 11.6)]
RECOMPUTE_EVENTS = [{"type": "start", "start": 2.0, "end": 2.6},
                    {"type": "keep", "start": 10.0, "end": 10.6}]


def test_recomputed_cuts_snap_to_the_word_gaps_without_audio(client, monkeypatch):
    """recompute-scenes-no-snap: the cuts come from the events' times; the
    edges go to the word boundaries / gaps (src/edge_snap.py on the
    words' times), so no kept word loses its start and no cut word keeps
    a tail."""
    import backend.main as M
    from backend.jobs import store
    job = _recompute_job(RECOMPUTE_WORDS)
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    r = client.post(f"/jobs/{job.id}/recompute-scenes", json={"events": RECOMPUTE_EVENTS})
    assert r.status_code == 200, r.text
    segs = [tuple(s) for s in store.get(job.id).segments]
    (a0, b0), (a1, b1) = segs
    # "Hallo" (from 2.55) keeps its start: the cut ends at the boundary,
    # not at the event's 2.6
    assert 2.54 <= a0 <= 2.56, segs
    # the keep phrase "Cleo keep." (10.08-10.55) goes whole, "weiter."
    # (to 10.08) stays whole, "Nächster" (from 10.7) too
    assert 10.07 <= b0 <= 10.09, segs
    assert 10.55 <= a1 <= 10.70, segs
    assert b1 == 30.0
    # never inside a word
    for w, s, e in RECOMPUTE_WORDS:
        for edge in (a0, b0, a1):
            assert not (s + 0.011 < edge < e - 0.011), (w, edge)


def test_recomputed_cuts_use_the_stored_peaks(client, monkeypatch, tmp_path):
    """With the job's peaks envelope the edge goes to the real pause: here
    a quiet dip at 2.7 s that Whisper's times don't show."""
    import backend.main as M
    from backend import media
    from backend.jobs import store
    words = [("Cleo", 2.0, 2.3), ("start.", 2.3, 2.85), ("Hallo", 2.85, 3.3)]
    peaks = bytearray([100] * 3100)
    for i in range(268, 274):           # 2.68-2.74 s: the pause
        peaks[i] = 5
    job = _recompute_job(words)
    path = tmp_path / "peaks.bin"
    path.write_bytes(bytes(peaks))
    key = f"{media.job_prefix(job.id)}peaks.bin"
    media.put_file(path, key, content_type="application/octet-stream",
                   store=media.backend())
    store.update(job.id, peaks_key=key, media_store=media.backend())
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    events = [{"type": "start", "start": 2.0, "end": 2.6}]
    r = client.post(f"/jobs/{job.id}/recompute-scenes", json={"events": events})
    assert r.status_code == 200, r.text
    (a0, _b0), = [tuple(s) for s in store.get(job.id).segments]
    assert 2.68 <= a0 <= 2.74, a0
