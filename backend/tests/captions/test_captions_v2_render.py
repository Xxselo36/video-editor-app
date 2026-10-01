"""UT4: the v2 render for real — Node caption layer (backend/captions)
+ one ffmpeg pass (captions_v2.render_primary) on generated clips.

- Sync: the audit clip (testdata/captions/audit_clip.json: 35 s, a filler
  cut inside "Mistake number two, [uh,] is dead air.") rendered from the
  v1 editor's payload units mapped onto the doc words: every spoken
  word is the active one at its midpoint (trace), no page spans a cut.
- Cuts land on the frame grid: the clip's moving marker says which
  source frame every output frame is.
- Pixels: the encoded output equals the layer composited over the source
  frame (luma SSIM on the caption band).
- A/V: audio and video end within one frame, on both the select path and
  the per-clip path (speed, fades, VFR source).
- Clicks: no transient at any cut (max |Δsample| within ±5 ms ≤ 3× the
  median of the surrounding 200 ms), and the check does catch one without
  the 15 ms fades.
- Loudness: CLEO_LOUDNORM=1 → −14 LUFS ± 1, true peak ≤ −1 dBTP (+0.5
  for AAC).
- CJK: a ja job draws with its per-job subset (UT3).

Skipped without node and the built layer (cd backend/captions && npm ci
&& node build.mjs; the session fixture builds the bundle when the
node_modules are there).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import caption_media as cm
import sync_sim as sim
from backend import captions_v2 as C
from backend import doc as edit_doc

W, H, FPS = 540, 960, 25


@pytest.fixture(scope="module", autouse=True)
def layer():
    if not C.node_binary():
        pytest.skip("node is not installed")
    d = C.layer_dir()
    if not (d / "node_modules" / "@napi-rs" / "canvas").is_dir():
        pytest.skip("caption layer deps missing: cd backend/captions && npm ci")
    r = subprocess.run([C.node_binary(), "build.mjs"], cwd=d, capture_output=True,
                       text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    assert C.layer_available()


def _ffprobe(path: Path, stream: str, entries: str) -> dict:
    from src.ffmpeg_utils import get_ffprobe_path
    r = subprocess.run([get_ffprobe_path(), "-v", "error", "-select_streams", stream,
                        "-show_entries", entries, "-of", "json", str(path)],
                       capture_output=True, text=True, timeout=60)
    return (json.loads(r.stdout).get("streams") or [{}])[0]


def _durations(path: Path) -> tuple[float, float]:
    v = _ffprobe(path, "v:0", "stream=duration")
    a = _ffprobe(path, "a:0", "stream=duration")
    return float(v["duration"]), float(a["duration"])


def _pcm(path: Path, sr: int = 48000) -> np.ndarray:
    r = subprocess.run([cm.ffmpeg(), "-v", "error", "-i", str(path), "-map", "0:a:0",
                        "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True, timeout=120)
    return np.frombuffer(r.stdout, np.float32).astype(np.float64)


def _spec(words, preset="power", lang="en", **extra):
    return {"v": 1, "engine": "v2", "style": {"presetId": preset, "overrides": {}},
            "language": lang, "words": words, "fonts": [], **extra}


def _marker_x(img, w: int, h: int) -> int | None:
    """Left edge of caption_media's moving square: (8 + 4 × source frame)
    mod (w − side)."""
    a = np.asarray(img, dtype=np.int32)
    side = max(8, w // 30)
    y = int(h * .385) + side // 2
    row = a[y]
    hit = np.nonzero((row[:, 0] > 200) & (row[:, 1] > 190) & (row[:, 2] < 120))[0]
    return int(hit[0]) if len(hit) else None


# ── the audit clip: sync, cut grid, pixels ───────────────────────────


@pytest.fixture(scope="module")
def audit(tmp_path_factory):
    V = sim.load_vectors()
    work = tmp_path_factory.mktemp("v2_audit")
    src = cm.make_source(work / "src.mp4", w=W, h=H, fps=FPS, seconds=35.0)
    raw = [w for s in V["whisper_segments"] for w in s["words"]]
    doc_words = edit_doc.words_from_transcript(raw)
    spec = _spec(C.source_words(V["units_payload"], doc_words), preset="clipper")
    segs = [tuple(s) for s in V["segments"]]
    out = work / "out.mp4"
    trace = work / "trace.json"
    res = C.render_primary(str(src), str(out), segs, None, spec, work / "w",
                           trace=str(trace))
    return {"V": V, "src": src, "out": out, "res": res, "spec": spec,
            "trace": json.loads(trace.read_text()), "segs": segs,
            "doc_words": doc_words, "work": work}


def test_audit_clip_select_path_and_frame_count(audit):
    res = audit["res"]
    assert res["path"] == "select" and res["clips"] == 6
    clips = C.clip_plan(audit["segs"], None, FPS)
    assert cm.probe_frames(audit["out"]) == res["frames"] == C.output_frames(clips, FPS)
    v, a = _durations(audit["out"])
    assert abs(v - res["frames"] / FPS) < 1 / FPS
    assert abs(v - a) <= 1 / FPS, (v, a)


def test_every_output_frame_comes_from_its_grid_frame(audit):
    clips = C.clip_plan(audit["segs"], None, FPS)
    n0 = 0
    for c in clips:
        first = round(c["start"] * FPS)
        count = round((c["end"] - c["start"]) * FPS)
        for k in (0, count - 1):   # first and last frame of every clip
            got = _marker_x(cm.frame_at(audit["out"], n0 + k), W, H)
            want = (8 + 4 * (first + k)) % (W - max(8, W // 30))
            assert got is not None and abs(got - want) <= 1, (c, k, got, want)
        n0 += count


def test_every_spoken_word_is_active_at_its_midpoint(audit):
    V, trace = audit["V"], audit["trace"]
    clips = C.clip_plan(audit["segs"], None, FPS)
    mapped = C.output_words(audit["spec"], clips, FPS)
    by_id = {w["id"]: w for w in mapped["words"]}
    rows = trace["frames"]

    def active_at(n):
        return next((r for r in rows if r["from"] <= n <= r["to"]), None)
    truth = [w for w in V["words"] if not w["filler"]]
    checked = right = 0
    for w in truth:
        mid = (w["start"] + w["end"]) / 2
        kept = next((c for c in clips if c["start"] <= mid < c["end"]), None)
        if kept is None:
            continue   # cut away
        out_t = sum(c["end"] - c["start"] for c in clips[:clips.index(kept)]) + mid - kept["start"]
        row = active_at(int(out_t * FPS))
        checked += 1
        word = by_id.get(row["id"]) if row and row["id"] else None
        if word and abs(word["srcStart"] - w["start"]) < 0.01 and word["text"] == w["text"]:
            right += 1
    assert checked >= 75
    assert right / checked >= 0.95, (right, checked)
    print(f"[v2 sync] {right}/{checked} words active at their midpoint")
    assert right == checked   # the audit clip: every word


def test_no_page_spans_a_cut(audit):
    breaks = C.output_words(audit["spec"], C.clip_plan(audit["segs"], None, FPS), FPS)["breaks"]
    pages = audit["trace"]["plan"]["layout"]
    assert len(pages) > 10
    for p in pages:
        assert not any(p["start"] + 1e-3 < b < p["end"] - 1e-3 for b in breaks), p
    # and every word is drawn on exactly one page
    ids = [w["id"] for p in pages for line in p["lines"] for w in line]
    assert len(ids) == len(set(ids))


def _layer_band(spec, src_info, frames_upto: int, mapped, band) -> np.ndarray:
    layer_in = C._layer_input(spec, mapped, src_info, frames_upto + 1, [], band=band)
    r = subprocess.run(C._node_cmd("render"), input=json.dumps(layer_in).encode(),
                       capture_output=True, timeout=120)
    assert r.returncode == 0, r.stderr[-400:]
    size = src_info["W"] * band["height"] * 4
    buf = np.frombuffer(r.stdout[-size:], np.uint8).reshape(band["height"], src_info["W"], 4)
    return buf.astype(np.float64)


def test_output_pixels_are_the_layer_over_the_source(audit):
    """What the viewer gets = the editor's layer composited over the
    source frame (luma SSIM on the caption band, after yuv420p + x264)."""
    src_info = C.probe(str(audit["src"]))
    clips = C.clip_plan(audit["segs"], None, FPS)
    mapped = C.output_words(audit["spec"], clips, FPS)
    band = audit["res"]["band"]
    def luma(x):
        return 0.2126 * x[..., 0] + 0.7152 * x[..., 1] + 0.0722 * x[..., 2]
    scores = []
    for w in mapped["words"][5:60:11]:
        n = int((w["start"] + w["end"]) / 2 * FPS)
        # the source frame of output frame n (select path: clip by clip)
        acc, src_n = 0, None
        for c in clips:
            cnt = round((c["end"] - c["start"]) * FPS)
            if n < acc + cnt:
                src_n = round(c["start"] * FPS) + (n - acc)
                break
            acc += cnt
        src = np.asarray(cm.frame_at(audit["src"], src_n), np.float64)
        out = np.asarray(cm.frame_at(audit["out"], n), np.float64)
        lay = _layer_band(audit["spec"], src_info, n, mapped, band)
        top, h = band["top"], band["height"]
        a = lay[..., 3:4] / 255.0
        want = src.copy()
        want[top:top + h] = lay[..., :3] + src[top:top + h] * (1 - a)
        s = cm.ssim(luma(want[top:top + h]), luma(out[top:top + h]))
        scores.append(s)
        # outside the band the frame is the source's
        assert cm.ssim(luma(src[:top]), luma(out[:top])) > 0.97
    print(f"[v2 pixels] band SSIM {[round(s, 4) for s in scores]}")
    assert min(scores) >= 0.98, scores


# ── per-clip path, VFR, A/V ──────────────────────────────────────────


@pytest.fixture(scope="module")
def tone_src(tmp_path_factory):
    """12 s, 30 fps, a loud pure tone: a cut without a fade clicks."""
    work = tmp_path_factory.mktemp("v2_tone")
    src = work / "tone.mp4"
    subprocess.run([cm.ffmpeg(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=12",
                    "-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*220*t):s=48000:d=12",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-g", "30",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
                    str(src)], check=True, timeout=120)
    return src


WORDS = [{"id": f"t{i}", "text": t, "start": 0.3 + 0.4 * i, "end": 0.6 + 0.4 * i}
         for i, t in enumerate(("one two three four five six seven eight nine ten "
                                "eleven twelve thirteen fourteen fifteen sixteen "
                                "seventeen eighteen nineteen twenty twentyone "
                                "twentytwo twentythree twentyfour twentyfive").split())]
TONE_SEGS = [(0.0, 2.013), (2.5, 4.0), (4.0, 6.27), (7.1, 9.0), (10.0, 11.5)]


def test_per_clip_path_speed_and_fades_keep_av_in_sync(tone_src, tmp_path):
    fx = [{"speed": 1.0}, {"speed": 1.5, "fadeIn": 0.3}, {"speed": 1.5},
          {"volume": 0.5, "fadeOut": 0.4}, {"speed": 0.75}]
    out = tmp_path / "fx.mp4"
    res = C.render_primary(str(tone_src), str(out), TONE_SEGS, fx, _spec(WORDS), tmp_path / "w")
    assert res["path"] == "segments"
    clips = C.clip_plan(TONE_SEGS, fx, 30)
    want = sum((c["end"] - c["start"]) / c["speed"] for c in clips)
    v, a = _durations(out)
    assert abs(v - want) <= 1.5 / 30, (v, want)
    assert abs(v - a) <= 1 / 30, (v, a)
    assert abs(cm.probe_frames(out) - C.output_frames(clips, 30)) <= len(clips)


def test_200_sped_up_clips_with_odd_frame_counts_dont_drift(tmp_path):
    """2x on 7-frame clips is 3.5 output frames each: video rounds to 4,
    and audio and captions must take the same 4 frames — else 200 such
    clips drift 100 frames (3.3 s) apart."""
    src = tmp_path / "small.mp4"
    subprocess.run([cm.ffmpeg(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=s=160x288:r=30:d=62",
                    "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*220*t):s=48000:d=62",
                    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
                   check=True, timeout=120)
    segs = [(i * 0.3, i * 0.3 + 7 / 30) for i in range(200)]   # 7 frames, gaps between
    fx = [{"speed": 2.0}] * 200
    words = [{"id": f"w{i}", "text": f"w{i}", "start": i * 0.3 + 0.01, "end": i * 0.3 + 0.2}
             for i in range(200)]
    out = tmp_path / "fast.mp4"
    res = C.render_primary(str(src), str(out), segs, fx, _spec(words), tmp_path / "w")
    clips = C.clip_plan(segs, fx, 30)
    assert res["path"] == "segments" and res["frames"] == 200 * 4
    assert cm.probe_frames(out) == 800
    v, a = _durations(out)
    assert abs(v - 800 / 30) <= 1 / 30, v
    assert abs(v - a) <= 1 / 30, (v, a)
    # captions on the same frame grid: clip k starts at frame 4k
    mapped = C.output_words(_spec(words), clips, 30)
    assert mapped["duration"] == pytest.approx(800 / 30)
    # (inside a clip time runs at its effective speed: 7 source frames in 4)
    assert mapped["words"][199]["start"] == pytest.approx(199 * 4 / 30 + 0.01 / 1.75, abs=1e-6)


def test_vfr_source_takes_the_per_clip_path_and_comes_out_cfr(tone_src, tmp_path, monkeypatch):
    real = C.probe
    monkeypatch.setattr(C, "probe", lambda p: {**real(p), "cfr": False})
    out = tmp_path / "vfr.mp4"
    res = C.render_primary(str(tone_src), str(out), TONE_SEGS[:3], None, _spec(WORDS), tmp_path / "w")
    assert res["path"] == "segments"
    s = _ffprobe(out, "v:0", "stream=r_frame_rate,avg_frame_rate")
    assert s["r_frame_rate"] == "30/1"
    num, den = (int(x) for x in s["avg_frame_rate"].split("/"))
    assert abs(num / den - 30) < 0.05
    v, a = _durations(out)
    assert abs(v - a) <= 1 / 30


def _click_ratios(pcm: np.ndarray, cuts_s: list[float], sr: int = 48000) -> list[float]:
    d = np.abs(np.diff(pcm))
    out = []
    for t in cuts_s:
        i = int(t * sr)
        near = d[max(0, i - int(0.005 * sr)):i + int(0.005 * sr)]
        around = np.concatenate([d[max(0, i - int(0.1 * sr)):max(0, i - int(0.01 * sr))],
                                 d[i + int(0.01 * sr):i + int(0.1 * sr)]])
        out.append(float(near.max() / max(1e-9, np.median(around))))
    return out


def test_no_clicks_at_cuts(tone_src, tmp_path, monkeypatch):
    clips = C.clip_plan(TONE_SEGS, None, 30)
    cuts, t = [], 0.0
    for c in clips[:-1]:
        t += c["end"] - c["start"]
        if c["cut_after"]:
            cuts.append(t)
    assert len(cuts) == 3   # 4.0 continues the source: a split, not a cut
    out = tmp_path / "fade.mp4"
    C.render_primary(str(tone_src), str(out), TONE_SEGS, None, _spec(WORDS), tmp_path / "w")
    ratios = _click_ratios(_pcm(out), cuts)
    assert max(ratios) <= 3.0, ratios
    # the check is sharp: without the fades the same cuts click
    monkeypatch.setattr(C, "CUT_FADE_S", 0.0)
    raw = tmp_path / "raw.mp4"
    inputs, graph, _ = C.build_graph(clips, C.probe(str(tone_src)), layer=None)
    graph = re.sub(r",afade=t=(in|out)(:st=[0-9.]+)?:d=0(?=[,\[])", "", graph)
    subprocess.run([cm.ffmpeg(), "-y", "-v", "error", "-i", str(tone_src),
                    "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "256k",
                    str(raw)], check=True, timeout=120)
    assert max(_click_ratios(_pcm(raw), cuts)) > 3.0


def test_loudnorm_to_minus_14(tone_src, tmp_path, monkeypatch):
    from backend import audio_analysis
    loud = audio_analysis.measure_loudness(str(tone_src))
    assert loud and loud["I"] > -10   # the tone is loud: −14 means turning it down
    # The switch lives on the API (build_spec puts the measurement in the
    # spec); the render worker on Modal doesn't have CLEO_LOUDNORM and must
    # still apply it.
    monkeypatch.delenv("CLEO_LOUDNORM", raising=False)
    out = tmp_path / "loud.mp4"
    C.render_primary(str(tone_src), str(out), TONE_SEGS, None,
                     _spec(WORDS, loudness=loud), tmp_path / "w")
    r = subprocess.run([cm.ffmpeg(), "-nostats", "-i", str(out), "-map", "0:a:0",
                        "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, timeout=120)
    summary = r.stderr[r.stderr.rindex("Summary:"):]
    i = float(re.search(r"I:\s+(-?[0-9.]+) LUFS", summary).group(1))
    tp = float(re.search(r"Peak:\s+(-?[0-9.]+) dBFS", summary).group(1))
    assert abs(i - (-14.0)) <= 1.0, i
    assert tp <= -0.5, tp


def test_none_style_cuts_without_a_layer(tone_src, tmp_path):
    out = tmp_path / "none.mp4"
    res = C.render_primary(str(tone_src), str(out), TONE_SEGS[:2], None,
                           _spec(WORDS, preset="none"), tmp_path / "w")
    assert res["band"] is None and out.is_file()


# ── CJK with the job's subset ────────────────────────────────────────


def test_ja_draws_with_the_job_subset(tone_src, tmp_path):
    pytest.importorskip("fontTools")
    from backend import font_subset
    text = "誰もあなたが本題に入るまで十秒も待ってくれません"
    made = font_subset.make("noto-sans-jp-800", text, tmp_path / "fonts")
    words = [{"id": f"j{i}", "text": text[i * 2:i * 2 + 2], "start": 0.2 + 0.3 * i,
              "end": 0.45 + 0.3 * i} for i in range(len(text) // 2)]
    spec = _spec(words, preset="power", lang="ja",
                 fonts=[{"id": "noto-sans-jp-800", "json": "jobs/x/fonts/sub.json",
                         "ttf": "jobs/x/fonts/sub.ttf"}])
    files = {"jobs/x/fonts/sub.json": made["files"]["json"],
             "jobs/x/fonts/sub.ttf": made["files"]["ttf"]}
    fetched = []

    def fetch(key, path):
        fetched.append(key)
        shutil.copyfile(files[key], path)
    out = tmp_path / "ja.mp4"
    res = C.render_primary(str(tone_src), str(out), [(0.0, 4.0)], None, spec,
                           tmp_path / "w", fetch=fetch)
    assert sorted(fetched) == sorted(files)
    plan = res["plan"]
    assert plan["fonts"]["ok"] and not plan["approximate"]
    assert "noto-sans-jp-800:job" in plan["fonts"]["loaded"]
    assert plan["fonts"]["uncovered"] == []


# ── render_to_dir end to end ─────────────────────────────────────────


def test_render_to_dir_v2(tone_src, tmp_path):
    from backend import pipeline
    timings: dict = {}
    files = pipeline.render_to_dir(
        str(tone_src), str(tmp_path / "out"), TONE_SEGS, [], [], "clipper",
        "balanced", "en", ["1:1"], [{"start": 1.0, "end": 3.0, "title": "h"}],
        timings=timings, captions=_spec(WORDS))
    assert Path(files["primary"]).is_file() and Path(files["thumb"]).is_file()
    assert Path(files["formats"]["1:1"]).is_file()
    assert [h["k"] for h in files["hooks"]] == [1]
    assert {"captions_plan", "encode", "thumbnail", "formats", "hooks"} <= set(timings)
    assert "burn" not in timings and not (tmp_path / "out" / "captions").exists()


def test_ux8_forced_breaks_start_caption_pages(tone_src, tmp_path):
    """A forced break in the v2 editor starts a new caption page in the
    export, as in the preview."""
    doc = json.loads((sim.REPO / "testdata/captions/ux8_doc.json").read_text())
    payload = json.loads((sim.REPO / "testdata/captions/ux8_payload.json").read_text())
    spec = _spec(C.source_words(payload["subtitles"], doc["words"]), preset="power")
    trace = tmp_path / "trace.json"
    C.render_primary(str(tone_src), str(tmp_path / "x.mp4"), [(0.0, 5.0)], None, spec,
                     tmp_path / "w", trace=str(trace))
    pages = json.loads(trace.read_text())["plan"]["layout"]
    firsts = [p["lines"][0][0]["id"] for p in pages]
    assert "w0008" in firsts and "w0012" in firsts, firsts
    assert all(w["id"] not in ("w0004", "w0011") for p in pages for ln in p["lines"] for w in ln)


def test_a_font_that_fails_to_load_fails_the_render(tone_src, tmp_path, monkeypatch):
    """No silent fallback font in an export: the layer exits 3, the job
    gets render_failed (and goes back to the editor)."""
    from backend import errors
    monkeypatch.setenv("CLEO_CAPTION_FONTS_DIR", str(tmp_path / "no-fonts"))
    with pytest.raises(C.CaptionLayerError, match="exit 3") as e:
        C.render_primary(str(tone_src), str(tmp_path / "x.mp4"), TONE_SEGS[:1], None,
                         _spec(WORDS), tmp_path / "w")
    assert errors.render_error_code(e.value) == "render_failed"


def test_characters_without_a_font_fail_instead_of_tofu(tone_src, tmp_path):
    """A ja render without the job's subset (or with characters it lacks):
    the layer exits 4, never a "successful" export with tofu."""
    words = [{"id": "j0", "text": "成果", "start": 0.2, "end": 0.8}]
    with pytest.raises(C.CaptionFontError, match="exit 4"):
        C.render_primary(str(tone_src), str(tmp_path / "x.mp4"), [(0.0, 2.0)], None,
                         _spec(words, lang="ja"), tmp_path / "w")


def test_a_subset_that_cant_be_fetched_fails_the_render(tone_src, tmp_path):
    def fetch(key, path):
        raise FileNotFoundError(key)
    spec = _spec([{"id": "j0", "text": "成果", "start": 0.2, "end": 0.8}], lang="ja",
                 fonts=[{"id": "noto-sans-jp-800", "json": "jobs/x/fonts/a.json",
                         "ttf": "jobs/x/fonts/a.ttf"}])
    with pytest.raises(C.CaptionFontError, match="unavailable"):
        C.render_primary(str(tone_src), str(tmp_path / "x.mp4"), [(0.0, 2.0)], None,
                         spec, tmp_path / "w", fetch=fetch)
