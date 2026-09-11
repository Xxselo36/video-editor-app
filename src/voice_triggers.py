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


# Bilingual wake commands — EN and DE both accepted. Every Cleo-
# mishearing (Clio, Cleyo, Klio, Kleo, Cleo) × every command variant.
_CLEO_VT_VARIANTS = [
    "cleo", "clio", "cleyo", "klio", "kleo",
    "clear", "cleer", "clara", "claro", "clean",
    "kilo", "keo", "kejo", "clea",
]


def _vt_combos(command_variants: list[str]) -> list[str]:
    return [f"{c} {cmd}" for c in _CLEO_VT_VARIANTS for cmd in command_variants]


DEFAULT_CUT_KEYWORDS = _vt_combos([
    # EN — 'Cleo stop' is the new voice-trigger primary. 'cut' moved
    # to scene-triggers as the RESTART command.
    "stop", "stops", "stopped", "stopping",
    # DE
    "stopp", "stoppe", "gestoppt",
    "halt", "halte",
    # Common mishears
    "top", "stap", "stoop",
])

DEFAULT_CONTINUE_KEYWORDS = _vt_combos([
    # EN
    "go", "goes", "goh",
    # DE
    "weiter", "weiterreden", "weiterr",
    # Mishears
    "los", "gone",
])


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

    # 1) Multi-token sequence match
    if word_idx + len(phrase_tokens) <= len(whisper_words):
        ok = True
        for i, tok in enumerate(phrase_tokens):
            w = whisper_words[word_idx + i]
            ww = _normalize(w.get("word", "") or w.get("text", "")).strip()
            if ww != tok:
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
        if ww == concat:
            start_t = float(w.get("start", 0))
            end_t = float(w.get("end", start_t))
            return (word_idx + 1, start_t, end_t)

    return None


def detect_voice_triggers(
    whisper_words: list[dict],
    cut_keywords: list[str] | None = None,
    continue_keywords: list[str] | None = None,
    clip_duration: float | None = None,
    silence_ranges: list[tuple[float, float]] | None = None,
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
        silence_ranges: optional list of (start, end) audio silence
            ranges from silence detection. If supplied, cut/continue
            boundaries snap to actual silence edges instead of trusting
            Whisper's word.end / word.start (which regularly drift into
            silence and cause perceptible pauses in the kept audio).

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

        # Cut boundary — two strategies, silence snap preferred:
        # 1) If audio-silence detection identifies a silence range that
        #    abuts cleo, snap cut_start to end-of-speech-before-silence
        #    (silence.start + tiny breath). This gives a tight, natural
        #    flow because it ignores Whisper's stretched word.end.
        # 2) Fallback: end kept side ~20ms after Whisper's prev word,
        #    capped 100ms before cleo starts so a stretched prev_word.end
        #    can't leak a "cle…" fragment into the kept audio.
        BREATH_TRIM = 0.02
        CUT_LEAD_CAP = 0.10
        cleo_cap = cut_phrase_start_t - CUT_LEAD_CAP

        # Strategy 1: silence snap
        cut_start = None
        if silence_ranges:
            for (sil_start, sil_end) in silence_ranges:
                # silence that ends within 500ms of cleo start (= gap
                # before cleo). Snap to its start = last speech before
                # cleo actually ended.
                if sil_start < cut_phrase_start_t and sil_end + 0.5 >= cut_phrase_start_t:
                    cut_start = max(0.0, sil_start + BREATH_TRIM)
                    break

        # Strategy 2: Whisper fallback
        if cut_start is None:
            if i > 0:
                prev_word_end = float(whisper_words[i - 1].get("end", cleo_cap))
                cut_start = min(prev_word_end + BREATH_TRIM, cleo_cap)
            else:
                cut_start = cleo_cap
            cut_start = max(0.0, cut_start)

        # Search for continue-keyword after the cut-phrase. If a NEW
        # cut-keyword appears first, the user restarted again without
        # saying 'go' — abandon this pair and re-anchor to the newer
        # cut (which is the actual restart point).
        j = cut_next_idx
        matched_continue = None
        cont_next_idx = None
        restart_from_new_cut = False
        while j < len(whisper_words):
            # Check for a new cut before checking for continue
            for kw in cut_keywords:
                m = _match_phrase_at(j, whisper_words, kw)
                if m is not None:
                    print(f"[voice-triggers] second '{matched_cut}' at "
                          f"{cut_phrase_start_t:.2f}s superseded by "
                          f"'{kw}' at {float(whisper_words[j].get('start', 0)):.2f}s "
                          f"(nested restart)", flush=True)
                    i = j
                    restart_from_new_cut = True
                    break
            if restart_from_new_cut:
                break
            for kw in continue_keywords:
                m = _match_phrase_at(j, whisper_words, kw)
                if m is not None:
                    cont_next_idx, _, continue_end = m
                    matched_continue = kw
                    break
            if matched_continue is not None:
                break
            j += 1

        if restart_from_new_cut:
            continue

        if matched_continue is None:
            # No continue-marker found — refuse to cut. Falling back to
            # clip-end would silently delete the rest of the take if the
            # user said the cut-keyword but forgot the continue-keyword.
            print(f"[voice-triggers] cut-marker '{matched_cut}' at "
                  f"{cut_phrase_start_t:.2f}s has no matching continue — skipping",
                  flush=True)
            break

        # End boundary: start of the FIRST word AFTER "go" (before buffer)
        if cont_next_idx < len(whisper_words):
            next_word_start = float(whisper_words[cont_next_idx].get("start", 0))
        else:
            next_word_start = float(
                whisper_words[cont_next_idx - 1].get("end", 0)
            ) + 1.0  # far in the future

        # continue_end — mirror of cut side, silence snap preferred:
        # 1) Silence range that starts near go's reported end → snap
        #    continue_end to silence.end - tiny lead. Kept side resumes
        #    right at start-of-next-speech, no dragged silence.
        # 2) Fallback: 20ms before Whisper's next word start; floored at
        #    go's reported end so we never leak "…o".
        NEXT_LEAD = 0.02
        go_end = continue_end  # Whisper's reported end of "go"

        snapped = None
        if silence_ranges:
            for (sil_start, sil_end) in silence_ranges:
                # silence that starts within 500ms of go's end (= gap
                # after go). Snap to its end = next speech begins.
                if sil_end > go_end and sil_start - 0.5 <= go_end:
                    snapped = max(0.0, sil_end - NEXT_LEAD)
                    break

        if snapped is not None:
            continue_end = max(go_end, snapped)
        else:
            continue_end = max(continue_end, next_word_start - NEXT_LEAD)

        pairs.append(VoiceTriggerPair(
            cut_start=cut_start,
            continue_end=continue_end,
            cut_word=matched_cut,
            continue_word=matched_continue,
        ))
        # Continue scanning AFTER the matched continue-phrase
        i = cont_next_idx

    return pairs


# Stopwords + fillers dropped from content-word extraction. Keeps only
# semantically meaningful tokens so pre/post overlap catches topic
# words like 'Testvideo' but not function words like 'das' or 'und'.
_PRE_RESTART_STOPWORDS = frozenset([
    # DE function words
    "der", "die", "das", "dass", "den", "dem", "des",
    "ein", "eine", "einen", "einem", "einer", "eines",
    "und", "oder", "aber", "denn", "weil", "ob",
    "ist", "sind", "war", "waren", "bin", "bist",
    "hat", "haben", "hatte", "hatten",
    "wird", "werden", "würde", "würden",
    "kann", "können", "muss", "müssen", "soll", "sollen",
    "ich", "du", "er", "sie", "es", "wir", "ihr",
    "mich", "dich", "sich", "uns", "euch", "mir", "dir",
    "in", "an", "auf", "für", "mit", "von", "bei", "zu",
    "als", "wie", "so", "auch", "noch", "nur", "mal",
    "ja", "nein", "doch", "nicht",
    # EN
    "a", "an", "the", "and", "or", "but", "is", "are", "was",
    "i", "you", "he", "she", "it", "we", "they",
    "in", "on", "at", "for", "with", "to", "of",
    # Fillers
    "äh", "ähm", "öh", "hm", "hmm", "mhm", "eh", "um", "uh",
])


def _content_norm(word: str) -> str | None:
    """Return normalized content form, or None if stopword/short."""
    n = _normalize(word).strip()
    if len(n) <= 1 or n in _PRE_RESTART_STOPWORDS:
        return None
    return n


def extend_pairs_for_pre_restart(
    pairs: list[VoiceTriggerPair],
    whisper_words: list[dict],
    lookback_seconds: float = 2.5,
    lookforward_seconds: float = 2.5,
) -> list[VoiceTriggerPair]:
    """Extend each trigger cut backward when a content word repeats
    across the cut.

    Common pattern: user says a phrase, realizes it's bad, calls
    "Cleo cut", then after "Cleo go" says a similar phrase and
    continues cleanly. Example:

        "...gutes Testvideo und das. Cleo cut. Ich weiß nicht. Cleo
         go. Testvideo wird ganz gut."

    "testvideo" appears BOTH just before the cut AND just after the
    continue — 100% signal that the pre-cut mention was the abandoned
    restart. Extend cut_start backward to swallow the first mention.

    Content-word overlap only (not exact N-gram): stopwords like
    "das", "und" ignored so the match works even when the user
    rephrases slightly. Lookback capped at 2.5s so we don't cut
    unrelated earlier mentions of topic words.
    """
    if not pairs or not whisper_words:
        return list(pairs)

    updated: list[VoiceTriggerPair] = []
    for p in pairs:
        pre = [
            w for w in whisper_words
            if w.get("end", 0) <= p.cut_start
            and w.get("end", 0) >= p.cut_start - lookback_seconds
        ]
        post = [
            w for w in whisper_words
            if w.get("start", 0) >= p.continue_end
            and w.get("start", 0) <= p.continue_end + lookforward_seconds
        ]
        if not pre or not post:
            updated.append(p)
            continue

        post_content: set[str] = set()
        for w in post:
            n = _content_norm(w.get("word", "") or "")
            if n:
                post_content.add(n)

        pre_last = [_normalize(w.get("word", "") or "").strip()
                    for w in pre[-6:]]
        post_first = [_normalize(w.get("word", "") or "").strip()
                      for w in post[:6]]
        print(f"[voice-triggers] pre-restart check @cut_start="
              f"{p.cut_start:.2f}s → continue_end={p.continue_end:.2f}s | "
              f"pre={pre_last} post={post_first} "
              f"post_content={sorted(post_content)}",
              flush=True)

        if not post_content:
            updated.append(p)
            continue

        # Find EARLIEST pre word (by start time) whose content form
        # appears in post_content. That's the beginning of the
        # abandoned restart intro.
        new_cut_start = p.cut_start
        for w in pre:  # pre is chronological
            n = _content_norm(w.get("word", "") or "")
            if n and n in post_content:
                new_cut_start = float(w.get("start", p.cut_start))
                break

        if new_cut_start < p.cut_start:
            updated.append(VoiceTriggerPair(
                cut_start=new_cut_start,
                continue_end=p.continue_end,
                cut_word=p.cut_word,
                continue_word=p.continue_word,
            ))
        else:
            updated.append(p)

    return updated


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
        # Drop if the subtitle STARTS inside a cut range. Overlap-check
        # was too aggressive — kept-side subtitles like 'Alhamdulillah'
        # ending 100ms past the cut boundary got dropped even though
        # their actual content was fully OUTSIDE the cut. Start-inside
        # is precise: 'Cleo cut' and 'Cleo go' start inside; kept-side
        # subtitles start outside.
        in_cut = any(p.cut_start <= start < p.continue_end for p in pairs)
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
