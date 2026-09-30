"""The edit document (EditDoc v2, PLAN_TECH §1.3): built at analysis end
for new web jobs (UT3), read and patched by the editor.

    {v: 2, language, words: [Word], clips: null, style: {presetId,
     overrides}, format: {aspect}, rev}
    Word = {id, text, start, end (SOURCE s), conf?, filler?, hidden?,
            breakBefore?}

- Words come from the transcription's word timings BEFORE the desktop
  code glues short words into caption units (src/audio.py), fillers
  included (flagged, hidden from captions). The LLM transcript cleanup
  is applied to them with apply_text_edit (a token diff: unchanged
  tokens keep their timing, replaced spans share theirs by characters).
- `clips` stays null until the UX10 deploy (such jobs open in the v1
  editor with the caption layer; rule 0.6: no migrations — old jobs have
  no doc at all). job.subtitles is still written for legacy readers.
- Style precedence: settings.caption_style (picked while waiting,
  PATCH /jobs/{id}) → the owner's prefs caption_style_by_aspect[aspect]
  → settings.caption_style_hint (browsers with local jobs send
  "clipper") → power. A preset that can't caption the transcript's
  script is replaced by the first recommended one. The script table is
  the web's own web/src/lib/captions/script-support.json (one file,
  read by both sides).
- apply_text_edit is shared with the web editor (state/textEdit.ts)
  through testdata/text_edit_vectors.json.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
from bisect import bisect_right
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterable

REPO = Path(__file__).resolve().parents[1]
SCRIPT_SUPPORT = REPO / "web" / "src" / "lib" / "captions" / "script-support.json"

DOC_VERSION = 2
DEFAULT_PRESET = "power"
# Tile order of the Style panel (web/src/lib/captions/presets.ts
# LAUNCH_PRESETS; a test keeps them equal).
LAUNCH_PRESETS = ("power", "mega", "clipper", "karaoke", "boxed", "punch",
                  "reveal", "neon", "gradient", "elegant", "subtitle",
                  "minimal")
PRESET_IDS = LAUNCH_PRESETS + ("none",)
DEFAULT_LIVE_PRESETS = "clipper,power"
# v1 preset ids → v2 styles (web/src/lib/captions/migrate.ts V1_PRESETS).
V1_PRESETS: dict[str, dict[str, Any]] = {
    "clean": {"presetId": "minimal", "overrides": {}},
    "subtle": {"presetId": "minimal", "overrides": {}},
    "classic": {"presetId": "power", "overrides": {"highlightColor": "#FFFFFF"}},
    "highlight": {"presetId": "boxed", "overrides": {}},
    "flash": {"presetId": "mega", "overrides": {}},
    "punch": {"presetId": "punch", "overrides": {}},
    "elegant": {"presetId": "elegant", "overrides": {}},
    "clipper": {"presetId": "clipper", "overrides": {}},
    "none": {"presetId": "none", "overrides": {}},
}
ASPECTS = ("9:16", "16:9", "original")

MAX_WORDS = 50_000
MAX_PATCH_BYTES = 64 * 1024
MAX_CAPTION_OVERRIDES = 2000
MAX_WORD_TEXT = 200
# Characters of a word id: "w0001", split parts "w0001.1".
_WORD_ID = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
_CAPTION_ID = re.compile(r"^[A-Za-z0-9._:-]{1,40}$")
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
# JavaScript's \s, so tokens split exactly like the web port's.
_WS = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_TOKEN = re.compile(f"[^{_WS}]+")
_PUNCT_ONLY = re.compile(r"^[^\w]+$")


class DocError(Exception):
    """A refused doc request: HTTP `status`, `code` (the answer's detail)
    and extra fields for the body."""

    def __init__(self, status: int, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.extra = extra


# ── scripts and presets ──────────────────────────────────────────────


@lru_cache(maxsize=1)
def support() -> dict[str, Any]:
    """web/src/lib/captions/script-support.json (read once)."""
    return json.loads(SCRIPT_SUPPORT.read_text(encoding="utf-8"))


def norm_lang(lang: str | None) -> str:
    """"pt-BR" → "pt", "" → "en" (scripts.ts normLang)."""
    base = re.split(r"[-_]", (lang or "en").strip().lower())[0]
    return base or "en"


def script_of_lang(lang: str | None) -> str:
    return support()["languages"].get(norm_lang(lang), "latin")


def support_level(preset_id: str, lang: str | None) -> str:
    """"native" | "fallback" | "unavailable" (scripts.ts presetSupport)."""
    script = script_of_lang(lang)
    if preset_id == "none":
        return "native"
    row = support()["presets"].get(preset_id)
    if not row or script == "rtl":
        return "unavailable"
    return row.get(script, "unavailable")


def live_presets(value: str | None = None) -> list[str]:
    """CLEO_CAPTION_PRESETS_LIVE (presets.ts parseLiveList): the presets
    the Style panel offers and the v2 render accepts; "none" always."""
    raw = (value if value is not None else os.environ.get(
        "CLEO_CAPTION_PRESETS_LIVE") or DEFAULT_LIVE_PRESETS).strip()
    if raw in ("all", "*"):
        return list(PRESET_IDS)
    ids = [s.lower() for s in re.split(r"[\s,]+", raw) if s.lower() in PRESET_IDS]
    ids = list(dict.fromkeys(ids))
    return ids if "none" in ids else ids + ["none"]


def recommended(lang: str | None, aspect: str | None = None,
                words_per_s: float | None = None,
                last: str | None = None) -> list[str]:
    """The presets UT5 recommends for a transcript, best first: those the
    script supports (native before fallback), within that 16:9 → Subtitle
    Bar, Minimal; fast talkers (> 3 words/s) → Power, One Word; slow ones
    (< 2) → Karaoke, Subtitle Bar; ties → the user's last style, then the
    tile order. RTL scripts: only "none"."""
    if script_of_lang(lang) == "rtl":
        return ["none"]
    liked: list[str] = []
    if aspect == "16:9":
        liked += ["subtitle", "minimal"]
    if words_per_s is not None and words_per_s > 3.0:
        liked += ["power", "punch"]
    elif words_per_s is not None and 0 < words_per_s < 2.0:
        liked += ["karaoke", "subtitle"]
    rank = {"native": 0, "fallback": 1}
    out = []
    for i, p in enumerate(LAUNCH_PRESETS):
        level = support_level(p, lang)
        if level not in rank:
            continue
        pref = liked.index(p) if p in liked else len(liked)
        out.append(((rank[level], pref, 0 if p == last else 1, i), p))
    return [p for _k, p in sorted(out)] or ["none"]


def style_ref(value: Any) -> dict[str, Any] | None:
    """{presetId, overrides} from a preset id (v2, or a v1 alias) or a
    {presetId, overrides} object; None when it names no known preset.
    Overrides are copied as given (validate_style checks them)."""
    if isinstance(value, str):
        pid, over = value, {}
    elif isinstance(value, dict) and isinstance(value.get("presetId"), str):
        pid = value["presetId"]
        over = value.get("overrides") if isinstance(value.get("overrides"), dict) else {}
    else:
        return None
    key = pid.strip().lower()
    if key in PRESET_IDS:
        return {"presetId": key, "overrides": copy.deepcopy(over)}
    alias = V1_PRESETS.get(key)
    if alias is not None:
        return {"presetId": alias["presetId"],
                "overrides": {**alias["overrides"], **copy.deepcopy(over)}}
    return None


def resolve_style(settings: dict | None, prefs: dict | None, language: str | None,
                  aspect: str, words_per_s: float | None = None,
                  live: list[str] | None = None) -> dict[str, Any]:
    """The doc's style at analysis end (precedence in the module doc)."""
    settings = settings or {}
    by_aspect = (prefs or {}).get("caption_style_by_aspect") or {}
    candidates = [settings.get("caption_style"),
                  by_aspect.get(aspect) if isinstance(by_aspect, dict) else None,
                  settings.get("caption_style_hint"), DEFAULT_PRESET]
    ref = next(r for r in (style_ref(c) for c in candidates) if r is not None)
    try:
        ref["overrides"] = validate_overrides(ref["overrides"])
    except DocError:
        ref["overrides"] = {}
    if support_level(ref["presetId"], language) == "unavailable":
        live = live if live is not None else live_presets()
        recs = recommended(language, aspect, words_per_s,
                           last=ref["presetId"])
        pick = next((p for p in recs if p in live), recs[0])
        ref = {"presetId": pick, "overrides": ref["overrides"]}
    return ref


def aspect_of(settings: dict | None) -> str:
    """format.aspect: settings.target_aspect (UX6), else what the
    upload's SmartCam format means (a reframe to 9:16 / 16:9), else the
    source's own frame."""
    s = settings or {}
    if s.get("target_aspect") in ASPECTS:
        return s["target_aspect"]
    if s.get("smartcam_enabled") and s.get("smartcam_format") in ("portrait", "landscape"):
        return "9:16" if s["smartcam_format"] == "portrait" else "16:9"
    return "original"


# ── validation ───────────────────────────────────────────────────────


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _in(v: Any, lo: float, hi: float) -> bool:
    return _num(v) and lo <= v <= hi


def validate_overrides(over: Any) -> dict[str, Any]:
    """The launch override set (review G3) plus per-caption position and
    size: {captionId: {y?, sizeScale?}}, captionId = the id of a caption
    page's first word (v2 doc) or a v1 phrase id. Raises DocError 400."""
    if not isinstance(over, dict):
        raise DocError(400, "bad_style", field="overrides")
    out: dict[str, Any] = {}
    checks: dict[str, Callable[[Any], bool]] = {
        "y": lambda v: _in(v, 0, 1),
        "sizeScale": lambda v: _in(v, 0.6, 1.6),
        "wordsPerPage": lambda v: v in (1, 2, 3, "auto") and not isinstance(v, bool),
        "case": lambda v: v in ("none", "upper"),
        "textColor": lambda v: isinstance(v, str) and bool(_HEX.match(v)),
        "highlightColor": lambda v: isinstance(v, str) and bool(_HEX.match(v)),
        "animation": lambda v: v in ("none", "pop", "fade"),
        "offsetMs": lambda v: _in(v, -300, 300),
    }
    for k, v in over.items():
        if k == "captions":
            out[k] = _validate_caption_overrides(v)
        elif k in checks:
            if not checks[k](v):
                raise DocError(400, "bad_style", field=f"overrides.{k}")
            out[k] = v
        else:
            raise DocError(400, "bad_style", field=f"overrides.{k}")
    return out


def _validate_caption_overrides(v: Any) -> dict[str, dict[str, float]]:
    if not isinstance(v, dict) or len(v) > MAX_CAPTION_OVERRIDES:
        raise DocError(400, "bad_style", field="overrides.captions")
    out: dict[str, dict[str, float]] = {}
    for cid, o in v.items():
        if not _CAPTION_ID.match(cid) or not isinstance(o, dict) or not o:
            raise DocError(400, "bad_style", field="overrides.captions")
        for k, x in o.items():
            ok = _in(x, 0, 1) if k == "y" else (
                _in(x, 0.6, 1.6) if k == "sizeScale" else False)
            if not ok:
                raise DocError(400, "bad_style", field=f"overrides.captions.{k}")
        out[cid] = dict(o)
    return out


def validate_style(value: Any, live: list[str] | None = None) -> dict[str, Any]:
    """A client's style (PATCH): a known live preset or a v1 alias, and
    overrides in range. Raises DocError 400."""
    if isinstance(value, dict):
        extra = set(value) - {"presetId", "overrides"}
        if extra:
            raise DocError(400, "bad_style", field=sorted(extra)[0])
        if "overrides" in value and not isinstance(value["overrides"], dict):
            raise DocError(400, "bad_style", field="overrides")
    ref = style_ref(value)
    if ref is None:
        raise DocError(400, "unknown_preset")
    live = live if live is not None else live_presets()
    if ref["presetId"] not in live:
        raise DocError(400, "preset_not_live", presetId=ref["presetId"])
    ref["overrides"] = validate_overrides(ref["overrides"])
    return ref


def validate_format(value: Any) -> dict[str, str]:
    if (not isinstance(value, dict) or set(value) != {"aspect"}
            or value["aspect"] not in ASPECTS):
        raise DocError(400, "bad_format")
    return {"aspect": value["aspect"]}


def validate_word(w: Any) -> dict[str, Any]:
    """One client word; raises DocError 400 (bad_word)."""
    if not isinstance(w, dict):
        raise DocError(400, "bad_word")
    wid = w.get("id")
    extra = set(w) - {"id", "text", "start", "end", "conf", "filler",
                      "hidden", "breakBefore"}
    if extra or not isinstance(wid, str) or not _WORD_ID.match(wid):
        raise DocError(400, "bad_word", id=wid if isinstance(wid, str) else None)
    text = w.get("text")
    if (not isinstance(text, str) or not text.strip()
            or len(text) > MAX_WORD_TEXT):
        raise DocError(400, "bad_word", id=wid, field="text")
    s, e = w.get("start"), w.get("end")
    if not (_num(s) and _num(e) and 0 <= s <= e):
        raise DocError(400, "bad_word", id=wid, field="start")
    out: dict[str, Any] = {"id": wid, "text": text, "start": s, "end": e}
    if "conf" in w:
        if not _in(w["conf"], 0, 1):
            raise DocError(400, "bad_word", id=wid, field="conf")
        out["conf"] = w["conf"]
    for k in ("filler", "hidden", "breakBefore"):
        if k in w:
            if not isinstance(w[k], bool):
                raise DocError(400, "bad_word", id=wid, field=k)
            if w[k]:
                out[k] = True
    return out


def check_words(words: list[dict], duration: float | None = None) -> None:
    """Count ≤ MAX_WORDS, unique ids, starts non-decreasing (the list is
    sorted by start), inside the recording."""
    if len(words) > MAX_WORDS:
        raise DocError(400, "too_many_words", max=MAX_WORDS)
    seen: set[str] = set()
    prev = -math.inf
    limit = (duration + 1.0) if duration and duration > 0 else math.inf
    for w in words:
        if w["id"] in seen:
            raise DocError(400, "duplicate_word_id", id=w["id"])
        seen.add(w["id"])
        if w["start"] < prev - 1e-9:
            raise DocError(400, "words_not_monotonic", id=w["id"])
        if w["end"] > limit:
            raise DocError(400, "word_out_of_range", id=w["id"])
        prev = w["start"]


def merge_words(words: list[dict], upsert: list[dict],
                delete: list[str]) -> list[dict]:
    """PATCH words: delete ids (unknown ones ignored), replace words by id
    in place, insert new ones at their start (after equal starts)."""
    gone = set(delete)
    out = [w for w in words if w["id"] not in gone]
    pos = {w["id"]: i for i, w in enumerate(out)}
    fresh = []
    for w in upsert:
        if w["id"] in gone:
            continue
        i = pos.get(w["id"])
        if i is not None:
            out[i] = w
        else:
            fresh.append(w)
    for w in fresh:
        i = bisect_right([x["start"] for x in out], w["start"])
        out.insert(i, w)
    return out


def apply_patch(doc: dict, cur_rev: float, payload: Any, *,
                duration: float | None = None,
                live: list[str] | None = None) -> tuple[dict, float]:
    """PATCH /jobs/{id}/doc: (new doc, new rev) or DocError. `payload`:
    {base_rev, rev, style?, format?, words?: {upsert, delete}}. base_rev
    must be the stored rev (else 409 stale_rev: another tab or device
    saved meanwhile) and rev must be newer. Checks run on the merged doc,
    so a refused patch changes nothing."""
    if not isinstance(payload, dict):
        raise DocError(400, "bad_request")
    extra = set(payload) - {"base_rev", "rev", "style", "format", "words"}
    if "clips" in extra:
        raise DocError(400, "clips_not_supported")
    if extra:
        raise DocError(400, "unknown_field", field=sorted(extra)[0])
    base, rev = payload.get("base_rev"), payload.get("rev")
    if not (_num(base) and _num(rev)):
        raise DocError(400, "bad_rev")
    cur = float(cur_rev or 0)
    if float(base) != cur or float(rev) <= cur:
        raise DocError(409, "stale_rev", rev=cur)
    new = copy.deepcopy(doc)
    if "style" in payload:
        new["style"] = validate_style(payload["style"], live)
    if "format" in payload:
        new["format"] = validate_format(payload["format"])
    if "words" in payload:
        ops = payload["words"]
        if not isinstance(ops, dict) or set(ops) - {"upsert", "delete"}:
            raise DocError(400, "bad_words")
        up, de = ops.get("upsert", []), ops.get("delete", [])
        if (not isinstance(up, list) or not isinstance(de, list)
                or not all(isinstance(x, str) for x in de)
                or len(up) > MAX_WORDS or len(de) > MAX_WORDS):
            raise DocError(400, "bad_words")
        new["words"] = merge_words(new.get("words") or [],
                                   [validate_word(w) for w in up], de)
        check_words(new["words"], duration)
    new["rev"] = float(rev)
    return new, float(rev)


# ── text edits (shared with the web: testdata/text_edit_vectors.json) ─


def tokenize(text: str) -> list[str]:
    """Whitespace-separated tokens (JavaScript's \\s set)."""
    return _TOKEN.findall(text or "")


def round_ms(x: float) -> float:
    """Math.round(x * 1000) / 1000 — the same on both sides."""
    return math.floor(x * 1000 + 0.5) / 1000


def _lcs_pairs(a: list[str], b: list[str], cap: int = 250_000) -> list[tuple[int, int]]:
    """Index pairs of a longest common subsequence of equal tokens:
    common prefix and suffix first, then a DP over the middle (none if
    the middle is larger than `cap` cells). Ties: skip the old token."""
    n, m = len(a), len(b)
    p = 0
    while p < n and p < m and a[p] == b[p]:
        p += 1
    s = 0
    while s < n - p and s < m - p and a[n - 1 - s] == b[m - 1 - s]:
        s += 1
    pairs = [(i, i) for i in range(p)]
    ma, mb = a[p:n - s], b[p:m - s]
    x, y = len(ma), len(mb)
    if x and y and x * y <= cap:
        L = [[0] * (y + 1) for _ in range(x + 1)]
        for i in range(x - 1, -1, -1):
            for j in range(y - 1, -1, -1):
                L[i][j] = (L[i + 1][j + 1] + 1 if ma[i] == mb[j]
                           else max(L[i + 1][j], L[i][j + 1]))
        i = j = 0
        while i < x and j < y:
            if ma[i] == mb[j]:
                pairs.append((p + i, p + j))
                i += 1
                j += 1
            elif L[i + 1][j] >= L[i][j + 1]:
                i += 1
            else:
                j += 1
    pairs += [(n - s + k, m - s + k) for k in range(s)]
    return pairs


def _new_id(base: str, taken: set[str]) -> str:
    k = 1
    while f"{base}.{k}" in taken:
        k += 1
    wid = f"{base}.{k}"
    taken.add(wid)
    return wid


def _spread(t0: float, t1: float, tokens: list[str]) -> list[tuple[float, float]]:
    """[t0, t1] shared by the tokens in proportion to their characters
    (code points), boundaries rounded to ms."""
    weights = [max(1, len(t)) for t in tokens]
    total = sum(weights)
    bounds, acc = [t0], 0
    for w in weights[:-1]:
        acc += w
        bounds.append(round_ms(t0 + (t1 - t0) * acc / total))
    bounds.append(t1)
    return [(bounds[k], bounds[k + 1]) for k in range(len(tokens))]


def apply_text_edit(words: list[dict], new_text: str,
                    taken_ids: Iterable[str] | None = None) -> list[dict]:
    """The words of a span after its text became `new_text` (a token
    diff against the words' texts; captions.md §4.2):

    - an unchanged token keeps its word (id, times, flags);
    - a changed run of as many tokens as words: each word keeps its id,
      times and flags and takes the new text;
    - otherwise the run's time [first start, last end] is shared by the
      new tokens in proportion to their characters; they take the run's
      ids in order (extra tokens get "<last id>.<k>"), hidden only if
      every old word was, breakBefore from the first old word;
    - a deleted run merges its time into the word before it (its end
      grows), else the word after it (its start moves back);
    - inserted tokens split the time of the word before them (else the
      word after them) in proportion to characters; the new ones get
      ids "<that word's id>.<k>".
    `taken_ids`: ids in use elsewhere in the doc (new ids avoid them).
    """
    if not words:
        return []
    old = [w["text"] for w in words]
    new = tokenize(new_text)
    taken = set(taken_ids or ()) | {w["id"] for w in words}
    pairs = _lcs_pairs(old, new)
    out: list[dict] = []
    pending_start: float | None = None      # a deleted run before any word
    pending_break = False
    pending_insert: list[str] = []          # tokens before the first word

    def emit(w: dict) -> None:
        nonlocal pending_start, pending_break, pending_insert
        w = dict(w)
        if pending_start is not None:
            w["start"] = min(w["start"], pending_start)
            pending_start = None
        if pending_break:
            w["breakBefore"] = True
            pending_break = False
        if pending_insert:
            toks = pending_insert + [w["text"]]
            spans = _spread(w["start"], w["end"], toks)
            for k, tok in enumerate(pending_insert):
                nw = {"id": _new_id(w["id"], taken), "text": tok,
                      "start": spans[k][0], "end": spans[k][1]}
                if w.get("hidden"):
                    nw["hidden"] = True
                if k == 0 and w.get("breakBefore"):
                    nw["breakBefore"] = True
                out.append(nw)
            w.pop("breakBefore", None)
            w["start"], w["end"] = spans[-1]
            pending_insert = []
        out.append(w)

    def block(o: list[dict], n: list[str]) -> None:
        nonlocal pending_start, pending_break, pending_insert
        if not o and not n:
            return
        if o and len(o) == len(n):
            for w, tok in zip(o, n):
                emit({**w, "text": tok})
            return
        if o and n:
            t0 = o[0]["start"]
            t1 = max(t0, max(w["end"] for w in o))
            spans = _spread(t0, t1, n)
            hidden = all(w.get("hidden") for w in o)
            for k, tok in enumerate(n):
                wid = o[k]["id"] if k < len(o) else _new_id(o[-1]["id"], taken)
                nw = {"id": wid, "text": tok, "start": spans[k][0], "end": spans[k][1]}
                if hidden:
                    nw["hidden"] = True
                if k == 0 and o[0].get("breakBefore"):
                    nw["breakBefore"] = True
                emit(nw)
            return
        if o:  # deleted
            end = max(w["end"] for w in o)
            if out:
                out[-1] = {**out[-1], "end": max(out[-1]["end"], end)}
            else:
                pending_start = o[0]["start"]
                pending_break = pending_break or bool(o[0].get("breakBefore"))
            return
        # inserted
        if out:
            prev = out.pop()
            toks = [prev["text"]] + n
            spans = _spread(prev["start"], prev["end"], toks)
            out.append({**prev, "start": spans[0][0], "end": spans[0][1]})
            for k, tok in enumerate(n):
                nw = {"id": _new_id(prev["id"], taken), "text": tok,
                      "start": spans[k + 1][0], "end": spans[k + 1][1]}
                if prev.get("hidden"):
                    nw["hidden"] = True
                out.append(nw)
        else:
            pending_insert = pending_insert + n

    i = j = 0
    for pi, pj in pairs:
        block(words[i:pi], new[j:pj])
        emit(words[pi])
        i, j = pi + 1, pj + 1
    block(words[i:], new[j:])
    return out


# ── the doc at analysis end ──────────────────────────────────────────


def _vocal(text: str) -> bool:
    """A filler sound (äh, ähm, uh, hm…): never captioned, never part of
    a caption unit (src/audio.py drops them before gluing)."""
    t = text.strip().lower().strip(".,!?;:\"'()[]…–—-")
    if not t:
        return False
    try:
        from src.filler_detection import _is_vocalisation
    except Exception:  # pragma: no cover - src/ is always there
        return False
    return _is_vocalisation(t)


def words_from_transcript(raw: Iterable[dict],
                          fillers: Iterable[dict] | None = None) -> list[dict]:
    """Doc words (ids w0001…, SOURCE times rounded to ms, sorted by
    start) from transcription words ({word|text, start, end,
    probability?}). filler: a filler sound, a punctuation-only
    hesitation mark ("…") or a detected filler range; fillers are hidden."""
    ranges = [(float(f["start"]), float(f["end"])) for f in (fillers or ())
              if f.get("start") is not None and f.get("end") is not None]
    out: list[dict] = []
    for w in raw or ():
        text = str(w.get("text", w.get("word")) or "").strip()
        try:
            s, e = float(w["start"]), float(w["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not text or not (math.isfinite(s) and math.isfinite(e)):
            continue
        s = max(0.0, round_ms(s))
        e = max(s, round_ms(e))
        word: dict[str, Any] = {"text": text, "start": s, "end": e}
        p = w.get("probability")
        if _num(p) and 0 <= p < 1:
            word["conf"] = round(float(p), 3)
        if (_vocal(text) or _PUNCT_ONLY.match(text)
                or any(fs - 0.002 <= s and e <= fe + 0.002 for fs, fe in ranges)):
            word["filler"] = True
            word["hidden"] = True
        out.append(word)
    out.sort(key=lambda x: x["start"])
    return number_words(out)


def words_from_units(subtitles: Iterable[dict]) -> list[dict]:
    """Fallback without word timings: each caption unit's tokens share
    its SOURCE time evenly (a unit that straddles a cut appears twice in
    job.subtitles and is taken once)."""
    seen: set[tuple] = set()
    raw: list[dict] = []
    for u in subtitles or ():
        s = u.get("original_start", u.get("start"))
        e = u.get("original_end", u.get("end"))
        if s is None or e is None or (s, e) in seen:
            continue
        seen.add((s, e))
        toks = tokenize(str(u.get("text") or ""))
        for k, tok in enumerate(toks):
            d = (float(e) - float(s)) / len(toks)
            raw.append({"text": tok, "start": float(s) + k * d,
                        "end": float(s) + (k + 1) * d})
    return words_from_transcript(raw)


def number_words(words: list[dict]) -> list[dict]:
    """Ids w0001, w0002, … in list order (id first in every word)."""
    return [{"id": f"w{i + 1:04d}", **{k: v for k, v in w.items() if k != "id"}}
            for i, w in enumerate(words)]


def apply_cleanup(words: list[dict], subtitles: list[dict],
                  cleaned: dict[int, str]) -> list[dict]:
    """The LLM cleanup's rewritten caption units (index → text) applied
    to the words with apply_text_edit: a unit's words are the non-filler-
    sound words inside its SOURCE time (original_start/end)."""
    if not cleaned:
        return words
    out = list(words)
    done: set[tuple] = set()
    for i in sorted(k for k in cleaned if isinstance(k, int)):
        if not (0 <= i < len(subtitles)):
            continue
        text = cleaned[i]
        u = subtitles[i]
        s = u.get("original_start", u.get("start"))
        e = u.get("original_end", u.get("end"))
        if not isinstance(text, str) or s is None or e is None or (s, e) in done:
            continue
        done.add((s, e))
        idx = [k for k, w in enumerate(out)
               if w["start"] >= float(s) - 0.002 and w["end"] <= float(e) + 0.002
               and not _vocal(w["text"])]
        if not idx:
            continue
        span = [out[k] for k in idx]
        if [w["text"] for w in span] == tokenize(text):
            continue
        taken = {w["id"] for w in out}
        edited = apply_text_edit(span, text, taken)
        drop = set(idx)
        rest = [(w["start"], k, w) for k, w in enumerate(out) if k not in drop]
        first = idx[0]
        ins = [(w["start"], first + n / (len(edited) + 1), w)
               for n, w in enumerate(edited)]
        out = [w for _s, _k, w in sorted(rest + ins, key=lambda x: (x[0], x[1]))]
    return out


def words_per_second(words: list[dict], segments: Iterable | None = None) -> float | None:
    """Spoken (non-filler) words per second of kept speech."""
    n = sum(1 for w in words if not w.get("filler"))
    secs = 0.0
    for seg in segments or ():
        try:
            secs += max(0.0, float(seg[1]) - float(seg[0]))
        except (TypeError, ValueError, IndexError):
            continue
    if secs <= 0 and words:
        secs = words[-1]["end"] - words[0]["start"]
    return n / secs if secs > 0 and n else None


def build_doc(words: list[dict], language: str | None, settings: dict | None,
              prefs: dict | None = None, segments: Iterable | None = None,
              live: list[str] | None = None) -> dict[str, Any]:
    """The EditDoc of a finished analysis (rev 0, clips null)."""
    aspect = aspect_of(settings)
    words = number_words(words)
    return {
        "v": DOC_VERSION,
        "language": norm_lang(language) if language else "en",
        "words": words,
        "clips": None,
        "style": resolve_style(settings, prefs, language, aspect,
                               words_per_second(words, segments), live),
        "format": {"aspect": aspect},
        "rev": 0,
    }


def load_prefs(owner_id: str | None) -> dict | None:
    """The owner's saved preferences (UX6 user_prefs), when that store
    exists; None otherwise (anonymous job, no prefs yet)."""
    if not owner_id:
        return None
    try:
        from backend import prefs as prefs_store  # type: ignore[attr-defined]
    except ImportError:
        return None
    try:
        return prefs_store.get(owner_id)
    except Exception as e:  # never fail an analysis over prefs
        print(f"[doc] prefs of {owner_id} unavailable: {e}", flush=True)
        return None


def commit_change(fields: dict[str, Any], res: dict[str, Any],
                  prefs: dict | None = None,
                  expect: tuple[str, ...] = ("processing",)
                  ) -> Callable[[Any], dict[str, Any] | None]:
    """The job change that saves a finished analysis (the WP1 thread and
    the task queue's worker both commit through it): `fields`, plus the
    doc of `res` with its style resolved against the job AS STORED at
    the commit — a style picked while the analysis ran (PATCH /jobs/{id}
    caption_style) lands in the doc. None (no write) once the job left
    `expect`."""
    base = res.get("doc")

    def change(cur: Any) -> dict[str, Any] | None:
        if getattr(cur, "status", None) not in expect:
            return None
        out = dict(fields)
        if isinstance(base, dict):
            doc = copy.deepcopy(base)
            doc["style"] = resolve_style(
                cur.settings, prefs, doc.get("language"),
                (doc.get("format") or {}).get("aspect") or "original",
                words_per_second(doc.get("words") or [], res.get("segments")))
            out["doc"] = doc
            out["doc_rev"] = 0.0
        return out
    return change
