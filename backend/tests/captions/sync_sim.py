"""Caption sync simulation (UX2): which word the v1 burn highlights at
every spoken word's midpoint, and which caption groups are burned twice.

Runs the real web entry of the burn — `_multi_clip_burn` with the web
pipeline's keyword arguments, so the real `_subs_for` and the real grouping
in `_render_segment_with_standalone_captions` — with two fakes: no video is
decoded (moviepy's VideoFileClip → a ColorClip) and
`create_highlight_phrase_subtitle` records what it would draw (words, their
times, start) instead of drawing it. Ported from the audit lab
(captions_lab/sim_highlight.py, prod_subs.py).

Data: testdata/captions/audit_clip.json, shared with the web test of
phrasesToUnits (web/src/features/editor/legacy/phraseUnits.test.mjs).
Regenerate its derived fields (units, phrases, units_payload) with the real
analysis code:

    python backend/tests/captions/sync_sim.py --regen
"""
from __future__ import annotations

import json
import re
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
VECTORS = REPO / "testdata" / "captions" / "audit_clip.json"
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


def load_vectors(path: Path = VECTORS) -> dict:
    return json.loads(Path(path).read_text())


# ── the analysis side: units exactly as production builds them ─────────

def build_units(whisper_segments: list[dict], segments: list) -> list[dict]:
    """job.subtitles: Whisper words → AudioAnalyzer units (fillers dropped,
    ≤3-char words glued to the next) → mapped onto the cut timeline."""
    from src.audio import AudioAnalyzer
    from src.plugin_api import _map_subtitles_to_segments
    a = AudioAnalyzer.__new__(AudioAnalyzer)
    a._transcription = {"segments": whisper_segments, "language": "en"}
    a._subtitles = []
    a._build_subtitles_from_transcription()
    return _map_subtitles_to_segments(a._subtitles,
                                      [tuple(s) for s in segments])


_SENTENCE_END = re.compile(r"[.!?…][\"'»)\]]*\s*$")


def build_phrases(subs: list[dict], max_words: int = 10,
                  max_gap: float = 1.5) -> list[dict]:
    """1:1 port of buildPhrases (web/src/app/app/page.tsx): units →
    transcript sentences, what the editor shows and edits."""
    out: list[dict] = []
    cur: list[int] = []

    def wc(t: str) -> int:
        return len((t or "").split())

    def flush() -> None:
        nonlocal cur
        if not cur:
            return
        f, last = subs[cur[0]], subs[cur[-1]]
        conf = sum(subs[i].get("confidence", 1) for i in cur) / len(cur)
        out.append({"start": f["start"], "end": last["end"],
                    "original_start": f.get("original_start", f["start"]),
                    "original_end": last.get("original_end", last["end"]),
                    "confidence": conf,
                    "text": " ".join((subs[i]["text"] or "").strip()
                                     for i in cur)})
        cur = []

    for i, s in enumerate(subs):
        if not (s["text"] or "").strip():
            continue
        if not cur:
            cur.append(i)
            continue
        prev = subs[cur[-1]]
        gap = s["start"] - prev["end"]
        ends = bool(_SENTENCE_END.search((prev["text"] or "").strip()))
        so_far = sum(wc(subs[j]["text"]) for j in cur)
        if ends or gap > max_gap or so_far + wc(s["text"]) > max_words:
            flush()
        cur.append(i)
    flush()
    return out


def legacy_payload(phrases: list[dict]) -> list[dict]:
    """What onApplyRender sent before UX2: one subtitle per sentence."""
    return [{"start": p["start"], "end": p["end"], "text": p["text"].strip(),
             "original_start": p["original_start"],
             "original_end": p["original_end"]}
            for p in phrases if p["text"].strip()]


def expected_units_payload(units: list[dict]) -> list[dict]:
    """phrasesToUnits(phrases, units) for unedited phrases: the units,
    without empty ones and without exact duplicates (a unit spanning a cut
    is mapped into both clips by _map_subtitles_to_segments)."""
    seen, out = set(), []
    for u in units:
        text = (u["text"] or "").strip()
        os_ = u.get("original_start", u["start"])
        oe_ = u.get("original_end", u["end"])
        key = (os_, oe_, text)
        if not text or key in seen:
            continue
        seen.add(key)
        out.append({"start": u["start"], "end": u["end"], "text": text,
                    "original_start": os_, "original_end": oe_})
    return out


# ── the render side ────────────────────────────────────────────────────

def spoken_words(words: list[dict], segments: list) -> list[dict]:
    """Ground truth in OUTPUT time: the non-filler words inside a kept
    segment, segments concatenated."""
    out, off = [], 0.0
    for s, e in segments:
        for w in words:
            if w["start"] >= s and w["end"] <= e and not w.get("filler"):
                out.append({"text": w["text"], "t0": off + w["start"] - s,
                            "t1": off + w["end"] - s})
        off += e - s
    return out


class _FakeVideo:
    """Stands in for moviepy's VideoFileClip: no decoding."""

    def __init__(self, path, *a, **k):
        from moviepy.editor import ColorClip
        self.duration = 10_000.0
        self._clip = ColorClip((1080, 1920), color=(0, 0, 0),
                               duration=self.duration)

    def subclip(self, s, e):
        return self._clip.set_duration(max(0.01, e - s))

    def close(self):
        pass


def record_render(monkeypatch, subtitles: list[dict], segments: list,
                  preset: str = "clipper", **burn_kwargs) -> list[dict]:
    """Every caption group the Clipper-style burn would draw:
    {"seg", "words", "word_times", "duration", "start", "out_start",
    "kwargs"} in output time. `burn_kwargs` go to _multi_clip_burn (the web
    pipeline's set: backend.pipeline.web_burn_kwargs)."""
    import moviepy.editor
    import src.effects as fx
    from plugins.premiere import video_editor_premiere as vep

    lock = threading.Lock()
    events: list[dict] = []
    real_render = vep._render_segment_with_standalone_captions
    current = threading.local()

    def fake_highlight(words, active_index, duration, video_size,
                       subtitle_config=None, word_times=None, **kw):
        ev = {"seg": current.seg, "words": list(words),
              "word_times": list(word_times or []), "duration": duration,
              "kwargs": kw}
        with lock:
            events.append(ev)

        class _Clip:
            def set_start(self, t):
                ev["start"] = t
                return self
        return _Clip()

    def render_segment(input_video, output_path, subs, cut_style, preset_,
                       preloaded_clip=None, **kw):
        current.seg = int(Path(output_path).stem.rsplit("_", 1)[-1])
        real_render(input_video, output_path, subs, cut_style, preset_,
                    preloaded_clip=preloaded_clip, return_clips_only=True,
                    **kw)
        return False          # nothing written: _burn_one skips the mux

    monkeypatch.setattr(moviepy.editor, "VideoFileClip", _FakeVideo)
    monkeypatch.setattr(fx, "create_highlight_phrase_subtitle",
                        fake_highlight)
    monkeypatch.setattr(vep, "_render_segment_with_standalone_captions",
                        render_segment)
    merge_gap = burn_kwargs.pop("merge_gap", 0.0)
    kept = vep._merge_tiny_segments([tuple(s) for s in segments],
                                    min_gap=merge_gap)
    vep._multi_clip_burn("/nonexistent.mp4", [tuple(s) for s in segments],
                         subtitles, preset, "/nonexistent-dir",
                         merge_gap=merge_gap, parallelism=1, **burn_kwargs)
    offsets, off = [], 0.0
    for s, e in kept:
        offsets.append(off)
        off += e - s
    for ev in events:
        ev["out_start"] = offsets[ev["seg"]] + ev["start"]
    events.sort(key=lambda ev: (ev["seg"], ev["start"]))
    return events


def _norm(x: str) -> str:
    return x.strip(".,!?:;\"'").upper()


def shown_at(events: list[dict], t: float):
    """(event, active word index) on screen at output time t, or None."""
    cand = [ev for ev in events
            if ev["out_start"] <= t < ev["out_start"] + ev["duration"]]
    if not cand:
        return None
    ev = cand[-1]
    rel, ai = t - ev["out_start"], 0
    for i in range(len(ev["word_times"]) - 1, -1, -1):
        if rel >= ev["word_times"][i][0]:
            ai = i
            break
    return ev, ai


def score(events: list[dict], truth: list[dict]) -> dict:
    """How many spoken words are the highlighted word at their midpoint,
    and which caption groups are burned in more than one clip."""
    ok, missing, rows = 0, 0, []
    for w in truth:
        mid = (w["t0"] + w["t1"]) / 2
        r = shown_at(events, mid)
        if r is None:
            missing += 1
            rows.append((w["text"], None, None))
            continue
        ev, ai = r
        hl = ev["words"][ai]
        ok += _norm(w["text"]) in [_norm(p) for p in hl.split()]
        rows.append((w["text"], hl, " ".join(ev["words"])))
    segs_of: dict[str, set] = {}
    for ev in events:
        segs_of.setdefault(" ".join(ev["words"]).upper(), set()).add(ev["seg"])
    dups = {k: sorted(v) for k, v in segs_of.items() if len(v) > 1}
    return {"correct": ok, "words": len(truth), "missing": missing,
            "duplicates": dups, "rows": rows, "events": len(events)}


# ── regeneration of the shared vectors ─────────────────────────────────

def dump_vectors(v: dict) -> str:
    """JSON with one record per line (readable diffs)."""
    parts = []
    for k, val in v.items():
        if isinstance(val, list):
            rows = ",\n  ".join(json.dumps(x, ensure_ascii=False) for x in val)
            parts.append(f" {json.dumps(k)}: [\n  {rows}\n ]")
        else:
            parts.append(f" {json.dumps(k)}: {json.dumps(val, ensure_ascii=False)}")
    return "{\n" + ",\n".join(parts) + "\n}\n"


def regen(path: Path = VECTORS) -> dict:
    v = load_vectors(path)
    units = build_units(v["whisper_segments"], v["segments"])
    phrases = build_phrases(units)
    v["units"] = units
    v["phrases"] = phrases
    v["units_payload"] = expected_units_payload(units)
    path.write_text(dump_vectors(v))
    return v


if __name__ == "__main__":
    if sys.argv[1:] == ["--regen"]:
        v = regen()
        print(f"{VECTORS}: {len(v['units'])} units, {len(v['phrases'])} "
              f"phrases, {len(v['units_payload'])} payload units")
    else:
        print(__doc__)
