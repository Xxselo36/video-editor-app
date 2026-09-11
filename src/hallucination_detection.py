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
    i = 0
    while i < len(words):
        if not words[i]["norm"]:
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
        i = j + 1

    return cuts
