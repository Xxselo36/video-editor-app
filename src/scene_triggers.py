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

import re


# Wake-word variants — Whisper regularly mishears "Cleo" as "Clio"
# (Renault-car), "Cleyo", "Klio", "Kleo". Plus common mishearings of
# the English command word in German audio (e.g. "restart" → "is what").
_CLEO_VARIANTS = [
    "cleo", "clio", "cleyo", "klio", "kleo",
    # Whisper mishearings observed in real recordings:
    "clear", "cleer", "clara", "claro", "clean",
    "kilo", "keo", "kejo", "clea",
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


def _normalize(text: str) -> str:
    return re.sub(r"[^\w\s]", " ", (text or "").lower()).strip()


def _match_phrase_at(word_idx: int, whisper_words: list[dict],
                     phrase: str) -> tuple[int, float, float] | None:
    """Match phrase either as consecutive tokens or as one merged word."""
    tokens = _normalize(phrase).split()
    if not tokens or word_idx >= len(whisper_words):
        return None
    if word_idx + len(tokens) <= len(whisper_words):
        ok = True
        for i, tok in enumerate(tokens):
            w = whisper_words[word_idx + i]
            ww = _normalize(w.get("word", "") or w.get("text", "")).strip()
            if ww != tok:
                ok = False
                break
        if ok:
            start = float(whisper_words[word_idx].get("start", 0))
            last = whisper_words[word_idx + len(tokens) - 1]
            end = float(last.get("end", start))
            return (word_idx + len(tokens), start, end)
    if len(tokens) >= 2:
        concat = "".join(tokens)
        w = whisper_words[word_idx]
        ww = _normalize(w.get("word", "") or w.get("text", "")).strip()
        if ww == concat:
            start = float(w.get("start", 0))
            end = float(w.get("end", start))
            return (word_idx + 1, start, end)
    return None


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
        cut_ranges: list of (start, end) audio ranges to cut
        events: list of (command_type, phrase_start, phrase_end) for
            logging / debugging.

    Feature is opt-in: if the user never says 'Cleo start', returns
    empty ranges — the scene machinery stays out of the pipeline.
    """
    starts = sorted(start_keywords or DEFAULT_START_KEYWORDS,
                    key=lambda p: -len(p.split()))
    restarts = sorted(restart_keywords or DEFAULT_RESTART_KEYWORDS,
                      key=lambda p: -len(p.split()))
    keeps = sorted(keep_keywords or DEFAULT_KEEP_KEYWORDS,
                   key=lambda p: -len(p.split()))
    finishes = sorted(finish_keywords or DEFAULT_FINISH_KEYWORDS,
                      key=lambda p: -len(p.split()))

    if not whisper_words:
        return [], []

    events: list[tuple[str, float, float, int]] = []
    i = 0
    while i < len(whisper_words):
        matched = False
        for cmd_type, kws in [
            ("start", starts), ("restart", restarts),
            ("keep", keeps), ("finish", finishes),
        ]:
            for kw in kws:
                m = _match_phrase_at(i, whisper_words, kw)
                if m is not None:
                    next_idx, phrase_start, phrase_end = m
                    events.append((cmd_type, phrase_start, phrase_end, next_idx))
                    i = next_idx
                    matched = True
                    break
            if matched:
                break
        if not matched:
            i += 1

    # No start command → feature not used; do nothing.
    first_start = next((e for e in events if e[0] == "start"), None)
    if first_start is None:
        return [], [(t, s, e) for (t, s, e, _) in events]

    cut_ranges: list[tuple[float, float]] = []

    # 1) Drop everything from audio start up to (and including) the
    #    first 'Cleo start' phrase.
    if first_start[1] > 0.0:
        cut_ranges.append((0.0, first_start[2]))

    anchor_end = first_start[2]
    idx_start = events.index(first_start) + 1

    for evt in events[idx_start:]:
        cmd_type, phrase_start, phrase_end, _next = evt
        if cmd_type in ("start", "restart"):
            # Both discard the current provisional and set a fresh
            # anchor. (Another 'Cleo start' effectively means the user
            # forgot to say restart and just started over.)
            cut_ranges.append((anchor_end, phrase_end))
            anchor_end = phrase_end
        elif cmd_type == "keep":
            # Keep the take; only cut the 'Cleo keep' phrase itself.
            cut_ranges.append((phrase_start, phrase_end))
            anchor_end = phrase_end
        elif cmd_type == "finish":
            # Cut the 'Cleo finish' phrase, then cut all following audio.
            tail_cap = clip_duration if clip_duration else (
                float(whisper_words[-1].get("end", phrase_end)) + 60.0
            )
            cut_ranges.append((phrase_start, tail_cap))
            break

    return cut_ranges, [(t, s, e) for (t, s, e, _) in events]
