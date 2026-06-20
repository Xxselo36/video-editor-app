"""
Content-aware smart cutting module.

Uses Whisper word-level timestamps to make intelligent cut decisions,
aligning cuts to sentence and clause boundaries for natural-feeling edits.
Can also blend with RMS-based silence detection for hybrid accuracy.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

_PY310 = sys.version_info >= (3, 10)
_DC_KWARGS = {"slots": True} if _PY310 else {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp *value* to [min_val, max_val]."""
    if value < min_val:
        return min_val
    if value > max_val:
        return max_val
    return value


def _merge_overlapping(
    segments: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Merge overlapping or touching intervals.

    *segments* does not need to be sorted — the function sorts internally.
    Returns a new sorted list of non-overlapping intervals.
    """
    if not segments:
        return []
    sorted_segs = sorted(segments, key=lambda s: s[0])
    merged: list[tuple[float, float]] = [sorted_segs[0]]
    for start, end in sorted_segs[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

_SENTENCE_END_CHARS = frozenset(".?!")
_CLAUSE_END_CHARS = frozenset(",;:")


@dataclass(**_DC_KWARGS)
class WordSegment:
    """A single word extracted from the Whisper transcription."""

    start: float
    end: float
    word: str
    confidence: float
    is_sentence_end: bool
    is_clause_end: bool


# ---------------------------------------------------------------------------
# SmartCutter
# ---------------------------------------------------------------------------

class SmartCutter:
    """Content-aware cut optimizer driven by Whisper word timestamps."""

    def __init__(self, transcription_result: dict, duration: float) -> None:
        self.transcription = transcription_result or {}
        self.duration = max(duration, 0.0)
        self._word_segments: list[WordSegment] | None = None

    # -- word extraction ----------------------------------------------------

    def get_word_segments(self) -> list[WordSegment]:
        """Extract all words from the transcription result.

        Strips leading whitespace from each word, detects sentence endings
        (. ? !) and clause endings (, ; :).  Results are cached and sorted
        by start time.
        """
        if self._word_segments is not None:
            return self._word_segments

        words: list[WordSegment] = []
        segments = self.transcription.get("segments") or []

        for seg in segments:
            seg_words = seg.get("words")
            if not seg_words:
                continue
            for w in seg_words:
                raw = w.get("word", "")
                text = raw.strip()
                if not text:
                    continue

                last_char = text[-1]
                is_sentence_end = last_char in _SENTENCE_END_CHARS
                is_clause_end = (
                    not is_sentence_end and last_char in _CLAUSE_END_CHARS
                )

                words.append(
                    WordSegment(
                        start=float(w.get("start", 0.0)),
                        end=float(w.get("end", 0.0)),
                        word=text,
                        confidence=float(w.get("probability", 0.0)),
                        is_sentence_end=is_sentence_end,
                        is_clause_end=is_clause_end,
                    )
                )

        words.sort(key=lambda ws: ws.start)
        self._word_segments = words
        return words

    # -- speech regions -----------------------------------------------------

    def compute_speech_regions(
        self,
        padding_before: float = 0.08,
        padding_after: float = 0.05,
    ) -> list[tuple[float, float]]:
        """Build speech regions from word timestamps.

        Each word produces a region [start - padding_before, end + padding_after].
        Overlapping or near-adjacent regions (gap < 0.15 s) are merged.
        All values are clamped to [0, duration].
        """
        words = self.get_word_segments()
        if not words:
            return []

        raw: list[tuple[float, float]] = []
        for w in words:
            s = _clamp(w.start - padding_before, 0.0, self.duration)
            e = _clamp(w.end + padding_after, 0.0, self.duration)
            if e > s:
                raw.append((s, e))

        if not raw:
            return []

        # Merge overlapping first, then close-gap merge.
        merged = _merge_overlapping(raw)
        return self.merge_segments(merged, min_gap=0.15)

    # -- boundary detection -------------------------------------------------

    def find_sentence_boundaries(self) -> list[float]:
        """Return end-times where sentences end.

        Uses both word-level punctuation and segment-level text as fallback
        (last word of a segment whose text ends with sentence punctuation).
        """
        words = self.get_word_segments()
        boundaries: set[float] = set()

        # Word-level detection
        for w in words:
            if w.is_sentence_end:
                boundaries.add(w.end)

        # Segment-level fallback: if segment text ends with sentence
        # punctuation but no word was flagged, use segment end time.
        for seg in self.transcription.get("segments") or []:
            text = (seg.get("text") or "").strip()
            if text and text[-1] in _SENTENCE_END_CHARS:
                boundaries.add(float(seg.get("end", 0.0)))

        return sorted(boundaries)

    def find_clause_boundaries(self) -> list[float]:
        """Return end-times where clauses end (commas, semicolons, colons)."""
        words = self.get_word_segments()
        return sorted(w.end for w in words if w.is_clause_end)

    # -- cut optimisation ---------------------------------------------------

    def optimize_cuts(
        self,
        segments: list[tuple[float, float]],
        max_adjust: float = 0.5,
    ) -> list[tuple[float, float]]:
        """Snap segment boundaries to the nearest natural break point.

        Priority: sentence boundary > clause boundary > word boundary > original.
        Adjustments are limited to *max_adjust* seconds in either direction.
        """
        if not segments:
            return []

        sentence_bounds = self.find_sentence_boundaries()
        clause_bounds = self.find_clause_boundaries()
        words = self.get_word_segments()
        word_ends = sorted({w.end for w in words})
        word_starts = sorted({w.start for w in words})

        def _nearest(ts: float, pool: list[float]) -> float | None:
            """Return the value in *pool* closest to *ts*, or None."""
            if not pool:
                return None
            # Binary search for the closest value.
            lo, hi = 0, len(pool) - 1
            best = pool[0]
            while lo <= hi:
                mid = (lo + hi) // 2
                if abs(pool[mid] - ts) < abs(best - ts):
                    best = pool[mid]
                if pool[mid] < ts:
                    lo = mid + 1
                elif pool[mid] > ts:
                    hi = mid - 1
                else:
                    return ts
            return best

        def _snap(ts: float, is_end: bool) -> float:
            """Snap *ts* to the best nearby boundary within max_adjust."""
            candidates: list[tuple[float, int]] = []  # (time, priority)

            # Sentence boundaries (highest priority = 0)
            b = _nearest(ts, sentence_bounds)
            if b is not None and abs(b - ts) <= max_adjust:
                candidates.append((b, 0))

            # Clause boundaries (priority 1)
            b = _nearest(ts, clause_bounds)
            if b is not None and abs(b - ts) <= max_adjust:
                candidates.append((b, 1))

            # Word boundaries (priority 2)
            pool = word_ends if is_end else word_starts
            b = _nearest(ts, pool)
            if b is not None and abs(b - ts) <= max_adjust:
                candidates.append((b, 2))

            if not candidates:
                return ts

            # Sort by priority (lower is better), then by distance.
            candidates.sort(key=lambda c: (c[1], abs(c[0] - ts)))
            return candidates[0][0]

        optimized: list[tuple[float, float]] = []
        for start, end in segments:
            new_start = _snap(start, is_end=False)
            new_end = _snap(end, is_end=True)
            # Ensure the segment stays valid.
            if new_end <= new_start:
                new_start, new_end = start, end
            optimized.append((
                _clamp(new_start, 0.0, self.duration),
                _clamp(new_end, 0.0, self.duration),
            ))

        # Word-aware safety: jedes Whisper-Wort, das zu mindestens 50 %
        # in einem Segment liegt, muss komplett enthalten sein. Sonst
        # werden kurze End-Wörter wie "leid", "auch", "und" reproducibly
        # abgeschnitten, weil die silence-detection den Auslaut als
        # Stille interpretiert.
        if words:
            expanded: list[tuple[float, float]] = []
            for s, e in optimized:
                ns, ne = s, e
                for w in words:
                    overlap_start = max(ns, w.start)
                    overlap_end = min(ne, w.end)
                    w_dur = max(0.001, w.end - w.start)
                    if (overlap_end - overlap_start) / w_dur >= 0.5:
                        # Wort gehört zu diesem Segment — Boundary expandieren
                        ns = min(ns, w.start)
                        ne = max(ne, w.end)
                expanded.append((
                    _clamp(ns, 0.0, self.duration),
                    _clamp(ne, 0.0, self.duration),
                ))
            optimized = expanded

        return _merge_overlapping(optimized)

    # -- hybrid detection ---------------------------------------------------

    def hybrid_detect(
        self,
        rms_segments: list[tuple[float, float]],
        word_segments: list[tuple[float, float]],
        trust_words: float = 0.7,
    ) -> list[tuple[float, float]]:
        """Combine RMS-based and word-based speech segments.

        * Where both agree, use the word segment's tighter boundaries.
        * RMS-only regions (music, non-speech) are kept.
        * Word-only regions (quiet speech) are included.
        * *trust_words* (0-1) controls boundary blending when both overlap.
        """
        trust_words = _clamp(trust_words, 0.0, 1.0)
        trust_rms = 1.0 - trust_words

        if not rms_segments and not word_segments:
            return []
        if not rms_segments:
            return _merge_overlapping(list(word_segments))
        if not word_segments:
            return _merge_overlapping(list(rms_segments))

        result: list[tuple[float, float]] = []
        used_word: list[bool] = [False] * len(word_segments)

        for rs, re in rms_segments:
            overlapping: list[int] = []
            for i, (ws, we) in enumerate(word_segments):
                if ws < re and we > rs:
                    overlapping.append(i)

            if overlapping:
                # Word segments confirm speech — blend boundaries.
                for i in overlapping:
                    used_word[i] = True
                    ws, we = word_segments[i]
                    blended_start = trust_words * ws + trust_rms * rs
                    blended_end = trust_words * we + trust_rms * re
                    result.append((blended_start, blended_end))
            else:
                # RMS-only: non-speech sound — keep as-is.
                result.append((rs, re))

        # Word-only regions: quiet speech not caught by RMS.
        for i, (ws, we) in enumerate(word_segments):
            if not used_word[i]:
                result.append((ws, we))

        return _merge_overlapping(result)

    # -- segment merging ----------------------------------------------------

    def merge_segments(
        self,
        segments: list[tuple[float, float]],
        min_gap: float = 0.15,
    ) -> list[tuple[float, float]]:
        """Merge segments closer than *min_gap* and drop tiny ones (< 0.05 s)."""
        if not segments:
            return []

        sorted_segs = sorted(segments, key=lambda s: s[0])
        merged: list[tuple[float, float]] = [sorted_segs[0]]

        for start, end in sorted_segs[1:]:
            prev_start, prev_end = merged[-1]
            if start - prev_end < min_gap:
                merged[-1] = (prev_start, max(prev_end, end))
            else:
                merged.append((start, end))

        # Drop segments shorter than 0.05 s.
        return [(s, e) for s, e in merged if (e - s) >= 0.05]
