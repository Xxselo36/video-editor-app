"""Groq Whisper — cloud-hosted transcription, ~10× faster than local.

Uses `whisper-large-v3-turbo` by default (fast, same-or-better accuracy
as local 'medium'). Returns None on missing key / API failure so the
caller can fall back to local faster-whisper without breaking the flow.

Requires GROQ_API_KEY env var. Get one free-tier at console.groq.com.
"""
from __future__ import annotations

import os
from typing import Any


# Model choice:
#   whisper-large-v3-turbo — fast (~10x realtime), same quality as
#                            'medium' locally, cheapest at $0.04/hour
#   whisper-large-v3       — slower but most accurate, $0.111/hour
# Default to turbo: matches our local 'medium' quality but far faster.
_MODEL = "whisper-large-v3-turbo"


def transcribe_via_groq(
    audio_path: str,
    initial_prompt: str | None = None,
    language: str | None = None,
) -> dict[str, Any] | None:
    """Transcribe an audio file via Groq's Whisper endpoint.

    Returns a dict shaped like faster-whisper's output (segments with
    nested per-word timestamps) so `analyzer._transcription` stays
    interface-compatible. Returns None on missing key / any error.
    """
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return None

    try:
        from openai import OpenAI
    except ImportError:
        print("[groq] openai package not installed — skipping cloud whisper",
              flush=True)
        return None

    client = OpenAI(
        api_key=key,
        base_url="https://api.groq.com/openai/v1",
    )

    kwargs: dict[str, Any] = {
        "model": _MODEL,
        "response_format": "verbose_json",
        "timestamp_granularities": ["word", "segment"],
    }
    if initial_prompt:
        kwargs["prompt"] = initial_prompt
    if language:
        kwargs["language"] = language

    try:
        with open(audio_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                file=(os.path.basename(audio_path), f),
                **kwargs,
            )
    except Exception as e:
        print(f"[groq] transcription failed: {e}", flush=True)
        return None

    # Response is a pydantic model — convert to plain dict.
    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)

    top_words = data.get("words") or []
    segments = data.get("segments") or []

    # Normalize word entries once
    normalized_words = [
        {
            "word": w.get("word", ""),
            "start": float(w.get("start", 0)),
            "end": float(w.get("end", 0)),
            "probability": float(w.get("probability", 1.0)),
        }
        for w in top_words
    ]

    # Groq returns words as a flat top-level list; faster-whisper nests
    # them per segment. Assign each word to the segment whose midpoint
    # is closest (guarantees every word lands in exactly one segment so
    # nothing gets dropped by an overlap-boundary miss).
    if segments:
        for i, seg in enumerate(segments):
            seg["words"] = []
            seg.setdefault("tokens", [])
            seg.setdefault("avg_logprob", 0.0)
            seg.setdefault("compression_ratio", 1.0)
            seg.setdefault("no_speech_prob", 0.0)
            seg.setdefault("id", i)
            seg.setdefault("seek", 0)

        for w in normalized_words:
            w_mid = (w["start"] + w["end"]) / 2.0
            best_seg = min(
                segments,
                key=lambda s: abs(
                    ((float(s.get("start", 0)) + float(s.get("end", 0))) / 2.0)
                    - w_mid
                ),
            )
            best_seg["words"].append(w)
    else:
        # No segments returned — synthesize one big segment holding all
        # words so downstream code still finds them.
        if normalized_words:
            segments = [{
                "id": 0,
                "seek": 0,
                "start": normalized_words[0]["start"],
                "end": normalized_words[-1]["end"],
                "text": data.get("text", ""),
                "tokens": [],
                "avg_logprob": 0.0,
                "compression_ratio": 1.0,
                "no_speech_prob": 0.0,
                "words": normalized_words,
            }]

    print(f"[groq] mapped {len(normalized_words)} words into "
          f"{len(segments)} segments", flush=True)

    return {
        "text": data.get("text", ""),
        "segments": segments,
        "language": data.get("language", language or "en"),
    }
