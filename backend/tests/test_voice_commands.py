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

from src.scene_triggers import find_scene_cut_ranges, plan_scene_cuts
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


def test_a_phonetic_start_never_throws_away_what_came_before():
    # "Kleeo, Stard." is only a phonetic guess at "Cleo start": it must
    # not cut everything before it (commands-5 (4)); only its phrase goes.
    words = TAKE + [("Satz.", 19.0, 19.5), ("Kleeo,", 20.2, 20.5), ("Stard.", 20.6, 20.9),
                    ("Video.", 21.5, 22.0)]
    cuts, events = scene(words, dur=30)
    assert [t for t, *_ in events] == ["start"]
    assert cuts == [(20.2, 20.9)]


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


@pytest.mark.parametrize("opening", ["start", "no-start"])
@pytest.mark.parametrize("cmd,gap", [("cut.", 0.6), ("cut.", 0.9), ("keep.", 0.4)])
def test_a_command_said_twice_cuts_both_copies(cmd, gap, opening):
    # "…Cleo cut. Cleo cut. Heute…" (unsure the first was heard): one
    # command, but the repeat's words must not open the next take
    # (commands-3) — with or without a "Cleo start" before.
    second = 4.6 + gap
    words = (START if opening == "start" else []) + TAKE + [("Cleo", 4.0, 4.3), (cmd, 4.3, 4.6),
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


# ── without "Cleo start" (owner decision: it is optional) ───────────
# A take begins right after the command before it (start, cut, keep,
# finish; before a clear start also the go of a stop … go pair), or at
# the start of the video; a said "Cleo start" still marks it. Until a
# clear (strong, non-phonetic) "Cleo start" a command that would remove
# more than IMPLICIT_CUT_MAX_S is only suggested (its phrase is cut), and
# a phonetic guess cuts its phrase only (a guess at "cut": a suggestion);
# from a clear start on, every command acts as before (owner O1).

def plan(items, dur=60.0, **kw):
    return plan_scene_cuts(collect_whisper_words(W(*items)), clip_duration=dur, **kw)


def cmd(word, at):
    """'Cleo <word>' said at `at` (0.6 s, punctuated: a command)."""
    return [("Cleo", at, round(at + 0.3, 3)), (word, round(at + 0.3, 3), round(at + 0.6, 3))]


def talk(a, b):
    """Speech from a to b: a word every 0.5 s, a sentence every 4."""
    out, t, k = [], a, 0
    while t + 0.4 <= b:
        k += 1
        out.append(("Satz." if k % 4 == 0 else "Wort", round(t, 3), round(t + 0.4, 3)))
        t += 0.5
    return out


NEXT = [("Neuer", 0.0, 0.3), ("Satz.", 0.3, 0.7)]


def after(at):
    """Two words from `at` on (kept unless something cuts them)."""
    return [(w, round(at + s, 3), round(at + e, 3)) for w, s, e in NEXT]


def test_without_start_a_cut_throws_away_the_take_from_the_beginning():
    p = plan(TAKE + cmd("cut.", 4.0) + after(5.5))
    assert p.cuts == [(0.0, 4.6)] and p.suggestions == []
    assert [t for t, *_ in p.events] == ["restart"]


def test_without_start_a_keep_cuts_only_its_phrase():
    p = plan(TAKE + cmd("keep.", 4.0) + after(5.5))
    assert p.cuts == [(4.0, 4.6)] and p.suggestions == []
    assert lost(p.cuts, 2.0, 3.2) == 0.0 and lost(p.cuts, 5.5, 6.2) == 0.0


def test_without_start_finish_cuts_the_rest():
    p = plan(TAKE + cmd("finish.", 4.0) + after(5.5), dur=10.0)
    assert p.cuts == [(4.0, 10.0)] and p.suggestions == []
    assert lost(p.cuts, 0.0, 4.0) == 0.0


@pytest.mark.parametrize("before", ["keep.", "cut.", "start."])
def test_the_take_starts_right_after_the_command_before(before):
    # a take, a command, a second take, "Cleo cut": only the second take
    # goes (from the first command's end)
    words = TAKE + cmd(before, 4.0) + talk(5.5, 8.0) + cmd("cut.", 9.0) + after(10.5)
    p = plan(words)
    assert covered(p.cuts, 4.6, 9.6) and p.suggestions == []
    assert lost(p.cuts, 10.5, 11.2) == 0.0
    if before == "keep.":
        assert lost(p.cuts, 2.0, 3.2) == 0.0    # the first take stays


def test_an_explicit_start_still_marks_the_take():
    # a keep, chatter, "Cleo start", a take, "Cleo cut": the chatter goes
    # with the start, the cut takes the take from the start on — the
    # take before the keep stays
    words = (TAKE + cmd("keep.", 4.0) + [("Kurz", 5.0, 5.4), ("Pause.", 5.4, 6.0)]
             + cmd("start.", 7.0) + talk(8.0, 9.5) + cmd("cut.", 10.0) + after(11.5))
    p = plan(words)
    assert p.cuts == [(4.0, 4.6), (4.6, 7.6), (7.6, 10.6)] and p.suggestions == []
    assert lost(p.cuts, 2.0, 3.2) == 0.0 and lost(p.cuts, 11.5, 12.2) == 0.0


@pytest.mark.parametrize("length,suggested", [(30.0, False), (59.5, False), (60.0, False),
                                              (60.6, True), (150.0, True)])
def test_a_long_cut_without_start_is_only_a_suggestion(length, suggested):
    # "Cleo cut." ending `length` s into the video, no command before it
    at = length - 0.6
    words = talk(0.5, at - 0.5) + cmd("cut.", at) + after(length + 1.0)
    p = plan(words, dur=length + 10)
    if suggested:
        # the spoken command goes, the take stays: offered in the editor
        assert p.cuts == [(at, length)]
        assert p.suggestions == [(0.0, length)]
        assert lost(p.cuts, 0.5, at - 0.5) == 0.0
    else:
        assert p.cuts == [(0.0, length)] and p.suggestions == []
    assert lost(p.cuts, length + 1.0, length + 1.7) == 0.0


def test_a_long_cut_after_a_keep_is_a_suggestion_from_the_keep():
    words = TAKE + cmd("keep.", 4.0) + talk(5.0, 75.0) + cmd("cut.", 76.0) + after(77.5)
    p = plan(words, dur=90)
    assert p.cuts == [(4.0, 4.6), (76.0, 76.6)]
    assert p.suggestions == [(4.6, 76.6)]


def test_after_a_said_start_every_long_take_is_cut_as_before():
    # owner O1: once "Cleo start" was said the rest of the video is a
    # started session — the take after a keep, and the one after a cut,
    # go whatever their length
    words = (START + talk(2.0, 75.0) + cmd("cut.", 76.0) + talk(77.5, 150.0)
             + cmd("cut.", 151.0) + after(152.5) + cmd("keep.", 154.0)
             + talk(155.0, 230.0) + cmd("cut.", 231.0) + after(232.5))
    p = plan(words, dur=240)
    assert p.suggestions == []
    assert p.cuts == [(0.0, 1.7), (1.7, 76.6), (76.6, 151.6), (154.0, 154.6), (154.6, 231.6)]
    assert lost(p.cuts, 152.5, 153.2) == 0.0 and lost(p.cuts, 232.5, 233.2) == 0.0


def test_no_limit_cuts_every_take():
    words = talk(0.5, 70.0) + cmd("cut.", 71.0) + after(72.5)
    p = plan(words, dur=80, implicit_cut_max_s=float("inf"))
    assert p.cuts == [(0.0, 71.6)] and p.suggestions == []
    # find_scene_cut_ranges: the plan's cuts (a suggestion isn't one)
    cuts, _events = scene(words, dur=80)
    assert cuts == [(71.0, 71.6)]


@pytest.mark.parametrize("cid,words", NOT_COMMANDS, ids=[c[0] for c in NOT_COMMANDS])
def test_everyday_speech_is_no_command_without_start(cid, words):
    p = plan(TAKE + words + TAIL, dur=40.0)
    assert p.events == [] and p.cuts == [] and p.suggestions == []


@pytest.mark.parametrize("case", WEAK_IN_SPEECH, ids=[c[0] for c in WEAK_IN_SPEECH])
def test_a_weak_form_after_a_full_sentence_is_speech_without_start(case):
    _cid, sentence, phrase, *gap = case
    p = plan(TAKE + _after(sentence, phrase, *gap) + TAIL, dur=40.0)
    assert p.events == [] and p.cuts == [] and p.suggestions == []


def test_commands_without_start_still_bound_stop_go():
    # "Cleo stop … Cleo cut … Cleo go": the scene command ends the open
    # stop (only its phrase goes) — and now cuts its take itself
    words = TAKE + cmd("stop.", 4.0) + [("schlecht.", 5.0, 5.5)] + cmd("cut.", 6.0) \
        + [("Neu.", 7.0, 7.4)] + cmd("go.", 8.0) + [("Gut.", 9.0, 9.4)]
    assert [p.kind for p in stopgo(words)] == ["stop", "go"]
    p = plan(words)
    assert p.cuts == [(0.0, 6.6)]
    assert lost(p.cuts, 7.0, 9.4) == 0.0


def test_a_finish_long_before_the_end_without_start_is_a_suggestion():
    # "Okay. Leo, fertig?" a minute into a 10-minute video, no start: it
    # used to delete the nine minutes after it
    for phrase in (("Leo,", "fertig?"), ("Cleo,", "finish.")):
        words = talk(0.5, 59.4) + [(phrase[0], 60.0, 60.3), (phrase[1], 60.3, 60.6)] + talk(61.0, 590.0)
        p = plan(words, dur=600.0)
        assert [t for t, *_ in p.events] == ["finish"]
        assert p.cuts == [(60.0, 60.6)]
        assert p.suggestions == [(60.0, 600.0)]


@pytest.mark.parametrize("left,suggested", [(30.0, False), (60.0, False), (60.5, True)])
def test_a_finish_without_start_removes_at_most_a_minute(left, suggested):
    at = 200.0
    words = talk(0.5, at - 0.6) + cmd("finish.", at) + talk(at + 1.0, at + left - 0.5)
    p = plan(words, dur=at + left)
    if suggested:
        assert p.cuts == [(at, at + 0.6)] and p.suggestions == [(at, at + left)]
    else:
        assert p.cuts == [(at, at + left)] and p.suggestions == []


def test_after_a_suggested_finish_the_commands_go_on():
    # the early "finish" was not applied: a cut and the real finish near
    # the end still act (the take of the cut began at the early finish)
    words = (talk(0.5, 59.4) + cmd("finish.", 60.0) + talk(61.0, 99.4) + cmd("cut.", 100.0)
             + talk(101.0, 559.4) + cmd("finish.", 560.0) + talk(561.0, 590.0))
    p = plan(words, dur=600.0)
    assert p.cuts == [(60.0, 60.6), (60.6, 100.6), (560.0, 600.0)]
    assert p.suggestions == [(60.0, 600.0)]


def test_a_finish_after_a_said_start_ends_the_video_whatever_is_left():
    words = START + talk(2.0, 59.4) + cmd("finish.", 60.0) + talk(61.0, 590.0)
    p = plan(words, dur=600.0)
    assert p.cuts == [(0.0, 1.7), (60.0, 600.0)] and p.suggestions == []


PHONETIC = {"keep": ("Kleeo,", "Kip."), "start": ("Kleeo,", "Stard."),
            "finish": ("Kleeo,", "Finisch."), "restart": ("Kleeo,", "Kat.")}


def guess(kind, at):
    """A phonetic guess at "Cleo <kind>" said at `at` (0.6 s)."""
    a, b = PHONETIC[kind]
    return [(a, at, round(at + 0.3, 3)), (b, round(at + 0.3, 3), round(at + 0.6, 3))]


@pytest.mark.parametrize("kind", ["keep", "start", "finish"])
def test_a_guess_before_the_first_start_shields_nothing(kind):
    # review R2: a guess at 20 s, warm-up, the real "Cleo start" at 40 s —
    # the start drops everything before it, as before (only the guess's
    # phrase is cut on its own)
    words = talk(0.5, 19.4) + guess(kind, 20.0) + talk(21.0, 39.4) + cmd("start.", 40.0) + talk(41.0, 120.0)
    p = plan(words, dur=130.0)
    assert [t for t, *_ in p.events] == [kind, "start"]
    assert p.cuts == [(20.0, 20.6), (0.0, 40.6)] and p.suggestions == []
    assert lost(p.cuts, 41.0, 130.0) == 0.0


@pytest.mark.parametrize("kind", ["keep", "start", "finish"])
def test_a_guess_without_start_cuts_only_its_phrase_and_anchors_nothing(kind):
    # …nor before a real "Cleo cut": its take reaches back past the guess
    words = talk(0.5, 19.4) + guess(kind, 20.0) + talk(21.0, 39.4) + cmd("cut.", 40.0) + after(41.5)
    p = plan(words, dur=130.0)
    assert p.cuts == [(20.0, 20.6), (0.0, 40.6)] and p.suggestions == []
    assert lost(p.cuts, 41.5, 42.2) == 0.0


def test_a_guess_at_cut_without_start_is_a_suggestion_whatever_its_length():
    # review R4: "Kleeo, Kat." 50 s in — under the limit, but only a guess
    words = talk(0.5, 49.4) + guess("restart", 50.0) + talk(51.0, 590.0)
    p = plan(words, dur=600.0)
    assert p.cuts == [(50.0, 50.6)] and p.suggestions == [(0.0, 50.6)]
    # a real cut from the same anchor later: offered as the longer one…
    words = talk(0.5, 19.4) + guess("restart", 20.0) + talk(21.0, 99.4) + cmd("cut.", 100.0) + after(101.5)
    p = plan(words, dur=200.0)
    assert p.cuts == [(20.0, 20.6), (100.0, 100.6)] and p.suggestions == [(0.0, 100.6)]
    # …or, within the limit, cut — the guess's suggestion is gone with it
    words = talk(0.5, 19.4) + guess("restart", 20.0) + talk(21.0, 49.4) + cmd("cut.", 50.0) + after(51.5)
    p = plan(words, dur=200.0)
    assert p.cuts == [(20.0, 20.6), (0.0, 50.6)] and p.suggestions == []


def test_a_guess_opens_no_session():
    # a guess at "start" is no said start: the long take after it stays
    # a suggestion (the limit stays on)
    words = talk(0.5, 19.4) + guess("start", 20.0) + talk(21.0, 119.4) + cmd("cut.", 120.0) + after(121.5)
    p = plan(words, dur=200.0)
    assert p.cuts == [(20.0, 20.6), (120.0, 120.6)] and p.suggestions == [(0.0, 120.6)]


def test_a_guess_at_start_after_a_said_start_cuts_its_take_as_before():
    # in a started session a guess acts as before the start became
    # optional: the take since the keep goes and the guess is an anchor;
    # the 100 s take after it is cut on its own (the session, owner O1)
    words = (START + talk(2.0, 49.4) + cmd("keep.", 50.0) + talk(51.0, 99.4) + guess("start", 100.0)
             + talk(101.0, 199.4) + cmd("cut.", 200.0) + after(201.5))
    p = plan(words, dur=210.0)
    assert [t for t, *_ in p.events] == ["start", "keep", "start", "restart"]
    assert p.cuts == [(0.0, 1.7), (50.0, 50.6), (50.6, 100.6), (100.6, 200.6)]
    assert p.suggestions == []
    assert lost(p.cuts, 2.0, 49.4) == 0.0


def weak_start(at):
    """"Leo, ist ab." (a misheard "Cleo start": weak) after a pause."""
    return [("Leo,", at, round(at + 0.3, 3)), ("ist", round(at + 0.3, 3), round(at + 0.5, 3)),
            ("ab.", round(at + 0.5, 3), round(at + 0.8, 3))]


def test_a_misheard_start_is_no_said_start():
    # review R3: it still starts a take (what came before it, under a
    # minute, goes) but the limit stays on for the takes after it
    words = talk(0.5, 9.4) + weak_start(10.0) + talk(11.5, 299.4) + cmd("cut.", 300.0) + after(301.5)
    p = plan(words, dur=400.0)
    assert [t for t, *_ in p.events] == ["start", "restart"]
    assert p.cuts == [(0.0, 10.8), (300.0, 300.6)]
    assert p.suggestions == [(10.8, 300.6)]
    # and dropping more than a minute before it is only suggested
    words = talk(0.5, 199.4) + weak_start(200.0) + talk(201.5, 300.0)
    p = plan(words, dur=400.0)
    assert p.cuts == [(200.0, 200.8)] and p.suggestions == [(0.0, 200.8)]


def test_a_go_starts_a_take_before_the_first_start():
    # owner O3: "Cleo stop … Cleo go", the take, "Cleo cut": the cut
    # reaches back to the go, not past the pair to the start of the video
    words = (talk(0.5, 9.4) + cmd("stop.", 10.0) + talk(11.0, 14.4) + cmd("go.", 15.0)
             + talk(16.0, 30.4) + cmd("cut.", 31.0) + after(32.5))
    (pair,) = stopgo(words)
    assert pair.kind == "pair" and not pair.guessed_go
    p = plan(words)
    assert p.cuts == [(pair.continue_end, 31.6)] and p.suggestions == []
    assert lost(p.cuts, 0.5, 9.4) == 0.0 and covered(p.cuts, 16.0, 31.6)
    # the 60 s count starts at the go too: a long take before the pair
    # doesn't make the cut a suggestion
    words = talk(0.5, 79.4) + cmd("stop.", 80.0) + talk(81.0, 84.4) + cmd("go.", 85.0) \
        + talk(86.0, 100.4) + cmd("cut.", 101.0) + after(102.5)
    p = plan(words, dur=120.0)
    assert p.suggestions == [] and covered(p.cuts, 86.0, 101.6) and lost(p.cuts, 0.5, 79.4) == 0.0


def test_a_go_guess_and_a_started_session_set_no_anchor():
    # a pair closed by a phonetic guess at the go ("Cleo Goo."): no anchor
    words = (talk(0.5, 9.4) + cmd("stop.", 10.0) + talk(11.0, 14.4) + [("Cleo", 15.0, 15.3), ("Goo.", 15.3, 15.6)]
             + talk(16.0, 30.4) + cmd("cut.", 31.0) + after(32.5))
    (pair,) = stopgo(words)
    assert pair.kind == "pair" and pair.guessed_go
    assert plan(words).cuts == [(0.0, 31.6)]
    # in a started session the cut reaches back to the keep, as before
    # (the owner's job: a stop … go between a keep and a cut)
    words = (START + talk(2.0, 19.4) + cmd("keep.", 20.0) + talk(21.0, 29.4) + cmd("stop.", 30.0)
             + talk(31.0, 34.4) + cmd("go.", 35.0) + talk(36.0, 49.4) + cmd("cut.", 50.0) + after(51.5))
    assert plan(words).cuts == [(0.0, 1.7), (20.0, 20.6), (20.6, 50.6)]


def _as_before(events, dur):
    """The scene cuts before "Cleo start" became optional (4aaef52^),
    from the commands found: nothing without a start; from the first
    one, start / cut its take, keep its phrase, finish the rest."""
    first = next((k for k, (t, *_r) in enumerate(events) if t == "start"), None)
    if first is None:
        return []
    cuts, anchor = [(0.0, events[first][2])], events[first][2]
    for t, s, e in events[first + 1:]:
        if t in ("start", "restart"):
            cuts.append((anchor, e))
        elif t == "keep":
            cuts.append((s, e))
        else:
            cuts.append((s, dur))
            break
        anchor = e
    return cuts


def test_with_an_opening_start_the_owners_commands_cut_as_before():
    # The owner's 29 scene commands at his timings (strong, punctuated,
    # touching the word before; speech between them), and his two
    # "Cleo stop … go" pairs: with his opening "Cleo start" every cut is
    # what it was before the start became optional, and nothing is
    # suggested.
    owner = [("start", 6.14, 9.06), ("keep", 22.66, 23.24), ("restart", 46.04, 47.0),
             ("restart", 49.96, 53.08), ("keep", 58.92, 59.92), ("keep", 76.876, 79.616),
             ("keep", 110.616, 113.436), ("stop", 131.08, 132.58), ("go", 143.68, 144.92),
             ("restart", 148.296, 150.776), ("keep", 152.532, 155.732),
             ("keep", 176.092, 177.052), ("keep", 192.672, 193.972), ("keep", 206.892, 210.012),
             ("keep", 225.828, 229.928), ("restart", 244.468, 246.448),
             ("restart", 256.988, 257.988), ("keep", 275.328, 277.768), ("keep", 293.208, 294.248),
             ("restart", 302.58, 305.06), ("keep", 329.38, 330.34), ("keep", 350.56, 352.88),
             ("keep", 402.516, 403.536), ("keep", 427.176, 429.056), ("keep", 450.416, 450.976),
             ("restart", 456.252, 457.192), ("keep", 497.772, 499.292), ("stop", 524.6, 525.4),
             ("go", 537.0, 537.6), ("keep", 551.028, 552.468), ("keep", 567.128, 568.108),
             ("restart", 571.368, 573.168), ("finish", 602.14, 604.28)]
    word = {"start": "start.", "restart": "cut.", "keep": "keep.", "finish": "finish.",
            "stop": "stop.", "go": "go."}
    words, t = [], 0.4
    for kind, s, e in owner:
        words += [w for w in talk(t, s - 0.1)]
        mid = round((s + e) / 2, 3)
        words += [("Cleo", s, mid), (word[kind], mid, e)]
        t = e + 0.5
    words += talk(t, 609.0)
    dur = 610.63
    p = plan(words, dur=dur)
    scene_cmds = [(k, s, e) for k, s, e in owner if k not in ("stop", "go")]
    assert [(k, round(s, 3), round(e, 3)) for k, s, e in p.events] == scene_cmds
    assert [k for k in (pp.kind for pp in stopgo(words))] == ["pair", "pair"]
    assert p.cuts == _as_before(p.events, dur)
    assert p.suggestions == []


# ── the suggestion through the analysis to the editor ───────────────

def test_cut_suggestions_of_the_analysis():
    from backend import pipeline
    items = [{"start": -0.2, "end": 70.0}, {"start": 80.0, "end": 150.0},
             {"start": 160.0, "end": 260.0}, {"start": 5, "end": 5}, {"start": "x"}]
    segs = [(0.0, 75.0), (80.0, 80.05), (155.0, 200.0)]
    # the second is left out by the timeline already (all but 50 ms),
    # the third ends at the video's end, broken ones are dropped
    assert pipeline.cut_suggestions_of(items, segs, 200.0) == [
        {"id": 0, "start": 0.0, "end": 70.0, "kind": "voice_cmd"},
        {"id": 1, "start": 160.0, "end": 200.0, "kind": "voice_cmd"}]
    assert pipeline.cut_suggestions_of(None, segs, 200.0) == []


def test_analyze_only_hands_the_suggestion_to_the_job(tmp_path, monkeypatch):
    from backend import pipeline
    from test_analysis_doc import _clip

    def analyze_video(video_path, **kw):
        return types.SimpleNamespace(
            segments=[(0.2, 5.6)], subtitles=[], duration=6.0, language="de",
            scene_events=[{"type": "restart", "start": 5.0, "end": 5.6}],
            cut_suggestions=[{"start": 0.0, "end": 5.6}], words=[], fillers=[])
    monkeypatch.setattr(pipeline, "analyze_video", analyze_video)
    import backend.llm as llm
    monkeypatch.setattr(llm, "cleanup_transcript", lambda subs, language=None: {})
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4", 6.0)), str(tmp_path / "job"), {})
    assert res["cut_suggestions"] == [{"id": 0, "start": 0.0, "end": 5.6, "kind": "voice_cmd"}]
    assert pipeline.analysis_fields(res)["cut_suggestions"] == res["cut_suggestions"]
    # the segments stay as the analysis made them: a suggestion is not cut
    assert [tuple(s) for s in res["segments"]] == [(0.2, 5.6)]


def test_the_job_serves_its_suggestions(client):
    from backend.jobs import store
    job = store.create("/in.mp4", {})
    sugg = [{"id": 0, "start": 0.0, "end": 70.0, "kind": "voice_cmd"}]
    store.update(job.id, status="awaiting_review", duration=80.0,
                 segments=[(0.0, 80.0)], cut_suggestions=sugg)
    assert store.get(job.id).cut_suggestions == sugg
    assert client.get(f"/jobs/{job.id}").json()["cut_suggestions"] == sugg
    # a job from before: none
    old = store.create("/in.mp4", {})
    assert client.get(f"/jobs/{old.id}").json()["cut_suggestions"] == []


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


def test_recompute_scenes_cuts_a_long_take_without_start_and_drops_the_suggestions(client, monkeypatch):
    """The user's own list has no 60 s limit (backend/main.py
    _save_recomputed_scenes): a "Cleo cut" 100 s into the video with no
    "Cleo start" cuts its take; the analysis' suggestions (its reading of
    the commands this list replaces) are gone."""
    import backend.main as M
    from backend.jobs import store
    job = store.create("/in.mp4", {})
    store.update(job.id, status="awaiting_review", duration=120.0,
                 segments=[(0.0, 120.0)], mezz_key=f"jobs/{job.id}/mezz.mp4",
                 cut_suggestions=[{"id": 0, "start": 0.0, "end": 100.6, "kind": "voice_cmd"}])
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    events = [{"type": "restart", "start": 100.0, "end": 100.6}]
    r = client.post(f"/jobs/{job.id}/recompute-scenes", json={"events": events})
    assert r.status_code == 200, r.text
    got = store.get(job.id)
    assert [list(s) for s in got.segments] == [[100.6, 120.0]]
    assert got.cut_suggestions == []
    assert client.get(f"/jobs/{job.id}").json()["cut_suggestions"] == []


def test_recompute_scenes_starts_a_take_after_a_stop_go_pair(client, monkeypatch):
    """Before a "Cleo start" the go of a "Cleo stop … go" pair in the
    job's words starts a take, as in the analysis: the recomputed cut
    reaches back to it, not to the start of the video."""
    import backend.main as M
    from backend.jobs import store
    words = ([("Hallo", 0.5, 0.9), ("Leute.", 0.9, 1.4), ("Cleo", 4.0, 4.3), ("stop.", 4.3, 4.6),
              ("schlecht.", 5.0, 5.5), ("Cleo", 8.0, 8.3), ("go.", 8.3, 8.6), ("Neuer", 9.0, 9.4),
              ("Versuch.", 9.4, 9.9), ("Cleo", 12.0, 12.3), ("cut.", 12.3, 12.6), ("Gut.", 13.0, 13.4)])
    job = _recompute_job(words)
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    events = [{"type": "restart", "start": 12.0, "end": 12.6}]
    r = client.post(f"/jobs/{job.id}/recompute-scenes", json={"events": events})
    assert r.status_code == 200, r.text
    segs = [tuple(s) for s in store.get(job.id).segments]
    # "Hallo Leute." stays; the take after the go ("Neuer Versuch.") and
    # the command go
    assert segs[0][0] == 0.0 and segs[0][1] >= 1.4, segs
    assert not any(a < 9.6 < b for a, b in segs), segs
    assert any(a <= 13.0 and b >= 13.4 for a, b in segs), segs
