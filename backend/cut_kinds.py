"""Why each automatic cut was made (UX10, PLAN_TECH `cut_ranges[].kind`).

The analysis removes footage in several passes (silence detection,
filler words and vocalisations, stutters, the "Cleo cut" voice and scene
commands …) and the job keeps only the result: `cut_ranges`, the inverse
of the kept segments. The v2 editor shows each cut with its reason and
restores them by reason ("Restore all pauses"), so every cut range gets a
`kind`:

  silence    a pause (silence detection, smart cut) — also the default
  filler     an "um" / "uh": filler words, hesitations, vocalisations,
             stutters, mumbles
  voice_cmd  a take removed by a voice or scene command ("Cleo cut")
  bad_take   reserved (an LLM bad-take detector; nothing sets it today)

Sources, best first:
  1. the analysis' own log of what each pass cut (src.plugin_api
     analyze_video(cut_kinds=[…]): (kind, start, end) per range);
  2. the edit document's words: a filler-flagged word whose middle lies
     in the cut makes it a filler cut (jobs analysed without the log).
A cut overlapped by voice / scene command ranges for at least a quarter
of its length (or half a second) is voice_cmd; else one with a quarter
of filler ranges or a filler word in it is filler; else silence.

Additive only: ranges keep their id, start, end and every other key;
`kind` is added (an existing one is kept). Jobs from before UX10 have no
kind — the editor falls back to the same word rule (state/cuts.ts).
"""
from __future__ import annotations

import math
from typing import Any, Iterable

KINDS = ("silence", "filler", "voice_cmd", "bad_take")
DEFAULT_KIND = "silence"

# share of a cut (or absolute seconds) a source must cover to name it
_SHARE = 0.25
_ABS_S = 0.5


def _span(r: Any) -> tuple[float, float] | None:
    try:
        if isinstance(r, dict):
            s, e = float(r["start"]), float(r["end"])
        else:
            s, e = float(r[0]), float(r[1])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if not (math.isfinite(s) and math.isfinite(e)) or e <= s:
        return None
    return s, e


def _merged(ranges: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for s, e in sorted(ranges):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def _overlap(s: float, e: float, ranges: list[tuple[float, float]]) -> float:
    total = 0.0
    for a, b in ranges:
        if b <= s:
            continue
        if a >= e:
            break
        total += min(b, e) - max(a, s)
    return total


def sources_by_kind(log: Iterable[Any] | None) -> dict[str, list[tuple[float, float]]]:
    """The analysis log [(kind, start, end), …] (or dicts with kind,
    start, end) as merged ranges per kind; unknown kinds are dropped."""
    by: dict[str, list[tuple[float, float]]] = {}
    for item in log or ():
        if isinstance(item, dict):
            kind, span = item.get("kind"), _span(item)
        else:
            try:
                kind, span = item[0], _span((item[1], item[2]))
            except (IndexError, TypeError):
                continue
        if kind not in KINDS or span is None:
            continue
        by.setdefault(kind, []).append(span)
    return {k: _merged(v) for k, v in by.items()}


def kind_of(start: float, end: float,
            sources: dict[str, list[tuple[float, float]]] | None = None,
            filler_mids: list[float] | None = None) -> str:
    """The kind of the cut [start, end] (module doc)."""
    length = end - start
    if length <= 0:
        return DEFAULT_KIND
    need = min(_ABS_S, _SHARE * length)
    src = sources or {}
    for kind in ("voice_cmd", "bad_take"):
        if _overlap(start, end, src.get(kind, [])) >= need - 1e-9:
            return kind
    if _overlap(start, end, src.get("filler", [])) >= need - 1e-9:
        return "filler"
    if filler_mids and any(start <= m <= end for m in filler_mids):
        return "filler"
    return DEFAULT_KIND


def label(cut_ranges: Iterable[dict] | None, *,
          log: Iterable[Any] | None = None,
          words: Iterable[dict] | None = None) -> list[dict]:
    """`cut_ranges` with a `kind` on each (module doc). New dicts; a
    range that already has a known kind keeps it."""
    sources = sources_by_kind(log)
    mids = sorted(
        (float(w["start"]) + float(w["end"])) / 2
        for w in (words or ())
        if isinstance(w, dict) and w.get("filler") and _span(w) is not None
    )
    out: list[dict] = []
    for c in cut_ranges or ():
        if not isinstance(c, dict):
            continue
        nc = dict(c)
        span = _span(c)
        if nc.get("kind") not in KINDS:
            nc["kind"] = kind_of(*span, sources, mids) if span else DEFAULT_KIND
        out.append(nc)
    return out
