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
_MAX_TOKENS_CLEANUP = 4000
_MAX_TOKENS_SOCIAL = 800


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


def cleanup_and_detect_bad_takes(
    phrases: list[dict],
    language: str | None = None,
    brand: str = "Cleo",
) -> dict[str, Any]:
    """Single Claude call: fix typos + detect repeated bad takes.

    Args:
        phrases: list of {"id": int, "text": str, "start": float, "end": float}
            already grouped to sentence level.
        language: ISO code like "de" or "en" (informs the model).
        brand: canonical brand name (e.g. "Cleo"). Whisper often hears
            "Clio"/"Cleyo"/"Klio" — Claude canonicalizes to this string.

    Returns:
        {
            "cleaned": {phrase_id: "fixed text", ...},
            "bad_takes": [phrase_id_to_drop, ...],
        }
        Empty dict on no-key or failure.
    """
    if not phrases:
        return {"cleaned": {}, "bad_takes": []}
    client = _client()
    if client is None:
        return {"cleaned": {}, "bad_takes": []}

    payload = [
        {"id": p.get("id", i), "text": p.get("text", "").strip()}
        for i, p in enumerate(phrases)
    ]
    lang_hint = f"The spoken language is {language}." if language else ""

    system = f"""You are a transcript editor for short-form video.

Two tasks, one JSON response:

1. CLEAN UP each phrase — CONSERVATIVE EDITING ONLY:
   - Fix obvious speech-to-text typos (homophones, missed words).
   - Canonicalize brand names. The product is called "{brand}" — replace
     misheard variants like "Clio", "Cleyo", "Klio", "Kleo" with "{brand}".
   - Restore proper capitalization and end-of-sentence punctuation.
   - REMOVE filler vocalisations from the visible text:
       DE: äh, ähm, ähhh, öh, öhm, ehm, hm, hmm, mhm, mmh
       EN: um, uh, uhm, uhh, hmm, hm, er, mhm
     Also collapse the resulting extra whitespace.
   - HARD RULES — violating any means you must return the input unchanged:
     * NEVER add words that weren't in the source. If a sentence feels
       incomplete, KEEP IT INCOMPLETE. The user's speech was cut mid-
       thought; do not invent a completion.
     * NEVER paraphrase, rewrite, or replace one phrasing with another.
     * NEVER add "Sprachbefehl", "Kommando", "Cut", or explanatory nouns
       the source doesn't already contain.
     * If unsure whether an edit is safe, RETURN THE ORIGINAL UNCHANGED.
   - Keep the speaker's voice, register, and word order exactly.

2. DETECT BAD TAKES — phrases where the speaker abandoned an attempt
   and re-said the same thing better in a later phrase:
   - Mark only the WORSE version (more fillers, incomplete, less fluent).
   - Be CONSERVATIVE: only mark if you're >80% sure it's a repeat take.
   - Never mark intentional repetition (emphasis, lists, refrains).

{lang_hint}

Respond with ONLY a JSON object in this exact shape:
{{
  "phrases": [{{"id": 0, "cleaned": "Fixed text."}}, ...],
  "bad_takes": [3, 7]
}}
"""

    user_msg = json.dumps({"phrases": payload}, ensure_ascii=False)

    try:
        resp = client.messages.create(
            model=_MODEL,
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
        return {"cleaned": {}, "bad_takes": []}

    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return {"cleaned": {}, "bad_takes": []}

    # Similarity guard: if the LLM invented new content, revert to the
    # original. Compare token sets — cleanup should REMOVE fillers /
    # canonicalize existing words, never introduce nouns like "Cut" or
    # "Sprachbefehl" that weren't in the source. If the cleaned version
    # has >30% new tokens the model wasn't supposed to know, drop it.
    orig_by_id = {int(p.get("id", i)): (p.get("text") or "").strip()
                  for i, p in enumerate(phrases)}

    def _tokens(s: str) -> set[str]:
        return {t for t in re.findall(r"\w+", s.lower()) if len(t) > 1}

    cleaned: dict[int, str] = {}
    for entry in parsed.get("phrases", []) or []:
        try:
            pid = int(entry["id"])
            txt = str(entry.get("cleaned", "")).strip()
            if not txt:
                continue
            orig = orig_by_id.get(pid, "")
            if orig:
                orig_toks = _tokens(orig)
                new_toks = _tokens(txt) - orig_toks
                # Allow a small number of edits (typo fixes swap tokens),
                # but reject anything that looks like hallucinated content.
                if orig_toks and len(new_toks) / max(1, len(orig_toks)) > 0.3:
                    print(f"[llm] rejected cleanup for phrase {pid}: "
                          f"added tokens {new_toks}", flush=True)
                    continue
            cleaned[pid] = txt
        except (KeyError, TypeError, ValueError):
            continue

    bad_takes: list[int] = []
    for x in parsed.get("bad_takes", []) or []:
        try:
            bad_takes.append(int(x))
        except (TypeError, ValueError):
            continue

    return {"cleaned": cleaned, "bad_takes": bad_takes}


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
