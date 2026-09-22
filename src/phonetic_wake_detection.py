"""Phonetic fuzzy matching for Cleo wake commands.

Whisper regularly produces phonetically-close mishears that the exact
keyword list can't catch: 'Klick hat' (Cleo keep), 'CleoKey' (Cleo
keep), 'Klick war' (Cleo cut). This module compares Whisper's word
tokens to the target commands using a lightweight phonetic signature
(consonant skeleton) so 'klick' matches 'cleo' or 'keep' fuzzily.

Runs as a secondary detection pass AFTER the exact-match keyword scan.
It only fires when the primary detection missed a plausible command.
Detected via a strict two-word pattern:

    <cleo-like> <command-like>

where 'cleo-like' means the word STARTS with a /k/ or /kl/ sound and
'command-like' means it phonetically matches one of the six command
words within edit distance 1 on the consonant skeleton.

Deterministic, cheap, and can be tuned per command type. Returns
events in the same shape as `find_scene_cut_ranges` so the caller can
merge them with the primary detection.
"""
from __future__ import annotations

import re


def _clean_word(word: str) -> str:
    """Lowercase, strip punctuation and diacritics-ish."""
    return re.sub(r"[^\w]", "", (word or "").lower())


# Consonant skeleton — keep only consonants that carry the identity of
# the word. Drops vowels, spaces, punctuation. Useful for approximate
# matching that ignores vowel confusion (Whisper mangles vowels far
# more often than consonants).
_VOWELS = set("aeiouäöüy")


def _consonant_skel(word: str) -> str:
    """Return the consonant skeleton of a word, lowercased."""
    w = _clean_word(word)
    return "".join(c for c in w if c not in _VOWELS)


# Cleo detection: match the first 2 characters of the CLEAN word (so
# 'cleo', 'clea', 'klio', 'kleo', 'klick' all pass). Overly-short
# words like 'k' or 'kx' don't count (guarded by _fuzzy_cleo).
_CLEO_SKELETONS = {"cl", "kl"}

# Target consonant skeletons for each command. Kept as strict, medium-
# length forms only — too-short skeletons like 'k' or 'st' produce
# false positives on unrelated content ('so', 'hat', 'ich').
_COMMAND_SKELETONS: dict[str, set[str]] = {
    # 'start' → 'strt' (also 'startet' etc all reduce to strt)
    "start": {"strt", "startt", "srtt"},
    # 'cut' → 'ct' + close phonetic ('kot' = kt)
    "cut": {"ct", "kt", "kts", "kd"},
    # 'keep' → 'kp' + Whisper mishears ('kieb'=kb, 'kiep'=kp, 'key'=k…)
    # Note: single 'k' too permissive — omitted. Sonnet will catch
    # the 'CleoKey' = single-word case anyway.
    "keep": {"kp", "kb", "kv", "kvb", "khp"},
    # 'finish' → full skeleton. 'finnisch' collapses to 'fnnsch',
    # accept both edit-distance ≤1 variants.
    "finish": {"fnsh", "fnnsh", "fnsch", "fnnsch"},
    # 'stop' → 'stp' + 'stopp'=stpp
    "stop": {"stp", "stpp"},
    # 'go' — Whisper produces 'g', 'go', 'goh'. Skeleton 'g' too
    # permissive so we require the LITERAL 2-3 chars containing 'g'
    # via an exception path in _fuzzy_command.
    "go": {"g"},
}


def _min_skeleton_len_for(cmd: str) -> int:
    """Some commands need the actual word skeleton to be at least
    this long to avoid overmatching. 'go' is special because it's
    genuinely one consonant."""
    return {"go": 1, "cut": 2, "keep": 2, "stop": 3, "start": 3, "finish": 3}.get(cmd, 2)


def _edit_distance_one(a: str, b: str) -> bool:
    """True if `a` and `b` differ by at most one edit operation."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    # Same length → count substitutions
    if la == lb:
        diff = sum(1 for x, y in zip(a, b) if x != y)
        return diff <= 1
    # Length differs by 1 → count insertion / deletion
    short, long = (a, b) if la < lb else (b, a)
    i = j = 0
    diff = 0
    while i < len(short) and j < len(long):
        if short[i] == long[j]:
            i += 1
            j += 1
        else:
            j += 1
            diff += 1
            if diff > 1:
                return False
    return True


def _fuzzy_cleo(word: str) -> bool:
    """True if `word` sounds Cleo-like (starts with kl-, first ~4
    chars have `cl` or `kl` consonant skeleton).
    """
    w = _clean_word(word)
    if not w:
        return False
    # Direct start match: 'cle', 'kle', 'kli', 'clo' etc.
    if w[:2] in {"cl", "kl"}:
        return True
    # Skeleton check on first 4-5 chars — catches 'cleo', 'klick',
    # 'clear', 'kilo', etc.
    prefix = w[:5]
    skel = _consonant_skel(prefix)
    if skel[:2] in _CLEO_SKELETONS:
        return True
    return False


# Required first-consonant for each command. Whisper may mangle the
# vowels but the initial plosive/fricative is very stable.
_COMMAND_FIRST_CONSONANT: dict[str, set[str]] = {
    "start": {"s"},
    "cut":   {"c", "k"},
    "keep":  {"c", "k"},   # keep/kieb/kip all start c/k
    "finish": {"f", "p"},  # 'finish', 'phinish'
    "stop":  {"s"},
    "go":    {"g"},
}


def _first_consonant(word: str) -> str:
    """First consonant char of the cleaned word, or empty."""
    w = _clean_word(word)
    for ch in w:
        if ch not in _VOWELS:
            return ch
    return ""


def _edit_distance(a: str, b: str) -> int:
    """Standard Levenshtein distance. Small strings, no memoization
    needed."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    la, lb = len(a), len(b)
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        curr = [i] + [0] * lb
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[lb]


# Full-word target vocabulary for each command (lowercased, no
# punctuation). Whisper mishears reduce to these via edit distance.
_COMMAND_FULL_WORDS: dict[str, set[str]] = {
    "start":  {"start", "starts", "starte", "startet", "started"},
    "cut":    {"cut", "cuts", "kot", "kutt", "kat", "kut"},
    "keep":   {"keep", "kip", "kiep", "kieb", "kib", "keb", "kep"},
    "finish": {"finish", "finnish", "finnisch", "finished", "fenish"},
    "stop":   {"stop", "stopp", "stopped"},
    "go":     {"go", "goh", "goes"},
}


def _fuzzy_command(word: str, cmd: str) -> bool:
    """True if `word` phonetically matches `cmd`. Uses full-word edit
    distance ≤1 against known Whisper-mishear vocab (see
    _COMMAND_FULL_WORDS) plus a first-consonant gate to prevent
    cross-matches like 'hat' → cut.
    """
    w = _clean_word(word)
    if not w:
        return False
    fc = _first_consonant(w)
    if fc not in _COMMAND_FIRST_CONSONANT.get(cmd, set()):
        return False
    if _fuzzy_cleo(w):
        return False  # cleo-like words are Cleo, never commands
    targets = _COMMAND_FULL_WORDS.get(cmd, set())
    # Very short words (go = 2 chars): only exact match. Otherwise
    # 'gi', 'ga', etc. would fire.
    if any(len(t) <= 2 for t in targets):
        return w in targets
    # Longer words: allow one edit
    for t in targets:
        d = _edit_distance(w, t)
        if d <= 1:
            return True
    return False


def find_phonetic_candidates(
    whisper_words: list[dict],
    already_detected: list[tuple[str, float, float]] | None = None,
    dedupe_window: float = 1.5,
) -> list[tuple[str, float, float, str]]:
    """Scan Whisper words for phonetic Cleo+command patterns.

    Args:
        whisper_words: flat list of {"word", "start", "end"} tokens.
        already_detected: (cmd_type, start_time, end_time) tuples from
            the exact-match pass. We skip candidates within
            `dedupe_window` seconds of an existing event to avoid
            duplicating what the primary already caught.
        dedupe_window: seconds around existing events to skip.

    Returns:
        list of (cmd_type, phrase_start, phrase_end, raw_text) tuples.
        Deduplicated against `already_detected`.
    """
    existing = list(already_detected or [])

    def _already(cmd: str, t: float) -> bool:
        for (ex_cmd, ex_start, ex_end) in existing:
            if ex_cmd != cmd:
                continue
            if abs(t - ex_start) <= dedupe_window:
                return True
            if ex_start <= t <= ex_end + dedupe_window:
                return True
        return False

    candidates: list[tuple[str, float, float, str]] = []
    for i in range(len(whisper_words) - 1):
        w = whisper_words[i]
        w_next = whisper_words[i + 1]
        w_text = w.get("word", "") or w.get("text", "") or ""
        n_text = w_next.get("word", "") or w_next.get("text", "") or ""

        if not _fuzzy_cleo(w_text):
            continue

        # Score every command against the next token; pick the best.
        best_cmd: str | None = None
        best_dist = 999
        for cmd, targets in _COMMAND_FULL_WORDS.items():
            if not _fuzzy_command(n_text, cmd):
                continue
            n_clean = _clean_word(n_text)
            local = min((_edit_distance(n_clean, t) for t in targets),
                        default=999)
            if local < best_dist:
                best_dist = local
                best_cmd = cmd
        if best_cmd is None:
            continue
        phrase_start = float(w.get("start", 0))
        phrase_end = float(w_next.get("end", phrase_start))
        if _already(best_cmd, phrase_start):
            continue
        raw = f"{w_text.strip()} {n_text.strip()}"
        if best_cmd == "cut":
            candidates.append(("restart", phrase_start, phrase_end, raw))
        elif best_cmd in ("start", "keep", "finish"):
            candidates.append((best_cmd, phrase_start, phrase_end, raw))

    return candidates
