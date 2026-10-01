"""UT4: caption engine v2 on the render (backend/captions_v2.py) — the
switch, the engine pinned at a job's first render, the style and words a
v2 render draws, the clip plan and filter graph, and how a v2 spec
travels (render_r2's spawn, the local path, the volume path). The real
render (Node layer + ffmpeg) is in captions/test_captions_v2_render.py.
"""
from __future__ import annotations

import sys
import time
import types

import pytest

import backend.main as M
from backend import captions_v2 as C
from backend import media, pipeline, storage
from backend.jobs import store

DOC_WORDS = [
    {"id": "w0001", "text": "Nobody", "start": 0.00, "end": 0.34},
    {"id": "w0002", "text": "waits", "start": 0.37, "end": 0.66},
    {"id": "w0003", "text": "äh", "start": 0.70, "end": 0.90, "filler": True, "hidden": True},
    {"id": "w0004", "text": "ten", "start": 0.95, "end": 1.10},
    {"id": "w0005", "text": "seconds.", "start": 1.12, "end": 1.50},
    {"id": "w0006", "text": "Really", "start": 2.00, "end": 2.40},
    {"id": "w0007", "text": "never.", "start": 2.45, "end": 2.90},
]
# The v1 editor's payload: word units with their source times (UX2).
UNITS = [
    {"start": 0.0, "end": 0.66, "text": "Nobody waits", "original_start": 0.0, "original_end": 0.66},
    {"start": 0.7, "end": 1.5, "text": "ten seconds.", "original_start": 0.95, "original_end": 1.50},
    # the same unit again (it spans a cut): taken once
    {"start": 0.9, "end": 1.5, "text": "ten seconds.", "original_start": 0.95, "original_end": 1.50},
    # edited in review: "Really never." → "Really never ever."
    {"start": 1.6, "end": 2.5, "text": "Really never ever.", "original_start": 2.0, "original_end": 2.9},
]


def _doc(style=None, words=None, lang="en"):
    return {"v": 2, "language": lang, "words": list(words or DOC_WORDS), "clips": None,
            "style": style or {"presetId": "power", "overrides": {}},
            "format": {"aspect": "9:16"}, "rev": 0}


def _job(**fields):
    job = store.create(None, {}, owner_id=None)
    base = dict(status="awaiting_review", mezz_key=f"jobs/{job.id}/mezz.mp4",
                segments=[(0.0, 1.5), (2.0, 3.0)], duration=3.0, language="en",
                settings={"caption_preset": "clipper", "style": "balanced",
                          "output_formats": []},
                doc=_doc(), mezz_fps=30.0, mezz_cfr=True)
    base.update(fields)
    store.update(job.id, **base)
    return store.get(job.id)


# ── switch and pinning ───────────────────────────────────────────────


def test_v1_by_default_and_pinned_at_the_first_render(monkeypatch):
    job = _job()
    assert C.engine_default() == "v1"
    assert C.prepare_render(store, job.id, job, UNITS) is None
    assert store.get(job.id).caption_engine == "v1"
    # The switch flips later: this project keeps v1 (review F11).
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    assert C.prepare_render(store, job.id, store.get(job.id), UNITS) is None
    assert store.get(job.id).caption_engine == "v1"
    assert store.get(job.id).render_doc is None


def test_v2_pins_and_snapshots(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    job = _job()
    spec = C.prepare_render(store, job.id, job, UNITS)
    assert spec is not None and spec["engine"] == "v2"
    assert spec["style"] == {"presetId": "clipper", "overrides": {}}
    assert spec["language"] == "en" and spec["fps"] == 30.0 and spec["cfr"] is True
    assert "loudness" not in spec
    got = store.get(job.id)
    assert got.caption_engine == "v2"
    assert got.render_doc["style"] == spec["style"]
    assert got.render_doc["words"] == spec["words"]
    # Back to v1 on the server: this project stays v2.
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v1")
    assert C.prepare_render(store, job.id, got, UNITS)["engine"] == "v2"


@pytest.mark.parametrize("fields, why", [
    ({"doc": None}, "no edit document (analysed before UT3)"),
    ({"settings": {"caption_preset": "clean"}}, "minimal is not live by default"),
    ({"language": "ru", "doc": _doc(lang="ru")}, "Clipper can't caption Cyrillic"),
])
def test_v2_only_for_docs_with_a_live_supported_style(monkeypatch, fields, why):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    job = _job(**fields)
    assert C.prepare_render(store, job.id, job, UNITS) is None, why
    assert store.get(job.id).caption_engine == "v1"


@pytest.mark.parametrize("fields", [
    {"output_keys": {"primary": "jobs/x/r1/primary.mp4"}},
    {"render_gen": 2},                                   # this is its 2nd render
    {"outputs": {"primary": "/data/old/cleo_output.mp4"}},   # legacy local job
    {"output_path": "/data/old/cleo_output.mp4"},
])
def test_projects_exported_before_ut4_stay_v1(monkeypatch, fields):
    """Exported with v1 before engines were pinned (caption_engine None):
    the switch must not change their look (DEPLOY.md §12)."""
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    job = _job(**fields)
    assert C.prepare_render(store, job.id, job, UNITS) is None
    assert store.get(job.id).caption_engine == "v1"
    # its first render after POST /render bumped render_gen to 1: v2
    fresh = _job(render_gen=1)
    assert C.prepare_render(store, fresh.id, fresh, UNITS)["engine"] == "v2"


def test_live_list_opens_more_presets(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    monkeypatch.setenv("CLEO_CAPTION_PRESETS_LIVE", "all")
    job = _job(settings={"caption_preset": "clean"})
    spec = C.prepare_render(store, job.id, job, UNITS)
    assert spec["style"] == {"presetId": "minimal", "overrides": {"y": 0.70}}


def test_a_broken_setup_renders_v1(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    job = _job()
    monkeypatch.setattr(C, "build_spec", lambda *a: 1 / 0)
    assert C.prepare_render(store, job.id, job, UNITS) is None
    # … but a job pinned to v2 fails loudly instead of changing its look
    pinned = _job(caption_engine="v2")
    with pytest.raises(ZeroDivisionError):
        C.prepare_render(store, pinned.id, pinned, UNITS)


# ── style and words ──────────────────────────────────────────────────


def test_style_precedence():
    j = types.SimpleNamespace
    doc = _doc(style={"presetId": "karaoke", "overrides": {"y": 0.6}})
    # a style picked for this job (PATCH /jobs) or an editor-saved doc
    assert C.style_for(j(doc=doc, doc_rev=0, settings={"caption_style": "karaoke",
                                                         "caption_preset": "clean"})
                       )["presetId"] == "karaoke"
    assert C.style_for(j(doc=doc, doc_rev=3.0, settings={"caption_preset": "clean"})
                       ) == {"presetId": "karaoke", "overrides": {"y": 0.6}}
    # otherwise the v1 preset's alias where the v1 export drew it (= UT1 preview)
    assert C.style_for(j(doc=doc, doc_rev=0, settings={"caption_preset": "classic"})
                       ) == {"presetId": "power",
                             "overrides": {"highlightColor": "#FFFFFF", "y": 0.72}}
    assert C.style_for(j(doc=doc, doc_rev=0, settings={"caption_preset": "clipper"})
                       ) == {"presetId": "clipper", "overrides": {}}
    assert C.style_for(j(doc=doc, doc_rev=0, settings={}))["presetId"] == "karaoke"
    assert C.style_for(j(doc=None, doc_rev=0, settings={}))["presetId"] == "power"


def test_source_words_from_units_and_doc():
    words = C.source_words(UNITS, DOC_WORDS)
    assert [w["text"] for w in words] == ["Nobody", "waits", "ten", "seconds.",
                                          "Really", "never", "ever."]
    # unchanged units keep the doc's own words (ids, timings); the hidden
    # filler between them isn't drawn
    assert words[:4] == [{k: w[k] for k in ("id", "text", "start", "end")}
                         for w in (DOC_WORDS[0], DOC_WORDS[1], DOC_WORDS[3], DOC_WORDS[4])]
    # an edited unit spreads its time over its tokens by length
    edited = words[4:]
    assert [w["id"] for w in edited] == ["u2w0", "u2w1", "u2w2"]
    assert edited[0]["start"] == 2.0 and edited[-1]["end"] == 2.9
    assert edited[0]["end"] == edited[1]["start"]
    assert all(a["end"] <= b["start"] + 1e-9 for a, b in zip(edited, edited[1:]))
    # no doc words at all: every unit split
    assert [w["id"] for w in C.source_words(UNITS[:1], [])] == ["u0w0", "u0w1"]
    assert C.source_words([], DOC_WORDS) == []


def test_ux8_payload_maps_onto_the_doc_words_with_forced_breaks():
    """The v2 editor's payload (UX8 captionSource → phrasesToUnits, made
    by the web code: testdata/captions/ux8_payload.json): glued units,
    hidden fillers dropped, forced breaks — on the doc's own words."""
    import json
    from conftest import REPO
    doc = json.loads((REPO / "testdata/captions/ux8_doc.json").read_text())
    payload = json.loads((REPO / "testdata/captions/ux8_payload.json").read_text())
    words = C.source_words(payload["subtitles"], doc["words"])
    shown = [w for w in doc["words"] if not w.get("hidden")]
    assert [w["id"] for w in words] == [w["id"] for w in shown]
    assert [(w["start"], w["end"]) for w in words] == [(w["start"], w["end"]) for w in shown]
    # the break on "you" and the hidden "um"'s break carried to "Show"
    assert [w["id"] for w in words if w.get("breakBefore")] == ["w0008", "w0012"]
    # a unit flagged breakBefore by the client does the same
    units = [dict(u) for u in payload["subtitles"]]
    units[2]["breakBefore"] = True                       # "ten seconds"
    flagged = C.source_words(units, doc["words"])
    assert next(w for w in flagged if w["id"] == "w0005").get("breakBefore")


def test_cjk_spec_carries_the_job_font_subset(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    words = [{"id": "w0001", "text": "結果", "start": 0.0, "end": 0.5}]
    subsets = {"noto-sans-jp-800": {"family": "cc-noto-sans-jp-800-abcd1234",
                                    "rev": "abcd1234", "chars": "結果",
                                    "json": "jobs/x/fonts/a.json",
                                    "ttf": "jobs/x/fonts/a.ttf",
                                    "woff2": "jobs/x/fonts/a.woff2"}}
    job = _job(language="ja", doc=_doc(lang="ja", words=words),
               settings={"caption_preset": "classic"}, font_subsets=subsets)
    spec = C.prepare_render(store, job.id, job,
                            [{"text": "結果", "original_start": 0.0, "original_end": 0.5}])
    assert spec["language"] == "ja"
    assert spec["fonts"] == [{"id": "noto-sans-jp-800", "json": "jobs/x/fonts/a.json",
                              "ttf": "jobs/x/fonts/a.ttf"}]


JA_WORDS = [{"id": "w0001", "text": "結果", "start": 0.0, "end": 0.5},
            {"id": "w0002", "text": "です", "start": 0.6, "end": 1.0}]
# Edited in the v1 editor: "結果" → "成果" (成 isn't in the analysis subset).
JA_UNITS = [{"text": "成果", "original_start": 0.0, "original_end": 0.5},
            {"text": "です", "original_start": 0.6, "original_end": 1.0}]


def _ja_job(**fields):
    return _job(language="ja", doc=_doc(lang="ja", words=JA_WORDS),
                settings={"caption_preset": "classic"}, **fields)


def test_cjk_subset_is_remade_for_edited_text(monkeypatch):
    """The subset was made from the doc's words; an edit in the v1 editor
    adds a character: the render re-subsets (as /fonts/refresh) instead of
    drawing tofu."""
    pytest.importorskip("fontTools")
    from backend import font_subset
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    job = _ja_job()
    import tempfile
    made = font_subset.make("noto-sans-jp-800", "結果です", tempfile.mkdtemp())
    subsets, _ = font_subset.store({"noto-sans-jp-800": made}, f"jobs/{job.id}/",
                                   lambda p, k, ct: media.put_file(p, k, content_type=ct))
    store.update(job.id, font_subsets=subsets)
    job = store.get(job.id)
    assert not font_subset.covers(subsets["noto-sans-jp-800"], "成果です")
    spec = C.prepare_render(store, job.id, job, JA_UNITS)
    got = store.get(job.id)
    entry = got.font_subsets["noto-sans-jp-800"]
    assert "成" in entry["chars"] and "結" in entry["chars"]   # doc text kept too
    assert spec["fonts"] == [{"id": "noto-sans-jp-800", "json": entry["json"],
                              "ttf": entry["ttf"]}]
    assert entry["ttf"] != subsets["noto-sans-jp-800"]["ttf"]
    assert got.caption_engine == "v2"
    # the old files are queued for deletion, their bytes no longer counted
    assert subsets["noto-sans-jp-800"]["ttf"] not in (got.media_bytes or {})


def test_cjk_without_any_subset_makes_one(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    calls = []

    def refresh(st, job_id, job, text, ws):
        calls.append((job.font_subsets, text))
        return {"noto-sans-jp-800": {"chars": "成果結です", "json": "a.json", "ttf": "a.ttf"}}
    from backend import font_subset
    monkeypatch.setattr(font_subset, "refresh", refresh)
    job = _ja_job()
    spec = C.prepare_render(store, job.id, job, JA_UNITS)
    assert spec["fonts"] == [{"id": "noto-sans-jp-800", "json": "a.json", "ttf": "a.ttf"}]
    assert calls and "成" in calls[0][1] and "結" in calls[0][1]


def test_cjk_font_failure_renders_v1_or_fails_a_pinned_job(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    from backend import errors, font_subset

    def broken(*a, **k):
        raise OSError("R2 down")
    monkeypatch.setattr(font_subset, "refresh", broken)
    job = _ja_job()
    # never exported: this render (and the project) stays v1
    assert C.prepare_render(store, job.id, job, JA_UNITS) is None
    assert store.get(job.id).caption_engine == "v1"
    # pinned to v2: no silent change of look, no tofu — the render fails
    pinned = _ja_job(caption_engine="v2")
    with pytest.raises(C.CaptionFontError) as e:
        C.prepare_render(store, pinned.id, pinned, JA_UNITS)
    assert errors.render_error_code(e.value) == "render_failed"


def test_loudness_rides_along_only_when_switched_on(monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", "v2")
    loud = {"I": -20.1, "TP": -3.0, "LRA": 5.0, "thresh": -30.4, "offset": 0.2}
    job = _job(audio_loudness=loud)
    assert "loudness" not in C.build_spec(job, UNITS, C.style_for(job))
    monkeypatch.setenv("CLEO_LOUDNORM", "1")
    assert C.build_spec(job, UNITS, C.style_for(job))["loudness"] == loud


# ── clip plan and filter graph ───────────────────────────────────────


def test_clip_plan_snaps_to_the_frame_grid():
    clips = C.clip_plan([(0.01, 1.01), (1.01, 2.0), (3.333, 4.0), (5.0, 5.01)],
                        [{"speed": 1.0}, {"speed": 2.0}, {}, {}], 30.0)
    assert [(c["start"], c["end"]) for c in clips] == [
        (0.0, 1.0), (1.0, 2.0), (100 / 30, 4.0)]   # 10 ms: under a frame, dropped
    assert [c["speed"] for c in clips] == [1.0, 2.0, 1.0]
    # the split at 1.0 continues the source: no fade there; 2.0 → 3.333 is a cut
    assert [(c["cut_before"], c["cut_after"]) for c in clips] == [
        (False, False), (False, True), (True, False)]
    assert C.output_frames(clips, 30.0) == 30 + 15 + 20


@pytest.mark.parametrize("clips, cfr, seg", [
    ([(0, 1), (2, 3)], True, False),
    ([(0, 1), (2, 3)], False, True),                 # VFR source
    ([(2, 3), (0, 1)], True, True),                  # out of source order
])
def test_select_path_needs_cfr_order_and_no_effects(clips, cfr, seg):
    assert C.needs_segment_inputs(C.clip_plan(clips, None, 30.0), cfr) is seg
    plan = C.clip_plan(clips, [{"speed": 1.5}, {}], 30.0)
    assert C.needs_segment_inputs(plan, True) is True
    plan = C.clip_plan(clips, [{}, {"fadeIn": 0.3}], 30.0)
    assert C.needs_segment_inputs(plan, True) is True


SRC = {"W": 1080, "H": 1920, "rate": "30", "fps": 30.0, "cfr": True,
       "audio": True, "start": 0.0}


def test_graph_select_path():
    clips = C.clip_plan([(0.0, 1.0), (1.0, 2.0), (3.0, 4.0)], None, 30.0)
    inputs, graph, audio = C.build_graph(clips, SRC, layer={"top": 1200, "height": 300})
    assert audio and inputs == [[]]
    assert "select='gte(t\\,-0.016667)*lt(t\\,0.983333)+" in graph
    assert "setpts=N*1/30/TB[vcat]" in graph
    assert "[0:v]trim" not in graph and "concat=n=3:v=1" not in graph
    assert "asplit=3[as0][as1][as2]" in graph
    # 15 ms fades only at the cut (2.0 → 3.0), not at the split at 1.0
    assert graph.count("afade=t=in") == 1 and graph.count("afade=t=out") == 1
    assert ("[as2]atrim=start=3:end=4,asetpts=PTS-STARTPTS,apad=whole_dur=1,atrim=duration=1,"
            "afade=t=in:st=0:d=0.015[a2]") in graph
    assert "concat=n=3:v=0:a=1[aout]" in graph
    assert "[vcat][1:v]overlay=0:1200:alpha=premultiplied:eof_action=pass" in graph
    assert "loudnorm" not in graph


def test_graph_segment_path_with_effects_and_loudnorm():
    clips = C.clip_plan([(0.0, 2.0), (3.0, 5.0)],
                        [{"speed": 1.5, "fadeIn": 0.5, "volume": 0.5}, {"speed": 3.0}], 30.0)
    loud = {"I": -20.0, "TP": -2.0, "LRA": 6.0, "thresh": -30.0, "offset": 0.5}
    inputs, graph, _ = C.build_graph(clips, {**SRC, "rate": "30000/1001", "fps": 29.97},
                                     layer=None, loudness=loud)
    assert inputs == [["-ss", "0", "-t", "2"], ["-ss", "3", "-t", "2"]]
    # 2 s at 1.5x = 39.96 frames at 29.97 → 40, video and audio alike
    assert ("[0:v]setpts=PTS-STARTPTS,setpts=PTS/1.500000,fps=30000/1001,"
            "tpad=stop_mode=clone:stop=1,trim=end_frame=40,fade=t=in:st=0:d=0.5[v0]") in graph
    assert "apad=whole_dur=1.334667,atrim=duration=1.334667" in graph   # 40 / 29.97
    assert "concat=n=2:v=1:a=0[vcat]" in graph
    assert "atempo=1.500000" in graph and "atempo=2.0,atempo=1.500000" in graph
    assert "volume=0.5000" in graph
    assert ("loudnorm=I=-14:TP=-1:LRA=11:linear=true:measured_I=-20.00:"
            "measured_TP=-2.00:measured_LRA=6.00:measured_thresh=-30.00:offset=0.50") in graph
    assert "[vcat]format=yuv420p[vout]" in graph


def test_graph_without_audio():
    clips = C.clip_plan([(0.0, 1.0)], None, 30.0)
    _inputs, graph, audio = C.build_graph(clips, {**SRC, "audio": False}, layer=None)
    assert not audio and "aout" not in graph and "[0:a]" not in graph


def test_output_words_map_through_the_snapped_clips():
    spec = {"words": C.source_words(UNITS, DOC_WORDS),
            "style": {"presetId": "power", "overrides": {"offsetMs": 100}}}
    clips = C.clip_plan([(0.0, 1.5), (2.0, 3.0)], None, 30.0)
    out = C.output_words(spec, clips)
    assert out["breaks"] == [1.5]
    first = out["words"][0]
    assert (first["id"], first["start"]) == ("w0001", 0.1)   # +100 ms sync offset
    really = next(w for w in out["words"] if w["text"] == "Really")
    assert really["start"] == pytest.approx(1.5 + 0.1)


# ── how the spec travels ─────────────────────────────────────────────


class _FakeModal:
    """modal.Function.from_name(...).spawn(**kw) → records kw, returns a
    render_r2-shaped result."""

    def __init__(self):
        self.spawns: list[dict] = []
        fake = self

        class _Call:
            def __init__(self, kw):
                self.kw = kw

            def get(self, timeout=None):
                p = self.kw["out_prefix"]
                return {"outputs": {"primary": {"key": p + "primary.mp4", "size": 7}},
                        "thumb": None, "hooks": [], "timings": {}}

            def cancel(self):
                pass

            def get_call_graph(self):
                return []

        class _Fn:
            def spawn(self, **kw):
                fake.spawns.append(kw)
                return _Call(kw)

            def get_current_stats(self):
                return types.SimpleNamespace(num_total_runners=1, backlog=0)

        self.module = types.SimpleNamespace(Function=types.SimpleNamespace(
            from_name=staticmethod(lambda app, name: _Fn())))


@pytest.fixture
def modal_r2(r2, monkeypatch):
    import backend.llm as llm_mod
    monkeypatch.setattr(llm_mod, "detect_hook_moments", lambda items, language=None: [])
    monkeypatch.setattr(llm_mod, "generate_social_caption",
                        lambda text, language=None: {"caption": "", "hashtags": []})
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    monkeypatch.setenv("CLEO_MODAL_RENDER_FN", "render_r2")
    monkeypatch.setenv("CLEO_MODAL_RETRY_DELAYS", "0")
    monkeypatch.setenv("CLEO_MODAL_POLL_S", "0.05")
    fake = _FakeModal()
    monkeypatch.setitem(sys.modules, "modal", fake.module)
    return fake


def _done(job_id: str, timeout=10.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        j = store.get(job_id)
        if j.status in ("done", "error") or (j.status == "awaiting_review" and j.error_code):
            return j.status == "done" and job_id not in M._active_jobs
        time.sleep(0.02)
    return False


@pytest.mark.parametrize("engine", ["v1", "v2"])
def test_render_r2_gets_captions_only_for_v2(client, modal_r2, monkeypatch, engine):
    monkeypatch.setenv("CLEO_CAPTION_ENGINE", engine)
    job = _job(media_store="r2")
    r = client.post(f"/jobs/{job.id}/render", json={"subtitles": UNITS})
    assert r.status_code == 200
    assert _done(job.id)
    [kw] = modal_r2.spawns
    assert kw["subtitles"] == UNITS and kw["caption_preset"] == "clipper"
    if engine == "v1":
        # a render_r2 deployed before UT4 never sees the new argument
        assert "captions" not in kw
    else:
        cap = kw["captions"]
        assert cap["engine"] == "v2" and cap["style"]["presetId"] == "clipper"
        assert [w["text"] for w in cap["words"]][:2] == ["Nobody", "waits"]
    got = store.get(job.id)
    assert got.caption_engine == engine
    assert got.output_keys["primary"].endswith("r1/primary.mp4")


def test_local_render_draws_v2_with_render_to_dir(tmp_path, monkeypatch):
    calls = {}
    monkeypatch.setattr(pipeline, "_modal_configured", lambda: False)
    monkeypatch.setattr(pipeline, "detect_hooks", lambda *a, **k: [])
    monkeypatch.setattr(media, "get_file", lambda key, path, store=None: (
        open(path, "wb").write(b"mezz")))
    monkeypatch.setattr(media, "put_file", lambda path, key, **kw: 1)
    monkeypatch.setattr(C, "layer_available", lambda: True)

    def render_to_dir(mezz, out, segs, fx, subs, *a, captions=None, fetch=None, **kw):
        calls["captions"], calls["segments"], calls["fetch"] = captions, segs, fetch
        p = tmp_path / "primary.mp4"
        p.write_bytes(b"x")
        return {"primary": str(p), "thumb": None, "formats": {}, "hooks": []}
    monkeypatch.setattr(pipeline, "render_to_dir", render_to_dir)
    monkeypatch.setattr(pipeline, "render_only", lambda **kw: pytest.fail("v1 path"))
    spec = {"engine": "v2", "style": {"presetId": "power", "overrides": {}}, "words": []}
    res = pipeline.render_to_keys(
        job_id="0123456789ab", gen=1, mezz_key="jobs/0123456789ab/mezz.mp4",
        out_prefix="jobs/0123456789ab/r1/", segments=[(0.0, 1.0), (2.0, 3.0)],
        subtitles=[], settings={}, language="en", cut_ranges=None,
        disabled_cuts=None, duration=3.0, workspace=str(tmp_path / "ws"),
        captions=spec)
    assert calls["captions"] is spec and calls["segments"] == [(0.0, 1.0), (2.0, 3.0)]
    assert callable(calls["fetch"])
    assert res["outputs"]["primary"]["key"] == "jobs/0123456789ab/r1/primary.mp4"


@pytest.mark.parametrize("why", ["no layer", "volume path"])
def test_v2_falls_back_to_v1_where_there_is_no_layer(tmp_path, monkeypatch, why):
    monkeypatch.setattr(pipeline, "_modal_configured", lambda: why == "volume path")
    monkeypatch.setattr(pipeline, "detect_hooks", lambda *a, **k: [])
    monkeypatch.setattr(media, "get_file", lambda key, path, store=None: (
        open(path, "wb").write(b"mezz")))
    monkeypatch.setattr(media, "put_file", lambda path, key, **kw: 1)
    monkeypatch.setattr(C, "layer_available", lambda: why != "no layer")
    monkeypatch.setattr(pipeline, "render_to_dir", lambda *a, **k: pytest.fail("v2"))
    seen = {}

    def render_only(**kw):
        seen.update(kw)
        p = tmp_path / "out.mp4"
        p.write_bytes(b"x")
        return {"outputs": {"primary": str(p)}, "hook_clips": []}
    monkeypatch.setattr(pipeline, "render_only", render_only)
    pipeline.render_to_keys(
        job_id="0123456789ab", gen=1, mezz_key="jobs/0123456789ab/mezz.mp4",
        out_prefix="jobs/0123456789ab/r1/", segments=[(0.0, 1.0)],
        subtitles=[], settings={}, language="en", cut_ranges=None,
        disabled_cuts=None, duration=1.0, workspace=str(tmp_path / "ws"),
        captions={"engine": "v2", "style": {"presetId": "power"}, "words": []})
    assert seen["use_modal"] is (why == "volume path")


def test_render_r2_signature_takes_captions_last():
    import ast
    from conftest import REPO
    tree = ast.parse((REPO / "backend" / "modal_render.py").read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
              and n.name == "render_r2")
    names = [a.arg for a in fn.args.args]
    assert names[-1] == "captions" and ast.unparse(fn.args.defaults[-1]) == "None"
    src = (REPO / "backend" / "modal_render.py").read_text()
    # the Modal image builds the layer and points captions_v2 at it
    for needle in ("NODE_SHA256", "npm ci", "node build.mjs", "CLEO_CAPTION_LAYER_DIR",
                   '"web/public/fonts/captions"', '"web/src/lib/captions"'):
        assert needle in src, needle
    assert storage is not None
