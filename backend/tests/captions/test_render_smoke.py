"""Smoke test: one real web render with the UX2 payload (port of the audit
lab's render_dup.py).

pipeline.render_to_dir — what render_r2 runs on Modal: burn with the web's
options, concat, thumbnail — renders the audit clip's two clips around the
filler cut ("Mistake number two, [uh,] is dead air. Every pause …") with
Clipper, from the word units the editor now sends. A thin wrapper records
what the real caption renderer draws. Checks: the MP4 is there and as long
as the two clips; no caption group is burned in both clips; every spoken
word is the highlighted one at its midpoint; and a caption is on screen
there. The source is a generated still clip (no binary media in git).
"""
from __future__ import annotations

import shutil
import threading
from pathlib import Path

import numpy as np
import pytest

import caption_media as cm
import sync_sim as sim

V = sim.load_vectors()
SEGS = [tuple(s) for s in V["segments"][2:4]]     # around the "uh," cut
W, H, FPS = 540, 960, 25


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    pytest.importorskip("moviepy")
    from _pytest.monkeypatch import MonkeyPatch
    from backend import pipeline
    import src.effects as fx
    from plugins.premiere import video_editor_premiere as vep

    work = tmp_path_factory.mktemp("render_smoke")
    src = cm.make_source(work / "src.mp4", w=W, h=H, fps=FPS, seconds=21.0,
                         marker=False)
    events, lock, where = [], threading.Lock(), threading.local()
    real_draw = fx.create_highlight_phrase_subtitle
    real_segment = vep._render_segment_with_standalone_captions

    def segment(input_video, output_path, *a, **kw):
        where.seg = int(Path(output_path).stem.rsplit("_", 1)[-1])
        return real_segment(input_video, output_path, *a, **kw)

    def draw(words, active_index, duration, video_size, subtitle_config=None,
             word_times=None, **kw):
        clip = real_draw(words, active_index, duration, video_size,
                         subtitle_config, word_times, **kw)
        ev = {"seg": where.seg, "words": list(words), "kwargs": kw,
              "word_times": list(word_times or []), "duration": duration}
        with lock:
            events.append(ev)
        real_set_start = clip.set_start

        def set_start(t, *a, **k):
            ev["start"] = t
            return real_set_start(t, *a, **k)
        clip.set_start = set_start
        return clip

    mp = MonkeyPatch()
    mp.setattr(fx, "create_highlight_phrase_subtitle", draw)
    mp.setattr(vep, "_render_segment_with_standalone_captions", segment)
    try:
        files = pipeline.render_to_dir(
            str(src), str(work / "out"), SEGS, [], V["units_payload"],
            "clipper", "tight", "en", [], [], parallelism=2)
    finally:
        mp.undo()
    offsets = [0.0, SEGS[0][1] - SEGS[0][0]]
    for ev in events:
        ev["out_start"] = offsets[ev["seg"]] + ev["start"]
    yield work, files, events
    shutil.rmtree(work, ignore_errors=True)


def test_render_outputs(rendered):
    _, files, events = rendered
    primary = Path(files["primary"])
    assert primary.is_file() and primary.stat().st_size > 10_000
    want = sum(e - s for s, e in SEGS)
    assert abs(cm.probe_frames(primary) / FPS - want) < 0.1
    assert events and all(ev["kwargs"] == {"bounce_anchor": "caption"}
                          for ev in events)


def test_no_caption_burned_twice_and_every_word_in_sync(rendered):
    _, _, events = rendered
    truth = sim.spoken_words(V["words"], SEGS)
    assert [w["text"] for w in truth][:6] == [
        "Mistake", "number", "two,", "is", "dead", "air."]
    r = sim.score(events, truth)
    assert r["duplicates"] == {}
    assert (r["correct"], r["missing"]) == (len(truth), 0), r["rows"]


def test_a_caption_is_on_screen_at_every_spoken_word(rendered):
    work, files, _ = rendered
    bg = np.asarray(cm.background(W, H), dtype=np.int16)
    y0, y1 = int(H * 0.70), int(H * 0.80)          # Clipper's band (0.75)
    for w in sim.spoken_words(V["words"], SEGS):
        t = (w["t0"] + w["t1"]) / 2
        frame = np.asarray(cm.frame_at(Path(files["primary"]), int(t * FPS)),
                           dtype=np.int16)
        diff = np.abs(frame[y0:y1] - bg[y0:y1]).mean()
        assert diff > 8, f"no caption at {t:.2f}s ({w['text']}): {diff:.1f}"
    # …and none outside it (the first frame before any speech is plain).
    first = np.asarray(cm.frame_at(Path(files["primary"]), 0), dtype=np.int16)
    assert np.abs(first[y0:y1] - bg[y0:y1]).mean() < 4
