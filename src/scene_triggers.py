"""Scene-based voice commands: Cleo start / restart / keep / finish.

Enables a record-once-and-refine workflow. Every take has an anchor,
where it began: the end of the command before it, or the start of the
video when there was none — "Cleo start" is not needed (owner
decision), it marks where a take begins.

    'Cleo start'   — anchors a new take. What came since the anchor is
                     dropped: everything before it when it is the first
                     command (setup/warmup), else e.g. the chatter after
                     a keep.
    'Cleo restart' — ('Cleo cut') discards the current provisional take
                     (from the anchor to this restart, inclusive). New
                     anchor set here. A take that did not begin at a
                     said 'Cleo start' and is longer than
                     IMPLICIT_CUT_MAX_S is not cut: only the spoken
                     phrase goes, and the take is a suggestion the
                     creator confirms in the editor (job.cut_suggestions).
    'Cleo keep'    — commits the current take. Content up to this
                     keep is preserved (the keep phrase itself is
                     removed). New anchor set here for the next scene.
    'Cleo finish'  — commits the final take. Everything after 'Cleo
                     finish' is dropped (cool-down / off-camera).

If the user doesn't say 'Cleo finish', the tail (from last anchor to
audio end) is kept forgivingly — user may have just stopped recording.
Parallel to voice_triggers.py which handles single-phrase 'Cleo cut/go'
inline failures.
"""
from __future__ import annotations

from functools import lru_cache
from typing import NamedTuple

from src import command_gate as gate


# Wake-word variants — Whisper regularly mishears "Cleo" as "Clio"
# (Renault-car), "Cleyo", "Klio", "Kleo". Plus common mishearings of
# the English command word in German audio (e.g. "restart" → "is what").
# Only the first five are strong (src/command_gate.py PRIMARY_WAKE); the
# others need a break before and after the phrase.
_CLEO_VARIANTS = [
    "cleo", "clio", "cleyo", "klio", "kleo",
    # Whisper mishearings observed in real recordings:
    "clear", "cleer", "clara", "claro", "clean",
    "kilo", "keo", "kejo", "clea",
    "chloe", "leo", "cleos",
]


def _combos(command_variants: list[str]) -> list[str]:
    """Build 'cleo <cmd>' for every Cleo-variant × command-variant."""
    return [f"{c} {cmd}" for c in _CLEO_VARIANTS for cmd in command_variants]


# Bilingual command set — English and German phrases both accepted so
# the user can say whatever comes naturally. Every phrase paired with
# every Cleo-mishearing (Clio, Cleyo, Klio, Kleo) plus phonetic collapse
# variants Whisper produces in mixed-language audio.

DEFAULT_START_KEYWORDS = _combos([
    # EN
    "start", "starts", "starte", "started", "starting",
    "star", "startet",
    # DE-mishearings of English 'start' in DE-audio
    "ist ab", "istab", "is ab", "isab",
    "hat ab", "hatab",
    "is tough", "istough", "is tuff", "is auf",
    "ist auf", "is doof",
])

DEFAULT_RESTART_KEYWORDS = _combos([
    # Primary — 'Cleo cut' is now the RESTART command (was voice-trigger).
    "cut", "cuts", "cutted", "cutting",
    # DE variants for 'cut'
    "schnitt", "schneiden", "schneide",
    # Whisper mishears of 'cut' in mixed audio
    "kutt", "kurt", "gut", "kot",
    # Legacy: 'restart' + its mishears kept as fallback so users who
    # already learned the old primary don't get broken.
    "restart", "restarts", "restarte", "restartet", "restarted",
    "is what", "is that", "is left", "is what's", "is that's",
    "rest art", "rest hart", "rest hard", "restard",
    "restat", "restate",
    # DE proper — semantic siblings
    "neu", "nue", "noi",
    "nochmal", "noch mal", "nochmals",
    "zurück", "zurueck", "zuruck",
])

DEFAULT_KEEP_KEYWORDS = _combos([
    # EN
    "keep", "keeps", "keep it", "keep it up",
    "kip", "kiep", "kef", "kefir",
    "kib", "keeb", "geeb",
    # DE proper
    "behalten", "behalte", "behält", "behaelt",
    "speichern", "speichere",
    "check",
])

DEFAULT_FINISH_KEYWORDS = _combos([
    # EN
    "finish", "finished", "finishes", "finishing",
    "finnisch", "finito", "finnish", "fenish",
    "fin", "finish it",
    # DE proper
    "ende", "enden", "endet",
    "fertig", "fertisch",
    "schluss", "schlus",
])


# The command words as taught. With a strong wake word they need only a
# break after them (src/command_gate.py); every other variant above (a
# mishearing, a German sibling, a stand-in like "gut" or "noch mal")
# needs breaks on both sides.
STRONG_COMMANDS = {
    "start": frozenset({"start", "starts", "starte", "started", "starting"}),
    "restart": frozenset({"cut", "restart", "restarts", "restarte",
                          "restartet", "restarted"}),
    "keep": frozenset({"keep", "keeps"}),
    "finish": frozenset({"finish", "finished", "finishes", "finishing"}),
}

# Same-type commands closer than this are one command said (or
# hallucinated) twice; the repeat's phrase is cut with the first one, at
# most REPEAT_REACH_S past the repeat's start (a hallucinated copy's
# times drift far into the following audio).
HALLUCINATION_GAP = 1.0
REPEAT_REACH_S = 1.2

# A "Cleo cut" whose take did not begin at a said "Cleo start" (it began
# after the command before it, or at the start of the video) removes at
# most this much on its own; a longer take is only suggested — one tap
# in the editor confirms it (owner decision). Its phrase is cut anyway.
IMPLICIT_CUT_MAX_S = 60.0


class ScenePlan(NamedTuple):
    """What the scene commands of a recording do (plan_scene_cuts)."""
    # (start, end) ranges to cut, Whisper times (the analysis snaps them
    # to the audio, src/edge_snap.py)
    cuts: list[tuple[float, float]]
    # (start, end) takes a "Cleo cut" would throw away, longer than
    # IMPLICIT_CUT_MAX_S without a "Cleo start": not cut (the phrase
    # itself is in `cuts`)
    suggestions: list[tuple[float, float]]
    # (command_type, phrase_start, phrase_end) for logging / debugging
    events: list[tuple[str, float, float]]


def _normalize(text: str) -> str:
    return gate.normalize(text)


def _table(start_keywords=None, restart_keywords=None, keep_keywords=None,
           finish_keywords=None) -> gate.CommandTable:
    return gate.CommandTable([
        ("start", start_keywords or DEFAULT_START_KEYWORDS, STRONG_COMMANDS["start"]),
        ("restart", restart_keywords or DEFAULT_RESTART_KEYWORDS, STRONG_COMMANDS["restart"]),
        ("keep", keep_keywords or DEFAULT_KEEP_KEYWORDS, STRONG_COMMANDS["keep"]),
        ("finish", finish_keywords or DEFAULT_FINISH_KEYWORDS, STRONG_COMMANDS["finish"]),
    ])


@lru_cache(maxsize=1)
def scene_table() -> gate.CommandTable:
    """The default scene commands (also the bounds of a stop … go pair,
    src/voice_triggers.py)."""
    return _table()


def find_scene_cut_ranges(
    whisper_words: list[dict],
    clip_duration: float | None = None,
    start_keywords: list[str] | None = None,
    restart_keywords: list[str] | None = None,
    keep_keywords: list[str] | None = None,
    finish_keywords: list[str] | None = None,
) -> tuple[list[tuple[float, float]], list[tuple[str, float, float]]]:
    """plan_scene_cuts as (cut_ranges, events): a suggested take is not
    cut (its "Cleo cut" phrase is)."""
    plan = plan_scene_cuts(whisper_words, clip_duration, start_keywords,
                           restart_keywords, keep_keywords, finish_keywords)
    return plan.cuts, plan.events


def plan_scene_cuts(
    whisper_words: list[dict],
    clip_duration: float | None = None,
    start_keywords: list[str] | None = None,
    restart_keywords: list[str] | None = None,
    keep_keywords: list[str] | None = None,
    finish_keywords: list[str] | None = None,
    implicit_cut_max_s: float | None = None,
) -> ScenePlan:
    """Scan words for scene commands: what they cut, what they suggest.

    Args:
        whisper_words: list of {"word": str, "start": float, "end": float}
        clip_duration: audio duration in seconds. Used to cap the
            'everything after Cleo finish' cut range.
        *_keywords: overrideable phrase lists per command type.
        implicit_cut_max_s: the most a "Cleo cut" without a "Cleo start"
            removes on its own (None: IMPLICIT_CUT_MAX_S; inf: no limit).

    Only phrases said as commands count (src/command_gate.py). No 'Cleo
    start' is needed: a take begins after the command before it, or at
    the start of the video (module doc). A phonetic guess never throws
    away what came before it: one at 'start' before any said one, or at
    'finish', cuts only its phrase.
    """
    if implicit_cut_max_s is None:
        implicit_cut_max_s = IMPLICIT_CUT_MAX_S
    if start_keywords or restart_keywords or keep_keywords or finish_keywords:
        table = _table(start_keywords, restart_keywords, keep_keywords,
                       finish_keywords)
    else:
        table = scene_table()

    words = gate.split_tokens(whisper_words)
    if not words:
        return ScenePlan([], [], [])
    norm = gate.normalized(words)

    # [type, start, end, phonetic, index of the word after the phrase]
    events: list[list] = []
    i = 0
    while i < len(words):
        m = table.match(words, norm, i)
        if m is None:
            i += 1
            continue
        cmd_type, _kw, next_idx, phrase_start, phrase_end, _weak = m
        events.append([cmd_type, phrase_start, phrase_end, False, next_idx])
        i = next_idx

    # Phonetic-fuzzy pass — catches Whisper mishears the exact-match
    # scan missed (e.g. 'Klio Kip', 'Kleo Kat.'). Only adds events,
    # never overrides — dedupe_window prevents collisions with the
    # primary detection.
    try:
        from src.phonetic_wake_detection import find_phonetic_candidates
        primary_events = [(t, s, e) for (t, s, e, *_r) in events]
        candidates = find_phonetic_candidates(
            words, already_detected=primary_events,
        )
        for (cmd_type, ph_s, ph_e, raw) in candidates:
            print(f"[phonetic] added {cmd_type} @ {ph_s:.2f}s — raw="
                  f"{raw!r}", flush=True)
            events.append([cmd_type, ph_s, ph_e, True,
                           gate.index_at(words, ph_s) + 2])
        # Re-sort chronologically since phonetic events are appended.
        events.sort(key=lambda e: e[1])
    except Exception as _phe:
        print(f"[phonetic] skipped: {_phe}", flush=True)

    # Dedupe consecutive same-type events within 1s — Whisper
    # sometimes hallucinates a command 2-3 times as a hedge when
    # decoding gets uncertain ('Cleo keep. Cleo keep. Cleo keep.' when
    # the user said it once), and a creator unsure the first was heard
    # says it twice. Keep the first occurrence of each cluster and cut
    # the repeat's phrase with it — capped, since the extra copies'
    # word.end timestamps can drift far into the following audio.
    deduped: list[list] = []
    for evt in events:
        if deduped and evt[0] == deduped[-1][0]:
            gap = evt[1] - deduped[-1][2]
            if gap < HALLUCINATION_GAP:
                reach = min(evt[2], evt[1] + REPEAT_REACH_S)
                if evt[4] < len(words):  # the word after the repeat
                    reach = min(reach, max(evt[1],
                                           float(words[evt[4]].get("start", 0))))
                deduped[-1][2] = max(deduped[-1][2], reach)
                deduped[-1][3] = deduped[-1][3] and evt[3]
                continue
        deduped.append(evt)
    events = deduped

    cut_ranges: list[tuple[float, float]] = []
    suggestions: list[tuple[float, float]] = []
    # The take in progress began at `anchor`: the end of the command
    # before it, or the start of the video. `explicit`: at a said 'Cleo
    # start' (not a phonetic guess); `started`: one was said before.
    anchor, explicit, started = 0.0, False, False

    for evt in events:
        cmd_type, phrase_start, phrase_end, phonetic, _next = evt
        if cmd_type == "start" and (started or not phonetic):
            # Drop what came since the anchor: everything before it as
            # the first command (also when Whisper puts its first word
            # at 0.0). A later 'Cleo start' effectively means the user
            # forgot to say restart and just started over.
            if phrase_end > anchor:
                cut_ranges.append((anchor, phrase_end))
            anchor, explicit = phrase_end, not phonetic
            started = started or not phonetic
        elif cmd_type == "restart":
            # Discard the current provisional take — a long one that
            # didn't begin at a 'Cleo start' only as a suggestion.
            if explicit or phrase_end - anchor <= implicit_cut_max_s:
                cut_ranges.append((anchor, phrase_end))
            else:
                cut_ranges.append((phrase_start, phrase_end))
                suggestions.append((anchor, phrase_end))
                print(f"[scene-triggers] 'Cleo cut' at {phrase_start:.2f}s "
                      f"would remove {phrase_end - anchor:.1f}s without "
                      f"'Cleo start' — suggested, not cut", flush=True)
            anchor, explicit = phrase_end, False
        elif cmd_type == "finish" and not phonetic:
            # Cut the 'Cleo finish' phrase, then cut all following audio.
            tail_cap = clip_duration if clip_duration else (
                float(words[-1].get("end", phrase_end)) + 60.0
            )
            cut_ranges.append((phrase_start, tail_cap))
            break
        else:
            # 'Cleo keep' — or a phonetic guess at 'finish', or at
            # 'start' before any said one: keep the take, cut only the
            # phrase itself.
            cut_ranges.append((phrase_start, phrase_end))
            anchor, explicit = phrase_end, False

    return ScenePlan(cut_ranges, suggestions,
                     [(t, s, e) for (t, s, e, *_r) in events])
