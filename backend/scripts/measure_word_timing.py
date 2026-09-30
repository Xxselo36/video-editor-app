#!/usr/bin/env python3
"""Word timing on real speech: Groq vs hand labels, and v1 caption sync
(UX2; PLAN_TECH "Word-timing measurement on real speech", reviews D1, C10).

1. Runs the production analysis (src.plugin_api.analyze_video: Groq
   whisper-large-v3 with the production prompts and its two passes, the
   production cuts and word units) on a real clip, or reads it from
   --cache (Groq is paid once per clip).
2. Aligns Groq's words to hand-labelled word boundaries
   (testdata/real_words/{de,en}.json, made as in
   backend/tests/captions/LABELLING.md) and reports the start/end error:
   median and p90 of |Groq - label|, and the mean (bias).
   A median above 80 ms (start or end) → schedule UT6 (forced alignment)
   before launch.
3. Renders the v1 captions as the web sends them since UX2 (the unedited
   transcript's word units, Clipper, the web's burn options) through the
   real _multi_clip_burn (only decoding and drawing are faked, as in
   test_caption_sync.py) and counts how many labelled words Groq
   recognised are the highlighted word at their labelled midpoint.
   Gate (test_caption_sync_real.py): >= 95 %, no caption burned twice.

The run also sets CLEO_GROQ_DEBUG=1, so the log shows whether Groq sends
a per-word probability (captions.md C21).

    GROQ_API_KEY=... python backend/scripts/measure_word_timing.py \\
        --clip ~/clips/de_60s.mp4 --labels testdata/real_words/de.json \\
        --cache /tmp/de_analysis.json --json /tmp/de_report.json --markdown

    # Audacity label export -> labels JSON
    python backend/scripts/measure_word_timing.py \\
        --convert-labels de_labels.txt --language de --clip-name de_60s.mp4 \\
        --out testdata/real_words/de.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
for _p in (REPO, REPO / "backend" / "tests" / "captions"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

UT6_MEDIAN_MS = 80.0     # median word-time error above this → UT6
SYNC_GATE = 0.95         # share of words highlighted at their midpoint


# ── labels ────────────────────────────────────────────────────────────

def read_audacity_labels(path: Path) -> list[dict]:
    """Audacity "Export Labels" text: start<TAB>end<TAB>label per line
    (a line starting with a backslash holds a label's frequency range)."""
    words = []
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        if not line.strip() or line.startswith("\\"):
            continue
        parts = line.split("\t")
        text = parts[2].strip() if len(parts) > 2 else ""
        if text:
            words.append({"text": text, "start": round(float(parts[0]), 4),
                          "end": round(float(parts[1]), 4)})
    return sorted(words, key=lambda w: w["start"])


def read_labels(path: Path) -> list[dict]:
    path = Path(path)
    if path.suffix.lower() == ".txt":
        return read_audacity_labels(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    words = data["words"] if isinstance(data, dict) else data
    return sorted(({"text": w["text"], "start": float(w["start"]),
                    "end": float(w["end"])} for w in words),
                  key=lambda w: w["start"])


def norm_word(word: str) -> str:
    """Comparable form: NFKC, case-folded, outer punctuation off."""
    w = unicodedata.normalize("NFKC", word or "").casefold()
    return re.sub(r"^[\W_]+|[\W_]+$", "", w)


# ── analysis (production code) ───────────────────────────────────────

def run_analysis(clip: Path, style: str = "balanced") -> dict:
    """analyze_video as the web pipeline runs it; returns the raw Whisper
    transcription (captured on its way into the unit builder), the kept
    segments and the word units (job.subtitles before the LLM cleanup)."""
    os.environ.setdefault("CLEO_GROQ_DEBUG", "1")
    from src import audio as audio_mod
    from src.plugin_api import analyze_video
    captured: dict = {}
    real = audio_mod.AudioAnalyzer._build_subtitles_from_transcription

    def spy(self):
        captured["transcription"] = self._transcription
        return real(self)
    audio_mod.AudioAnalyzer._build_subtitles_from_transcription = spy
    try:
        res = analyze_video(str(clip), style=style)
    finally:
        audio_mod.AudioAnalyzer._build_subtitles_from_transcription = real
    return {"clip": Path(clip).name, "language": res.language,
            "duration": res.duration,
            "transcription": captured.get("transcription") or {},
            "segments": [[float(s), float(e)] for s, e in res.segments],
            "units": list(res.subtitles or [])}


def whisper_words(transcription: dict) -> list[dict]:
    words = []
    for seg in transcription.get("segments") or []:
        for w in seg.get("words") or []:
            text = (w.get("word") or "").strip()
            if text and w.get("start") is not None and w.get("end") is not None:
                words.append({"text": text, "start": float(w["start"]),
                              "end": float(w["end"]),
                              "probability": w.get("probability")})
    return words


# ── 2. timing error ──────────────────────────────────────────────────

def align(labels: list[dict], hyp: list[dict]) -> list[tuple[int, int]]:
    """(label index, Groq word index) for words both have, in order."""
    a = [norm_word(w["text"]) for w in labels]
    b = [norm_word(w["text"]) for w in hyp]
    sm = SequenceMatcher(None, a, b, autojunk=False)
    return [(blk.a + k, blk.b + k) for blk in sm.get_matching_blocks()
            for k in range(blk.size) if a[blk.a + k]]


def _pct(xs: list[float], q: float) -> float | None:
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def _stats(errors_ms: list[float]) -> dict:
    absolute = [abs(e) for e in errors_ms]
    r = lambda x: None if x is None else round(x, 1)  # noqa: E731
    return {"median_abs": r(_pct(absolute, 0.5)), "p90_abs": r(_pct(absolute, 0.9)),
            "mean": r(sum(errors_ms) / len(errors_ms)) if errors_ms else None}


def timing_report(labels: list[dict], hyp: list[dict]) -> dict:
    pairs = align(labels, hyp)
    d_start = [(hyp[j]["start"] - labels[i]["start"]) * 1000 for i, j in pairs]
    d_end = [(hyp[j]["end"] - labels[i]["end"]) * 1000 for i, j in pairs]
    worst = sorted(((max(abs(s), abs(e)), labels[i]["text"], round(s), round(e))
                    for (i, _), s, e in zip(pairs, d_start, d_end)), reverse=True)
    start, end = _stats(d_start), _stats(d_end)
    medians = [m for m in (start["median_abs"], end["median_abs"]) if m is not None]
    return {
        "labels": len(labels), "groq_words": len(hyp), "matched": len(pairs),
        "start_ms": start, "end_ms": end,
        "worst": [{"word": w, "start_ms": s, "end_ms": e} for _, w, s, e in worst[:10]],
        "ut6": bool(medians) and max(medians) > UT6_MEDIAN_MS,
        "pairs": pairs,
    }


# ── 3. v1 caption sync ───────────────────────────────────────────────

def sync_report(labels: list[dict], segments: list, units: list[dict],
                pairs: list[tuple[int, int]]) -> dict:
    """The web's UX2 render of the unedited transcript, scored on the
    labelled words Groq recognised (ASR errors are timing-neutral here)
    that are captioned at all (no filler sounds) and fully inside a kept
    segment."""
    import pytest
    import sync_sim as sim
    from backend.pipeline import web_burn_kwargs
    from src.filler_detection import _is_vocalisation
    payload = sim.expected_units_payload(units)   # = phrasesToUnits, unedited
    with pytest.MonkeyPatch.context() as mp:
        events = sim.record_render(mp, payload, segments, "clipper",
                                   **web_burn_kwargs("clipper"))
    recognised = {i for i, _ in pairs}
    truth, off = [], 0.0
    for s, e in segments:
        for i, w in enumerate(labels):
            if (i in recognised and s <= w["start"] and w["end"] <= e
                    and not _is_vocalisation(norm_word(w["text"]))):
                truth.append({"text": w["text"], "t0": off + w["start"] - s,
                              "t1": off + w["end"] - s})
        off += e - s
    r = sim.score(events, truth, norm=norm_word)
    share = r["correct"] / r["words"] if r["words"] else None
    return {"scored": r["words"], "correct": r["correct"],
            "share": None if share is None else round(share, 4),
            "no_caption": r["missing"], "burned_twice": r["duplicates"],
            "passes": share is not None and share >= SYNC_GATE
            and not r["duplicates"],
            "misses": [row for row in r["rows"] if row[1] is None
                       or norm_word(row[0]) not in map(norm_word, row[1].split())][:20]}


def measure(labels: list[dict], analysis: dict) -> dict:
    hyp = whisper_words(analysis["transcription"])
    timing = timing_report(labels, hyp)
    sync = sync_report(labels, analysis["segments"], analysis["units"],
                       timing.pop("pairs"))
    probs = [w["probability"] for w in hyp if w.get("probability") is not None]
    return {"clip": analysis.get("clip"), "language": analysis.get("language"),
            "timing": timing, "sync": sync,
            "groq_probability_varies": len(set(probs)) > 1}


# ── output ───────────────────────────────────────────────────────────

def summary(rep: dict) -> str:
    t, s = rep["timing"], rep["sync"]
    lines = [
        f"clip {rep['clip']} ({rep['language']}): {t['labels']} labelled words, "
        f"{t['groq_words']} Groq words, {t['matched']} matched",
        f"word start error: median {t['start_ms']['median_abs']} ms, p90 "
        f"{t['start_ms']['p90_abs']} ms, mean {t['start_ms']['mean']:+} ms"
        if t["matched"] else "word start error: no matched words",
        f"word end error:   median {t['end_ms']['median_abs']} ms, p90 "
        f"{t['end_ms']['p90_abs']} ms, mean {t['end_ms']['mean']:+} ms"
        if t["matched"] else "word end error: no matched words",
        ("→ median > 80 ms: schedule UT6 (forced alignment) before launch"
         if t["ut6"] else "→ median <= 80 ms: no UT6 needed"),
        f"v1 caption sync (Clipper, UX2 payload): {s['correct']}/{s['scored']} "
        f"words highlighted at their midpoint ({(s['share'] or 0) * 100:.1f} %), "
        f"{len(s['burned_twice'])} caption groups burned twice → "
        + ("PASS" if s["passes"] else "FAIL") + " (gate 95 %, 0 twice)",
        "Groq per-word probability: "
        + ("varies (real)" if rep["groq_probability_varies"]
           else "constant (missing, defaulted to 1.0?) — see the [groq] debug line"),
    ]
    return "\n".join(lines)


def markdown_row(rep: dict) -> str:
    t, s = rep["timing"], rep["sync"]
    return (f"| {rep['clip']} | {rep['language']} | {t['labels']} | {t['matched']} | "
            f"{t['start_ms']['median_abs']} / {t['start_ms']['p90_abs']} | "
            f"{t['end_ms']['median_abs']} / {t['end_ms']['p90_abs']} | "
            f"{(s['share'] or 0) * 100:.1f} % ({s['correct']}/{s['scored']}) | "
            f"{len(s['burned_twice'])} | {'yes' if t['ut6'] else 'no'} |")


MARKDOWN_HEADER = (
    "| clip | lang | labelled | matched | start error median / p90 (ms) | "
    "end error median / p90 (ms) | v1 sync | burned twice | UT6? |\n"
    "|---|---|---|---|---|---|---|---|---|")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--clip", type=Path, help="the real clip (video or audio)")
    ap.add_argument("--labels", type=Path, help="labels JSON (or Audacity .txt)")
    ap.add_argument("--cache", type=Path,
                    help="analysis JSON: read if it exists, else written")
    ap.add_argument("--style", default="balanced",
                    help="cut style, as the upload's setting (default balanced)")
    ap.add_argument("--json", type=Path, help="write the full report here")
    ap.add_argument("--markdown", action="store_true",
                    help="print a row for docs/qa/word-timing.md")
    ap.add_argument("--convert-labels", type=Path,
                    help="Audacity label export to convert (with --out)")
    ap.add_argument("--language", help="for --convert-labels")
    ap.add_argument("--clip-name", help="for --convert-labels")
    ap.add_argument("--out", type=Path, help="for --convert-labels")
    args = ap.parse_args(argv)

    if args.convert_labels:
        if not args.out:
            ap.error("--convert-labels needs --out")
        words = read_audacity_labels(args.convert_labels)
        doc = {"language": args.language, "clip": args.clip_name,
               "source": args.convert_labels.name, "words": words}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n",
                            encoding="utf-8")
        print(f"{len(words)} labels → {args.out}")
        return 0

    if not args.labels or not (args.clip or (args.cache and args.cache.exists())):
        ap.error("needs --labels and --clip (or an existing --cache)")
    labels = read_labels(args.labels)
    if args.cache and args.cache.exists():
        analysis = json.loads(args.cache.read_text(encoding="utf-8"))
    else:
        if not os.environ.get("GROQ_API_KEY"):
            ap.error("GROQ_API_KEY is not set: the measurement is of the "
                     "production transcription (Groq)")
        analysis = run_analysis(args.clip, style=args.style)
        if args.clip:
            analysis["clip_sha256"] = hashlib.sha256(
                args.clip.read_bytes()).hexdigest()
        if args.cache:
            args.cache.parent.mkdir(parents=True, exist_ok=True)
            args.cache.write_text(json.dumps(analysis, ensure_ascii=False),
                                  encoding="utf-8")
    rep = measure(labels, analysis)
    print(summary(rep))
    if args.markdown:
        print()
        print(MARKDOWN_HEADER)
        print(markdown_row(rep))
    if args.json:
        args.json.write_text(json.dumps(rep, ensure_ascii=False, indent=1),
                             encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
