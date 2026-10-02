"""UX6: the start screen's settings on the server.

- POST /jobs settings allowlist (_clean_settings): target_aspect, cut
  pace (tight / smooth / none, "balanced" = smooth), spoken_language,
  caption_style_hint (live preset ids only); the legacy keys still pass.
- target_aspect → SmartCam (pipeline.smartcam_plan); a failed reframe →
  job.format_warning "smartcam_failed" and a centre crop (no bars).
- "No cuts" (style none): one segment over the video, only silence
  > 1 s at the edges trimmed (pipeline.no_cut_plan).
- spoken_language reaches the transcription (one Groq pass in it).
- GET /config lists the spoken languages; GET/PUT /me/prefs.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import backend.main as M
from backend import pipeline, prefs, whisper_groq

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(
    not FFMPEG or not shutil.which("ffprobe"),
    reason="ffmpeg/ffprobe not installed")


# ── POST /jobs settings ──────────────────────────────────────────────


def test_clean_settings_new_keys():
    out = M._clean_settings({
        "target_aspect": "9:16", "style": "none", "spoken_language": "DE",
        "caption_style_hint": "clipper", "remove_fillers": False,
        "voice_triggers": True, "resolution": "1080", "output_formats": [],
    }, None)
    assert out == {"target_aspect": "9:16", "style": "none",
                   "spoken_language": "de", "caption_style_hint": "clipper",
                   "remove_fillers": False, "voice_triggers": True,
                   "resolution": "1080", "output_formats": []}


@pytest.mark.parametrize("style,stored", [
    # stored exactly as before UX6 (purely additive): "none" is new
    ("tight", "tight"), ("smooth", "smooth"), ("balanced", "balanced"),
    ("none", "none"), (" Tight ", "Tight"), ("fast", "fast"), ("", None),
    (5, None),
])
def test_clean_settings_pace(style, stored):
    assert M._clean_settings({"style": style}, None).get("style") == stored


@pytest.mark.parametrize("value", ["auto", "xx", "english", 7, None, "zz"])
def test_clean_settings_drops_unknown_languages(value):
    assert "spoken_language" not in M._clean_settings(
        {"spoken_language": value}, None)


@pytest.mark.parametrize("hint,stored", [
    # kept as before UX6; doc.resolve_style ignores what isn't a preset
    ("clipper", "clipper"), ("power", "power"), (" bogus ", "bogus"),
    ("", None), (3, None),
])
def test_clean_settings_hint_as_before(hint, stored):
    assert M._clean_settings({"caption_style_hint": hint},
                             None).get("caption_style_hint") == stored


def test_clean_settings_keeps_the_legacy_keys():
    legacy = {"caption_preset": "clipper", "style": "tight",
              "voice_triggers": True, "remove_fillers": True,
              "smartcam_enabled": True, "smartcam_format": "portrait",
              "resolution": "1080", "output_formats": ["9:16", "1:1"]}
    assert M._clean_settings(dict(legacy), None) == legacy


# ── target_aspect → SmartCam ─────────────────────────────────────────


@pytest.mark.parametrize("settings,plan", [
    ({"target_aspect": "9:16"}, (True, "portrait")),
    ({"target_aspect": "16:9"}, (False, "portrait")),
    ({"target_aspect": "original"}, (False, "portrait")),
    # the target decides, whatever an old key says
    ({"target_aspect": "original", "smartcam_enabled": True}, (False, "portrait")),
    # older clients
    ({"smartcam_enabled": True, "smartcam_format": "landscape"}, (True, "landscape")),
    ({}, (False, "portrait")),
])
def test_smartcam_plan(settings, plan):
    assert pipeline.smartcam_plan(settings) == plan


def _clip(path: Path, size: str, seconds: float = 1.5) -> Path:
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"testsrc=size={size}:rate=10:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    "-c:v", "libx264", "-preset", "ultrafast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                    str(path)], check=True)
    return path


@pytest.fixture
def analysis(monkeypatch):
    """Stub transcription + LLM; SmartCam recorded and failing (no file);
    the kwargs analyze_video got and the spoken language it ran under."""
    import backend.llm as llm
    seen: dict = {}

    def analyze_video(video_path, **kw):
        seen["kw"] = kw
        seen["language"] = whisper_groq._SPOKEN_LANGUAGE.get()
        return SimpleNamespace(
            segments=[(1.4, 2.0), (2.6, 3.4)],
            subtitles=[{"start": 0.0, "end": 0.5, "text": "hi",
                        "original_start": 1.5, "original_end": 2.0},
                       {"start": 0.6, "end": 1.2, "text": "there",
                        "original_start": 2.7, "original_end": 3.3}],
            duration=4.0, language="en", scene_events=[])
    monkeypatch.setattr(pipeline, "analyze_video", analyze_video)
    monkeypatch.setattr(llm, "cleanup_transcript",
                        lambda subs, language=None: {})
    calls: list[dict] = []

    def smartcam(**kw):
        calls.append(kw)
        return None
    monkeypatch.setattr(pipeline, "_run_smartcam_preprocess", smartcam)
    seen["smartcam"] = calls
    return seen


@needs_ffmpeg
def test_target_9x16_on_a_portrait_source_is_kept(tmp_path, analysis):
    src = _clip(tmp_path / "phone.mp4", "90x160")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"),
                                {"target_aspect": "9:16"})
    assert analysis["smartcam"] == []           # no reframe, no zoom
    assert res["format_warning"] is None
    assert pipeline._display_size(res["normalized_path"]) == (90, 160)


@needs_ffmpeg
@pytest.mark.parametrize("aspect", ["16:9", "original"])
def test_other_targets_never_reframe(tmp_path, analysis, aspect):
    src = _clip(tmp_path / "in.mp4", "90x160")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"),
                                {"target_aspect": aspect})
    assert analysis["smartcam"] == []
    # A portrait source asked for 16:9 stays as it is (no pillarbox).
    assert pipeline._display_size(res["normalized_path"]) == (90, 160)


@needs_ffmpeg
def test_failed_smartcam_centre_crops_and_warns(tmp_path, analysis):
    src = _clip(tmp_path / "land.mp4", "320x180")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"),
                                {"target_aspect": "9:16"})
    [call] = analysis["smartcam"]
    assert call["smartcam_format"] == "portrait"
    assert call["same_aspect_zoom"] == 1.0
    assert res["format_warning"] == "smartcam_failed"
    w, h = pipeline._display_size(res["normalized_path"])
    assert h == 180 and abs(w / h - 9 / 16) < 0.02    # cropped, no bars
    assert pipeline.analysis_fields(res)["format_warning"] == "smartcam_failed"


@needs_ffmpeg
def test_smartcam_exception_is_a_warning_too(tmp_path, analysis, monkeypatch):
    def boom(**kw):
        raise RuntimeError("no face model")
    monkeypatch.setattr(pipeline, "_run_smartcam_preprocess", boom)
    src = _clip(tmp_path / "land.mp4", "320x180")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"),
                                {"target_aspect": "9:16"})
    assert res["format_warning"] == "smartcam_failed"


def test_format_warning_is_public():
    from backend.jobs import store
    job = store.create(None, {})
    store.update(job.id, format_warning="smartcam_failed")
    assert store.get(job.id).to_dict()["format_warning"] == "smartcam_failed"


# ── "No cuts" ────────────────────────────────────────────────────────


def test_no_cut_plan_keeps_everything_but_long_edges():
    segs = [(1.4, 2.0), (2.6, 3.4), (5.0, 8.0)]
    subs = [
        {"start": 0.0, "end": 0.6, "text": "a", "original_start": 1.4, "original_end": 2.0},
        # split over two segments by the cut plan: appears twice
        {"start": 0.6, "end": 0.7, "text": "b", "original_start": 1.9, "original_end": 2.8},
        {"start": 0.7, "end": 0.8, "text": "b", "original_start": 1.9, "original_end": 2.8},
        {"start": 1.0, "end": 2.0, "text": "c", "original_start": 5.0, "original_end": 6.0},
    ]
    plan, out = pipeline.no_cut_plan(segs, subs, 8.5)
    assert plan == [(1.4, 8.5)]                 # 1.4 s lead trimmed, 0.5 s tail kept
    assert [s["text"] for s in out] == ["a", "b", "c"]
    assert [(s["start"], s["end"]) for s in out] == [
        (0.0, 0.6), (0.5, 1.4), (3.6, 4.6)]
    assert out[1]["original_start"] == 1.9     # source times kept


def test_no_cut_plan_short_edges_stay():
    plan, _ = pipeline.no_cut_plan([(0.8, 2.0), (3.0, 9.2)], [], 10.0)
    assert plan == [(0.0, 10.0)]


@needs_ffmpeg
def test_no_cuts_analysis(tmp_path, analysis):
    src = _clip(tmp_path / "in.mp4", "160x90", seconds=4.0)
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"),
                                {"style": "none", "remove_fillers": True,
                                 "voice_triggers": True})
    kw = analysis["kw"]
    assert kw["remove_fillers"] is False and kw["voice_triggers"] is False
    # 1.4 s of silence before the first word: trimmed; the end is kept.
    assert res["segments"] == [(1.4, 4.0)]
    assert [s["start"] for s in res["subtitles"]] == [0.1, 1.3]
    assert res["cut_ranges"] == pipeline._invert_segments([(1.4, 4.0)], 4.0)
    assert len(res["cut_ranges"]) == 1


# ── spoken language ──────────────────────────────────────────────────


def test_spoken_language_is_the_code_picked(monkeypatch):
    """Groq may name the language in full ("portuguese"); the result
    carries the code the user picked."""
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq",
                        lambda audio_path, initial_prompt=None, language=None:
                        {"language": "po", "segments": [], "text": ""})
    with whisper_groq.spoken_language("pt"):
        assert whisper_groq.transcribe_via_groq_multilang("a.wav")["language"] == "pt"


def test_spoken_language_runs_one_pass(monkeypatch):
    calls: list = []

    def fake(audio_path, initial_prompt=None, language=None):
        calls.append(language)
        return {"language": language or "de", "segments": [], "text": ""}
    monkeypatch.setattr(whisper_groq, "transcribe_via_groq", fake)
    with whisper_groq.spoken_language("ja"):
        out = whisper_groq.transcribe_via_groq_multilang("a.wav")
    assert calls == ["ja"] and out["language"] == "ja"
    calls.clear()
    whisper_groq.transcribe_via_groq_multilang("a.wav")
    assert calls == [None, "en"]                # the two-pass default again
    calls.clear()
    with whisper_groq.spoken_language("auto"):
        whisper_groq.transcribe_via_groq_multilang("a.wav")
    assert calls == [None, "en"]


@needs_ffmpeg
def test_analysis_passes_the_language(tmp_path, analysis):
    src = _clip(tmp_path / "in.mp4", "160x90")
    pipeline.analyze_only(str(src), str(tmp_path / "job"),
                          {"spoken_language": "fr"})
    assert analysis["language"] == "fr"
    assert whisper_groq._SPOKEN_LANGUAGE.get() is None   # reset after


# ── GET /config ──────────────────────────────────────────────────────


def test_config_lists_spoken_languages(client):
    langs = client.get("/config").json()["spoken_languages"]
    assert langs[0] == "auto"
    assert {"en", "de", "ja", "hi", "zh"} <= set(langs)
    assert all(len(x) == 2 for x in langs[1:]) and len(set(langs)) == len(langs)


# ── /me/prefs ────────────────────────────────────────────────────────


def test_prefs_need_accounts(client):
    assert client.get("/me/prefs").status_code == 404
    assert client.put("/me/prefs", json={"style": "tight"}).status_code == 404


def test_prefs_roundtrip(client, auth_on, bearer):
    h = bearer("user_prefs")
    assert client.get("/me/prefs", headers=h).json() == {}
    r = client.put("/me/prefs", headers=h, json={
        "target_aspect": "original", "style": "balanced",
        "remove_fillers": False, "voice_triggers": True,
        "spoken_language": "de"})
    assert r.status_code == 200
    want = {"target_aspect": "original", "style": "smooth",
            "remove_fillers": False, "voice_triggers": True,
            "spoken_language": "de"}
    assert r.json() == want
    assert client.get("/me/prefs", headers=h).json() == want
    # A merge: other keys stay; null removes one.
    r = client.put("/me/prefs", headers=h, json={
        "spoken_language": None,
        "caption_style_by_aspect": {"9:16": {"presetId": "clipper"}}})
    assert r.json() == {**{k: v for k, v in want.items() if k != "spoken_language"},
                        "caption_style_by_aspect": {
                            "9:16": {"presetId": "clipper", "overrides": {}}}}
    # Another user sees nothing; the doc build reads them.
    assert client.get("/me/prefs", headers=bearer("user_other")).json() == {}
    from backend import doc as edit_doc
    assert edit_doc.load_prefs("user_prefs")["style"] == "smooth"


@pytest.mark.parametrize("body,field", [
    ({"style": "fast"}, "style"),
    ({"target_aspect": "4:3"}, "target_aspect"),
    ({"remove_fillers": "yes"}, "remove_fillers"),
    ({"spoken_language": "xx"}, "spoken_language"),
    ({"caption_style_by_aspect": {"9:16": {"presetId": "bogus"}}}, "caption_style_by_aspect"),
    ({"caption_style_by_aspect": {"4:3": {"presetId": "power"}}}, "caption_style_by_aspect"),
    ({"_r2_storage_key": "x"}, "_r2_storage_key"),
    ([1, 2], "body"),
])
def test_prefs_refuse_bad_values(client, auth_on, bearer, body, field):
    h = bearer("user_bad")
    r = client.put("/me/prefs", headers=h, json=body)
    assert r.status_code == 400
    assert r.json()["code"] == "bad_prefs" and r.json()["detail"]["field"] == field
    assert client.get("/me/prefs", headers=h).json() == {}


def test_prefs_parse_drops_stale_values():
    raw = json.dumps({"style": "smooth", "target_aspect": "1:1", "x": 1})
    assert prefs._parse(raw) == {"style": "smooth"}
    assert prefs._parse("not json") is None and prefs._parse(None) is None


# ── old payloads: exactly the processing of before UX6 ────────────────

# What the web sent before UX6 (the workflow presets / Custom).
OLD_PAYLOADS = [
    {"caption_preset": "clipper", "style": "tight", "voice_triggers": True,
     "remove_fillers": True, "smartcam_enabled": True,
     "smartcam_format": "portrait", "resolution": "1080",
     "output_formats": ["9:16"]},
    {"caption_preset": "clean", "style": "smooth", "voice_triggers": True,
     "remove_fillers": True, "smartcam_enabled": False,
     "smartcam_format": "landscape", "resolution": "1080",
     "output_formats": ["16:9", "9:16"]},
    {"caption_preset": "subtle", "style": "balanced", "voice_triggers": True,
     "remove_fillers": True, "smartcam_enabled": False,
     "smartcam_format": "portrait", "resolution": "1080",
     "output_formats": []},
    {"caption_preset": "clean", "style": "balanced", "voice_triggers": True,
     "remove_fillers": True, "smartcam_enabled": True,
     "smartcam_format": "landscape", "resolution": "1080",
     "output_formats": ["1:1"]},
]


@pytest.mark.parametrize("payload", OLD_PAYLOADS)
def test_old_payload_is_stored_unchanged(payload):
    assert M._clean_settings(dict(payload), None) == payload


@pytest.mark.parametrize("payload", OLD_PAYLOADS)
def test_old_payload_smartcam_as_before(payload):
    assert pipeline.smartcam_plan(payload) == (
        payload["smartcam_enabled"], payload["smartcam_format"])


@needs_ffmpeg
@pytest.mark.parametrize("payload", OLD_PAYLOADS)
def test_old_payload_analysis_as_before(tmp_path, analysis, payload):
    """Same analyze_video arguments as before UX6 (style map tight → fast,
    else smooth; fillers / voice commands as sent), SmartCam with the
    sent format (16:9 landscape reframe included), and a failed reframe
    keeps the normalized source — no crop, no warning."""
    src = _clip(tmp_path / "in.mp4", "160x90")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"), dict(payload))
    kw = analysis["kw"]
    assert kw["style"] == ("fast" if payload["style"] == "tight" else "smooth")
    assert kw["remove_fillers"] is True and kw["voice_triggers"] is True
    assert analysis["language"] is None                  # two-pass auto
    calls = analysis["smartcam"]
    if payload["smartcam_enabled"]:
        [call] = calls
        assert call["smartcam_format"] == payload["smartcam_format"]
    else:
        assert calls == []
    assert res["format_warning"] is None
    assert res["normalized_path"] == str(tmp_path / "job" / "normalized.mp4")
    assert pipeline._display_size(res["normalized_path"]) == (160, 90)
    # The cut plan as analysed (no "No cuts" rewrite).
    assert res["segments"] == [(1.4, 2.0), (2.6, 3.4)]


@needs_ffmpeg
def test_old_payload_smartcam_exception_still_fails(tmp_path, analysis, monkeypatch):
    def boom(**kw):
        raise RuntimeError("no face model")
    monkeypatch.setattr(pipeline, "_run_smartcam_preprocess", boom)
    src = _clip(tmp_path / "land.mp4", "320x180")
    with pytest.raises(RuntimeError):
        pipeline.analyze_only(str(src), str(tmp_path / "job"), dict(OLD_PAYLOADS[0]))
