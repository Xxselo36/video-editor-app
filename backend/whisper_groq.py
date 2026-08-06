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

    # Groq returns words at the top level (flat list). faster-whisper's
    # format nests words inside each segment. Reshape by time-overlap so
    # downstream code that reads seg.words keeps working unchanged.
    for i, seg in enumerate(segments):
        seg_start = float(seg.get("start", 0))
        seg_end = float(seg.get("end", 0))
        seg["words"] = [
            {
                "word": w.get("word", ""),
                "start": float(w.get("start", 0)),
                "end": float(w.get("end", 0)),
                "probability": float(w.get("probability", 1.0)),
            }
            for w in top_words
            if (
                float(w.get("start", 0)) >= seg_start - 0.15
                and float(w.get("end", 0)) <= seg_end + 0.15
            )
        ]
        # Fill in any fields faster-whisper always populates but Groq skips
        seg.setdefault("tokens", [])
        seg.setdefault("avg_logprob", 0.0)
        seg.setdefault("compression_ratio", 1.0)
        seg.setdefault("no_speech_prob", 0.0)
        seg.setdefault("id", i)
        seg.setdefault("seek", 0)

    return {
        "text": data.get("text", ""),
        "segments": segments,
        "language": data.get("language", language or "en"),
    }
