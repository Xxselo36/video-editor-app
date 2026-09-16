"""Detect inter-word gaps within a segment that indicate untranscribed
audible content (typically drawn-out fillers Whisper 'cleans up').

Whisper's decoder often omits filler vocalisations ('ääääh', 'öhm',
long throat clears) from its output — even though the audio contains
them. That leaves:

  transcription:  'Testvideo' [gap ≥ 400ms] 'und'
  actual audio:   'Testvideo ääääh und'

Silence detection sees energy across the whole span → keeps it as
speech. Filler detector needs a matched word to trigger. Neither
catches this class.

This module finds gaps > threshold between consecutive Whisper words
that fall inside a kept speech segment (per silence detection) and
returns them as cut ranges. Deterministic. No LLM.
"""
from __future__ import annotations


def find_word_gap_cuts(
    transcription: dict,
    speech_ranges: list[tuple[float, float]] | None = None,
    min_gap_seconds: float = 0.4,
    keep_edge_pad: float = 0.05,
) -> list[tuple[float, float, float]]:
    """Find gaps between consecutive Whisper words that likely contain
    untranscribed audible content.

    Args:
        transcription: Whisper output with .segments[].words[].
        speech_ranges: optional list of (start, end) speech ranges
            from silence detection. If given, only report gaps that
            fall INSIDE a speech range (meaning the gap has audible
            content, not real silence).
        min_gap_seconds: gap size below which we don't cut. Real
            speech has natural micro-pauses of 100-300ms.
        keep_edge_pad: how much space to keep around each real word.
            Cut range is (word_end + pad, next_word_start - pad).

    Returns: list of (start, end, gap_size) cut ranges, sorted.
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
            })

    if len(words) < 2:
        return []

    def _in_speech_range(t: float) -> bool:
        if not speech_ranges:
            return True
        return any(s <= t <= e for (s, e) in speech_ranges)

    cuts: list[tuple[float, float, float]] = []
    for i in range(len(words) - 1):
        gap_start = words[i]["end"]
        gap_end = words[i + 1]["start"]
        gap = gap_end - gap_start
        if gap < min_gap_seconds:
            continue
        # The gap must fall inside a speech range (audible content).
        # If it falls in a silence-detected region, that's a real
        # pause and silence detection already handles it.
        gap_mid = (gap_start + gap_end) / 2
        if not _in_speech_range(gap_mid):
            continue

        cut_s = round(gap_start + keep_edge_pad, 3)
        cut_e = round(gap_end - keep_edge_pad, 3)
        if cut_e - cut_s > 0.1:
            cuts.append((cut_s, cut_e, round(gap, 3)))

    return cuts
