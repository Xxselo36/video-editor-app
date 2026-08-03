"""Voice-Trigger Editing.

User sagt während der Aufnahme bestimmte Keywords um Bereiche markieren
zu lassen, die später automatisch rausgeschnitten werden:

    - CUT-Marker (Fehlversuch beginnt): "cut", "schnitt", "scheiße",
      "nochmal", "scrap that", "redo", "stop"
    - CONTINUE-Marker (Fehlversuch endet, ab hier geht's weiter):
      "weiter", "okay", "los", "continue", "go"

Beispiel im Transkript:
    "Heute will ich über X reden ... äh scheiße ... weiter heute will
     ich über X reden"
                       ↑                ↑
                       cut-Marker       continue-Marker

→ Plugin entfernt aus den Speech-Segmenten den Bereich vom Start des
  cut-Markers bis zum Ende des continue-Markers (inkl. der Trigger-
  Wörter selbst, damit sie nicht im finalen Video zu hören sind).

Wenn nach einem cut-Marker kein continue-Marker kommt (z.B. weil der
User vergessen hat es zu sagen), greift ein Fallback: wir entfernen
bis zum Ende des Audios / Clips — schlauer wäre "Sentence-Boundary
Erkennung" aber das ist v1.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


# Cleo-Wake-Word plus Whisper-Mishears. We accept anything within
# Levenshtein-1 of these below, so even "kleu kut" or "clear cat"
# still fires. "Clio" (Renault car) never appears with cut/go in
# normal speech — safe as a trigger.
DEFAULT_CUT_KEYWORDS = [
    "cleo cut", "clio cut", "cleyo cut", "klio cut", "kleo cut",
    "clea cut", "leo cut", "kleu cut", "cleo cat", "cleo cart",
    "cleo caught", "clear cut",
]
DEFAULT_CONTINUE_KEYWORDS = [
    "cleo go", "clio go", "cleyo go", "klio go", "kleo go",
    "clea go", "leo go", "kleu go", "cleo goh", "cleo goal",
]


def _levenshtein(a: str, b: str) -> int:
    """Small edit-distance for fuzzy trigger matching (words only)."""
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr.append(min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost))
        prev = curr
    return prev[-1]


def _token_matches(whisper_tok: str, target_tok: str) -> bool:
    """True if Whisper's token matches a trigger token exactly OR is
    within 1 edit (handles Whisper's typical drift on wake words)."""
    if whisper_tok == target_tok:
        return True
    # Allow 1 edit for short words, 2 for longer ones
    max_edits = 1 if len(target_tok) <= 4 else 2
    return _levenshtein(whisper_tok, target_tok) <= max_edits


@dataclass
class VoiceTriggerPair:
    """One detected cut→continue pair.

    Times are seconds from clip start; trigger words are the literal
    Whisper-detected words for logging/debugging.
    """
    cut_start: float       # Start of the cut-marker word
    continue_end: float    # End of the continue-marker word
    cut_word: str
    continue_word: str | None  # None if no matching continue found


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation. Used for matching keywords."""
    return re.sub(r"[^\w\s]", " ", text.lower()).strip()


def _match_phrase_at(word_idx: int, whisper_words: list[dict],
                      phrase: str) -> tuple[int, float, float] | None:
    """Try to match `phrase` at whisper_words[word_idx]. Two forms:

    1) Multi-token: phrase tokens map to consecutive Whisper words
       (e.g. phrase="cleo cut" → words ["cleo", "cut"]).
    2) Concatenated single-token: phrase with spaces removed matches a
       single Whisper word (e.g. phrase="cleo cut" → word "cleocut" —
       happens when the user speaks the trigger fast and Whisper merges
       the two tokens into one).

    Returns (next_idx, phrase_start_time, phrase_end_time) on success,
    else None. `next_idx` points to the first word AFTER the match so
    callers can skip past it.
    """
    phrase_tokens = _normalize(phrase).split()
    if not phrase_tokens or word_idx >= len(whisper_words):
        return None

    # 1) Multi-token sequence match — with fuzzy per-token compare
    if word_idx + len(phrase_tokens) <= len(whisper_words):
        ok = True
        for i, tok in enumerate(phrase_tokens):
            w = whisper_words[word_idx + i]
            ww = _normalize(w.get("word", "") or w.get("text", "")).strip()
            if not _token_matches(ww, tok):
                ok = False
                break
        if ok:
            start_t = float(whisper_words[word_idx].get("start", 0))
            last = whisper_words[word_idx + len(phrase_tokens) - 1]
            end_t = float(last.get("end", start_t))
            return (word_idx + len(phrase_tokens), start_t, end_t)

    # 2) Concatenated single-token match (only meaningful for multi-word phrases)
    if len(phrase_tokens) >= 2:
        concat = "".join(phrase_tokens)
        w = whisper_words[word_idx]
        ww = _normalize(w.get("word", "") or w.get("text", "")).strip()
        if _token_matches(ww, concat):
            start_t = float(w.get("start", 0))
            end_t = float(w.get("end", start_t))
            return (word_idx + 1, start_t, end_t)

    return None


def detect_voice_triggers(
    whisper_words: list[dict],
    cut_keywords: list[str] | None = None,
    continue_keywords: list[str] | None = None,
    clip_duration: float | None = None,
) -> list[VoiceTriggerPair]:
    """Scan a Whisper word-list for cut→continue trigger pairs.

    Args:
        whisper_words: list of {"word": str, "start": float, "end": float}
            (Whisper's word_timestamps=True output).
        cut_keywords: phrases that start a "remove this" range. Falls
            back to DEFAULT_CUT_KEYWORDS.
        continue_keywords: phrases that end a "remove this" range and
            mark the next take. Falls back to DEFAULT_CONTINUE_KEYWORDS.
        clip_duration: if no continue-marker follows a cut-marker,
            we extend the removal range to this duration (or the end of
            the last word if not given).

    Returns: list of VoiceTriggerPair. Empty list if no triggers found.
    """
    cut_keywords = cut_keywords or DEFAULT_CUT_KEYWORDS
    continue_keywords = continue_keywords or DEFAULT_CONTINUE_KEYWORDS

    if not whisper_words:
        return []

    # Pre-sort phrases longest-first so "scrap that" wins over "scrap"
    cut_keywords = sorted(cut_keywords, key=lambda p: -len(p.split()))
    continue_keywords = sorted(continue_keywords, key=lambda p: -len(p.split()))

    pairs: list[VoiceTriggerPair] = []
    i = 0
    while i < len(whisper_words):
        # Try to match a cut-keyword starting at word i
        matched_cut = None
        cut_next_idx = None
        cut_phrase_start_t = None
        for kw in cut_keywords:
            m = _match_phrase_at(i, whisper_words, kw)
            if m is not None:
                cut_next_idx, cut_phrase_start_t, _ = m
                matched_cut = kw
                break

        if not matched_cut:
            i += 1
            continue

        # Clean cut boundary: end of the word BEFORE the trigger phrase
        # so the last spoken word stays intact, but breath/silence right
        # before "cleo" gets removed for a hard, clean cut.
        if i > 0:
            cut_start = float(whisper_words[i - 1].get("end", cut_phrase_start_t))
        else:
            cut_start = cut_phrase_start_t

        # Search for continue-keyword after the cut-phrase
        j = cut_next_idx
        matched_continue = None
        cont_next_idx = None
        while j < len(whisper_words):
            for kw in continue_keywords:
                m = _match_phrase_at(j, whisper_words, kw)
                if m is not None:
                    cont_next_idx, _, _ = m
                    matched_continue = kw
                    break
            if matched_continue is not None:
                break
            j += 1

        if matched_continue is None:
            # No continue-marker found — refuse to cut. Falling back to
            # clip-end would silently delete the rest of the take if the
            # user said the cut-keyword but forgot the continue-keyword.
            print(f"[voice-triggers] cut-marker '{matched_cut}' at "
                  f"{cut_phrase_start_t:.2f}s has no matching continue — skipping",
                  flush=True)
            break

        # Clean continue boundary: start of the FIRST word AFTER "go"
        # so the trigger itself and any breath/silence after it are cut.
        # Whisper often ends "go" ~100-200ms before the actual audio tail
        # finishes, so extend the cut by 150ms — inaudibly clips the next
        # word's leading silence but reliably swallows the "go" residue.
        TAIL_BUFFER = 0.15
        if cont_next_idx < len(whisper_words):
            next_word_start = float(whisper_words[cont_next_idx].get("start", 0))
            trigger_end = float(whisper_words[cont_next_idx - 1].get("end", 0))
            continue_end = min(
                next_word_start,
                trigger_end + TAIL_BUFFER,
            )
        else:
            # Continue-phrase is the very last word — extend beyond its end
            last = whisper_words[cont_next_idx - 1]
            continue_end = float(last.get("end", 0)) + TAIL_BUFFER

        pairs.append(VoiceTriggerPair(
            cut_start=cut_start,
            continue_end=continue_end,
            cut_word=matched_cut,
            continue_word=matched_continue,
        ))
        # Continue scanning AFTER the matched continue-phrase
        i = cont_next_idx

    return pairs


def apply_voice_triggers_to_segments(
    segments: list[tuple[float, float]],
    pairs: list[VoiceTriggerPair],
) -> list[tuple[float, float]]:
    """Remove the cut→continue ranges from speech segments.

    Each pair carves out [cut_start, continue_end] from any speech
    segment that overlaps with it. Segments that get split into two
    pieces (overlap in the middle) become two new segments.
    """
    if not pairs:
        return list(segments)

    # Sort pairs by start, just in case
    pairs_sorted = sorted(pairs, key=lambda p: p.cut_start)

    out: list[tuple[float, float]] = list(segments)
    for p in pairs_sorted:
        new_out: list[tuple[float, float]] = []
        for (s, e) in out:
            if e <= p.cut_start or s >= p.continue_end:
                # No overlap — keep as is
                new_out.append((s, e))
            elif s >= p.cut_start and e <= p.continue_end:
                # Fully inside cut range — drop entirely
                continue
            elif s < p.cut_start and e <= p.continue_end:
                # Cut overlaps the END of segment — trim end
                new_out.append((s, p.cut_start))
            elif s >= p.cut_start and e > p.continue_end:
                # Cut overlaps the START of segment — trim start
                new_out.append((p.continue_end, e))
            else:
                # Cut sits in the MIDDLE — split into two segments
                new_out.append((s, p.cut_start))
                new_out.append((p.continue_end, e))
        out = new_out

    # Drop zero/negative-length segments that round-off can produce
    return [(s, e) for (s, e) in out if e - s > 0.05]


def apply_voice_triggers_to_subtitles(
    subtitles: list,
    pairs: list[VoiceTriggerPair],
) -> list:
    """Drop subtitles that fall inside any cut→continue range.

    Accepts both raw dicts and `Subtitle` dataclasses (different callers
    pass different shapes — the standalone uses dataclasses, the plugin
    flow converts to dicts later). We just read `.start` / `.end`
    attributes if `.get` is missing.
    """
    if not pairs:
        return list(subtitles)

    def _start(s):
        return float(s.get("start", 0) if hasattr(s, "get") else getattr(s, "start", 0))

    def _end(s, default):
        return float(s.get("end", default) if hasattr(s, "get") else getattr(s, "end", default))

    kept = []
    for s in subtitles:
        start = _start(s)
        end = _end(s, start)
        # Subtitle is "in" a cut range if its midpoint is inside the
        # cut. This is robust against tiny boundary mismatches.
        mid = (start + end) / 2.0
        in_cut = any(p.cut_start <= mid <= p.continue_end for p in pairs)
        if not in_cut:
            kept.append(s)
    return kept


def collect_whisper_words(transcription: dict) -> list[dict]:
    """Flatten Whisper's nested {segments: [{words: [...]}]} structure
    into a single list of word-dicts for trigger scanning."""
    if not transcription:
        return []
    words = []
    for seg in transcription.get("segments", []):
        seg_words = seg.get("words") or []
        for w in seg_words:
            # word_timestamps gives "word" or "text"; normalize key
            entry = {
                "word": w.get("word", w.get("text", "")),
                "start": float(w.get("start", 0)),
                "end": float(w.get("end", 0)),
            }
            words.append(entry)
    return words
