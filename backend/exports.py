"""Exports after the first one (UX11; flows.md §3.6–3.10, PLAN 2.6/2.10).

Pure helpers — stdlib only, the task queue's worker imports this on
Modal too — for:

- **Fair use** (owner-approved, ROADMAP §6a / PLAN 2.6 B): the first
  CLEO_FREE_RENDERS (3) successful exports of a video are free; every
  further one records CLEO_RENDER_FAIRUSE_PCT (25) % of the video's
  charged length in the minutes ledger under its own key
  `{job_id}#r{gen}` (accounts.usage is keyed by job id), with
  enforce=False: it never blocks, and a failed export gives it back.
  Only with billing on and for a real (non-service) user; the instant
  export of a speculative render is never charged and never counted.
- **Caps** (abuse guards, never a paywall): CLEO_MAX_RENDERS_PER_USER
  exports of one account at once (429 too_many_renders),
  CLEO_MAX_RENDERS_PER_JOB_DAY per video per 24 h (429 render_limit),
  CLEO_MAX_RENDER_QUEUE waiting exports (503 server_busy). 0 = off.
- **Instant export** (speculative render, CLEO_SPECULATIVE_RENDER=1):
  what a render of the job as analysed would get — its fingerprint —
  so a later POST /render of exactly that can take the finished result.
- **Bonus clips** only for an untouched timeline (review G6).
- **Download names** (review F9) and the **SRT / VTT** caption files
  (review F8) of the latest export.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import unicodedata
from typing import Any, Iterable

DAY_S = 86400.0
# Bonus clips only from videos at least this long (output seconds).
HOOKS_MIN_OUTPUT_S = 90.0


# ── settings ─────────────────────────────────────────────────────────


def _env_num(name: str, default: float) -> float:
    try:
        v = float((os.environ.get(name) or "").strip() or default)
    except ValueError:
        return float(default)
    return v if math.isfinite(v) else float(default)


def free_renders() -> int:
    """CLEO_FREE_RENDERS: successful exports per video that cost nothing."""
    return max(0, int(_env_num("CLEO_FREE_RENDERS", 3)))


def fairuse_pct() -> float:
    """CLEO_RENDER_FAIRUSE_PCT: % of the video's charged length every
    export after the free ones records (0–100)."""
    return min(100.0, max(0.0, _env_num("CLEO_RENDER_FAIRUSE_PCT", 25)))


def max_renders_per_user() -> int:
    """CLEO_MAX_RENDERS_PER_USER (default 1, 0 = no cap)."""
    return max(0, int(_env_num("CLEO_MAX_RENDERS_PER_USER", 1)))


def max_render_queue() -> int:
    """CLEO_MAX_RENDER_QUEUE: exports that may wait for a render slot
    (default 50, 0 = no cap)."""
    return max(0, int(_env_num("CLEO_MAX_RENDER_QUEUE", 50)))


def max_renders_per_job_day() -> int:
    """CLEO_MAX_RENDERS_PER_JOB_DAY (default 20, 0 = no cap)."""
    return max(0, int(_env_num("CLEO_MAX_RENDERS_PER_JOB_DAY", 20)))


def speculative_enabled() -> bool:
    """CLEO_SPECULATIVE_RENDER=1: render v2-engine jobs once right after
    their analysis, so an export without changes is instant."""
    return (os.environ.get("CLEO_SPECULATIVE_RENDER") or "").strip() == "1"


# ── fair use ─────────────────────────────────────────────────────────


def render_cost_seconds(basis_seconds: float | None) -> int:
    """Seconds one paid export records: ceil(pct % of the basis)."""
    basis = max(0.0, float(basis_seconds or 0.0))
    return int(math.ceil(fairuse_pct() / 100.0 * basis - 1e-9))


def free_renders_left(renders_ok: int | None) -> int:
    return max(0, free_renders() - int(renders_ok or 0))


def next_render_cost(renders_ok: int | None, basis_seconds: float | None) -> int:
    """What the next export records: 0 while free ones are left."""
    if free_renders_left(renders_ok) > 0:
        return 0
    return render_cost_seconds(basis_seconds)


def usage_key(job_id: str, gen: int) -> str:
    """The ledger row of one paid export (accounts.usage is keyed by job
    id; the job's own row is its upload)."""
    return f"{job_id}#r{int(gen)}"


def recent_renders(times: Iterable[Any] | None, now: float | None = None) -> list[float]:
    """The export request times of the last 24 h (job.render_times)."""
    now = time.time() if now is None else now
    out = []
    for t in times or ():
        try:
            f = float(t)
        except (TypeError, ValueError):
            continue
        if now - DAY_S < f <= now + 60:
            out.append(f)
    return out


# ── fingerprints ─────────────────────────────────────────────────────


def _digest(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _ms(x: Any) -> int | None:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return int(round(f * 1000)) if math.isfinite(f) else None


def clip_plan(segments: Iterable[Any] | None,
              effects: list[dict] | None) -> list[list[Any]]:
    """The rendered clip plan: [start ms, end ms, speed, fadeIn, fadeOut,
    volume] per kept segment, in order."""
    segs = list(segments or [])
    effs = list(effects or [])
    if len(effs) != len(segs):
        effs = [{} for _ in segs]
    out = []
    for seg, eff in zip(segs, effs):
        try:
            s, e = float(seg[0]), float(seg[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        eff = eff if isinstance(eff, dict) else {}
        out.append([_ms(s), _ms(e),
                    round(float(eff.get("speed") or 1.0), 4),
                    round(float(eff.get("fadeIn") or 0.0), 3),
                    round(float(eff.get("fadeOut") or 0.0), 3),
                    round(float(1.0 if eff.get("volume") is None
                                else eff.get("volume")), 3)])
    return out


def segments_hash(segments: Iterable[Any] | None,
                  effects: list[dict] | None = None) -> str:
    """job.analysis_segments_hash: the clip plan the analysis made."""
    return _digest(clip_plan(segments, effects))


def job_plan_hash(job: Any) -> str:
    return segments_hash(job.segments,
                         (job.settings or {}).get("segment_effects"))


def hooks_allowed(job: Any, output_s: float) -> bool:
    """Bonus clips for this render (review G6): only when the timeline is
    the analysis' own (their times are found on it) and the video is at
    least HOOKS_MIN_OUTPUT_S long. Jobs analysed before the hash existed
    keep today's behaviour."""
    if output_s < HOOKS_MIN_OUTPUT_S:
        return False
    want = getattr(job, "analysis_segments_hash", None)
    return not want or want == job_plan_hash(job)


def is_v2(job: Any) -> bool:
    """The job's latest export came from the v2 export sheet (POST /render
    {"client": "v2"}, kept as job.export_client). Every UX11 rule that
    changes an export applies only then; a v1 export behaves as before."""
    return getattr(job, "export_client", None) == "v2"


def settings_for_render(job: Any, output_s: float) -> dict[str, Any]:
    """The settings a render gets: v2 exports with the bonus-clip gate
    (render_settings), v1 exports job.settings as before."""
    if is_v2(job):
        return render_settings(job, output_s)
    return job.settings


def social_digest(subtitles: Iterable[Any] | None,
                  segments: Iterable[Any] | None) -> str:
    """What a post text was made from: the export's captions and cut."""
    return _digest({"units": canonical_units(subtitles),
                    "plan": clip_plan(segments, None)})


def keep_social(job: Any, subtitles: Iterable[Any] | None) -> bool:
    """A v2 export keeps the stored post text when it was made from the
    same transcript and cut (no LLM call); a v1 export always makes it
    again, as before."""
    return (is_v2(job) and bool(job.social_caption)
            and getattr(job, "social_source", None)
            == social_digest(subtitles, job.segments))


def render_settings(job: Any, output_s: float) -> dict[str, Any]:
    """job.settings as a render gets them: bonus clips switched off
    unless hooks_allowed (the job itself is not changed)."""
    settings = dict(job.settings or {})
    if not hooks_allowed(job, output_s):
        settings["hook_clips_enabled"] = False
    return settings


def canonical_units(subtitles: Iterable[Any] | None) -> list[list[Any]]:
    """A render payload's caption units as [text, start ms, end ms] in
    source time (original_start / original_end when given, as the burn
    places them), whitespace-normalized, empty ones and repeats dropped —
    so the same captions compare equal however a client shaped them."""
    out: list[list[Any]] = []
    seen: set[tuple] = set()
    for u in subtitles or ():
        if not isinstance(u, dict):
            continue
        text = " ".join(str(u.get("text") or "").split())
        if not text:
            continue
        s = _ms(u.get("original_start", u.get("start")))
        e = _ms(u.get("original_end", u.get("end")))
        if s is None or e is None:
            continue
        key = (text, s, e)
        if key in seen:
            continue
        seen.add(key)
        out.append([text, s, e])
    return out


def units_hash(subtitles: Iterable[Any] | None) -> str:
    return _digest(canonical_units(subtitles))


def state_fingerprint(job: Any, style: dict | None) -> str:
    """Everything besides the caption units that changes what a render
    of `job` looks like: the clip plan with its effects, the caption
    style and engine, and the revisions of the edit doc and the v1
    transcript. Any save in the editor moves it."""
    settings = job.settings or {}
    return _digest({
        "plan": clip_plan(job.segments, settings.get("segment_effects")),
        "style": style,
        "preset": settings.get("caption_preset"),
        "doc_rev": float(job.doc_rev or 0),
        "phrases_rev": float(job.edited_phrases_rev or 0),
        "disabled_cuts": [],
    })


def analysis_units(job: Any) -> list[dict]:
    """The caption units an unedited editor sends for this job (the
    analysis' word units, as GET /subtitles hands them out): what a
    speculative render draws."""
    out = []
    for u in job.subtitles or ():
        if not isinstance(u, dict) or not str(u.get("text") or "").strip():
            continue
        s = u.get("original_start", u.get("start"))
        e = u.get("original_end", u.get("end"))
        out.append({"start": u.get("start", s), "end": u.get("end", e),
                    "text": u.get("text"), "original_start": s,
                    "original_end": e})
    return out


_DOC_SENTENCE_END = re.compile(r"[.!?…。！？][\"'»”)\]]*$")
MIN_UNIT_S = 0.05


def removed_ranges(segments: Iterable[Any] | None, duration: float | None,
                   min_s: float = 0.05) -> list[tuple[float, float]]:
    """The source ranges the timeline cuts away — web/src/features/editor/
    v2/model.ts removedRanges (via useCuts removedOf: none without a kept
    clip)."""
    kept = []
    for seg in segments or ():
        try:
            s, e = float(seg[0]), float(seg[1])
        except (TypeError, ValueError, IndexError):
            continue
        if e > s:
            kept.append((max(0.0, s), min(float(duration or e) or e, e)))
    if not kept:
        return []
    kept.sort()
    dur = float(duration or 0.0)
    out: list[tuple[float, float]] = []
    cursor = 0.0
    for s, e in kept:
        if s - cursor >= min_s:
            out.append((cursor, s))
        cursor = max(cursor, e)
    if dur - cursor >= min_s:
        out.append((cursor, dur))
    return out


def doc_units(words: Iterable[dict] | None,
              removed: list[tuple[float, float]] | None = None) -> list[dict]:
    """The caption units the v2 editor sends for an unedited doc — the
    Python twin of web/src/features/editor/state/doc.ts captionUnits
    (phrasesToUnits returns them unchanged for unedited sentences):
    hidden words left out; a segment ends at a sentence end, a pause
    over 1.5 s or a forced break; inside it a word of ≤ 3 characters
    takes the next one with it; a unit of ≤ 0.05 s joins a neighbour.
    For the v2 engine both shapes draw the same words (build_spec maps
    units onto the doc's words), so an instant export accepts either.
    `removed` (UX10 exportCaptionSource): words whose middle lies in a
    cut range are left out and end the segment — no unit glues across a
    cut."""
    segs: list[list[dict]] = []
    seg: list[dict] = []
    forced = False
    for w in words or ():
        if not isinstance(w, dict):
            continue
        if removed:
            m = (float(w["start"]) + float(w["end"])) / 2
            if any(a <= m <= b for a, b in removed):
                forced = forced or bool(w.get("breakBefore"))
                if seg:
                    segs.append(seg)
                seg = []
                continue
        if w.get("hidden"):
            forced = forced or bool(w.get("breakBefore"))
            continue
        prev = seg[-1] if seg else None
        brk = forced or bool(w.get("breakBefore"))
        forced = False
        if prev is not None and (
                brk or _DOC_SENTENCE_END.search(str(prev.get("text") or ""))
                or float(w["start"]) - float(prev["end"]) > 1.5):
            segs.append(seg)
            seg = []
        seg.append(w)
    if seg:
        segs.append(seg)
    out: list[dict] = []
    for sw in segs:
        groups: list[list[dict]] = []
        i = 0
        while i < len(sw):
            if len(str(sw[i].get("text") or "").strip()) <= 3 and i + 1 < len(sw):
                groups.append([sw[i], sw[i + 1]])
                i += 2
            else:
                groups.append([sw[i]])
                i += 1
        k = 0
        while k < len(groups) and len(groups) > 1:
            g = groups[k]
            if float(g[-1]["end"]) - float(g[0]["start"]) > MIN_UNIT_S:
                k += 1
                continue
            if k + 1 < len(groups):
                groups[k:k + 2] = [g + groups[k + 1]]
            else:
                groups[k - 1:k + 1] = [groups[k - 1] + g]
                k -= 1
        for g in groups:
            out.append({"start": g[0]["start"], "end": g[-1]["end"],
                        "text": " ".join(str(w.get("text") or "").strip() for w in g),
                        "original_start": g[0]["start"],
                        "original_end": g[-1]["end"]})
    return out


def spec_unit_digests(job: Any, units: list[dict]) -> list[str]:
    """What a POST /render of the unedited job may carry: the analysis'
    units (v1 editor) and, with an edit doc, the doc's (v2 editor)."""
    out = [units_hash(units)]
    words = (job.doc or {}).get("words") if isinstance(job.doc, dict) else None
    if words:
        removed = removed_ranges(job.segments, job.duration)
        # the v2 editor's export source (UX10: the words that play), and
        # the doc's caption source of editors from before it
        for shape in (doc_units(words, removed), doc_units(words)):
            d = units_hash(shape)
            if d not in out:
                out.append(d)
    return out


def spec_ready(job: Any, style: dict | None) -> bool:
    """A finished speculative render that still matches the job as it is
    stored (no edit since its snapshot)."""
    spec = getattr(job, "spec", None)
    return bool(isinstance(spec, dict) and spec.get("status") == "done"
                and spec.get("output_keys")
                and spec.get("state") == state_fingerprint(job, style))


# ── download names (review F9) ───────────────────────────────────────

_TRANSLIT = {
    # Cyrillic (ISO 9-ish, readable ASCII)
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "і": "i", "ї": "yi", "є": "ye", "ґ": "g",
    # Greek
    "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i",
    "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
    "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
    # Latin letters NFKD doesn't take apart
    "ß": "ss", "æ": "ae", "ø": "o", "œ": "oe", "ł": "l", "đ": "d",
    "ð": "d", "þ": "th", "ı": "i",
}
_SLUG_MAX = 60


def slug(text: str | None) -> str:
    """ASCII file-name slug: lower case, transliterated (Latin accents,
    Cyrillic, Greek), other scripts dropped, words joined by '_'."""
    base = os.path.splitext(str(text or "").strip())[0] if text else ""
    out = []
    for ch in unicodedata.normalize("NFKD", base.lower()):
        if unicodedata.combining(ch):
            continue
        if ch.isascii():
            out.append(ch if ch.isalnum() else " ")
        else:
            out.append(_TRANSLIT.get(ch, " "))
    words = "".join(out).split()
    s = "_".join(words)
    if len(s) > _SLUG_MAX:
        s = s[:_SLUG_MAX].rsplit("_", 1)[0] or s[:_SLUG_MAX]
    return s.strip("_")


def aspect_tag(fmt: str, primary_aspect: str | None) -> str | None:
    """'9x16' for format '9:16'; the primary's own aspect for 'primary'
    (None when it keeps the source's frame)."""
    a = primary_aspect if fmt == "primary" else fmt
    if not a or a == "original" or ":" not in a:
        return None
    return a.replace(":", "x")


def download_name(title: str | None, fmt: str, primary_aspect: str | None,
                  created_at: float | None = None) -> str:
    """`{slug}_cleocuts_{aspect}.mp4` (hook clips: `…_clip_{k}.mp4`);
    `video_{yyyy-mm-dd}` when the title has no usable letters."""
    name = slug(title)
    if not name:
        when = created_at or time.time()
        name = "video_" + time.strftime("%Y-%m-%d", time.gmtime(when))
    if fmt.startswith("hook_"):
        k = re.sub(r"[^0-9]", "", fmt) or "1"
        return f"{name}_cleocuts_clip_{k}.mp4"
    tag = aspect_tag(fmt, primary_aspect)
    return f"{name}_cleocuts_{tag}.mp4" if tag else f"{name}_cleocuts.mp4"


# ── caption files (review F8) ────────────────────────────────────────

CUE_MAX_CHARS = 42
CUE_MAX_LINES = 2
CUE_MAX_S = 7.0
CUE_MIN_S = 0.5
_SENTENCE_END = re.compile(r"[.!?…。！？]['\"”’)\]]*$")


def export_captions(subtitles: Iterable[Any] | None, job: Any,
                    offset_ms: float = 0.0) -> dict[str, Any]:
    """What GET /captions.srt needs of an export, kept with it (the edit
    may change afterwards): the units it drew, its clips, the offset."""
    clips = []
    for seg in job.edit_segments():
        clips.append([round(float(seg["start"]), 4), round(float(seg["end"]), 4),
                      round(float(seg.get("speed") or 1.0), 4)])
    units = [[u[0], u[1] / 1000.0, u[2] / 1000.0]
             for u in canonical_units(subtitles)]
    return {"v": 1, "units": units, "clips": clips,
            "offset_ms": float(offset_ms or 0.0)}


def doc_offset_ms(job: Any) -> float:
    """The v2 caption sync nudge (doc.style.overrides.offsetMs) — only
    the v2 engine applies it."""
    if job.caption_engine != "v2":
        return 0.0
    style = (job.doc or {}).get("style") if isinstance(job.doc, dict) else None
    over = (style or {}).get("overrides") if isinstance(style, dict) else None
    try:
        return float((over or {}).get("offsetMs") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def caption_cues(snapshot: dict[str, Any] | None) -> list[tuple[float, float, list[str]]]:
    """Cues (start, end, lines) in OUTPUT time of an export_captions()
    snapshot: units outside the kept clips dropped, ≤ 42 characters per
    line, ≤ 2 lines, a new cue after a sentence end, at every cut and
    past CUE_MAX_S."""
    from backend import timeline_map
    if not isinstance(snapshot, dict):
        return []
    clips = [{"start": c[0], "end": c[1], "speed": c[2]}
             for c in snapshot.get("clips") or [] if len(c) >= 3]
    words = [{"id": i, "text": u[0], "start": u[1], "end": u[2]}
             for i, u in enumerate(snapshot.get("units") or []) if len(u) >= 3]
    mapped = timeline_map.map_to_output(clips, words,
                                        float(snapshot.get("offset_ms") or 0))
    cues: list[tuple[float, float, list[str]]] = []
    lines: list[str] = []
    start = end = 0.0
    run = None

    def flush() -> None:
        nonlocal lines
        if lines:
            cues.append((start, end, lines))
        lines = []

    for w in mapped["words"]:
        text = " ".join(str(w["text"]).split())
        if not text:
            continue
        if lines and (w["run"] != run or w["end"] - start > CUE_MAX_S):
            flush()
        if not lines:
            start, run = float(w["start"]), w["run"]
            lines = [text]
        else:
            cur = lines[-1]
            if len(cur) + 1 + len(text) <= CUE_MAX_CHARS:
                lines[-1] = f"{cur} {text}"
            elif len(lines) < CUE_MAX_LINES:
                lines.append(text)
            else:
                flush()
                start, run = float(w["start"]), w["run"]
                lines = [text]
        end = float(w["end"])
        if _SENTENCE_END.search(text):
            flush()
    flush()
    # Every cue at least CUE_MIN_S long where the next one leaves room;
    # never overlapping.
    out = []
    for i, (s, e, ls) in enumerate(cues):
        nxt = cues[i + 1][0] if i + 1 < len(cues) else None
        e = max(e, s + CUE_MIN_S)
        if nxt is not None:
            e = min(e, nxt)
        if e <= s:
            e = s + 0.001
        out.append((s, e, ls))
    return out


def _ts(t: float, sep: str) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_srt(cues: list[tuple[float, float, list[str]]]) -> str:
    blocks = [f"{i}\n{_ts(s, ',')} --> {_ts(e, ',')}\n" + "\n".join(ls)
              for i, (s, e, ls) in enumerate(cues, 1)]
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def to_vtt(cues: list[tuple[float, float, list[str]]]) -> str:
    blocks = [f"{_ts(s, '.')} --> {_ts(e, '.')}\n"
              + "\n".join(_vtt_safe(x) for x in ls) for s, e, ls in cues]
    return "WEBVTT\n\n" + "\n\n".join(blocks) + ("\n" if blocks else "")


def _vtt_safe(line: str) -> str:
    return line.replace("&", "&amp;").replace("<", "&lt;").replace("-->", "→")
