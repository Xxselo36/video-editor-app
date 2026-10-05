"""Transcribe one span of a job's recording on demand (backlog #20,
POST /jobs/{id}/transcribe-span; the route is in backend/main.py).

When the v2 editor restores, extends or trims a clip into footage the
edit doc has no words for — the analysis cut it (silence) so Whisper
never heard it as speech, or a silence hallucination was hidden — it
asks for that span alone:

    {start, end, base_rev, rev}  (SOURCE seconds; ≤ MAX_SPAN_S)
    → {words: [Word], rev, changed}

1. The span is cut from the job's proxy (else the mezzanine) with
   ffmpeg, CONTEXT_S of audio around it so Whisper hears whole words: a
   local file, or with R2 a ranged read over a presigned GET (ffmpeg's
   -ss before -i seeks by byte ranges; nothing is downloaded whole).
2. It goes to Groq through backend/whisper_groq.py, with the analysis'
   language handling (transcribe_via_groq_multilang inside
   spoken_language(settings.spoken_language)).
3. The words whose middle lies in the span — and not inside a word the
   doc already has — become doc words (backend/doc.py
   words_from_transcript: filler sounds flagged and hidden; a run that
   reads like a silence hallucination is hidden), ids "t<ms>" (unique
   in the doc), and are merged with the doc's own PATCH rule
   (apply_prepared: base_rev must be the stored rev, rev newer; the
   merge places them by start). The span is recorded in
   doc["spans"] as [start, end, prev_rev, rev].

Idempotent: a span that already has words, or lies inside a recorded
span (Whisper found nothing there before), is not transcribed again —
the answer is the words the doc has there, changed false. When the
recorded span was written on exactly this base_rev and is the doc's
latest change (a retry whose first answer was lost), changed is true:
the client may take that rev as its own.

Billing is off for this: a span transcription is never charged (no
minutes, no credits) — its cost is a few cents of Groq per hour of
spans, bounded by the rate limit and the span cap.
"""
from __future__ import annotations

import math
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from backend import doc as edit_doc

# Longest span per call (seconds of the source).
MAX_SPAN_S = 60.0
# Shortest span worth a call (the editor asks from 0.5 s).
MIN_SPAN_S = 0.2
# Audio before / after the span sent along (whole words at the edges).
CONTEXT_S = 0.6
# Spans remembered in the doc (oldest dropped).
MAX_RECORDED = 200
# Calls per minute per user (anonymous: per job).
RATE_PER_MIN = 20
FFMPEG_TIMEOUT_S = 120


class SpanError(Exception):
    """A refusal: (status, code, extra) for main.py's ApiRefusal."""

    def __init__(self, status: int, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.extra = extra


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def parse(payload: Any, duration: float | None) -> dict[str, float]:
    """{start, end, base_rev, rev} checked. Raises SpanError 400."""
    if not isinstance(payload, dict) or set(payload) - {"start", "end", "base_rev", "rev"}:
        raise SpanError(400, "invalid_payload")
    s, e = payload.get("start"), payload.get("end")
    if not (_num(s) and _num(e)) or s < 0 or e <= s:
        raise SpanError(400, "invalid_payload", field="start")
    if e - s > MAX_SPAN_S + 1e-6:
        raise SpanError(400, "invalid_payload", field="end", max_s=MAX_SPAN_S)
    if e - s < MIN_SPAN_S:
        raise SpanError(400, "invalid_payload", field="end", min_s=MIN_SPAN_S)
    if duration and duration > 0 and s >= duration:
        raise SpanError(400, "invalid_payload", field="start")
    base, rev = payload.get("base_rev"), payload.get("rev")
    if not (_num(base) and _num(rev)):
        raise SpanError(400, "bad_rev")
    end = min(float(e), float(duration)) if duration and duration > 0 else float(e)
    return {"start": edit_doc.round_ms(float(s)), "end": edit_doc.round_ms(end),
            "base_rev": float(base), "rev": float(rev)}


# ── the doc side ─────────────────────────────────────────────────────


def _speech(w: dict) -> bool:
    """A word that counts as text there: not a hidden silence
    hallucination (hidden + nospeech)."""
    return not (w.get("hidden") and w.get("nospeech"))


def _mid(w: dict) -> float:
    return (float(w["start"]) + float(w["end"])) / 2


def words_in(doc: dict, start: float, end: float) -> list[dict]:
    """The doc's words whose middle lies in [start, end]."""
    return [w for w in doc.get("words") or [] if start <= _mid(w) <= end]


def _recorded(doc: dict) -> list[list[float]]:
    out = []
    for r in doc.get("spans") or []:
        if isinstance(r, list) and len(r) == 4 and all(_num(x) for x in r):
            out.append([float(x) for x in r])
    return out


def covered(doc: dict, start: float, end: float) -> list[float] | bool:
    """Is there nothing to transcribe in [start, end]? The recorded span
    that holds it (a list), True when speech words are there, else
    False."""
    for r in _recorded(doc):
        if r[0] - 0.05 <= start and end <= r[1] + 0.05:
            return r
    return any(_speech(w) for w in words_in(doc, start, end))


def new_words(raw: list[dict], offset: float, start: float, end: float,
              doc: dict) -> list[dict]:
    """Doc words of a span's transcription (`raw` timed from `offset`):
    the ones whose middle is in [start, end] and not inside a word the
    doc has; ids "t<ms>" unique in the doc."""
    shifted = []
    for w in raw:
        try:
            s, e = float(w["start"]) + offset, float(w["end"]) + offset
        except (KeyError, TypeError, ValueError):
            continue
        shifted.append({**w, "start": max(0.0, s), "end": max(0.0, e)})
    built = edit_doc.words_from_transcript(shifted)
    old = doc.get("words") or []
    spans = [(float(w["start"]), float(w["end"])) for w in old]
    keep = []
    for w in built:
        m = _mid(w)
        if not (start <= m <= end):
            continue
        if any(a < m < b for a, b in spans):
            continue
        keep.append(w)
    # a whole span that reads like Whisper's silence inventions stays hidden
    text = " ".join(str(w["text"]) for w in keep)
    if keep and edit_doc._SILENCE_HALLUCINATIONS.search(text):
        for w in keep:
            w["hidden"] = True
            w["nospeech"] = True
    taken = {w["id"] for w in old}
    out = []
    for w in keep:
        base = f"t{int(round(w['start'] * 1000))}"
        wid, k = base, 1
        while wid in taken:
            k += 1
            wid = f"{base}-{k}"
        taken.add(wid)
        out.append({**{k2: v for k2, v in w.items() if k2 != "id"}, "id": wid})
    return [edit_doc.validate_word(w) for w in out]


def commit(doc: dict, cur_rev: float, span: dict[str, float],
           words: list[dict], duration: float | None) -> tuple[dict, float]:
    """`doc` with `words` merged (the PATCH rule: base_rev == stored rev,
    rev newer; raises DocError 409 stale_rev) and the span recorded."""
    prep = {"base_rev": span["base_rev"], "rev": span["rev"],
            "words": (words, [])}
    new, rev = edit_doc.apply_prepared(doc, cur_rev, prep, duration=duration)
    rec = _recorded(doc) + [[span["start"], span["end"], float(cur_rev or 0), rev]]
    new["spans"] = rec[-MAX_RECORDED:]
    return new, rev


# ── media and Groq ───────────────────────────────────────────────────


def extract_audio(source: str, start: float, duration: float, out: str) -> None:
    """[start, start + duration] of `source` (a path or an http(s) URL)
    as 16 kHz mono AAC. Input seeking (-ss before -i): over a presigned
    URL ffmpeg reads byte ranges around the span, not the file."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y",
           "-ss", f"{start:.3f}", "-i", source, "-t", f"{duration:.3f}",
           "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k",
           out]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       timeout=FFMPEG_TIMEOUT_S)
    if r.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        raise RuntimeError(f"ffmpeg span extract failed: {r.stderr[-300:]}")


def raw_words(result: dict | None) -> list[dict]:
    """Word timings of a whisper_groq result."""
    out = []
    for seg in (result or {}).get("segments") or []:
        for w in seg.get("words") or []:
            if w.get("start") is None or w.get("end") is None:
                continue
            out.append({"word": w.get("word", ""), "start": w["start"],
                        "end": w["end"],
                        "probability": w.get("probability", 1.0)})
    return out


def transcribe(source: str, span: dict[str, float], language: str | None,
               duration: float | None) -> tuple[list[dict], float]:
    """(raw words timed from the returned offset, offset) of the span of
    `source`. Raises SpanError 503 when Groq isn't configured, 502 when
    the call or ffmpeg failed."""
    from backend import whisper_groq
    a = max(0.0, span["start"] - CONTEXT_S)
    b = span["end"] + CONTEXT_S
    if duration and duration > 0:
        b = min(b, float(duration))
    with tempfile.TemporaryDirectory(prefix="cleo-span-") as tmp:
        out = str(Path(tmp) / "span.m4a")
        try:
            extract_audio(source, a, max(0.05, b - a), out)
        except (RuntimeError, subprocess.TimeoutExpired, OSError) as e:
            print(f"[span] {e}", flush=True)
            raise SpanError(502, "transcription_unavailable") from None
        try:
            with whisper_groq.spoken_language(language):
                result = whisper_groq.transcribe_via_groq_multilang(out)
        except whisper_groq.GroqTranscriptionError as e:
            print(f"[span] groq failed: {e}", flush=True)
            raise SpanError(502, "transcription_unavailable") from None
    if result is None:
        raise SpanError(503, "transcription_unavailable")
    return raw_words(result), a
