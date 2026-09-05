"""LLM helper layer — Claude Haiku for transcript polish + bad-take
detection + social-media caption generation.

Soft-fails when ANTHROPIC_API_KEY is missing: callers just get the
original input back, the pipeline continues. This way the web app keeps
working in dev without a key, and any feature using the LLM is opt-in
from the env-config side.

Cost per call (Haiku, June 2026):
  - cleanup + bad-take : ~$0.003 per 10-min video
  - social caption     : ~$0.001
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

# Auto-load repo-root .env so direct imports of this module (not just
# via FastAPI) pick up ANTHROPIC_API_KEY.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

_MODEL = "claude-haiku-4-5"
_MODEL_CLEANUP = "claude-haiku-4-5"       # fast + cheap, good enough for typo/filler fix
_MODEL_BAD_TAKE = "claude-sonnet-4-6"     # smarter model for judgment call on restarts
_MAX_TOKENS_CLEANUP = 4000
_MAX_TOKENS_BAD_TAKE = 1500
_MAX_TOKENS_SOCIAL = 800


# ---------------------------------------------------------------------------
# Python-side bad-take candidate filter — reduces the LLM's job to a
# short list of pre-vetted suspicious pairs instead of every phrase.
# ---------------------------------------------------------------------------

# Stopwords for content-word extraction. Kept language-agnostic: both
# German and English sets applied together (a token that's a stopword
# in either language gets dropped). Adding low-value discourse markers
# too so they don't inflate overlap counts.
_STOPWORDS_DE = frozenset([
    "der", "die", "das", "dass", "den", "dem", "des",
    "ein", "eine", "einen", "einem", "einer", "eines",
    "und", "oder", "aber", "denn", "weil", "ob",
    "ist", "sind", "war", "waren", "bin", "bist", "seid",
    "hat", "haben", "hatte", "hatten", "hätte", "hätten",
    "wird", "werden", "würde", "würden", "wurde", "wurden",
    "kann", "können", "konnte", "muss", "müssen", "soll", "sollen",
    "will", "wollen", "mag", "mögen", "darf", "dürfen",
    "ich", "du", "er", "sie", "es", "wir", "ihr",
    "mich", "dich", "sich", "uns", "euch", "mir", "dir", "ihm", "ihn", "ihnen",
    "mein", "dein", "sein", "unser", "euer", "ihre",
    "in", "an", "auf", "für", "mit", "von", "bei", "zu",
    "nach", "aus", "durch", "über", "unter", "vor", "hinter", "zwischen",
    "als", "wie", "so", "sehr", "auch", "noch", "nur", "mal", "schon",
    "dann", "jetzt", "hier", "da", "dort", "heute", "gestern", "morgen",
    "ja", "nein", "doch", "nicht", "kein", "keine",
    "man", "etwas", "nichts", "alles", "ganz", "eigentlich", "halt",
])

_STOPWORDS_EN = frozenset([
    "a", "an", "the", "and", "or", "but", "because", "if",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "has", "have", "had", "having",
    "will", "would", "shall", "should", "can", "could", "may", "might",
    "do", "does", "did", "done",
    "i", "you", "he", "she", "it", "we", "they",
    "me", "him", "her", "us", "them",
    "my", "your", "his", "our", "their", "its",
    "in", "on", "at", "for", "with", "from", "to", "of", "by", "about",
    "as", "like", "so", "very", "also", "still", "only", "just",
    "then", "now", "here", "there", "today", "yesterday", "tomorrow",
    "yes", "no", "not", "none", "some", "any", "all",
])

# Failure cues — words that suggest the speaker abandoned an attempt.
# Strong cues alone are enough (rare in normal speech unless restarting).
# Medium cues can be emphasis/rant — need corroboration.
_FAILURE_CUES_STRONG = frozenset([
    "nochmal", "moment", "warte", "sekunde", "stop",
    "wait", "hold", "again", "restart", "sorry",
])

_FAILURE_CUES_MEDIUM = frozenset([
    "scheiße", "scheisse", "mist", "verdammt", "kacke",
    "shit", "fuck", "damn", "crap",
])


def _tokenize(text: str) -> list[str]:
    """Lowercase, strip punctuation, split on whitespace."""
    if not text:
        return []
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    return [t for t in cleaned.split() if t]


def _content_words(text: str) -> set[str]:
    """Return the set of content words (non-stopword, len>1)."""
    stopwords = _STOPWORDS_DE | _STOPWORDS_EN
    return {t for t in _tokenize(text) if t not in stopwords and len(t) > 1}


def _failure_score(text: str) -> int:
    """Score how much a phrase looks like an abandoned take.

    Strong cue = 2 pts. Medium cue = 1 pt. Both types co-occurring in
    the same phrase = +1 bonus (e.g. 'scheiße nochmal' is a much
    stronger restart signal than either alone). Score >= 2 counts as
    a real failure signal.
    """
    tokens = set(_tokenize(text))
    strong = tokens & _FAILURE_CUES_STRONG
    medium = tokens & _FAILURE_CUES_MEDIUM
    score = 2 * len(strong) + len(medium)
    if strong and medium:
        score += 1
    return score


def find_bad_take_candidates(
    phrases: list[dict],
    max_gap_seconds: float = 2.0,
    strong_overlap_threshold: float = 0.7,
    weak_overlap_threshold: float = 0.3,
    lookahead: int = 3,
) -> list[tuple[int, int, str]]:
    """Pre-filter for bad-take detection.

    Returns list of (worse_id, better_id, reason) candidate pairs where:
    - B starts within max_gap_seconds after A ends (restarts are prompt)
    - Either:
      a) content-word overlap between A and B >= strong_overlap_threshold
         (clean restart with same words), OR
      b) A's failure score >= 2 AND overlap >= weak_overlap_threshold
         (A stumbled with 'scheiße nochmal' + B rephrases the intent)

    The LLM only judges pairs that pass this filter — so the LLM never
    even sees phrases that are obviously not restarts, cutting cost +
    false-positive risk.
    """
    candidates: list[tuple[int, int, str]] = []
    for i, a in enumerate(phrases):
        a_end = float(a.get("end") or 0)
        a_text = a.get("text", "") or ""
        a_words = _content_words(a_text)
        if not a_words:
            continue
        a_cue = _failure_score(a_text)

        for j in range(i + 1, min(i + 1 + lookahead, len(phrases))):
            b = phrases[j]
            b_start = float(b.get("start") or 0)
            gap = b_start - a_end
            if gap > max_gap_seconds:
                break  # too far — restarts don't wait long
            b_words = _content_words(b.get("text", "") or "")
            if not b_words:
                continue

            overlap = len(a_words & b_words) / min(len(a_words), len(b_words))

            reason = None
            if overlap >= strong_overlap_threshold:
                reason = f"overlap {overlap:.0%}"
            elif a_cue >= 2 and overlap >= weak_overlap_threshold:
                reason = f"failure-cue score {a_cue} + overlap {overlap:.0%}"

            if reason:
                a_id = int(a.get("id", i))
                b_id = int(b.get("id", j))
                candidates.append((a_id, b_id, reason))

    return candidates


def _client():
    """Lazy-create the Anthropic client. Returns None if no key set."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except Exception as e:
        print(f"[llm] anthropic init failed: {e}", flush=True)
        return None


def _extract_json(text: str) -> Any | None:
    """Pull the first valid JSON object out of the model response.

    Models sometimes wrap JSON in prose or code fences — strip those.
    """
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    # Find the first {...} block
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def cleanup_transcript(
    phrases: list[dict],
    language: str | None = None,
    brand: str = "Cleo",
) -> dict[int, str]:
    """Text-only cleanup — typos, brand canonicalization, filler removal.

    Runs on Haiku (fast + cheap). Does NOT decide anything about cuts.

    Returns {phrase_id: cleaned_text}. Empty on failure / no key.
    """
    if not phrases:
        return {}
    client = _client()
    if client is None:
        return {}

    payload = [
        {"id": int(p.get("id", i)), "text": (p.get("text", "") or "").strip()}
        for i, p in enumerate(phrases)
    ]
    lang_hint = f"The spoken language is {language}." if language else ""

    system = f"""You are a transcript editor for short-form video.

Clean up each phrase:
- Fix obvious speech-to-text typos (homophones, missed words).
- Canonicalize brand names. The product is called "{brand}" — replace
  misheard variants like "Clio", "Cleyo", "Klio", "Kleo" with "{brand}".
- Restore proper capitalization and end-of-sentence punctuation.
- REMOVE filler vocalisations from the visible text:
    DE: äh, ähm, ähhh, öh, öhm, ehm, hm, hmm, mhm, mmh
    EN: um, uh, uhm, uhh, hmm, hm, er, mhm
  Also collapse the resulting extra whitespace. Keep meaningful
  discourse markers ("also", "quasi", "you know") — they're only
  fillers when the speech-cut pipeline agrees.
- DO NOT paraphrase, rewrite, or change meaning. Keep speaker's voice.

{lang_hint}

Respond with ONLY a JSON object in this exact shape:
{{"phrases": [{{"id": 0, "cleaned": "Fixed text."}}, ...]}}
"""

    user_msg = json.dumps({"phrases": payload}, ensure_ascii=False)

    try:
        resp = client.messages.create(
            model=_MODEL_CLEANUP,
            max_tokens=_MAX_TOKENS_CLEANUP,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = "".join(
            getattr(b, "text", "") for b in (resp.content or [])
            if getattr(b, "type", None) == "text"
        )
    except Exception as e:
        print(f"[llm] cleanup call failed: {e}", flush=True)
        return {}

    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return {}

    cleaned: dict[int, str] = {}
    for entry in parsed.get("phrases", []) or []:
        try:
            pid = int(entry["id"])
            txt = str(entry.get("cleaned", "")).strip()
            if txt:
                cleaned[pid] = txt
        except (KeyError, TypeError, ValueError):
            continue
    return cleaned


def detect_bad_takes(
    phrases: list[dict],
    candidates: list[tuple[int, int, str]],
    language: str | None = None,
) -> list[int]:
    """LLM second-opinion on pre-filtered bad-take candidates.

    Uses Sonnet (bigger model, better judgment) but only when the
    Python filter has surfaced actual candidates — no candidates → no
    call, no cost.

    Args:
        phrases: full phrase list with RAW text (fillers and failure
            cues MUST still be in there — they're the LLM's evidence).
        candidates: (worse_id, better_id, python_reason) tuples from
            find_bad_take_candidates().
        language: ISO code hint.

    Returns: list of phrase_ids the LLM confirms as bad takes.
    """
    if not candidates:
        return []
    client = _client()
    if client is None:
        return []

    by_id = {int(p.get("id", i)): p for i, p in enumerate(phrases)}
    pids_sorted = sorted(by_id.keys())

    # Include 1 phrase of neighboring context around each candidate so
    # the LLM sees flow (was this an emotional rant → follow-up, or a
    # genuine restart?).
    context_ids: set[int] = set()
    for (a_id, b_id, _reason) in candidates:
        context_ids.update([a_id, b_id])
        for pid in (a_id, b_id):
            try:
                idx = pids_sorted.index(pid)
                if idx > 0:
                    context_ids.add(pids_sorted[idx - 1])
                if idx + 1 < len(pids_sorted):
                    context_ids.add(pids_sorted[idx + 1])
            except ValueError:
                pass

    context_phrases = [
        {"id": pid, "text": (by_id[pid].get("text", "") or "").strip()}
        for pid in sorted(context_ids)
    ]
    candidate_pairs = [
        {"worse_id": a_id, "better_id": b_id, "python_reason": reason}
        for (a_id, b_id, reason) in candidates
    ]
    lang_hint = f"The spoken language is {language}." if language else ""

    system = f"""You judge bad-take restarts in short-form video transcripts.

A Python heuristic has already flagged candidate pairs. Your job is to
CONFIRM or REJECT each — you have the final say. Reject aggressively
when in doubt: leaving one extra sentence in the video is far less
damaging than deleting real content.

A bad take is when the speaker abandoned an attempt (usually stumbled
with "äh", "scheiße", "nochmal", or trailed off) and re-said the SAME
intended thought in a later phrase. Only remove the WORSE version.

DO NOT flag these (they look similar but are NOT bad takes):

1. Emotional outburst / rant / cursing followed by a CONTINUATION of
   the thought (not a rephrase of the same sentence):
     A: "Ich hasse es wenn Leute zu spät kommen, verdammt nochmal"
     B: "Deshalb sag ich immer: sei pünktlich"
   → B is a follow-up conclusion, NOT a restart of A. REJECT.

2. Intentional repetition for emphasis / rhetorical effect:
     A: "Das ist wichtig."
     B: "Das ist WIRKLICH wichtig."
   → Rhetorical device. REJECT.

3. Two related sentences on the same topic that use similar words but
   make DIFFERENT points:
     A: "Löwen sind gefährlich"
     B: "Tiger sind sogar gefährlicher als Löwen"
   → Different comparison, not a restart. REJECT.

4. Lists, refrains, callbacks to earlier phrases:
     A: "Erstens: früh aufstehen."
     B: "Zweitens: früh anfangen."
   → Structured list. REJECT.

CONFIRM as bad take only when B is a CLEANER RE-EXPRESSION of the
same intended thought A was trying to convey. Prototypical case:
   A: "Der wichtigste Trick ist scheiße wie war das nochmal"
   B: "Der wichtigste Trick ist morgens um 6 aufzustehen"
→ A trails off + B completes the same intended sentence. CONFIRM.

{lang_hint}

Respond with ONLY a JSON object:
{{
  "confirmed_bad_takes": [worse_id, ...],
  "reasons": {{"worse_id_as_string": "one-line reason for confirm or reject"}}
}}

Include a reason for EVERY candidate (both confirmed and rejected),
so we can debug false-positives / false-negatives later.
"""

    user_msg = json.dumps({
        "context_phrases": context_phrases,
        "candidate_pairs": candidate_pairs,
    }, ensure_ascii=False)

    try:
        resp = client.messages.create(
            model=_MODEL_BAD_TAKE,
            max_tokens=_MAX_TOKENS_BAD_TAKE,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = "".join(
            getattr(b, "text", "") for b in (resp.content or [])
            if getattr(b, "type", None) == "text"
        )
    except Exception as e:
        print(f"[llm] bad-take call failed: {e}", flush=True)
        return []

    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return []

    confirmed: list[int] = []
    for x in parsed.get("confirmed_bad_takes", []) or []:
        try:
            confirmed.append(int(x))
        except (TypeError, ValueError):
            continue

    reasons = parsed.get("reasons") or {}
    if reasons:
        print(f"[llm] bad-take reasoning: {reasons}", flush=True)

    return confirmed


def detect_hook_moments(
    phrases: list[dict],
    language: str | None = None,
    max_clips: int = 3,
    min_seconds: float = 20.0,
    max_seconds: float = 60.0,
) -> list[dict]:
    """Find the top short-form hook moments in a long-form transcript.

    Args:
        phrases: list of {"id": int, "text": str, "start": float, "end": float}
            in final-render timeline order.
        language: ISO code (informs the model).
        max_clips: hard cap on returned clips.
        min_seconds, max_seconds: hook duration window.

    Returns:
        list of {"start": float, "end": float, "title": str, "reason": str}
        in score-desc order. Empty on no-key / failure.
    """
    if not phrases:
        return []
    client = _client()
    if client is None:
        return []

    payload = [
        {
            "id": p.get("id", i),
            "text": p.get("text", "").strip(),
            "start": float(p.get("start", 0)),
            "end": float(p.get("end", 0)),
        }
        for i, p in enumerate(phrases)
    ]
    lang_hint = f"The content is in {language}." if language else ""
    total_dur = phrases[-1].get("end", 0) if phrases else 0

    system = f"""You are a short-form video producer finding viral hook
moments inside a longer video transcript.

Pick UP TO {max_clips} non-overlapping moments that would each work as
a {int(min_seconds)}-{int(max_seconds)} second standalone clip for
TikTok / Reels / Shorts. Look for:
  - Strong punchlines / surprising statements
  - Concrete wow-facts or counterintuitive claims
  - Emotional peaks (laughter, frustration, excitement)
  - Self-contained mini-stories with setup + payoff

DO NOT pick:
  - Generic intros ("hi guys welcome back")
  - Mid-sentence cutoffs
  - Boring transitions

{lang_hint}
Total transcript duration: {total_dur:.0f}s.

Respond with ONLY a JSON object:
{{
  "clips": [
    {{
      "start": 12.5,
      "end": 42.0,
      "title": "Short clickbait-ish title (under 50 chars)",
      "reason": "Why this is a hook (one sentence)"
    }}
  ]
}}

Use TIME RANGES that align with phrase boundaries — pick a phrase's
start time as your start, a later phrase's end time as your end. Stay
within {int(min_seconds)}-{int(max_seconds)} seconds total per clip.
"""

    user_msg = json.dumps({"phrases": payload}, ensure_ascii=False)
    try:
        resp = client.messages.create(
            model=_MODEL,
            max_tokens=2000,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = "".join(
            getattr(b, "text", "") for b in (resp.content or [])
            if getattr(b, "type", None) == "text"
        )
    except Exception as e:
        print(f"[llm] hook-detection call failed: {e}", flush=True)
        return []

    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return []
    out: list[dict] = []
    for c in parsed.get("clips", []) or []:
        try:
            s = float(c["start"])
            e = float(c["end"])
            if e - s < min_seconds * 0.7 or e - s > max_seconds * 1.3:
                continue  # outside acceptable bounds
            out.append({
                "start": round(max(0.0, s), 2),
                "end": round(max(s + 1.0, e), 2),
                "title": str(c.get("title", "Clip"))[:80],
                "reason": str(c.get("reason", "")),
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out[:max_clips]


def generate_social_caption(
    full_transcript: str,
    language: str | None = None,
) -> dict[str, Any]:
    """Generate a short-form caption + hashtags for the final render."""
    if not full_transcript.strip():
        return {"caption": "", "hashtags": []}
    client = _client()
    if client is None:
        return {"caption": "", "hashtags": []}

    lang_hint = (
        f"Write the caption in {language}."
        if language else
        "Write the caption in the same language as the transcript."
    )

    system = f"""You write social-media captions for TikTok / Reels / Shorts.

Read the transcript. Return ONE punchy caption (under 220 chars,
hook in the first 6 words, no emojis unless it's the brand vibe)
and 4-6 relevant hashtags.

{lang_hint}

Respond with ONLY a JSON object:
{{"caption": "...", "hashtags": ["tag", "tag"]}}
"""

    try:
        resp = client.messages.create(
            model=_MODEL,
            max_tokens=_MAX_TOKENS_SOCIAL,
            system=system,
            messages=[{"role": "user", "content": full_transcript[:6000]}],
        )
        text = "".join(
            getattr(b, "text", "") for b in (resp.content or [])
            if getattr(b, "type", None) == "text"
        )
    except Exception as e:
        print(f"[llm] social-caption call failed: {e}", flush=True)
        return {"caption": "", "hashtags": []}

    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return {"caption": "", "hashtags": []}
    caption = str(parsed.get("caption", "")).strip()
    hashtags = [
        str(h).lstrip("#").strip()
        for h in (parsed.get("hashtags") or [])
        if str(h).strip()
    ]
    return {"caption": caption, "hashtags": hashtags}
