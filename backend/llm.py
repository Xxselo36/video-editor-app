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
_MODEL_COMMAND_FIX = "claude-haiku-4-5"   # short call, contextual reasoning fine on Haiku
_MAX_TOKENS_CLEANUP = 4000
_MAX_TOKENS_COMMAND_FIX = 800
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


def correct_voice_commands(
    transcription: dict[str, Any],
    language: str | None = None,
    brand: str = "Cleo",
) -> dict[str, Any]:
    """Post-process Whisper transcription to fix misheard voice commands.

    Whisper often mangles 'Cleo <cmd>' in mixed-language audio:
    'Cleo restart' → 'Cleo is what', 'Cleo finish' → 'Clear finish',
    'Cleo start' → 'Cleo ist ab'. Hand-coding every variant is
    whack-a-mole; the LLM sees full context and can identify likely
    commands even in novel mishearings.

    Runs on the raw whisper transcription (segments with per-word
    timestamps). For each identified correction, mutates the affected
    word tokens IN PLACE so downstream voice-trigger / scene-trigger
    detection sees clean command phrases.

    Args:
        transcription: Whisper output {segments: [{words: [...]}]}.
        language: ISO code hint for the LLM.
        brand: canonical wake word.

    Returns:
        The transcription (same object, mutated) plus a debug list of
        corrections applied under key '_command_corrections'.

    Soft-fails on no key / model error — returns transcription unchanged.
    """
    if not transcription:
        return transcription
    client = _client()
    if client is None:
        return transcription

    # Flatten all words with global index
    all_words: list[dict[str, Any]] = []
    for seg in transcription.get("segments") or []:
        for w in seg.get("words") or []:
            all_words.append(w)
    if not all_words:
        return transcription

    # Build a compact indexed transcript for the LLM
    indexed = [
        {"i": i, "w": (w.get("word", "") or "").strip()}
        for i, w in enumerate(all_words)
    ]
    lang_hint = f"Spoken language: {language}." if language else ""

    system = f"""You correct misheard voice commands in a video transcript.

The user records short videos with these voice commands to control
editing at recording time:
  '{brand} start'   — begin a take
  '{brand} cut'     — discard the current take, restart
  '{brand} keep'    — commit the current take, next scene
  '{brand} finish'  — end the video
  '{brand} stop'    — mark a bad sentence (paired with 'go')
  '{brand} go'      — resume after 'stop'

Whisper often mishears these in mixed English/German audio. Known patterns:
  - '{brand}' → 'clear', 'clara', 'kleo', 'klio', 'cleer', 'clean', 'kilo'
  - 'start'   → 'ist ab', 'istab', 'is auf', 'ist tough', 'is doof'
  - 'cut'     → 'kutt', 'kot', 'gut', 'kurt', 'schnitt'
  - 'keep'    → 'kip', 'kiep', 'geeb', 'behalten' (DE-legit)
  - 'finish'  → 'finnisch', 'fenish', 'finito', 'finished'
  - 'stop'    → 'stopp', 'top', 'halt'
  - 'go'      → 'goes', 'los', 'weiter', 'gone'

You get the transcript as an array of tokens with indices. Find spots
where the user LIKELY said a voice command but Whisper misheard. A
strong signal is 2-3 consecutive tokens where:
  1. The first token phonetically resembles '{brand}' (starts with 'k'
     or 'cl' sound, ends in vowel), AND
  2. The following 1-2 tokens phonetically resemble a command word

Also consider position: video intros often START with a command
('Cleo start'), video ends often FINISH with one ('Cleo finish').

BE CONSERVATIVE. Only correct when you are >90% confident it was a
mangled command. When in doubt, leave the transcript alone — a wrong
correction cuts real content out of the video.

{lang_hint}

Respond with ONLY a JSON object:
{{
  "corrections": [
    {{"start_index": 42, "end_index": 43, "original": "clear finish",
      "corrected_to": "cleo finish"}},
    ...
  ]
}}

Empty corrections list is a valid answer.
"""

    user_msg = json.dumps({"tokens": indexed}, ensure_ascii=False)

    try:
        resp = client.messages.create(
            model=_MODEL_COMMAND_FIX,
            max_tokens=_MAX_TOKENS_COMMAND_FIX,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = "".join(
            getattr(b, "text", "") for b in (resp.content or [])
            if getattr(b, "type", None) == "text"
        )
    except Exception as e:
        print(f"[llm] command-fix call failed: {e}", flush=True)
        return transcription

    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return transcription

    corrections = parsed.get("corrections") or []
    if not corrections:
        return transcription

    # Apply corrections IN PLACE: replace the text of the token range
    # with the corrected phrase's tokens. Keep original timestamps —
    # the LLM only fixes the word text.
    applied: list[dict[str, Any]] = []
    for c in corrections:
        try:
            s_i = int(c.get("start_index"))
            e_i = int(c.get("end_index"))
            corrected = str(c.get("corrected_to", "")).strip()
        except (TypeError, ValueError):
            continue
        if not corrected or s_i < 0 or e_i >= len(all_words) or e_i < s_i:
            continue

        corr_tokens = corrected.split()
        span = e_i - s_i + 1
        # If the corrected phrase has the same token count as the
        # span, do a 1:1 replace. Otherwise map best-effort: distribute
        # tokens across the span, padding/joining as needed.
        if len(corr_tokens) == span:
            for offset, tok in enumerate(corr_tokens):
                all_words[s_i + offset]["word"] = tok
        elif len(corr_tokens) < span:
            # Fewer corrected tokens than span → put them in the first
            # slots, mark the rest as empty (they'll be stripped later)
            for offset, tok in enumerate(corr_tokens):
                all_words[s_i + offset]["word"] = tok
            for offset in range(len(corr_tokens), span):
                all_words[s_i + offset]["word"] = ""
        else:
            # More corrected tokens than span → cram the extras into
            # the last slot as a single joined word.
            for offset in range(span - 1):
                all_words[s_i + offset]["word"] = corr_tokens[offset]
            all_words[s_i + span - 1]["word"] = " ".join(corr_tokens[span - 1:])

        applied.append({
            "range": [s_i, e_i],
            "from": c.get("original", ""),
            "to": corrected,
        })

    if applied:
        print(f"[cmd-fix] applied {len(applied)} correction(s): {applied}",
              flush=True)

    transcription["_command_corrections"] = applied
    return transcription


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
