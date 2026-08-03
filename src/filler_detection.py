"""Filler word detection module for SmartCut video editor.

Detects filler words (um, uh, like, etc.) in Whisper transcription results
and provides time ranges for removal. Works with Whisper's word-level timestamps
to identify and segment filler words across multiple languages.

Usage:
    detector = FillerDetector(language="auto", sensitivity="medium")
    fillers = detector.detect_fillers(transcription_result)
    filler_segments = detector.get_filler_segments(transcription_result)
    clean_segments = detector.filter_segments(speech_segments, filler_segments)
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class FillerWord:
    """A detected filler word with timing and confidence information."""
    start: float
    end: float
    word: str
    confidence: float


class FillerDetector:
    """Detects filler words in Whisper transcription results.

    Supports multiple languages and sensitivity levels. Handles both
    single-word fillers ("um") and multi-word fillers ("you know").
    """

    FILLER_WORDS: dict[str, set[str]] = {
        "en": {
            "um", "uh", "uhm", "uhh", "hmm", "hm", "mm", "mhm",
            "ah", "oh", "er", "like", "you know", "basically",
            "literally", "actually", "right", "kind of", "sort of",
            "i mean", "so yeah", "you see", "well",
        },
        "de": {
            # Whisper transcribes "äh"-sounds in many spellings — cover them.
            "ähm", "äh", "ähhh", "ähhm", "öh", "öhm", "ehm", "eh",
            "hm", "hmm", "mhh", "mhm", "mmh",
            # Meta-fillers ("also", "halt", "quasi") only kill if confident.
            "also", "halt", "quasi", "sozusagen", "irgendwie",
            "na ja", "naja", "genau", "eben",
        },
    }

    # Words we're SURE are fillers regardless of Whisper's probability.
    # These are pure vocalisations that have no semantic meaning — if
    # transcribed at all, they're almost always real fillers.
    ALWAYS_FILLER: dict[str, set[str]] = {
        "en": {"um", "uh", "uhm", "uhh", "hmm", "hm", "mm", "mhm", "er"},
        "de": {"ähm", "äh", "ähhh", "ähhm", "öh", "öhm", "ehm", "eh",
               "hm", "hmm", "mhh", "mhm", "mmh"},
    }

    SENSITIVITY_THRESHOLDS: dict[str, float] = {
        "low": 0.5,
        "medium": 0.3,
        "high": 0.1,
    }

    def __init__(self, language: str = "auto", sensitivity: str = "medium") -> None:
        self.language = language
        if sensitivity not in self.SENSITIVITY_THRESHOLDS:
            raise ValueError(
                f"Invalid sensitivity '{sensitivity}'. "
                f"Must be one of: {', '.join(self.SENSITIVITY_THRESHOLDS)}"
            )
        self.sensitivity = sensitivity
        self.confidence_threshold = self.SENSITIVITY_THRESHOLDS[sensitivity]

    def _resolve_language(self, transcription_result: dict) -> str:
        """Resolve the language to use for filler detection."""
        if self.language != "auto":
            return self.language
        return transcription_result.get("language", "en")

    def _get_filler_set(self, language: str) -> set[str]:
        """Get the filler word set for a language, falling back to English."""
        return self.FILLER_WORDS.get(language, self.FILLER_WORDS.get("en", set()))

    def _get_max_filler_word_count(self, filler_set: set[str]) -> int:
        """Return the maximum number of tokens in any multi-word filler."""
        if not filler_set:
            return 1
        return max(len(f.split()) for f in filler_set)

    def detect_fillers(self, transcription_result: dict) -> list[FillerWord]:
        """Scan all words in all segments and return detected filler words.

        Args:
            transcription_result: Whisper transcription dict with "segments"
                and optionally "language". Each segment has a "words" list
                with entries like {"word": " um", "start": 1.23, "end": 1.45,
                "probability": 0.9}.

        Returns:
            List of FillerWord instances for each detected filler, sorted by
            start time. Only includes fillers whose probability meets the
            confidence threshold.
        """
        if not transcription_result:
            return []

        language = self._resolve_language(transcription_result)
        filler_set = self._get_filler_set(language)
        if not filler_set:
            return []

        segments = transcription_result.get("segments", [])
        if not segments:
            return []

        max_filler_tokens = self._get_max_filler_word_count(filler_set)
        detected: list[FillerWord] = []

        for segment in segments:
            words = segment.get("words", [])
            if not words:
                continue

            # Clean words: strip whitespace and punctuation
            cleaned = []
            for w in words:
                text = w.get("word", "")
                text = text.strip().lower().strip(".,!?;:\"'()[]…–—-")
                cleaned.append({
                    "text": text,
                    "start": w.get("start", 0.0),
                    "end": w.get("end", 0.0),
                    "probability": w.get("probability", 0.0),
                })

            # Track which word indices have already been consumed by a
            # multi-word filler so we don't double-detect them.
            consumed: set[int] = set()

            # Check multi-word fillers first (longest match wins)
            for n in range(max_filler_tokens, 1, -1):
                for i in range(len(cleaned) - n + 1):
                    if any(j in consumed for j in range(i, i + n)):
                        continue
                    phrase = " ".join(cleaned[j]["text"] for j in range(i, i + n))
                    if phrase in filler_set:
                        # Average probability across constituent words
                        avg_prob = sum(
                            cleaned[j]["probability"] for j in range(i, i + n)
                        ) / n
                        if avg_prob >= self.confidence_threshold:
                            detected.append(FillerWord(
                                start=cleaned[i]["start"],
                                end=cleaned[i + n - 1]["end"],
                                word=phrase,
                                confidence=avg_prob,
                            ))
                            for j in range(i, i + n):
                                consumed.add(j)

            # Check single-word fillers.
            # ALWAYS_FILLER words (pure vocalisations like "äh", "um")
            # bypass the probability threshold — if Whisper transcribed
            # them at all, they're fillers, and the "small" model gives
            # low confidence for these tokens which was hiding them
            # entirely.
            always_filler_set = self.ALWAYS_FILLER.get(language, set())
            for i, w in enumerate(cleaned):
                if i in consumed:
                    continue
                if w["text"] not in filler_set:
                    continue
                is_always_filler = w["text"] in always_filler_set
                if is_always_filler or w["probability"] >= self.confidence_threshold:
                    detected.append(FillerWord(
                        start=w["start"],
                        end=w["end"],
                        word=w["text"],
                        confidence=w["probability"],
                    ))

        detected.sort(key=lambda f: f.start)
        return detected

    def get_filler_segments(
        self, transcription_result: dict
    ) -> list[tuple[float, float]]:
        """Return merged (start, end) time ranges of detected fillers.

        Adjacent or overlapping filler segments with a gap smaller than 0.1s
        are merged into a single segment.

        Args:
            transcription_result: Whisper transcription dict.

        Returns:
            Sorted list of (start, end) tuples.
        """
        fillers = self.detect_fillers(transcription_result)
        if not fillers:
            return []

        # Build raw segments sorted by start time (already sorted)
        raw: list[tuple[float, float]] = [(f.start, f.end) for f in fillers]

        # Merge overlapping / adjacent segments (gap < 0.1s)
        merged: list[tuple[float, float]] = [raw[0]]
        for start, end in raw[1:]:
            prev_start, prev_end = merged[-1]
            if start <= prev_end + 0.1:
                # Merge: extend the previous segment
                merged[-1] = (prev_start, max(prev_end, end))
            else:
                merged.append((start, end))

        return merged

    def filter_segments(
        self,
        speech_segments: list[tuple[float, float]],
        filler_segments: list[tuple[float, float]],
        min_gap: float = 0.05,
    ) -> list[tuple[float, float]]:
        """Remove filler time ranges from speech segments.

        Handles all edge cases:
        - Filler at the start of a segment
        - Filler at the end of a segment
        - Filler in the middle of a segment (splits it)
        - Filler spanning the entirety of a segment
        - Filler spanning multiple segments

        Args:
            speech_segments: List of (start, end) speech time ranges.
            filler_segments: List of (start, end) filler time ranges to remove.
            min_gap: Minimum duration for a resulting segment to be kept.
                Segments shorter than this are discarded.

        Returns:
            New list of (start, end) speech segments with fillers removed.
        """
        if not speech_segments:
            return []
        if not filler_segments:
            return list(speech_segments)

        result: list[tuple[float, float]] = []

        for seg_start, seg_end in speech_segments:
            # Collect all fillers that overlap with this speech segment
            overlapping = [
                (fs, fe)
                for fs, fe in filler_segments
                if fs < seg_end and fe > seg_start
            ]

            if not overlapping:
                result.append((seg_start, seg_end))
                continue

            # Sort overlapping fillers by start time
            overlapping.sort()

            # Walk through the segment, carving out filler regions
            cursor = seg_start
            for filler_start, filler_end in overlapping:
                # Clamp filler to segment boundaries
                f_start = max(filler_start, seg_start)
                f_end = min(filler_end, seg_end)

                if cursor < f_start:
                    # There's a speech portion before this filler
                    gap = f_start - cursor
                    if gap >= min_gap:
                        result.append((cursor, f_start))

                # Advance cursor past the filler
                cursor = max(cursor, f_end)

            # Remaining speech after the last filler
            if cursor < seg_end:
                gap = seg_end - cursor
                if gap >= min_gap:
                    result.append((cursor, seg_end))

        return result


def get_supported_languages() -> list[str]:
    """Return list of language codes with filler word support."""
    return sorted(FillerDetector.FILLER_WORDS.keys())


def detect_fillers_audio(sample_rate: int, audio_data, speech_segments: list[tuple[float, float]],
                         min_duration: float = 0.2, max_duration: float = 1.5) -> list[tuple[float, float]]:
    """Detect filler sounds directly from audio signal.

    Filler sounds (ähm, uh, um) have characteristic properties:
    - Low energy compared to normal speech
    - Low spectral variation (monotone)
    - Duration typically 0.2-1.5s
    - Occur within speech segments (not silence)

    Args:
        sample_rate: Audio sample rate.
        audio_data: Numpy audio array (mono, float).
        speech_segments: List of (start, end) speech time ranges.
        min_duration: Minimum filler duration in seconds.
        max_duration: Maximum filler duration in seconds.

    Returns:
        List of (start, end) tuples for detected filler sounds.
    """
    import numpy as np

    fillers = []
    window_ms = 50  # 50ms analysis window
    window_size = int(sample_rate * window_ms / 1000)
    hop_size = window_size // 2

    for seg_start, seg_end in speech_segments:
        i_start = int(seg_start * sample_rate)
        i_end = int(seg_end * sample_rate)
        seg_audio = audio_data[i_start:i_end]

        if len(seg_audio) < window_size * 2:
            continue

        # Compute RMS energy for each window
        rms_values = []
        for i in range(0, len(seg_audio) - window_size, hop_size):
            w = seg_audio[i:i + window_size]
            rms_values.append(np.sqrt(np.mean(w ** 2)))

        if not rms_values:
            continue

        rms_arr = np.array(rms_values)
        median_rms = np.median(rms_arr)

        if median_rms < 1e-6:
            continue

        # Compute spectral flatness for each window (monotone = high flatness)
        flatness_values = []
        for i in range(0, len(seg_audio) - window_size, hop_size):
            w = seg_audio[i:i + window_size]
            spectrum = np.abs(np.fft.rfft(w * np.hanning(len(w))))
            spectrum = spectrum[1:]  # skip DC
            spectrum = np.maximum(spectrum, 1e-10)
            geo_mean = np.exp(np.mean(np.log(spectrum)))
            arith_mean = np.mean(spectrum)
            flatness_values.append(geo_mean / arith_mean if arith_mean > 0 else 0)

        flatness_arr = np.array(flatness_values)

        # Detect filler candidates: low-ish energy + high spectral flatness (monotone)
        # Filler = energy between 15-60% of median AND flatness > 0.3
        filler_mask = (
            (rms_arr > median_rms * 0.15) &
            (rms_arr < median_rms * 0.6) &
            (flatness_arr > 0.25)
        )

        # Find contiguous runs
        in_filler = False
        filler_start_idx = 0
        for j in range(len(filler_mask)):
            if filler_mask[j] and not in_filler:
                filler_start_idx = j
                in_filler = True
            elif not filler_mask[j] and in_filler:
                in_filler = False
                t_start = seg_start + filler_start_idx * hop_size / sample_rate
                t_end = seg_start + j * hop_size / sample_rate
                dur = t_end - t_start
                if min_duration <= dur <= max_duration:
                    fillers.append((t_start, t_end))

        # Handle filler at end of segment
        if in_filler:
            t_start = seg_start + filler_start_idx * hop_size / sample_rate
            t_end = seg_end
            dur = t_end - t_start
            if min_duration <= dur <= max_duration:
                fillers.append((t_start, t_end))

    # Merge close fillers
    if not fillers:
        return []
    fillers.sort()
    merged = [fillers[0]]
    for s, e in fillers[1:]:
        if s <= merged[-1][1] + 0.1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))

    return merged
