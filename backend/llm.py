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
_MAX_TOKENS_CLEANUP = 4000
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
    "dann", "jetzt", "hier", "da", "dort",
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
    "then", "now", "here", "there",
    "yes", "no", "not", "none", "some", "any", "all",
])

def _tokenize(text: str) -> list[str]:
    """Lowercase, strip punctuation, split on whitespace."""
    if not text:
        return []
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    return [t for t in cleaned.split() if t]


# Filler vocalisations — dropped from content-word extraction so
# "Heute geht es um äh Selbstdisziplin" and "Heute geht es um
# Selbstdisziplin" have identical content sets (100% Jaccard).
_FILLERS = frozenset([
    "äh", "ähm", "ähhh", "öh", "öhm", "ehm",
    "hm", "hmm", "mhm", "mmh", "hä",
    "um", "uh", "uhm", "uhh", "er", "erm",
])


def _content_words(text: str) -> set[str]:
    """Return the set of content words (non-stopword, non-filler, len>1)."""
    stopwords = _STOPWORDS_DE | _STOPWORDS_EN | _FILLERS
    return {t for t in _tokenize(text) if t not in stopwords and len(t) > 1}


def find_duplicate_bad_takes(
    phrases: list[dict],
    similarity_threshold: float = 0.85,
    max_gap_seconds: float = 3.0,
    min_content_words: int = 2,
    lookahead: int = 3,
) -> list[tuple[int, int, float]]:
    """Deterministic near-duplicate detection — no LLM, no judgment.

    Returns list of (drop_id, keep_id, similarity) tuples where an
    earlier phrase A should be dropped in favour of a later phrase B
    because they are near-identical text spoken close in time.

    All three conditions must hold:
    1. Jaccard overlap of content words (stopwords ignored) >= threshold
    2. B starts within max_gap_seconds of A ending (restarts are prompt)
    3. Both A and B have at least min_content_words content words
       (avoids cutting duplicate short interjections like "ja ja")

    This catches only OBVIOUS restarts where the user said essentially
    the same sentence twice. Subtler bad takes ("scheiße nochmal" +
    a rephrase with different words) are NOT caught — that's the
    intentional tradeoff for zero-false-positive behavior.
    """
    to_drop: list[tuple[int, int, float]] = []
    dropped_ids: set[int] = set()

    for i, a in enumerate(phrases):
        a_id = int(a.get("id", i))
        if a_id in dropped_ids:
            continue
        a_content = _content_words(a.get("text", "") or "")
        if len(a_content) < min_content_words:
            continue
        a_end = float(a.get("end") or 0)

        for j in range(i + 1, min(i + 1 + lookahead, len(phrases))):
            b = phrases[j]
            b_id = int(b.get("id", j))
            if b_id in dropped_ids:
                continue
            b_start = float(b.get("start") or 0)
            if b_start - a_end > max_gap_seconds:
                break
            b_content = _content_words(b.get("text", "") or "")
            if len(b_content) < min_content_words:
                continue

            # Jaccard: |A ∩ B| / |A ∪ B| — symmetric, rewards near-
            # identity, penalises when one phrase has extra content
            # words the other lacks.
            intersection = len(a_content & b_content)
            union = len(a_content | b_content)
            jaccard = intersection / union if union > 0 else 0.0

            if jaccard >= similarity_threshold:
                to_drop.append((a_id, b_id, jaccard))
                dropped_ids.add(a_id)
                break  # A is dropped, don't compare further

    return to_drop


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
