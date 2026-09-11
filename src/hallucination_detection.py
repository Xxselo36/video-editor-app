"""Detect Whisper hallucination loops.

Whisper's decoder occasionally falls into a repetition loop, producing
the same token 10-50+ times in a row within a few seconds. Triggered by:
- Ambiguous audio (silence with mic noise, mumble, room tone)
- Prompt bias (any filler token in the initial prompt encourages the
  loop under uncertainty — that's why our wake-prompt no longer lists
  'um' / 'äh')
- Long stretches without clear speech

These runs aren't real speech; they're the language model dominating
the acoustic signal. Cut them as ranges so downstream sees clean audio.
"""
from __future__ import annotations

import re


def _norm(text: str) -> str:
    return re.sub(r"[^\w]", "", (text or "").lower())


def find_hallucination_cuts(
    transcription: dict,
    min_repeats: int = 5,
    max_span_seconds: float = 3.0,
) -> list[tuple[float, float, str, int]]:
    """Find runs of identical consecutive words that likely represent
    a Whisper decoding loop.

    Args:
        transcription: Whisper output with segments.words[].
        min_repeats: minimum consecutive count to flag as a loop.
            Real speech rarely repeats a single word 5+ times in a row.
        max_span_seconds: only flag if the entire run fits within this
            duration. Legit repetition ('ja ja ja ja ja') tends to be
            spread over longer time; hallucination loops are packed.

    Returns: list of (start, end, word, count) tuples — audio ranges
    to cut plus debug info.
    """
    words: list[dict] = []
    for seg in transcription.get("segments") or []:
        for w in seg.get("words") or []:
            if w.get("start") is None or w.get("end") is None:
                continue
            words.append({
                "start": float(w["start"]),
                "end": float(w["end"]),
                "text": (w.get("word", "") or "").strip(),
                "norm": _norm(w.get("word", "") or ""),
            })

    cuts: list[tuple[float, float, str, int]] = []
    consumed: set[int] = set()

    # Pass 1: single-word loops ('um um um um um…')
    i = 0
    while i < len(words):
        if i in consumed or not words[i]["norm"]:
            i += 1
            continue
        j = i
        while (j + 1 < len(words)
               and words[j + 1]["norm"] == words[i]["norm"]):
            j += 1
        run_length = j - i + 1
        if run_length >= min_repeats:
            span = words[j]["end"] - words[i]["start"]
            if span <= max_span_seconds:
                cuts.append((
                    round(words[i]["start"], 3),
                    round(words[j]["end"], 3),
                    words[i]["text"],
                    run_length,
                ))
                for k in range(i, j + 1):
                    consumed.add(k)
        i = j + 1

    # Pass 2: multi-word phrase loops ('Cleo keep. Cleo keep. Cleo
    # keep.'). Whisper hedges with 2-3× phrase repeats when uncertain,
    # a subtler hallucination pattern than the single-word case.
    # Threshold looser here: 3+ repeats of a 2-3 word phrase within
    # max_span_seconds is a clear loop.
    PHRASE_LEN_RANGE = (2, 3)
    PHRASE_MIN_REPEATS = 3
    for phrase_len in PHRASE_LEN_RANGE:
        i = 0
        while i + phrase_len * PHRASE_MIN_REPEATS <= len(words):
            if any(k in consumed for k in range(i, i + phrase_len)):
                i += 1
                continue
            # Try to grow a run of identical phrase_len-word phrases
            phrase = tuple(words[i + k]["norm"] for k in range(phrase_len))
            if not all(phrase):
                i += 1
                continue
            reps = 1
            j = i + phrase_len
            while j + phrase_len <= len(words):
                next_phrase = tuple(words[j + k]["norm"]
                                    for k in range(phrase_len))
                if next_phrase != phrase:
                    break
                reps += 1
                j += phrase_len
            if reps >= PHRASE_MIN_REPEATS:
                span = words[j - 1]["end"] - words[i]["start"]
                if span <= max_span_seconds * reps / 2:
                    cuts.append((
                        round(words[i]["start"], 3),
                        round(words[j - 1]["end"], 3),
                        " ".join(words[i + k]["text"] for k in range(phrase_len)),
                        reps,
                    ))
                    for k in range(i, j):
                        consumed.add(k)
                    i = j
                    continue
            i += 1

    # Sort cuts by start time
    cuts.sort(key=lambda c: c[0])
    return cuts
