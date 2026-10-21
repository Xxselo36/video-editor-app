"""Scene-based voice commands: Cleo start / restart / keep / finish.

Enables a record-once-and-refine workflow:
    'Cleo start'   — anchors a new take. Everything before the FIRST
                     Cleo start in the video is dropped (setup/warmup).
    'Cleo restart' — discards the current provisional take (from last
                     anchor to this restart, inclusive). New anchor
                     set here.
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
    """Scan words for scene commands, return (cut_ranges, events).

    Args:
        whisper_words: list of {"word": str, "start": float, "end": float}
        clip_duration: audio duration in seconds. Used to cap the
            'everything after Cleo finish' cut range.
        *_keywords: overrideable phrase lists per command type.

    Returns:
        cut_ranges: list of (start, end) audio ranges to cut (Whisper
            times; the analysis snaps them to the audio, src/edge_snap.py)
        events: list of (command_type, phrase_start, phrase_end) for
            logging / debugging.

    Only phrases said as commands count (src/command_gate.py). Feature is
    opt-in: if the user never says 'Cleo start' (a phonetic guess at one
    doesn't count), returns empty ranges — the scene machinery stays out
    of the pipeline. A phonetic guess at 'finish' cuts only its phrase,
    never the rest of the video.
    """
    if start_keywords or restart_keywords or keep_keywords or finish_keywords:
        table = _table(start_keywords, restart_keywords, keep_keywords,
                       finish_keywords)
    else:
        table = scene_table()

    words = gate.split_tokens(whisper_words)
    if not words:
        return [], []
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

    # No start command → feature not used; do nothing.
    first_start = next((e for e in events if e[0] == "start" and not e[3]),
                       None)
    if first_start is None:
        return [], [(t, s, e) for (t, s, e, *_r) in events]

    cut_ranges: list[tuple[float, float]] = []

    # 1) Drop everything from audio start up to (and including) the
    #    first 'Cleo start' phrase — also when Whisper puts its first
    #    word at 0.0.
    if first_start[2] > 0.0:
        cut_ranges.append((0.0, first_start[2]))

    anchor_end = first_start[2]
    idx_start = events.index(first_start) + 1

    for evt in events[idx_start:]:
        cmd_type, phrase_start, phrase_end, phonetic, _next = evt
        if cmd_type in ("start", "restart"):
            # Both discard the current provisional and set a fresh
            # anchor. (Another 'Cleo start' effectively means the user
            # forgot to say restart and just started over.)
            cut_ranges.append((anchor_end, phrase_end))
            anchor_end = phrase_end
        elif cmd_type == "keep" or (cmd_type == "finish" and phonetic):
            # Keep the take; only cut the 'Cleo keep' phrase itself.
            cut_ranges.append((phrase_start, phrase_end))
            anchor_end = phrase_end
        elif cmd_type == "finish":
            # Cut the 'Cleo finish' phrase, then cut all following audio.
            tail_cap = clip_duration if clip_duration else (
                float(words[-1].get("end", phrase_end)) + 60.0
            )
            cut_ranges.append((phrase_start, tail_cap))
            break

    return cut_ranges, [(t, s, e) for (t, s, e, *_r) in events]
