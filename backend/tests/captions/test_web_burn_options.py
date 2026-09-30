"""The web's caption burn options (UX2): positions, bounce anchor, and that
every web render path passes them — while the desktop defaults stay.

- sub_pos is the vertical centre of the caption block (measured here on
  real renders), web positions Clean 0.70 / Classic 0.72 / Subtle 0.76;
  src/styles.py keeps the desktop's 0.50 / 0.85 / 0.90.
- bounce_anchor="caption": Clipper's bounce-in scales the caption in place;
  the desktop's "frame" scales around the frame centre (captions.md C12).
- render_only (local), render_to_dir (render_r2) and Modal's
  render_burn_concat all pass pipeline.web_burn_kwargs.
- The hook LLM still gets transcript lines, not word units.
"""
from __future__ import annotations

import ast

import numpy as np
import pytest

import sync_sim as sim
from backend import pipeline
from conftest import REPO

WEB = {"clean": 0.70, "classic": 0.72, "subtle": 0.76}
DESKTOP = {"clean": 0.50, "classic": 0.85, "subtle": 0.90}


@pytest.mark.parametrize("preset", ["clipper", "highlight", "flash", "punch",
                                    "elegant", "clean", "classic", "subtle",
                                    None, "nonsense"])
def test_web_burn_kwargs(preset):
    kw = pipeline.web_burn_kwargs(preset)
    assert kw["assign_by_midpoint"] is True
    assert kw["bounce_anchor"] == "caption"
    assert kw.get("sub_pos") == WEB.get(preset)


def test_desktop_positions_stay():
    from src.styles import CAPTION_STYLES
    for preset, y in DESKTOP.items():
        assert CAPTION_STYLES[preset]["subtitle_position_y"] == y


def _caption_rows(preset, sub_pos, size=(540, 960)):
    """Rows (y) the caption covers when the whole phrase is on screen."""
    from moviepy.editor import ColorClip, CompositeVideoClip
    from plugins.premiere.video_editor_premiere import (
        _render_segment_with_standalone_captions)
    base = ColorClip(size, color=(0, 0, 0), duration=3)
    subs = [{"start": 0.0, "end": 0.5, "text": "Nobody"},
            {"start": 0.5, "end": 1.0, "text": "waits"},
            {"start": 1.0, "end": 1.6, "text": "ten"}]
    clips = _render_segment_with_standalone_captions(
        None, "/dev/null", subs, "balanced", preset, preloaded_clip=base,
        return_clips_only=True, sub_pos=sub_pos)
    assert clips, f"{preset}: no caption clips"
    frame = CompositeVideoClip([base] + clips).get_frame(1.3)
    rows = np.flatnonzero(frame.max(axis=(1, 2)) > 60)
    assert rows.size
    return rows


@pytest.mark.parametrize("preset", sorted(WEB))
@pytest.mark.parametrize("where", ["web", "desktop"])
def test_sub_pos_is_the_caption_centre(preset, where):
    pytest.importorskip("moviepy")
    pos = WEB[preset] if where == "web" else None
    rows = _caption_rows(preset, pos)
    h = 960
    centre = (rows[0] + rows[-1]) / 2 / h
    want = pos if pos is not None else DESKTOP[preset]
    assert abs(centre - want) < 0.03, (preset, where, centre, want)


def _mask_box(clip, t):
    m = clip.mask.get_frame(t)
    rows = np.flatnonzero(m.max(axis=1) > 0.5)
    cols = np.flatnonzero(m.max(axis=0) > 0.5)
    return rows[0], rows[-1], cols[0], cols[-1]


@pytest.mark.parametrize("anchor", ["frame", "caption"])
def test_bounce_anchor(anchor):
    from src.effects import create_highlight_phrase_subtitle
    w, h = 540, 960
    cfg = {"subtitle_position_y": 0.75, "subtitle_fontsize_multiplier": 0.99,
           "subtitle_highlight_color_hex": "#39FF14",
           "_highlight_font": "bangers"}
    clip = create_highlight_phrase_subtitle(
        ["Nobody", "waits", "ten"], 0, 1.2, (w, h), cfg,
        [(0.0, 0.4), (0.4, 0.8), (0.8, 1.2)], bounce_anchor=anchor)
    top0, bot0, left0, right0 = _mask_box(clip, 0.0)      # scale 1.12
    top1, bot1, left1, right1 = _mask_box(clip, 0.5)      # at rest
    rest_cy = (top1 + bot1) / 2
    shift = (top0 + bot0) / 2 - rest_cy
    assert (bot0 - top0) > 1.08 * (bot1 - top1)            # it does bounce
    if anchor == "caption":
        assert abs(shift) <= 2                              # in place
        assert abs((left0 + right0) - (left1 + right1)) <= 4
    else:                                                   # desktop: moves
        assert shift == pytest.approx((rest_cy - h / 2) * 0.12, abs=4)
    # The colour layer moves with the mask: its fill (white / green, inside
    # the black outline) is centred where the mask is.
    rgb = clip.get_frame(0.0).max(axis=2) > 60
    rows = np.flatnonzero(rgb.any(axis=1))
    assert abs((rows[0] + rows[-1]) / 2 - (top0 + bot0) / 2) <= 2


# ── every web render path passes the options ─────────────────────────

class _Stop(Exception):
    pass


def _capture_burn(monkeypatch):
    got = {}

    def burn(**kw):
        got.update(kw)
        raise _Stop()
    monkeypatch.setattr(pipeline, "_multi_clip_burn", burn)
    return got


def test_render_to_dir_passes_the_web_options(tmp_path, monkeypatch):
    got = _capture_burn(monkeypatch)
    with pytest.raises(_Stop):
        pipeline.render_to_dir(str(tmp_path / "m.mp4"), str(tmp_path / "o"),
                               [(0.0, 1.0)], [], [], "clean", "balanced",
                               "en", [], [], parallelism=8)
    assert got["assign_by_midpoint"] is True
    assert got["bounce_anchor"] == "caption"
    assert got["sub_pos"] == 0.70 and got["parallelism"] == 8
    assert got["merge_gap"] == 0.0


def test_local_render_passes_the_web_options(tmp_path, monkeypatch):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    got = _capture_burn(monkeypatch)
    src = tmp_path / "n.mp4"
    src.write_bytes(b"x")
    with pytest.raises(_Stop):
        pipeline.render_only(str(src), str(tmp_path / "o"), [(0.0, 1.0)], [],
                             {"caption_preset": "classic"}, hooks=[])
    assert got["assign_by_midpoint"] is True
    assert got["bounce_anchor"] == "caption" and got["sub_pos"] == 0.72


def test_modal_volume_path_passes_the_web_options():
    """render_burn_concat (Modal's default path) calls _multi_clip_burn
    itself: it must add web_burn_kwargs(caption_preset) there too."""
    tree = ast.parse((REPO / "backend" / "modal_render.py").read_text())
    [fn] = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
            and n.name == "render_burn_concat"]
    [call] = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
              and getattr(n.func, "id", None) == "_multi_clip_burn"]
    spread = [ast.unparse(k.value) for k in call.keywords if k.arg is None]
    assert spread == ["web_burn_kwargs(caption_preset)"]


# ── hook detection keeps getting transcript lines ────────────────────

V = sim.load_vectors()


def test_word_units_are_regrouped_into_the_editors_lines():
    lines = pipeline._transcript_lines(V["units_payload"])
    assert [ln["text"] for ln in lines] == [p["text"] for p in V["phrases"]]
    assert [(ln["start"], ln["end"]) for ln in lines] == [
        (p["start"], p["end"]) for p in V["phrases"]]
    # The payload before UX2 (sentences) gives the same lines.
    legacy = pipeline._transcript_lines(sim.legacy_payload(V["phrases"]))
    assert [ln["text"] for ln in legacy] == [p["text"] for p in V["phrases"]]
    # Malformed client entries are skipped, not raised (hooks are soft).
    junk = ["x", {"text": "a", "start": "soon"}, {"text": None}]
    assert pipeline._transcript_lines(junk + V["units_payload"][:2]) == [
        {"text": "Hey, so today", "start": 0.15, "end": 0.891}]


def test_hook_llm_gets_lines(monkeypatch):
    import backend.llm as llm
    seen = []

    def detect(items, language=None):
        seen.append(items)
        return [{"start": 1.0, "end": 25.0, "title": "t", "reason": "r"}]
    monkeypatch.setattr(llm, "detect_hook_moments", detect)
    hooks = pipeline.detect_hooks(V["units_payload"], {}, 120.0, "en")
    assert len(hooks) == 1
    [items] = seen
    assert len(items) == len(V["phrases"]) == 12      # not 63 units
    assert items[5] == {"id": 5, "text": "Mistake number two, is dead air.",
                        "start": 11.364, "end": 13.414}
