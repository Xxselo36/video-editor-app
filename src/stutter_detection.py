"""Stutter detection — repeated N-gram sequences in Whisper words.

A stutter is when the speaker restarts a sentence beginning with the
same 2-4 words in quick succession:

    "Es ist ein, es ist ein sehr schönes Thema"
     ^^^^^^^^^^^  ^^^^^^^^^^^ ← same 3 words, <1s apart → cut first

    "Ich weiß, ich weiß, was du meinst"
     ^^^^^^^^^  ^^^^^^^^^ ← same 2 words → cut first

Deterministic. No LLM judgment. Runs on Whisper's word timestamps and
returns audio (start, end) ranges to cut. Single-word repetitions like
"ja ja" are intentionally NOT cut (usually emphasis, not stutter).
"""
from __future__ import annotations

import re


def _norm_word(text: str) -> str:
    """Lowercase + strip punctuation for word equality comparison."""
    return re.sub(r"[^\w]", "", (text or "").lower())


def _collect_words(transcription: dict) -> list[dict]:
    """Flatten the {segments: [{words: [...]}]} shape into one list.

    Each entry: {"word": raw, "norm": normalized, "start": s, "end": e}.
    Words that normalize to empty (pure punctuation) are dropped.
    """
    out: list[dict] = []
    for seg in transcription.get("segments") or []:
        for w in seg.get("words") or []:
            norm = _norm_word(w.get("word", "") or "")
            if not norm:
                continue
            out.append({
                "word": (w.get("word", "") or "").strip(),
                "norm": norm,
                "start": float(w.get("start") or 0),
                "end": float(w.get("end") or 0),
            })
    return out


def find_stutter_cuts(
    transcription: dict,
    min_ngram_size: int = 2,
    max_ngram_size: int = 4,
    max_gap_seconds: float = 1.0,
) -> list[tuple[float, float]]:
    """Find stutter repetitions in a Whisper transcription.

    For each position i, checks whether words[i:i+n] repeats immediately
    after itself (with an optional short pause / interjection). Greedy
    on N: tries longest ngrams first so "es ist ein, es ist ein" fires
    as a 3-word match rather than a 2-word one.

    The cut range spans from A's start to B's start — that swallows
    any pause between A and B so the video doesn't hang on dead air.

    Args:
        transcription: Whisper result dict with .segments[].words[].
        min_ngram_size: shortest phrase considered a stutter. Default 2
            avoids cutting emphatic single-word repeats ("ja ja").
        max_ngram_size: longest phrase considered. Default 4 covers
            typical restart patterns.
        max_gap_seconds: how far after A's end B may start and still
            count as a stutter. Real restarts happen fast (<1s).

    Returns: list of (start, end) audio ranges to cut, in encounter
    order (may overlap if the same word position anchored multiple
    matches — the caller's segment-cutter handles overlaps).
    """
    words = _collect_words(transcription)
    if len(words) < 2 * min_ngram_size:
        return []

    cuts: list[tuple[float, float]] = []
    consumed: set[int] = set()

    i = 0
    while i < len(words):
        if i in consumed:
            i += 1
            continue

        matched = False
        for n in range(max_ngram_size, min_ngram_size - 1, -1):
            if i + 2 * n > len(words):
                continue

            a = words[i:i + n]
            # A short lookahead window for B — allow up to N-1 filler
            # words between A and B (e.g. "was ich sagen ähm was ich
            # sagen wollte"). max_gap_seconds enforces time separation.
            max_j = min(i + n + max(n, 3), len(words) - n + 1)
            for j in range(i + n, max_j):
                b = words[j:j + n]
                if b[0]["start"] - a[-1]["end"] > max_gap_seconds:
                    break
                if all(a[k]["norm"] == b[k]["norm"] for k in range(n)):
                    cut_start = a[0]["start"]
                    cut_end = b[0]["start"]
                    if cut_end > cut_start:
                        cuts.append((round(cut_start, 3),
                                    round(cut_end, 3)))
                    for k in range(i, i + n):
                        consumed.add(k)
                    i = j  # continue scanning from B onwards
                    matched = True
                    break
            if matched:
                break

        if not matched:
            i += 1

    return cuts
