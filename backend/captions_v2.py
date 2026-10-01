"""Caption engine v2 on the render worker (UT4; captions.md §5.2).

The export draws its captions with the editor's own caption engine
(web/src/lib/captions): a Node process (backend/captions/render_layer.mjs,
an esbuild bundle of web/src/lib/captions/node/render-layer.ts on
@napi-rs/canvas) streams the caption band of every output frame as raw
premultiplied RGBA into ONE ffmpeg pass that cuts the mezz, overlays the
band and encodes — instead of the v1 MoviePy burn per clip + concat +
effects pass (2–3 lossy generations).

API side (the render thread / the task queue's worker, before
pipeline.render_to_keys):

    spec = prepare_render(store, job_id, job, subtitles)   # None → v1

- Engine choice (review F11): CLEO_CAPTION_ENGINE=v2 (default v1) makes
  new renders v2 — only for jobs with an edit document (UT3) whose
  style's preset is live (CLEO_CAPTION_PRESETS_LIVE) and supports the
  transcript's script. The engine is pinned on the job at its FIRST
  render (job.caption_engine) and never changes, so a project keeps the
  look of its first export; switching the flag back to v1 only affects
  jobs that never rendered.
- Words: the render payload's caption units (the v1 editor's
  phrasesToUnits, source times original_start/original_end) mapped onto
  the doc's words — a unit whose tokens are exactly the doc's words in
  its time span takes those words (their own timings and ids); an edited
  unit splits its time over its tokens by length, like the UT1 preview.
- Style (precedence): a style the user picked for this job
  (settings.caption_style, PATCH /jobs/{id}) or an editor-saved doc
  (doc_rev > 0) → doc.style; otherwise the v2 alias of the job's v1
  caption_preset at the web's export position — the look the UT1 live
  preview shows for that job; else doc.style.

Worker side (pipeline.render_to_dir with captions=spec):

    render_primary(mezz, out, segments, effects, spec, work, fetch)

- Every clip boundary snaps to the mezz frame grid (review C8). CFR mezz,
  all speeds 1, no fades: one input, `select` of the kept frames +
  `setpts=N/rate/TB`. Otherwise (speed, fades, VFR mezz, clips out of
  source order) one `-ss -t` input per clip, `fps=rate`, `concat`. Never
  N `trim`s of one video input (3.3 GB peak in the lab).
- Audio: `asplit` → per clip `atrim` + 15 ms `afade` in/out at every cut
  (review C9) + speed / volume / clip fades → `concat`; with
  CLEO_LOUDNORM=1 a linear `loudnorm` to −14 LUFS from the analysis
  measurement (review D10) → AAC 256 kb/s.
- Video: `overlay=0:{band top}:alpha=premultiplied` of the caption
  layer, x264 veryfast crf 17 (CLEO_V2_X264_PRESET / CLEO_V2_CRF).
- The primary only; thumbnail, extra formats and hook clips are made
  from it by render_to_dir as before.
"""
from __future__ import annotations

import copy
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
from bisect import bisect_left
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Iterable

from backend import doc as edit_doc
from backend import timeline_map

REPO = Path(__file__).resolve().parents[1]
# backend/captions: package.json pins @napi-rs/canvas + harfbuzzjs, and
# build.mjs bundles render_layer.mjs there. The Modal image builds it in
# /opt/cleo-captions/backend/captions (CLEO_CAPTION_LAYER_DIR): its
# backend/ mount would hide a build inside /app/backend.
DEFAULT_LAYER_DIR = Path(__file__).resolve().parent / "captions"
FONTS_DIR = REPO / "web" / "public" / "fonts" / "captions"


def layer_dir() -> Path:
    return Path(os.environ.get("CLEO_CAPTION_LAYER_DIR") or DEFAULT_LAYER_DIR)


def layer_bundle() -> Path:
    return layer_dir() / "render_layer.mjs"

SPEC_VERSION = 1
ENGINES = ("v1", "v2")
# The v1 web presets' caption centre (pipeline.WEB_SUB_POS, interim.ts
# WEB_SUB_POS): their v2 alias is drawn where the v1 export put them.
WEB_SUB_POS = {"clean": 0.70, "classic": 0.72, "subtle": 0.76}
# Audio fade at every cut (review C9): long enough to remove the click,
# too short to hear.
CUT_FADE_S = 0.015
AUDIO_BITRATE = "256k"
# Matching a payload unit to the doc's words (source seconds).
_SPAN_EPS = 0.002


class CaptionLayerError(RuntimeError):
    """The caption layer or the v2 encode failed (the job gets
    render_failed, errors.render_error_code)."""


# ── switches ────────────────────────────────────────────────────────


def engine_default() -> str:
    """CLEO_CAPTION_ENGINE: the engine a job's first render pins
    ("v1" unless set to "v2")."""
    v = (os.environ.get("CLEO_CAPTION_ENGINE") or "v1").strip().lower()
    return v if v in ENGINES else "v1"


def loudnorm_enabled() -> bool:
    return (os.environ.get("CLEO_LOUDNORM") or "").strip() == "1"


def node_binary() -> str | None:
    return shutil.which((os.environ.get("CLEO_NODE") or "node").strip() or "node")


def layer_available() -> bool:
    """Can this machine draw the caption layer (node, the bundle and its
    native canvas package)?"""
    return bool(node_binary()) and layer_bundle().is_file() and (
        layer_dir() / "node_modules" / "@napi-rs" / "canvas").is_dir()


# ── API side: engine, style, words ──────────────────────────────────


def style_for(job: Any) -> dict[str, Any]:
    """{presetId, overrides} the v2 render draws (module doc)."""
    doc = job.doc or {}
    settings = job.settings or {}
    doc_style = edit_doc.style_ref(doc.get("style"))
    if settings.get("caption_style") is not None or float(job.doc_rev or 0) > 0:
        if doc_style is not None:
            return doc_style
    v1 = settings.get("caption_preset")
    if isinstance(v1, str) and v1.strip():
        ref = edit_doc.style_ref(v1)
        if ref is not None:
            y = WEB_SUB_POS.get(v1.strip().lower())
            if y is not None and "y" not in ref["overrides"]:
                ref["overrides"]["y"] = y
            return ref
    return doc_style or {"presetId": edit_doc.DEFAULT_PRESET, "overrides": {}}


def choose_engine(job: Any, style: dict[str, Any] | None = None) -> str:
    """The job's pinned engine, or the one its first render pins."""
    if job.caption_engine in ENGINES:
        return job.caption_engine
    if engine_default() != "v2" or not isinstance(job.doc, dict):
        return "v1"
    style = style or style_for(job)
    pid = style["presetId"]
    if pid not in edit_doc.live_presets():
        return "v1"
    lang = job.doc.get("language") or job.language
    if edit_doc.support_level(pid, lang) == "unavailable":
        return "v1"
    return "v2"


def _unit_span(u: dict) -> tuple[float, float] | None:
    s = u.get("original_start", u.get("start"))
    e = u.get("original_end", u.get("end"))
    try:
        s, e = float(s), float(e)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(s) and math.isfinite(e)):
        return None
    return (s, e) if e >= s else (e, s)


def source_words(subtitles: Iterable[dict] | None,
                 doc_words: Iterable[dict] | None) -> list[dict]:
    """The payload's caption units as SOURCE-time words (module doc).
    Each unit is taken once (by its source span), in source order."""
    units: dict[tuple[float, float], str] = {}
    for u in subtitles or ():
        if not isinstance(u, dict):
            continue
        span = _unit_span(u)
        if span is None or span in units:
            continue
        units[span] = str(u.get("text") or "")
    words = sorted((w for w in doc_words or () if isinstance(w, dict)
                    and not w.get("hidden") and str(w.get("text") or "").strip()),
                   key=lambda w: (float(w["start"]), float(w["end"])))
    starts = [float(w["start"]) for w in words]
    out: list[dict] = []
    for ui, (span, text) in enumerate(sorted(units.items())):
        s, e = span
        tokens = edit_doc.tokenize(text)
        if not tokens:
            continue
        i = bisect_left(starts, s - _SPAN_EPS)
        inside = []
        while i < len(words) and starts[i] <= e + _SPAN_EPS:
            if float(words[i]["end"]) <= e + _SPAN_EPS:
                inside.append(words[i])
            i += 1
        if [str(w["text"]) for w in inside] == tokens:
            for w in inside:
                word = {"id": str(w.get("id") or f"u{ui}"), "text": str(w["text"]),
                        "start": float(w["start"]), "end": float(w["end"])}
                if w.get("breakBefore"):
                    word["breakBefore"] = True
                out.append(word)
            continue
        # Edited unit: its time over its tokens by length (interim.ts
        # interimWords).
        total = sum(len(t) for t in tokens) or 1
        at = 0
        for wi, tok in enumerate(tokens):
            ws = s + (e - s) * at / total
            at += len(tok)
            we = e if wi == len(tokens) - 1 else s + (e - s) * at / total
            out.append({"id": f"u{ui}w{wi}", "text": tok,
                        "start": edit_doc.round_ms(ws),
                        "end": edit_doc.round_ms(max(ws, we))})
    out.sort(key=lambda w: (w["start"], w["end"]))
    return out


def build_spec(job: Any, subtitles: list | None, style: dict[str, Any]) -> dict[str, Any]:
    """The captions argument of a v2 render (pipeline.render_to_keys →
    render_r2 / render_to_dir): JSON, small enough for a Modal call."""
    doc = job.doc or {}
    lang = doc.get("language") or job.language or "en"
    fonts = []
    font_id = None
    try:
        from backend import font_subset
        font_id = font_subset.font_for(lang)
    except Exception:
        font_id = None
    entry = (job.font_subsets or {}).get(font_id) if font_id else None
    if isinstance(entry, dict) and entry.get("json") and entry.get("ttf"):
        fonts.append({"id": font_id, "json": entry["json"], "ttf": entry["ttf"]})
    spec: dict[str, Any] = {
        "v": SPEC_VERSION,
        "engine": "v2",
        "style": style,
        "language": lang,
        "words": source_words(subtitles, doc.get("words")),
        "fonts": fonts,
        "fps": job.mezz_fps,
        "cfr": bool(job.mezz_cfr),
    }
    if loudnorm_enabled() and isinstance(job.audio_loudness, dict):
        spec["loudness"] = dict(job.audio_loudness)
    return spec


def prepare_render(store: Any, job_id: str, job: Any,
                   subtitles: list | None) -> dict[str, Any] | None:
    """Pin the job's caption engine at its first render and return the
    v2 captions spec, or None for a v1 render. Never raises: a failure
    here renders v1 (logged) — unless the job is already pinned to v2."""
    try:
        style = style_for(job)
        engine = choose_engine(job, style)
        if job.caption_engine is None:
            def pin(cur: Any) -> dict | None:
                if cur.caption_engine is not None:
                    return None
                return {"caption_engine": engine}
            if store.modify(job_id, pin) is None:
                cur = store.get(job_id)
                engine = (cur.caption_engine if cur is not None
                          and cur.caption_engine in ENGINES else engine)
        if engine != "v2":
            return None
        spec = build_spec(job, subtitles, style)
        snapshot = {"v": 2, "gen": int(job.render_gen or 0),
                    "source": "units", "style": copy.deepcopy(style),
                    "language": spec["language"], "words": spec["words"]}
        store.modify(job_id, lambda cur: {"render_doc": snapshot})
        return spec
    except Exception as e:
        if getattr(job, "caption_engine", None) == "v2":
            raise
        print(f"[captions] job {job_id}: v2 setup failed, rendering v1: "
              f"{type(e).__name__}: {e}", flush=True)
        return None


# ── worker side: clips, words, filter graph ─────────────────────────


def probe(path: str) -> dict[str, Any]:
    """{W, H, rate (ffmpeg rate text), fps, cfr, audio, start}."""
    from src.ffmpeg_utils import get_ffprobe_path
    r = subprocess.run(
        [get_ffprobe_path(), "-v", "error", "-show_entries",
         "stream=codec_type,width,height,r_frame_rate,avg_frame_rate:"
         "format=start_time", "-of", "json", path],
        capture_output=True, text=True, timeout=60)
    data = json.loads(r.stdout or "{}")
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    if v is None:
        raise CaptionLayerError(f"no video stream in {path}")

    def rate(x: Any) -> Fraction | None:
        try:
            f = Fraction(str(x))
        except (ValueError, ZeroDivisionError):
            return None
        return f if f > 0 else None

    real, avg = rate(v.get("r_frame_rate")), rate(v.get("avg_frame_rate"))
    if real is not None and real > 120:
        real = None
    cfr = bool(real and avg and abs(float(avg) - float(real)) / float(real) < 0.005)
    nominal = float(avg or real or 30)
    try:
        from backend.pipeline import CFR_RATES
    except Exception:  # pragma: no cover — pipeline always imports
        CFR_RATES = [("30", 30.0)]
    best_text, best = min(CFR_RATES, key=lambda r: abs(r[1] - nominal))
    if cfr and real is not None and abs(best - float(real)) / float(real) > 0.001:
        text = f"{real.numerator}/{real.denominator}"
    else:
        text = best_text
    try:
        start = float((data.get("format") or {}).get("start_time") or 0.0)
    except (TypeError, ValueError):
        start = 0.0
    return {"W": int(v["width"]), "H": int(v["height"]), "rate": text,
            "fps": float(Fraction(text)), "cfr": cfr,
            "audio": any(s.get("codec_type") == "audio" for s in streams),
            "start": start if math.isfinite(start) else 0.0}


def _num(eff: dict, key: str, default: float) -> float:
    v = eff.get(key)
    try:
        f = default if v is None else float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def clip_plan(segments: Iterable, effects: list[dict] | None,
              fps: float) -> list[dict[str, Any]]:
    """Clips snapped to the frame grid: [{start, end, speed, fadeIn,
    fadeOut, volume, cut_before, cut_after}]; clips shorter than a frame
    are dropped. `cut_*`: the boundary is a cut (not the source-
    continuous edge of a split)."""
    segs = [(float(s), float(e)) for s, e in segments]
    fx = effects if effects and len(effects) == len(segs) else [{}] * len(segs)
    out: list[dict[str, Any]] = []
    for (s, e), eff in zip(segs, fx):
        a = round(s * fps) / fps
        b = round(e * fps) / fps
        if b - a < 0.5 / fps:
            continue
        speed = _num(eff or {}, "speed", 1.0)
        out.append({"start": a, "end": b,
                    "speed": speed if speed > 0 else 1.0,
                    "fadeIn": max(0.0, _num(eff or {}, "fadeIn", 0.0)),
                    "fadeOut": max(0.0, _num(eff or {}, "fadeOut", 0.0)),
                    "volume": max(0.0, _num(eff or {}, "volume", 1.0))})
    for i, c in enumerate(out):
        prev = out[i - 1] if i else None
        nxt = out[i + 1] if i + 1 < len(out) else None
        c["cut_before"] = prev is not None and abs(prev["end"] - c["start"]) > 1e-6
        c["cut_after"] = nxt is not None and abs(c["end"] - nxt["start"]) > 1e-6
    return out


def needs_segment_inputs(clips: list[dict], cfr: bool) -> bool:
    """The single-input select path needs a CFR source, speed 1, no
    fades, and clips in source order."""
    if not cfr:
        return True
    last = -1.0
    for c in clips:
        if abs(c["speed"] - 1.0) > 1e-3 or c["fadeIn"] > 0 or c["fadeOut"] > 0:
            return True
        if c["start"] < last - 1e-6:
            return True
        last = c["end"]
    return False


def output_frames(clips: list[dict], fps: float) -> int:
    total = 0
    for c in clips:
        total += max(1, int(math.floor((c["end"] - c["start"]) / c["speed"] * fps + 0.5)))
    return total


def _atempo(speed: float) -> list[str]:
    out = []
    r = speed
    while r > 2.0:
        out.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        out.append("atempo=0.5")
        r /= 0.5
    if abs(r - 1.0) > 1e-3:
        out.append(f"atempo={r:.6f}")
    return out


def _f(x: float) -> str:
    return f"{x:.6f}".rstrip("0").rstrip(".") or "0"


def build_graph(clips: list[dict], src: dict[str, Any], *,
                layer: dict[str, Any] | None,
                loudness: dict[str, Any] | None = None,
                segment_inputs: bool | None = None,
                ) -> tuple[list[list[str]], str, bool]:
    """(per-input ffmpeg args, filter graph, has audio). Input 0..k-1:
    the mezz (once, or once per clip); the caption layer, if any, is the
    last input (rawvideo on stdin). Output pads: [vout] and [aout]."""
    rate = Fraction(src["rate"])
    fps = float(rate)
    # ffmpeg starts every input at t = 0 (no -copyts), so filter times
    # and -ss positions are source times as the analysis measured them.
    seg = needs_segment_inputs(clips, src["cfr"]) if segment_inputs is None else segment_inputs
    audio = bool(src.get("audio"))
    n = len(clips)
    inputs: list[list[str]] = []
    parts: list[str] = []
    half = 0.5 / fps
    if not seg:
        inputs.append([])
        terms = "+".join(
            f"gte(t\\,{_f(c['start'] - half)})*lt(t\\,{_f(c['end'] - half)})"
            for c in clips)
        parts.append(f"[0:v]select='{terms}',"
                     f"setpts=N*{rate.denominator}/{rate.numerator}/TB[vcat]")
        if audio:
            if n == 1:
                parts.append("[0:a]anull[as0]")
            else:
                parts.append("[0:a]asplit=" + str(n) + "".join(f"[as{i}]" for i in range(n)))
    else:
        for i, c in enumerate(clips):
            inputs.append(["-ss", _f(c["start"]), "-t", _f(c["end"] - c["start"])])
            v = [f"[{i}:v]setpts=PTS-STARTPTS"]
            if abs(c["speed"] - 1.0) > 1e-3:
                v.append(f"setpts=PTS/{c['speed']:.6f}")
            v.append(f"fps={rate.numerator}/{rate.denominator}")
            d = (c["end"] - c["start"]) / c["speed"]
            if c["fadeIn"] > 0:
                v.append(f"fade=t=in:st=0:d={_f(min(c['fadeIn'], d / 2))}")
            if c["fadeOut"] > 0:
                fo = min(c["fadeOut"], d / 2)
                v.append(f"fade=t=out:st={_f(max(0.0, d - fo))}:d={_f(fo)}")
            parts.append(",".join(v) + f"[v{i}]")
        parts.append("".join(f"[v{i}]" for i in range(n))
                     + f"concat=n={n}:v=1:a=0[vcat]")
    if audio:
        for i, c in enumerate(clips):
            if seg:
                a = [f"[{i}:a]asetpts=PTS-STARTPTS",
                     f"atrim=duration={_f(c['end'] - c['start'])}"]
            else:
                a = [f"[as{i}]atrim=start={_f(c['start'])}:end={_f(c['end'])}",
                     "asetpts=PTS-STARTPTS"]
            a += _atempo(c["speed"])
            if abs(c["volume"] - 1.0) > 1e-3:
                a.append(f"volume={c['volume']:.4f}")
            d = (c["end"] - c["start"]) / c["speed"]
            fi = min(c["fadeIn"], d / 2) if c["fadeIn"] > 0 else 0.0
            fo = min(c["fadeOut"], d / 2) if c["fadeOut"] > 0 else 0.0
            if fi > 0:
                a.append(f"afade=t=in:st=0:d={_f(fi)}")
            elif c["cut_before"] and d > 4 * CUT_FADE_S:
                a.append(f"afade=t=in:st=0:d={_f(CUT_FADE_S)}")
            if fo > 0:
                a.append(f"afade=t=out:st={_f(max(0.0, d - fo))}:d={_f(fo)}")
            elif c["cut_after"] and d > 4 * CUT_FADE_S:
                a.append(f"afade=t=out:st={_f(d - CUT_FADE_S)}:d={_f(CUT_FADE_S)}")
            parts.append(",".join(a) + f"[a{i}]")
        tail = ["".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1"]
        if loudness:
            try:
                tail.append(
                    "loudnorm=I=-14:TP=-1:LRA=11:linear=true"
                    f":measured_I={float(loudness['I']):.2f}"
                    f":measured_TP={float(loudness['TP']):.2f}"
                    f":measured_LRA={float(loudness['LRA']):.2f}"
                    f":measured_thresh={float(loudness['thresh']):.2f}"
                    f":offset={float(loudness['offset']):.2f}")
                tail.append("aresample=48000")
            except (KeyError, TypeError, ValueError):
                pass
        parts.append(",".join(tail) + "[aout]")
    if layer:
        k = len(inputs)
        parts.append(f"[vcat][{k}:v]overlay=0:{int(layer['top'])}:"
                     "alpha=premultiplied:eof_action=pass:format=auto,"
                     "format=yuv420p[vout]")
    else:
        parts.append("[vcat]format=yuv420p[vout]")
    return inputs, ";".join(parts), audio


def output_words(spec: dict[str, Any], clips: list[dict]) -> dict[str, Any]:
    """timeline_map.map_to_output of the spec's words on the snapped
    clips, with the style's sync offset."""
    over = (spec.get("style") or {}).get("overrides") or {}
    return timeline_map.map_to_output(
        [{"start": c["start"], "end": c["end"], "speed": c["speed"]} for c in clips],
        spec.get("words") or [], offset_ms=float(over.get("offsetMs") or 0.0))


# ── worker side: running it ─────────────────────────────────────────


def _layer_input(spec: dict[str, Any], mapped: dict[str, Any], src: dict[str, Any],
                 frames: int, fonts: list[dict], band: dict | None = None,
                 trace: str | None = None) -> dict[str, Any]:
    style = spec.get("style") or {}
    out = {
        "words": [{k: w[k] for k in ("id", "text", "start", "end", "breakBefore") if k in w}
                  for w in mapped["words"]],
        "breaks": mapped["breaks"],
        "style": {"presetId": style.get("presetId") or "none",
                  "overrides": {k: v for k, v in (style.get("overrides") or {}).items()
                                if k != "captions"}},
        "lang": spec.get("language") or "en",
        "W": src["W"], "H": src["H"], "fps": src["fps"], "frames": frames,
        "fontsDir": str(Path(os.environ.get("CLEO_CAPTION_FONTS_DIR") or FONTS_DIR)),
        "fonts": fonts,
    }
    if band is not None:
        out["band"] = band
    if trace:
        out["trace"] = trace
    return out


def _node_cmd(mode: str) -> list[str]:
    node = node_binary()
    bundle = layer_bundle()
    if not node or not bundle.is_file():
        raise CaptionLayerError(
            f"caption layer unavailable (node: {node}, {bundle} missing?)")
    return [node, str(bundle), mode]


def layer_plan(layer_in: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
    r = subprocess.run(_node_cmd("plan"), input=json.dumps(layer_in).encode(),
                       capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise CaptionLayerError(
            f"caption layer plan failed (exit {r.returncode}): "
            f"{r.stderr.decode(errors='replace')[-600:]}")
    return json.loads(r.stdout.decode())


def _fetch_fonts(spec: dict[str, Any], work: Path,
                 fetch: Callable[[str, str], Any] | None) -> list[dict]:
    out = []
    for f in spec.get("fonts") or []:
        if fetch is None:
            print(f"[captions] no fetch for {f.get('id')}: system fallback font", flush=True)
            continue
        d = work / "fonts"
        d.mkdir(parents=True, exist_ok=True)
        jp = d / os.path.basename(f["json"])
        tp = d / os.path.basename(f["ttf"])
        try:
            fetch(f["json"], str(jp))
            fetch(f["ttf"], str(tp))
        except Exception as e:  # the browser had its own CJK font then too
            print(f"[captions] font {f.get('id')} unavailable: {e}", flush=True)
            continue
        out.append({"id": f["id"], "json": str(jp), "file": str(tp)})
    return out


def _encoder_args() -> list[str]:
    return ["-c:v", "libx264",
            "-preset", os.environ.get("CLEO_V2_X264_PRESET", "veryfast"),
            "-crf", os.environ.get("CLEO_V2_CRF", "17"),
            "-pix_fmt", "yuv420p"]


def _ffmpeg_threads() -> list[str]:
    try:
        n = max(0, int(os.environ.get("CLEO_FFMPEG_THREADS", "4")))
    except ValueError:
        n = 4
    return ["-threads", str(n)] if n else []


def _watch(procs: list[subprocess.Popen], cancel_check: Callable[[], bool] | None,
           timeout: float) -> None:
    t0 = time.monotonic()
    while any(p.poll() is None for p in procs):
        if cancel_check and cancel_check():
            for p in procs:
                p.kill()
            raise InterruptedError("Cancelled")
        if time.monotonic() - t0 > timeout:
            for p in procs:
                p.kill()
            raise CaptionLayerError(f"v2 render exceeded {timeout:.0f} s")
        time.sleep(0.05)


def _tail(fh) -> str:
    fh.seek(0)
    return fh.read().decode(errors="replace")[-800:]


def render_primary(
    mezz: str,
    out_path: str,
    segments: list,
    effects: list[dict] | None,
    spec: dict[str, Any],
    work: str | Path,
    *,
    fetch: Callable[[str, str], Any] | None = None,
    timings: dict[str, float] | None = None,
    cancel_check: Callable[[], bool] | None = None,
    progress: Callable[[str, float], None] | None = None,
    trace: str | None = None,
) -> dict[str, Any]:
    """Cut + captions + encode in one ffmpeg pass (module doc). Returns
    {frames, band, path: 'select'|'segments', clips, plan}."""
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    timings = timings if timings is not None else {}
    t = time.monotonic()
    src = probe(mezz)
    clips = clip_plan(segments, effects, src["fps"])
    if not clips:
        raise CaptionLayerError("nothing to render: no clip is a frame long")
    seg = needs_segment_inputs(clips, src["cfr"])
    frames = output_frames(clips, src["fps"])
    mapped = output_words(spec, clips)
    style = spec.get("style") or {}
    band = None
    plan: dict[str, Any] = {}
    layer_in = None
    if (style.get("presetId") or "none") != "none" and mapped["words"]:
        fonts = _fetch_fonts(spec, work, fetch)
        layer_in = _layer_input(spec, mapped, src, frames, fonts, trace=trace)
        plan = layer_plan(layer_in)
        band = plan.get("band")
        if band:
            layer_in["band"] = band
        else:
            layer_in = None
    timings["captions_plan"] = round(time.monotonic() - t, 3)
    t = time.monotonic()
    inputs, graph, audio = build_graph(
        clips, src, layer=band if layer_in else None,
        loudness=spec.get("loudness") if loudnorm_enabled() else None,
        segment_inputs=seg)
    from src.ffmpeg_utils import get_ffmpeg_path
    cmd = [get_ffmpeg_path(), "-y", "-v", "error"]
    if layer_in is None:
        cmd.append("-nostdin")
    for extra in inputs:
        cmd += [*_ffmpeg_threads(), *extra, "-i", mezz]
    if layer_in is not None:
        cmd += ["-f", "rawvideo", "-pix_fmt", "rgba",
                "-s", f"{src['W']}x{band['height']}",
                "-framerate", src["rate"], "-thread_queue_size", "64",
                "-i", "pipe:0"]
    script = None
    if len(graph) > 100_000:
        fd, script = tempfile.mkstemp(suffix=".ffgraph", dir=str(work), text=True)
        with os.fdopen(fd, "w") as fh:
            fh.write(graph)
        cmd += ["-filter_complex_script", script]
    else:
        cmd += ["-filter_complex", graph]
    cmd += ["-map", "[vout]"]
    if audio:
        cmd += ["-map", "[aout]", "-c:a", "aac", "-b:a", AUDIO_BITRATE]
    cmd += [*_encoder_args(), *_ffmpeg_threads(), "-r", src["rate"],
            "-movflags", "+faststart", out_path]
    timeout = float(os.environ.get("CLEO_V2_TIMEOUT_S") or 1800)
    if progress:
        progress("Rendering…", 15)
    with tempfile.TemporaryFile() as ferr, tempfile.TemporaryFile() as nerr:
        node = None
        try:
            if layer_in is not None:
                node = subprocess.Popen(_node_cmd("render"), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=nerr)
                ff = subprocess.Popen(cmd, stdin=node.stdout, stdout=subprocess.DEVNULL,
                                      stderr=ferr)
                node.stdout.close()
                feeder = threading.Thread(target=_feed, args=(node, layer_in), daemon=True)
                feeder.start()
                _watch([ff, node], cancel_check, timeout)
                feeder.join(timeout=5)
            else:
                ff = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=ferr)
                _watch([ff], cancel_check, timeout)
        finally:
            if script:
                Path(script).unlink(missing_ok=True)
        # ffmpeg first: when it fails, the layer only sees a closed pipe.
        if ff.returncode != 0 or not Path(out_path).is_file():
            raise CaptionLayerError(f"ffmpeg v2 render failed (exit {ff.returncode}): {_tail(ferr)}")
        if node is not None and node.returncode != 0:
            raise CaptionLayerError(f"caption layer failed (exit {node.returncode}): {_tail(nerr)}")
        if node is not None:
            line = _tail(nerr).strip().splitlines()
            if line:
                print(line[-1], flush=True)
    timings["encode"] = round(time.monotonic() - t, 3)
    return {"frames": frames, "band": band, "path": "segments" if seg else "select",
            "clips": len(clips), "plan": {k: plan.get(k) for k in ("pages", "presetId", "approximate", "fonts")}}


def _feed(node: subprocess.Popen, layer_in: dict[str, Any]) -> None:
    try:
        node.stdin.write(json.dumps(layer_in).encode())
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            node.stdin.close()
        except OSError:
            pass
