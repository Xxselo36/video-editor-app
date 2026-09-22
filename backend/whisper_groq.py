"""Groq Whisper — cloud-hosted transcription.

Uses `whisper-large-v3` (full) — fewer hallucinations, better command-
word recognition in mixed DE/EN audio than turbo. Returns None on
missing key / API failure so the caller can fall back to local
faster-whisper without breaking the flow.

Requires GROQ_API_KEY env var. Get one free-tier at console.groq.com.

MULTI-LANGUAGE STRATEGY (transcribe_via_groq_multilang):
  Whisper picks ONE language per file when language=None. In mixed
  DE/EN videos this transliterates the minority language into the
  majority (English 'I hope' → German 'Ich hoffe' etc). We run two
  passes (auto + explicit en), then per 5-second time bucket pick the
  pass with higher average word probability. Doubles the Groq bill
  but produces the correct language per region.
"""
from __future__ import annotations

import os
from typing import Any


# Model choice:
#   whisper-large-v3       — slower (~4× realtime) but noticeably fewer
#                            hallucinations + fewer command-word mishears.
#                            $0.111/hour on Groq.
#   whisper-large-v3-turbo — faster (~10× realtime) but hallucinates
#                            more on ambiguous audio, produces phrase-
#                            repeat hedges under uncertainty ($0.04/hour).
# Upgraded to non-turbo after user reported repeated command mishearings
# and phrase-loop hallucinations that turbo produced.
_MODEL = "whisper-large-v3"


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

    # Normalize language to ISO-639 short code. Groq sometimes returns
    # full names ('german', 'english') which break downstream code that
    # keys off {'de', 'en'} (e.g. filler detection).
    LANG_MAP = {
        "german": "de", "deutsch": "de", "de": "de",
        "english": "en", "en": "en",
        "spanish": "es", "es": "es",
        "french": "fr", "fr": "fr",
        "italian": "it", "it": "it",
    }
    raw_lang = str(data.get("language") or language or "en").lower()
    norm_lang = LANG_MAP.get(raw_lang, raw_lang[:2])

    print(f"[groq] language raw='{raw_lang}' → normalised='{norm_lang}'",
          flush=True)

    return {
        "text": data.get("text", ""),
        "segments": segments,
        "language": norm_lang,
    }


def transcribe_via_groq_multilang(
    audio_path: str,
    initial_prompt: str | None = None,
    bucket_seconds: float = 5.0,
) -> dict[str, Any] | None:
    """Two-pass Whisper for mixed-language audio.

    Runs one pass with auto-detected language (usually the dominant
    language of the file) and a second explicit English pass. Groups
    all words into `bucket_seconds`-wide time buckets. Each bucket
    picks the pass with higher average word probability — that's the
    pass Whisper was most confident about for that stretch of audio.

    Combined output stitches winning-pass words back into segments so
    downstream code (voice-triggers, filler detection, …) sees a
    single unified transcription. `language` on the result is set to
    the auto-detected language for compatibility with filler word
    lookup.

    Cost: 2× Groq bill (~$0.22/hr instead of $0.11/hr). For a 10min
    video that's ~$0.037. Trade-off for correct multi-language text.
    """
    print("[groq] running multi-language two-pass transcription…",
          flush=True)
    pass_auto = transcribe_via_groq(audio_path,
                                    initial_prompt=initial_prompt,
                                    language=None)
    if pass_auto is None:
        return None

    detected_lang = pass_auto.get("language", "en")
    # Skip the English second pass if Whisper already thought the file
    # was English — no benefit, save the API call.
    if detected_lang == "en":
        print("[groq] auto pass detected 'en' — skipping second pass",
              flush=True)
        return pass_auto

    pass_en = transcribe_via_groq(audio_path,
                                  initial_prompt=initial_prompt,
                                  language="en")
    if pass_en is None:
        print("[groq] English pass failed — using auto pass only",
              flush=True)
        return pass_auto

    def _all_words(t: dict) -> list[dict]:
        out: list[dict] = []
        for seg in t.get("segments") or []:
            for w in seg.get("words") or []:
                if w.get("start") is None or w.get("end") is None:
                    continue
                out.append({
                    "word": w.get("word", ""),
                    "start": float(w["start"]),
                    "end": float(w["end"]),
                    "probability": float(w.get("probability", 1.0)),
                })
        return out

    words_auto = _all_words(pass_auto)
    words_en = _all_words(pass_en)
    if not words_auto and not words_en:
        return pass_auto

    max_t = max(
        max((w["end"] for w in words_auto), default=0.0),
        max((w["end"] for w in words_en), default=0.0),
    )
    n_buckets = int(max_t / bucket_seconds) + 1

    def _bucket_stats(words: list[dict]) -> list[dict]:
        stats = [{"n": 0, "sum": 0.0, "words": []} for _ in range(n_buckets)]
        for w in words:
            bi = int(w["start"] / bucket_seconds)
            if bi < 0 or bi >= n_buckets:
                continue
            stats[bi]["n"] += 1
            stats[bi]["sum"] += w["probability"]
            stats[bi]["words"].append(w)
        return stats

    stats_auto = _bucket_stats(words_auto)
    stats_en = _bucket_stats(words_en)

    merged_words: list[dict] = []
    en_buckets = 0
    for bi in range(n_buckets):
        a = stats_auto[bi]
        e = stats_en[bi]
        a_avg = (a["sum"] / a["n"]) if a["n"] else 0.0
        e_avg = (e["sum"] / e["n"]) if e["n"] else 0.0
        # Pick the pass with the higher avg prob for this bucket.
        # Tie-break: prefer auto to avoid over-anglicising DE speech.
        if e["n"] > 0 and e_avg > a_avg + 0.02:
            merged_words.extend(e["words"])
            en_buckets += 1
        else:
            merged_words.extend(a["words"])

    print(f"[groq] multi-lang merge: {en_buckets}/{n_buckets} buckets "
          f"picked English pass", flush=True)

    # Rebuild segments by grouping merged words into sentences based on
    # natural pauses (>0.6s gap → new segment).
    merged_words.sort(key=lambda w: w["start"])
    segments: list[dict[str, Any]] = []
    cur: list[dict] = []
    GAP_NEW_SEGMENT = 0.6
    for w in merged_words:
        if cur and w["start"] - cur[-1]["end"] > GAP_NEW_SEGMENT:
            segments.append({
                "id": len(segments),
                "seek": 0,
                "start": cur[0]["start"],
                "end": cur[-1]["end"],
                "text": " ".join(x["word"] for x in cur).strip(),
                "tokens": [], "avg_logprob": 0.0,
                "compression_ratio": 1.0, "no_speech_prob": 0.0,
                "words": cur,
            })
            cur = []
        cur.append(w)
    if cur:
        segments.append({
            "id": len(segments),
            "seek": 0,
            "start": cur[0]["start"],
            "end": cur[-1]["end"],
            "text": " ".join(x["word"] for x in cur).strip(),
            "tokens": [], "avg_logprob": 0.0,
            "compression_ratio": 1.0, "no_speech_prob": 0.0,
            "words": cur,
        })

    return {
        "text": " ".join(s["text"] for s in segments).strip(),
        "segments": segments,
        "language": detected_lang,
    }
