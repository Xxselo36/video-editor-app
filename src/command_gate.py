"""When a matched "Cleo <command>" phrase counts as a spoken command.

Creators talk about the product and use the command words in normal
speech: "Ich finde Cleo gut,", "Wenn Cleo fertig ist", "mit CleoCuts
geschnitten", "a clean cut". Read as commands, those throw away a take
or (a false "finish") the whole rest of the video, without notice. A
real command is said as a sentence of its own: in the owner's Groq
transcript all 34 commands carry punctuation right after the command
word, and 33 of 34 follow a punctuated word.

So a phrase found by the keyword match (scene_triggers, voice_triggers)
or the phonetic pass (phonetic_wake_detection) counts only:

  - with a break after its last word: punctuation on it, a gap of at
    least BREAK_GAP_S to the next word, or the end of the transcript or
    of a Whisper segment;
  - for the weak forms, also with a break before the wake word: a
    mishearing of "Cleo" ("clear", "kilo", "Chloe", …), a stand-in for
    the command word ("gut", "is that", "noch mal", "startet", …) and
    every phonetic guess;
  - and a weak form never right after a full sentence of speech
    (FULL_SENTENCE_WORDS words or more since the sentence before ended,
    no pause of BREAK_GAP_S in between): "Das war hart. Leo is tough."
    or "… gemacht. Cleo is tough." read as sentences, not as a "Cleo
    start" that would throw away everything before it (F8). It still
    counts at the start of the transcript, after a pause Whisper left in
    the times, after a short sentence ("Okay. Cleo, ist ab.") or right
    after another command.

Tokens the LLM command fix rewrote (backend.llm.correct_voice_commands
marks them `cmd_fix`) count as they are: the model read the context.
"""
from __future__ import annotations

import re
import unicodedata

# Seconds of silence after a command word (or before the wake word) that
# count as a sentence break when Whisper wrote no punctuation.
BREAK_GAP_S = 0.3

# A sentence this long before a weak form (with no pause after it) makes
# the weak form part of the speech, not a command (accept).
FULL_SENTENCE_WORDS = 3

# The wake word as taught and as Whisper spells it most of the time; the
# other variants in the keyword lists are weak (need breaks both sides).
PRIMARY_WAKE = frozenset({"cleo", "clio", "kleo", "klio", "cleyo"})

# The product's own name: "CleoCuts" as one token is never a command.
PRODUCT_TOKENS = frozenset({"cleocuts"})

_PUNCT_END = re.compile(r"[.,!?;:…]+[\"'»«“”‘’)\]]*\s*$")
_SENTENCE_END = re.compile(r"[.!?…]+[\"'»«“”‘’)\]]*\s*$")


def fold(text: str) -> str:
    """Lowercase without accents ('Cléo' → 'cleo'; umlauts lose their
    dots, on both sides of every comparison)."""
    nfkd = unicodedata.normalize("NFKD", (text or "").lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def normalize(text: str) -> str:
    """Folded, apostrophes dropped ("Cleo's" → "cleos"), other
    punctuation as spaces, trimmed — the keyword match form."""
    t = re.sub(r"['’`´]", "", fold(text))
    return re.sub(r"[^\w\s]", " ", t).strip()


def _text(w: dict) -> str:
    return (w.get("word", "") or w.get("text", "") or "")


def ends_clause(text: str) -> bool:
    """Does the token end with sentence or clause punctuation?"""
    return bool(_PUNCT_END.search(text or ""))


def break_after(words: list[dict], k: int) -> bool:
    """Is there a break right after words[k]?"""
    if k >= len(words) - 1:
        return True
    w = words[k]
    if w.get("brk_after") or ends_clause(_text(w)):
        return True
    gap = float(words[k + 1].get("start", 0)) - float(w.get("end", 0))
    return gap >= BREAK_GAP_S - 1e-9


def break_before(words: list[dict], i: int) -> bool:
    """Is there a break right before words[i]?"""
    if i <= 0:
        return True
    prev = words[i - 1]
    if words[i].get("brk_before") or prev.get("brk_after") or ends_clause(_text(prev)):
        return True
    gap = float(words[i].get("start", 0)) - float(prev.get("end", 0))
    return gap >= BREAK_GAP_S - 1e-9


def gap_before(words: list[dict], i: int) -> float:
    """Seconds of silence Whisper left before words[i] (inf at the start)."""
    if i <= 0:
        return float("inf")
    return float(words[i].get("start", 0)) - float(words[i - 1].get("end", 0))


def after_full_sentence(words: list[dict], i: int) -> bool:
    """Do words[i] follow straight on from a full sentence of speech —
    FULL_SENTENCE_WORDS words or more back to the end of the sentence
    before them, without a pause of BREAK_GAP_S?"""
    if gap_before(words, i) >= BREAK_GAP_S - 1e-9:
        return False
    n, j = 0, i - 1
    while j >= 0:
        n += 1
        if n >= FULL_SENTENCE_WORDS:
            return True
        # does that sentence start at words[j]?
        if (j == 0 or _SENTENCE_END.search(_text(words[j - 1]))
                or words[j - 1].get("brk_after") or words[j].get("brk_before")
                or gap_before(words, j) >= BREAK_GAP_S - 1e-9):
            return False
        j -= 1
    return False


def llm_fixed(words: list[dict], i: int, k: int) -> bool:
    return any(words[j].get("cmd_fix") for j in range(i, min(k + 1, len(words))))


def accept(words: list[dict], i: int, k: int, *, weak: bool) -> bool:
    """Is the phrase words[i..k] (wake word first) a command?"""
    if llm_fixed(words, i, k):
        return True
    if not break_after(words, k):
        return False
    return not weak or (break_before(words, i)
                        and not after_full_sentence(words, i))


def is_weak(phrase: str, strong_commands: frozenset[str]) -> bool:
    """A keyword phrase 'wake command…' is weak unless its wake word is a
    PRIMARY_WAKE spelling and its command one of `strong_commands`."""
    toks = normalize(phrase).split()
    if not toks:
        return True
    return toks[0] not in PRIMARY_WAKE or " ".join(toks[1:]) not in strong_commands


# Inside one token: a hyphen, dash, comma or slash between letters, or a
# space ("Cleo-Cut.", "Cleo–cut", "Cleo,cut", the LLM fix's "cleo keep").
_INNER_SPLIT = re.compile(r"(?<=\w)[\-‐‑–—,/]+(?=\w)|\s+")
_PUNCT_ONLY = re.compile(r"^[^\w]+$")


def split_tokens(words: list[dict]) -> list[dict]:
    """The words as the command scan reads them: a token Whisper (or the
    LLM fix) glued from several words is split into one entry per word,
    its time shared by letter count (the last keeps the token's trailing
    punctuation); a punctuation-only token ('...', '…', '-', Whisper's
    hesitation mark) is dropped and counts as a break after the word
    before it. Other keys (cmd_fix, brk_*) are kept. Idempotent."""
    out: list[dict] = []
    for w in words or []:
        raw = _text(w).strip()
        if not raw:
            continue
        if _PUNCT_ONLY.match(raw):
            if out:
                out[-1] = {**out[-1], "brk_after": True}
            continue
        parts = [p for p in _INNER_SPLIT.split(raw) if p]
        start = float(w.get("start", 0) or 0)
        end = float(w.get("end", start) or start)
        if len(parts) <= 1:
            out.append({**w, "word": raw, "start": start, "end": end})
            continue
        weights = [max(1, len(re.sub(r"[^\w]", "", p))) for p in parts]
        total = float(sum(weights))
        t = start
        for n, (p, wt) in enumerate(zip(parts, weights)):
            e = end if n == len(parts) - 1 else t + (end - start) * wt / total
            piece = {**w, "word": p, "start": t, "end": e}
            if n:
                piece.pop("brk_before", None)
            if n < len(parts) - 1:
                piece.pop("brk_after", None)
            out.append(piece)
            t = e
    return out


class CommandTable:
    """Keyword phrases of one or more command types, matched against a
    word list (the scan of scene_triggers and voice_triggers). Each
    phrase matches as consecutive tokens or as one merged token
    ("CleoCut." — never the product name), and only when said as a
    command (accept)."""

    def __init__(self, groups: list[tuple[str, list[str], frozenset[str]]]):
        """`groups`: (command type, phrases, strong command words), in
        precedence order; within a type the longest phrase wins."""
        self._types: list[tuple[str, dict, dict]] = []
        for cmd_type, keywords, strong in groups:
            first: dict[str, list[tuple[tuple[str, ...], str, bool]]] = {}
            concat: dict[str, tuple[str, bool]] = {}
            for kw in sorted(keywords, key=lambda p: -len(p.split())):
                toks = tuple(normalize(kw).split())
                if not toks:
                    continue
                weak = is_weak(kw, strong)
                first.setdefault(toks[0], []).append((toks, kw, weak))
                if len(toks) >= 2:
                    joined = "".join(toks)
                    if joined not in PRODUCT_TOKENS:
                        concat.setdefault(joined, (kw, weak))
            self._types.append((cmd_type, first, concat))

    def match(self, words: list[dict], norm: list[str], i: int
              ) -> tuple[str, str, int, float, float, bool] | None:
        """(type, phrase, next index, start, end, weak) of the first
        phrase said as a command at words[i]; `norm`: normalize() of
        every word."""
        if i >= len(words) or not norm[i]:
            return None
        for cmd_type, first, concat in self._types:
            for toks, kw, weak in first.get(norm[i], ()):
                n = len(toks)
                if (tuple(norm[i:i + n]) == toks
                        and accept(words, i, i + n - 1, weak=weak)):
                    start = float(words[i].get("start", 0))
                    return (cmd_type, kw, i + n, start,
                            float(words[i + n - 1].get("end", start)), weak)
            hit = concat.get(norm[i])
            if hit is not None and accept(words, i, i, weak=hit[1]):
                start = float(words[i].get("start", 0))
                return (cmd_type, hit[0], i + 1, start,
                        float(words[i].get("end", start)), hit[1])
        return None


def normalized(words: list[dict]) -> list[str]:
    """normalize() of every word, for CommandTable.match."""
    return [normalize(_text(w)) for w in words]


def index_at(words: list[dict], t: float) -> int:
    """Index of the first word starting at or after `t`."""
    for j, w in enumerate(words):
        if float(w.get("start", 0)) >= t - 1e-6:
            return j
    return len(words)
