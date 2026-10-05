"""Groq Whisper — cloud-hosted transcription.

Uses `whisper-large-v3` (full) — fewer hallucinations, better command-
word recognition in mixed DE/EN audio than turbo. Returns None when Groq
isn't configured (no key / no openai package) so the caller can use
local faster-whisper. A failed call is retried (honoring retry-after);
when it still fails — for any chunk or pass — GroqTranscriptionError is
raised: a transcript with holes must never pass as a complete one.

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
import random
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Iterator


# Spoken languages a web user can pick at upload (UX6; GET /config
# spoken_languages, after "auto"): Whisper's languages with an ISO 639-1
# code.
SPOKEN_LANGUAGES = (
    "en", "de", "es", "fr", "pt", "it", "tr", "pl", "nl", "ru", "ja", "ko",
    "id", "hi", "zh", "ar", "sv", "ca", "fi", "vi", "he", "uk", "el", "ms",
    "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la",
    "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
    "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be",
    "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
    "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "ln", "ha", "ba",
    "su",
)

# The language the uploader picked (settings.spoken_language), for the
# transcription of this analysis: set by backend.pipeline around
# analyze_video (same thread), read by transcribe_via_groq_multilang.
# The desktop code that calls it (src/audio.py) stays unchanged.
_SPOKEN_LANGUAGE: ContextVar[str | None] = ContextVar(
    "cleo_spoken_language", default=None)


@contextmanager
def spoken_language(language: str | None) -> Iterator[None]:
    """Transcribe in `language` (ISO 639-1) inside this block; None or
    "auto" = detect it (the two-pass default)."""
    lang = language if language in SPOKEN_LANGUAGES else None
    token = _SPOKEN_LANGUAGE.set(lang)
    try:
        yield
    finally:
        _SPOKEN_LANGUAGE.reset(token)


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


# Groq caps upload body at ~25MB. Long videos (10min+ WAV/M4A) blow
# past that with a 413 error. Chunk them into <=CHUNK_MAX_SECONDS
# pieces with a small overlap so word-level timestamps stitch cleanly.
CHUNK_MAX_SECONDS = 300.0   # 5 minutes per chunk, well under 25MB even in WAV
CHUNK_OVERLAP_SECONDS = 2.0  # tiny overlap to catch words on chunk edges

# Retry policy per Groq call: MAX_ATTEMPTS tries; the wait before a retry
# is the server's retry-after when it sends one, else RETRY_BACKOFF_S.
# A retry-after above CLEO_GROQ_MAX_RETRY_WAIT (default 60 s; e.g. the
# hourly audio quota is used up) fails right away instead of blocking a
# worker for minutes.
MAX_ATTEMPTS = 3
RETRY_BACKOFF_S = (2.0, 6.0)
REQUEST_TIMEOUT_S = 180.0
# 408/409/429 and 5xx are worth another try; other 4xx (bad request,
# auth, 413 too large) fail the same way again.
_RETRY_STATUS = {408, 409, 429}

# A caller that answers a user who waits (POST /jobs/{id}/transcribe-span)
# narrows the policy for its calls: (attempts, timeout seconds). The
# client retries itself; a request thread is never held for minutes.
_REQUEST_POLICY: ContextVar[tuple[int, float] | None] = ContextVar(
    "groq_request_policy", default=None)


@contextmanager
def request_policy(attempts: int, timeout_s: float) -> Iterator[None]:
    """Groq calls inside this block get at most `attempts` tries of at
    most `timeout_s` seconds each."""
    token = _REQUEST_POLICY.set((max(1, int(attempts)), float(timeout_s)))
    try:
        yield
    finally:
        _REQUEST_POLICY.reset(token)


def _debug_enabled() -> bool:
    """CLEO_GROQ_DEBUG=1: log one raw verbose_json word per request."""
    return os.environ.get("CLEO_GROQ_DEBUG", "").strip().lower() in (
        "1", "true", "yes", "on")


def _log_raw_sample(words: list, segments: list) -> None:
    """One raw verbose_json word object as Groq sent it, with its text
    redacted to its length (user speech), plus a segment's keys. Settles
    whether Groq returns a per-word `probability` (captions.md C21): the
    parser defaults it to 1.0, so without it the editor's low-confidence
    flag never fires and the two-pass language merge (which compares
    average word probabilities) always keeps the auto pass — then drop the
    en pass or merge by segment avg_logprob instead."""
    import json

    def plain(x: Any) -> Any:
        if isinstance(x, dict):
            return dict(x)
        dump = getattr(x, "model_dump", None)
        # No repr(): it would print the word's text.
        return dump() if callable(dump) else {"unparsed": type(x).__name__}

    try:
        word = plain(words[0]) if words else None
        if isinstance(word, dict):
            for k in ("word", "text"):
                if isinstance(word.get(k), str):
                    word[k] = f"<{len(word[k])} chars>"
        seg = plain(segments[0]) if segments else None
        has_p = isinstance(word, dict) and word.get("probability") is not None
        print("[groq] debug: raw verbose_json word = "
              f"{json.dumps(word, default=str)[:500]}; per-word probability: "
              f"{'yes' if has_p else 'NO'}; segment keys: "
              f"{sorted(seg) if isinstance(seg, dict) else None}", flush=True)
    except Exception as e:  # a debug line must never cost a transcript
        print(f"[groq] debug: could not log a raw word ({type(e).__name__})",
              flush=True)


class GroqTranscriptionError(ConnectionError):
    """Groq transcription failed after retries (or with an error a retry
    can't fix). A ConnectionError (an OSError) on purpose: the web
    backend treats OSErrors as infrastructure failures and refunds the
    minutes. The message starts with "transcription_unavailable:" and
    carries no API response text (shown to users as-is).

    `retry_after_s`: the wait the server asked for with its last error
    (retry-after-ms / retry-after), if any — the task queue's Groq
    breaker opens at once above 60 s (backend/leader.py)."""

    retry_after_s: float | None = None


def _status_code(exc: BaseException) -> int | None:
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def _retryable(exc: BaseException) -> bool:
    code = _status_code(exc)
    if code is None:
        # No HTTP status: connection error / timeout (openai's
        # APIConnectionError, APITimeoutError) or an OS-level error.
        return type(exc).__name__ in (
            "APIConnectionError", "APITimeoutError",
        ) or isinstance(exc, (ConnectionError, TimeoutError))
    return code in _RETRY_STATUS or code >= 500


def _retry_after(exc: BaseException) -> float | None:
    """Seconds the server asked us to wait (retry-after-ms / retry-after
    headers of the error's HTTP response), or None."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    try:
        ms = headers.get("retry-after-ms")
        if ms is not None:
            return max(0.0, float(ms) / 1000.0)
        sec = headers.get("retry-after")
        if sec is not None:
            return max(0.0, float(sec))
    except (TypeError, ValueError):
        pass  # HTTP-date form: fall back to our own backoff
    return None


def _max_retry_wait() -> float:
    """CLEO_GROQ_MAX_RETRY_WAIT (seconds, default 60)."""
    try:
        return float(os.environ.get("CLEO_GROQ_MAX_RETRY_WAIT", "60"))
    except ValueError:
        return 60.0


def _describe(exc: BaseException) -> str:
    # Class name only: the message reaches the web UI, which keys some of
    # its error texts on words and numbers ("audio", "404", "413"). The
    # full error is in the log.
    return type(exc).__name__


def _probe_duration(audio_path: str) -> float:
    """Return audio duration in seconds using ffprobe. 0 on failure."""
    import subprocess
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "format=duration", "-of",
             "default=noprint_wrappers=1:nokey=1", audio_path],
            capture_output=True, text=True, timeout=30,
        )
        return float(result.stdout.strip() or 0)
    except Exception:
        return 0.0


def _extract_chunk(
    audio_path: str,
    start: float,
    duration: float,
) -> str | None:
    """Extract an audio slice into a temp .m4a file (AAC copy — fast +
    small). Returns the path, or None on error.
    """
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as tmp:
        out = tmp.name
    cmd = [
        "ffmpeg", "-y",
        "-i", audio_path,
        "-ss", f"{start:.3f}",
        "-t", f"{duration:.3f}",
        "-vn",
        "-c:a", "aac", "-b:a", "128k",
        "-avoid_negative_ts", "make_zero",
        out,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            print(f"[groq] chunk extract failed: {r.stderr[-200:]}",
                  flush=True)
            os.remove(out)
            return None
        return out
    except Exception as e:
        print(f"[groq] chunk extract exception: {e}", flush=True)
        try:
            os.remove(out)
        except OSError:
            pass
        return None


def transcribe_via_groq(
    audio_path: str,
    initial_prompt: str | None = None,
    language: str | None = None,
) -> dict[str, Any] | None:
    """Transcribe an audio file via Groq's Whisper endpoint.

    Automatically chunks files longer than CHUNK_MAX_SECONDS so Groq's
    25MB body limit doesn't produce 413 errors. Timestamps of the
    stitched result are on the ORIGINAL audio's timeline.

    Returns a dict shaped like faster-whisper's output (segments with
    nested per-word timestamps) so `analyzer._transcription` stays
    interface-compatible. Returns None when Groq isn't configured;
    raises GroqTranscriptionError when a call failed after its retries.
    """
    duration = _probe_duration(audio_path)
    if duration > CHUNK_MAX_SECONDS:
        return _transcribe_chunked(
            audio_path, duration,
            initial_prompt=initial_prompt, language=language,
        )
    return _transcribe_single(
        audio_path,
        initial_prompt=initial_prompt, language=language,
    )


def _transcribe_chunked(
    audio_path: str,
    duration: float,
    initial_prompt: str | None,
    language: str | None,
) -> dict[str, Any] | None:
    """Split-and-stitch transcription for long files. Words + segments
    of every chunk are offset back onto the original timeline."""
    import os as _os
    n_chunks = int((duration - 1) / CHUNK_MAX_SECONDS) + 1
    print(f"[groq] audio {duration:.1f}s > chunk limit → splitting into "
          f"{n_chunks} chunk(s)", flush=True)

    all_words: list[dict] = []
    all_segments: list[dict] = []
    detected_lang: str | None = None
    seg_id = 0

    for i in range(n_chunks):
        c_start = i * CHUNK_MAX_SECONDS
        c_len = min(CHUNK_MAX_SECONDS + CHUNK_OVERLAP_SECONDS,
                    duration - c_start)
        if c_len <= 0:
            break
        chunk_path = _extract_chunk(audio_path, c_start, c_len)
        if chunk_path is None:
            # Skipping it would silently drop up to 5 minutes of
            # transcript (and every cut / caption in them).
            raise GroqTranscriptionError(
                f"transcription_unavailable: could not cut chunk "
                f"{i + 1}/{n_chunks} for upload"
            )

        try:
            sub = _transcribe_single(
                chunk_path,
                initial_prompt=initial_prompt, language=language,
            )
        finally:
            try:
                _os.remove(chunk_path)
            except Exception:
                pass
        if sub is None:  # Groq not configured (can't happen mid-file)
            return None

        if detected_lang is None:
            detected_lang = sub.get("language")

        # Offset every word/segment back to original timeline. Drop
        # words that fall inside the overlap tail of THIS chunk so
        # the next chunk's real content wins (except last chunk).
        keep_until = c_len if i == n_chunks - 1 else CHUNK_MAX_SECONDS
        for s in sub.get("segments") or []:
            words = []
            for w in s.get("words") or []:
                w_start = float(w.get("start", 0))
                if w_start > keep_until:
                    continue
                words.append({
                    "word": w.get("word", ""),
                    "start": w_start + c_start,
                    "end": float(w.get("end", 0)) + c_start,
                    "probability": float(w.get("probability", 1.0)),
                })
            all_words.extend(words)
            if words:
                all_segments.append({
                    "id": seg_id,
                    "seek": 0,
                    "start": words[0]["start"],
                    "end": words[-1]["end"],
                    "text": " ".join(x["word"] for x in words).strip(),
                    "tokens": [], "avg_logprob": 0.0,
                    "compression_ratio": 1.0, "no_speech_prob": 0.0,
                    "words": words,
                })
                seg_id += 1

    # No words at all is a valid (silent) transcript, not a failure:
    # the analysis then stops with "No speech detected" like a short
    # silent file does.
    return {
        "text": " ".join(s["text"] for s in all_segments).strip(),
        "segments": all_segments,
        "language": detected_lang or language or "en",
    }


def _transcribe_single(
    audio_path: str,
    initial_prompt: str | None,
    language: str | None,
) -> dict[str, Any] | None:
    """One Groq request (no chunking), retried per the policy above.
    None = Groq not configured; raises GroqTranscriptionError on failure."""
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return None

    try:
        from openai import OpenAI
    except ImportError:
        print("[groq] openai package not installed — skipping cloud whisper",
              flush=True)
        return None

    max_attempts, timeout_s = _REQUEST_POLICY.get() or (MAX_ATTEMPTS, REQUEST_TIMEOUT_S)
    # max_retries=0: the SDK's own retries would stack on ours.
    client = OpenAI(
        api_key=key,
        base_url="https://api.groq.com/openai/v1",
        max_retries=0,
        timeout=timeout_s,
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

    attempt = 0
    while True:
        attempt += 1
        try:
            with open(audio_path, "rb") as f:
                resp = client.audio.transcriptions.create(
                    file=(os.path.basename(audio_path), f),
                    **kwargs,
                )
            break
        except Exception as e:
            print(f"[groq] transcription attempt {attempt}/{max_attempts} "
                  f"failed: {e}", flush=True)
            asked = _retry_after(e)
            if not _retryable(e) or attempt >= max_attempts:
                err = GroqTranscriptionError(
                    f"transcription_unavailable: Groq failed after "
                    f"{attempt} attempt(s) ({_describe(e)})"
                )
                err.retry_after_s = asked
                raise err from e
            wait = asked
            if wait is None:
                wait = RETRY_BACKOFF_S[min(attempt, len(RETRY_BACKOFF_S)) - 1]
                wait *= 1 + random.uniform(-0.2, 0.2)
            if wait > _max_retry_wait():
                err = GroqTranscriptionError(
                    f"transcription_unavailable: Groq asked to retry in "
                    f"{wait:.0f} s ({_describe(e)})"
                )
                err.retry_after_s = wait
                raise err from e
            time.sleep(wait)

    # Response is a pydantic model — convert to plain dict.
    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
    from backend import costs
    costs.record_groq(data.get("duration") or 0)

    top_words = data.get("words") or []
    segments = data.get("segments") or []
    if _debug_enabled():
        _log_raw_sample(top_words, segments)

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


def _norm_word(text: str) -> str:
    return "".join(ch for ch in (text or "").lower() if ch.isalnum())


def _drop_boundary_duplicates(
        picked: list[tuple[str, dict]]) -> tuple[list[dict], int]:
    """Words of the two passes, sorted by start, minus the duplicates a
    pass switch makes at a bucket boundary.

    Buckets go by word START, so a word spoken across a boundary can sit
    in bucket n of one pass (start 9.98) and bucket n+1 of the other
    (start 10.01). When the buckets pick different passes, that word was
    kept twice ("…funktioniert. funktioniert."). Within one pass Whisper's
    words never overlap, so a word from the OTHER pass that overlaps the
    previous kept word by more than half of the shorter one — or repeats
    its text right at it — is the same speech: the earlier one stays.
    Returns (words, how many were dropped)."""
    picked = sorted(picked, key=lambda p: (p[1]["start"], p[1]["end"]))
    out: list[dict] = []
    last_src: str | None = None
    dropped = 0
    for src, w in picked:
        if out and src != last_src:
            prev = out[-1]
            overlap = min(prev["end"], w["end"]) - max(prev["start"], w["start"])
            shorter = min(prev["end"] - prev["start"], w["end"] - w["start"])
            same = (_norm_word(prev["word"]) != ""
                    and _norm_word(prev["word"]) == _norm_word(w["word"]))
            if ((shorter > 0 and overlap > 0.5 * shorter)
                    or (same and w["start"] < prev["end"] + 0.15)):
                dropped += 1
                continue
        out.append(w)
        last_src = src
    return out, dropped


def transcribe_via_groq_multilang(
    audio_path: str,
    initial_prompt: str | None = None,
    bucket_seconds: float = 5.0,
    initial_prompt_en: str | None = None,
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
    forced = _SPOKEN_LANGUAGE.get()
    if forced:
        # The uploader named the language (UX6): one pass in it, no
        # second English pass — a wrong detection can't happen.
        print(f"[groq] spoken language given: '{forced}' — one pass",
              flush=True)
        result = transcribe_via_groq(
            audio_path,
            initial_prompt=(initial_prompt_en or initial_prompt)
            if forced == "en" else initial_prompt,
            language=forced)
        # The code the user picked, not Groq's own reading of it (it
        # may answer with a full name, "portuguese", which the
        # normalisation would cut to "po").
        if result is not None:
            result["language"] = forced
        return result

    print("[groq] running multi-language two-pass transcription…",
          flush=True)
    pass_auto = transcribe_via_groq(audio_path,
                                    initial_prompt=initial_prompt,
                                    language=None)
    if pass_auto is None:  # Groq not configured
        return None

    detected_lang = pass_auto.get("language", "en")
    # Skip the English second pass if Whisper already thought the file
    # was English — no benefit, save the API call.
    if detected_lang == "en":
        print("[groq] auto pass detected 'en' — skipping second pass",
              flush=True)
        return pass_auto

    # The forced-English pass gets its own prompt (no German example
    # text), so German disfluency priming can't leak into it. A failure
    # raises (after retries) instead of quietly returning the auto pass:
    # English stretches would come out transliterated.
    pass_en = transcribe_via_groq(audio_path,
                                  initial_prompt=initial_prompt_en or initial_prompt,
                                  language="en")
    if pass_en is None:  # Groq not configured (can't happen here)
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

    picked: list[tuple[str, dict]] = []
    en_buckets = 0
    for bi in range(n_buckets):
        a = stats_auto[bi]
        e = stats_en[bi]
        a_avg = (a["sum"] / a["n"]) if a["n"] else 0.0
        e_avg = (e["sum"] / e["n"]) if e["n"] else 0.0
        # Pick the pass with the higher avg prob for this bucket.
        # Tie-break: prefer auto to avoid over-anglicising DE speech.
        if e["n"] > 0 and e_avg > a_avg + 0.02:
            picked.extend(("en", w) for w in e["words"])
            en_buckets += 1
        else:
            picked.extend(("auto", w) for w in a["words"])

    merged_words, dropped = _drop_boundary_duplicates(picked)
    print(f"[groq] multi-lang merge: {en_buckets}/{n_buckets} buckets "
          f"picked English pass"
          + (f", {dropped} boundary duplicate(s) dropped" if dropped else ""),
          flush=True)

    # Rebuild segments by grouping merged words into sentences based on
    # natural pauses (>0.6s gap → new segment).
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
