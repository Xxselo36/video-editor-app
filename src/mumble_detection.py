"""Mumble detection via Whisper word-level confidence.

Whisper gives each transcribed word a probability score. Words with
very low probability are usually:
  - Mumbled / unclear speech
  - Wrongly-guessed placeholders for unintelligible audio
  - (occasionally) rare words / proper nouns Whisper doesn't know

We group words into phrases by their natural pauses and cut phrases
where the AVERAGE confidence is below a conservative threshold AND
the phrase is long enough that it can't be a single-word false alarm.

Explicit limitation: confidence-based detection catches Whisper's
'I'm not sure what this was' moments. It does NOT catch cases where
Whisper CONFIDENTLY MIS-TRANSCRIBES (gibberish that sounds like real
German). Those slip through — there's no signal to detect them from
the text.
"""
from __future__ import annotations


def _collect_words(transcription: dict) -> list[dict]:
    """Flatten Whisper's nested word structure."""
    out: list[dict] = []
    for seg in transcription.get("segments") or []:
        for w in seg.get("words") or []:
            if w.get("start") is None or w.get("end") is None:
                continue
            out.append({
                "start": float(w["start"]),
                "end": float(w["end"]),
                "prob": float(w.get("probability") or 1.0),
                "text": (w.get("word", "") or "").strip(),
            })
    return out


def find_mumble_cuts(
    transcription: dict,
    confidence_threshold: float = 0.25,
    min_phrase_words: int = 3,
    min_phrase_duration: float = 0.6,
    max_phrase_gap: float = 0.4,
) -> list[tuple[float, float, float, str]]:
    """Find low-confidence phrases in a Whisper transcription.

    Args:
        transcription: Whisper result dict with .segments[].words[].
        confidence_threshold: avg word probability below which we cut.
            Whisper on clear speech usually reports 0.7-0.95; anything
            <0.25 is essentially 'no idea what was said'. Conservative
            floor to avoid cutting real content that just happens to
            be a rare word or proper noun.
        min_phrase_words: skip 1-2 word groups (too easy to be a rare
            noun that Whisper wasn't sure about, not real mumbling).
        min_phrase_duration: skip very short phrases (<0.6s). Real
            mumbling is typically longer.
        max_phrase_gap: how much silence between consecutive words
            starts a new phrase. Larger gap = clear pause = new sentence.

    Returns: list of (start, end, avg_confidence, phrase_text) tuples.
    Caller applies the cut ranges to segments and logs the phrase text
    for debugging.
    """
    words = _collect_words(transcription)
    if len(words) < min_phrase_words:
        return []

    # Group into phrases by pause
    phrases: list[list[dict]] = [[words[0]]]
    for w in words[1:]:
        gap = w["start"] - phrases[-1][-1]["end"]
        if gap > max_phrase_gap:
            phrases.append([w])
        else:
            phrases[-1].append(w)

    cuts: list[tuple[float, float, float, str]] = []
    for phrase in phrases:
        if len(phrase) < min_phrase_words:
            continue
        duration = phrase[-1]["end"] - phrase[0]["start"]
        if duration < min_phrase_duration:
            continue
        avg_prob = sum(w["prob"] for w in phrase) / len(phrase)
        if avg_prob < confidence_threshold:
            text = " ".join(w["text"] for w in phrase)
            cuts.append((
                round(phrase[0]["start"], 3),
                round(phrase[-1]["end"], 3),
                round(avg_prob, 3),
                text,
            ))

    return cuts
