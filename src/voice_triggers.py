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
User vergessen hat es zu sagen) — innerhalb von PAIR_MAX_S und vor dem
nächsten Szenen-Kommando —, wird nur die Kommando-Phrase selbst
entfernt, nie der Rest des Videos; ein "go" ohne "stop" davor ebenso.
Als Kommando zählt nur, was als eigener Satz gesagt wurde
(src/command_gate.py).
"""
from __future__ import annotations

from dataclasses import dataclass

from src import command_gate as gate


# Bilingual wake commands — EN and DE both accepted. Every Cleo-
# mishearing (Clio, Cleyo, Klio, Kleo, Cleo) × every command variant.
_CLEO_VT_VARIANTS = [
    "cleo", "clio", "cleyo", "klio", "kleo",
    # weak spellings (src/command_gate.py: breaks before and after)
    "clear", "cleer", "clara", "claro", "clean",
    "kilo", "keo", "kejo", "clea",
    "chloe", "leo", "cleos",
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

# The command words as taught (with a PRIMARY_WAKE "Cleo" they need only
# a break after them; every other form needs breaks on both sides).
STRONG_STOP = frozenset({"stop", "stops", "stopped", "stopping", "stopp"})
STRONG_GO = frozenset({"go"})

# A "Cleo stop" closes on the next "Cleo go" within PAIR_MAX_S, unless a
# scene command comes first; otherwise only the stop phrase is cut (a
# forgotten "go" must not delete minutes). A go more than LONG_PAIR_S
# after its stop has to be a strong, punctuated "Cleo go.".
PAIR_MAX_S = 60.0
LONG_PAIR_S = 20.0


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
    # "pair" (stop … go), or a lone command phrase cut on its own:
    # "stop" (no go followed in time) or "go" (no stop before it).
    kind: str = "pair"
    # a pair closed by a phonetic guess at the go (no take begins there:
    # src/scene_triggers.py stop_go_resumes)
    guessed_go: bool = False


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation and accents. Used for matching
    keywords (src/command_gate.py normalize)."""
    return gate.normalize(text)


# Cut boundaries. Silence snap preferred: a silence range right before
# "Cleo" (after "go") gives a tight, natural flow and ignores Whisper's
# stretched word times — but only when no other word lies between the
# silence and the command, else that word would be cut. Fallback: 20 ms
# past the previous word's Whisper end, capped 100 ms before "Cleo" so a
# stretched prev_word.end can't leak a "cle…" fragment; the analysis
# then snaps every edge to the audio (src/edge_snap.py).
_BREATH_TRIM = 0.02
_CUT_LEAD_CAP = 0.10
_NEXT_LEAD = 0.02
_SNAP_REACH_S = 0.5
_WORD_TOL_S = 0.05


def _cut_side(words: list[dict], i: int, phrase_start: float,
              silence_ranges: list[tuple[float, float]] | None) -> float:
    """Where the removal before the command phrase at words[i] begins."""
    prev = words[i - 1] if i > 0 else None
    for (sil_start, sil_end) in silence_ranges or ():
        # a silence that ends within 500 ms of cleo (the gap before it)
        if not (sil_start < phrase_start and sil_end + _SNAP_REACH_S >= phrase_start):
            continue
        if prev is not None and (
                float(prev.get("end", 0)) > sil_end + _WORD_TOL_S
                or float(prev.get("start", 0)) >= sil_start - _WORD_TOL_S):
            continue  # a word between the silence and cleo (or inside it)
        return max(0.0, sil_start + _BREATH_TRIM)
    cleo_cap = phrase_start - _CUT_LEAD_CAP
    if prev is not None:
        prev_end = float(prev.get("end", cleo_cap))
        return max(0.0, min(prev_end + _BREATH_TRIM, cleo_cap))
    return max(0.0, cleo_cap)


def _resume_side(words: list[dict], next_idx: int, phrase_end: float,
                 silence_ranges: list[tuple[float, float]] | None) -> float:
    """Where the kept audio after the command phrase ending at
    `phrase_end` (next word: words[next_idx]) resumes."""
    nxt = words[next_idx] if next_idx < len(words) else None
    for (sil_start, sil_end) in silence_ranges or ():
        # a silence that starts within 500 ms of go's end (the gap after it)
        if not (sil_end > phrase_end and sil_start - _SNAP_REACH_S <= phrase_end):
            continue
        if nxt is not None and (
                float(nxt.get("start", 0)) < sil_start - _WORD_TOL_S
                or float(nxt.get("end", 0)) <= sil_end + _WORD_TOL_S):
            continue  # a word between go and the silence (or inside it)
        return max(phrase_end, sil_end - _NEXT_LEAD)
    if nxt is not None:
        next_word_start = float(nxt.get("start", 0))
    else:
        next_word_start = float(words[-1].get("end", 0)) + 1.0  # far in the future
    return max(phrase_end, next_word_start - _NEXT_LEAD)


def detect_voice_triggers(
    whisper_words: list[dict],
    cut_keywords: list[str] | None = None,
    continue_keywords: list[str] | None = None,
    clip_duration: float | None = None,
    silence_ranges: list[tuple[float, float]] | None = None,
    quiet: bool = False,
) -> list[VoiceTriggerPair]:
    """Scan a Whisper word-list for cut→continue trigger pairs.

    Args:
        whisper_words: list of {"word": str, "start": float, "end": float}
            (Whisper's word_timestamps=True output).
        cut_keywords: phrases that start a "remove this" range. Falls
            back to DEFAULT_CUT_KEYWORDS.
        continue_keywords: phrases that end a "remove this" range and
            mark the next take. Falls back to DEFAULT_CONTINUE_KEYWORDS.
        clip_duration: unused (kept for callers).
        silence_ranges: optional list of (start, end) audio silence
            ranges from silence detection. If supplied, cut/continue
            boundaries snap to actual silence edges instead of trusting
            Whisper's word.end / word.start (which regularly drift into
            silence and cause perceptible pauses in the kept audio).
        quiet: no log lines (src/scene_triggers.py reads the pairs too).

    Only phrases said as commands count (src/command_gate.py). A stop
    pairs with the next go within PAIR_MAX_S (a second stop before it
    stays inside the pair: everything from the FIRST stop is the bad
    part); a scene command first, or no go in time, cuts just the stop
    phrase; a go with no open stop cuts just its own phrase — so a
    spoken command never stays in the video, and a forgotten go never
    deletes minutes.

    Returns: list of VoiceTriggerPair (kind "pair", "stop" or "go").
    Empty list if no triggers found.
    """
    words = gate.split_tokens(whisper_words)
    if not words:
        return []
    log = (lambda *_a, **_k: None) if quiet else print
    from src.scene_triggers import scene_table
    table = gate.CommandTable([
        ("stop", cut_keywords or DEFAULT_CUT_KEYWORDS, STRONG_STOP),
        ("go", continue_keywords or DEFAULT_CONTINUE_KEYWORDS, STRONG_GO),
    ])
    scene = scene_table()
    norm = gate.normalized(words)

    # 1) Every command phrase, in order: (kind, i, next_idx, start, end,
    #    phrase, strong and punctuated, phonetic guess). Scene commands
    #    only bound pairs.
    marks: list[tuple[str, int, int, float, float, str, bool]] = []
    i = 0
    while i < len(words):
        m = table.match(words, norm, i)
        if m is None:
            m = scene.match(words, norm, i)
            if m is not None:
                m = ("scene",) + m[1:]
        if m is None:
            i += 1
            continue
        kind, kw, nxt, ps, pe, weak = m
        exact = gate.llm_fixed(words, i, nxt - 1) or (
            not weak and gate.ends_clause(words[nxt - 1].get("word", "")))
        marks.append((kind, i, nxt, ps, pe, kw, exact, False))
        i = nxt

    # Phonetic guesses at "Cleo stop" / "Cleo go" ('Cleo Stob.', 'Kleo
    # stoppt.', 'Clio Goo.'): weak, so never closing a long pair.
    try:
        from src.phonetic_wake_detection import find_phonetic_candidates
        found = [(mk[0], mk[3], mk[4]) for mk in marks]
        for (cmd, ps, pe, raw) in find_phonetic_candidates(
                words, already_detected=found, commands=("stop", "go")):
            mi = gate.index_at(words, ps)
            if any(mk[1] <= mi < mk[2] for mk in marks):
                continue  # inside a phrase the keyword scan found
            log(f"[phonetic] added {cmd} @ {ps:.2f}s — raw={raw!r}",
                flush=True)
            marks.append((cmd, mi, mi + 2, ps, pe, raw, False, True))
        marks.sort(key=lambda mk: mk[3])
    except Exception as _phe:
        log(f"[phonetic] stop/go skipped: {_phe}", flush=True)

    def phrase_cut(mk) -> tuple[float, float]:
        _k, mi, mn, ps, pe, *_r = mk
        return (_cut_side(words, mi, ps, silence_ranges),
                _resume_side(words, mn, pe, silence_ranges))

    # 2) Pair them.
    pairs: list[VoiceTriggerPair] = []
    k = 0
    while k < len(marks):
        mk = marks[k]
        kind = mk[0]
        if kind == "scene":
            k += 1
            continue
        if kind == "go":
            s, e = phrase_cut(mk)
            log(f"[voice-triggers] '{mk[5]}' at {mk[3]:.2f}s has no "
                f"stop before it — cutting the phrase only", flush=True)
            pairs.append(VoiceTriggerPair(cut_start=s, continue_end=e,
                                          cut_word=mk[5], continue_word=None,
                                          kind="go"))
            k += 1
            continue
        closing = None
        j = k + 1
        while j < len(marks):
            nx = marks[j]
            if nx[3] - mk[4] > PAIR_MAX_S or nx[0] == "scene":
                break
            if nx[0] == "stop":
                log(f"[voice-triggers] second '{nx[5]}' at {nx[3]:.2f}s "
                    f"inside the stop at {mk[3]:.2f}s (nested)", flush=True)
            elif nx[3] - mk[4] <= LONG_PAIR_S or nx[6]:
                closing = j
                break
            j += 1
        if closing is None:
            s, e = phrase_cut(mk)
            log(f"[voice-triggers] cut-marker '{mk[5]}' at {mk[3]:.2f}s "
                f"has no matching continue — cutting the phrase only",
                flush=True)
            pairs.append(VoiceTriggerPair(cut_start=s, continue_end=e,
                                          cut_word=mk[5], continue_word=None,
                                          kind="stop"))
            k += 1
            continue
        go = marks[closing]
        pairs.append(VoiceTriggerPair(
            cut_start=_cut_side(words, mk[1], mk[3], silence_ranges),
            continue_end=_resume_side(words, go[2], go[4], silence_ranges),
            cut_word=mk[5],
            continue_word=go[5],
            guessed_go=go[7],
        ))
        # Continue scanning AFTER the matched continue-phrase
        k = closing + 1

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
        if p.kind != "pair":
            updated.append(p)
            continue
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
    into a single list of word-dicts for trigger scanning: tokens glued
    from several words split, punctuation-only tokens dropped
    (command_gate.split_tokens), each segment's first / last word marked
    as a break (brk_before / brk_after), the LLM command fix's mark
    (cmd_fix) kept."""
    if not transcription:
        return []
    # Filler sounds are skipped so 'Cleo, äh, cut' still reads as the
    # command 'Cleo cut' (Whisper transcribes fillers since the prompt
    # asks for them).
    from src.filler_detection import _is_vocalisation
    words = []
    for seg in transcription.get("segments", []):
        seg_words = []
        for w in seg.get("words") or []:
            _t = (w.get("word", w.get("text", "")) or "").strip().lower().strip(
                ".,!?;:\"'()[]…–—-")
            if _t and _is_vocalisation(_t):
                continue
            # word_timestamps gives "word" or "text"; normalize key
            entry = {
                "word": w.get("word", w.get("text", "")),
                "start": float(w.get("start", 0)),
                "end": float(w.get("end", 0)),
            }
            if w.get("cmd_fix"):
                entry["cmd_fix"] = True
            seg_words.append(entry)
        seg_words = gate.split_tokens(seg_words)
        if seg_words:
            seg_words[0]["brk_before"] = True
            seg_words[-1]["brk_after"] = True
        words.extend(seg_words)
    return words
