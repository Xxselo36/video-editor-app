"""Source ↔ output time mapping for captions (UT3), the Python twin of
web/src/lib/captions/timeline.ts. Both run testdata/timeline_vectors.json
(backend/tests/test_timeline_map.py, the web's timeline.test.ts); change
one, change the other and the vectors.

Words carry SOURCE times (the recording); the edit keeps a list of clips
(source ranges, in output order, optionally sped up). map_to_output turns
words into OUTPUT-time words for the caption engine:
- words outside every clip are dropped (and hidden words, by default);
- inside a clip: t_out = clip_out_start + (t_src − clip.start) / speed;
- consecutive clips that continue each other in the source (a split, a
  speed change) form one run; every other boundary is a cut and becomes
  a hard page break (`breaks`, output seconds);
- a word straddling a cut belongs to the run holding most of it and is
  clipped to that run, so no word — and no page — shows in two clips;
- `offset_ms` (the global sync nudge, −300..300) shifts words after
  mapping, clamped to their run.

Clips are dicts {start, end, speed?} or (start, end) pairs (job.segments);
words are dicts {id, text, start, end, hidden?, breakBefore?} (EditDoc
words). Plain floats throughout, the same operations in the same order as
the TypeScript, so both sides agree to the last bit on the vectors.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

EPS = 1e-3
OFFSET_LIMIT_MS = 300.0


@dataclass
class _Placed:
    start: float
    end: float
    speed: float
    out_start: float
    out_end: float


@dataclass
class _Run:
    clips: list[_Placed] = field(default_factory=list)
    src_start: float = 0.0
    src_end: float = 0.0
    out_start: float = 0.0
    out_end: float = 0.0


def _clip(c: Any) -> tuple[float, float, Any]:
    if isinstance(c, dict):
        return float(c["start"]), float(c["end"]), c.get("speed")
    return float(c[0]), float(c[1]), None


def _place(clips: Iterable[Any]) -> list[_Placed]:
    out: list[_Placed] = []
    t = 0.0
    for c in clips:
        start, end, speed = _clip(c)
        if not (end - start > EPS):
            continue
        sp = float(speed) if isinstance(speed, (int, float)) and speed > 0 else 1.0
        d = (end - start) / sp
        out.append(_Placed(start, end, sp, t, t + d))
        t += d
    return out


def _runs(placed: list[_Placed]) -> list[_Run]:
    runs: list[_Run] = []
    for c in placed:
        last = runs[-1] if runs else None
        if last is not None and abs(c.start - last.src_end) <= EPS:
            last.clips.append(c)
            last.src_end = c.end
            last.out_end = c.out_end
        else:
            runs.append(_Run([c], c.start, c.end, c.out_start, c.out_end))
    return runs


def _map_in_run(run: _Run, t: float) -> float:
    x = min(run.src_end, max(run.src_start, t))
    for c in run.clips:
        if x <= c.end + 1e-9:
            return c.out_start + (max(x, c.start) - c.start) / c.speed
    return run.clips[-1].out_end


def output_duration(clips: Iterable[Any]) -> float:
    placed = _place(clips)
    return placed[-1].out_end if placed else 0.0


def src_to_out(clips: Iterable[Any], t: float) -> float | None:
    """Output time of a source time, or None if it is cut away."""
    for c in _place(clips):
        if c.start - 1e-9 <= t < c.end:
            return c.out_start + (t - c.start) / c.speed
    return None


def out_to_src(clips: Iterable[Any], t: float) -> float | None:
    """Source time of an output time (clamped to the edit)."""
    placed = _place(clips)
    if not placed:
        return None
    for c in placed:
        if t < c.out_end:
            return c.start + max(0.0, t - c.out_start) * c.speed
    return placed[-1].end


def map_to_output(clips: Iterable[Any], words: Iterable[dict],
                  offset_ms: float = 0.0,
                  include_hidden: bool = False) -> dict[str, Any]:
    """{words: [{id, text, start, end, srcStart, srcEnd, run,
    breakBefore?}], breaks: [output s], duration} — timeline.ts
    mapToOutput."""
    placed = _place(clips)
    runs = _runs(placed)
    duration = placed[-1].out_end if placed else 0.0
    shift = max(-OFFSET_LIMIT_MS, min(OFFSET_LIMIT_MS,
                                      float(offset_ms or 0.0))) / 1000
    per_run: list[list[tuple[dict, int]]] = [[] for _ in runs]
    for order, w in enumerate(words):
        if (w.get("hidden") and not include_hidden) or not str(w.get("text") or "").strip():
            continue
        s = min(float(w["start"]), float(w["end"]))
        e = max(float(w["start"]), float(w["end"]))
        best, best_score = -1, 0.0
        for i, r in enumerate(runs):
            overlap = min(e, r.src_end) - max(s, r.src_start)
            score = overlap if overlap > 0 else (
                1e-9 if r.src_start <= s < r.src_end else 0.0)
            if score > best_score:
                best, best_score = i, score
        if best >= 0:
            per_run[best].append((w, order))
    out: list[dict[str, Any]] = []
    for i, items in enumerate(per_run):
        r = runs[i]
        items.sort(key=lambda it: (float(it[0]["start"]), it[1]))
        for w, _order in items:
            s = min(float(w["start"]), float(w["end"]))
            e = max(float(w["start"]), float(w["end"]))
            os_ = min(r.out_end, max(r.out_start, _map_in_run(r, s) + shift))
            oe = min(r.out_end, max(r.out_start, _map_in_run(r, e) + shift))
            word = {"id": w.get("id"), "text": w.get("text"), "start": os_,
                    "end": max(os_, oe), "srcStart": w["start"],
                    "srcEnd": w["end"], "run": i}
            if w.get("breakBefore"):
                word["breakBefore"] = True
            out.append(word)
    return {"words": out, "breaks": [r.out_start for r in runs[1:]],
            "duration": duration}
