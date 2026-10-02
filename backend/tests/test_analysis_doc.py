"""UT3 at analysis time, end to end: analyze_only builds the edit doc
from the words before the caption-unit gluing (cleanup applied), makes
the mezz CFR and measures loudness + peaks; both commit paths (the WP1
thread and the task queue's worker) store the doc, peaks.bin and the CJK
font subsets, and the doc's style is the one picked while the analysis
ran."""
from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import backend.main as M
from backend import jobs, media, pipeline, taskq, worker
from backend.jobs import store
from conftest import analysis_result
from src.ffmpeg_utils import get_ffmpeg_path

WORDS = [  # Whisper words: "So um we gonna win" (+ a filler sound)
    {"text": "So", "start": 0.3, "end": 0.5, "probability": 0.9},
    {"text": "um", "start": 0.5, "end": 0.9, "probability": 0.4},
    {"text": "we", "start": 1.0, "end": 1.2, "probability": 1.0},
    {"text": "gonna", "start": 1.2, "end": 1.6, "probability": 1.0},
    {"text": "win.", "start": 1.7, "end": 2.0, "probability": 1.0},
]
UNITS = [  # src/audio.py's caption units of them (filler dropped, glued)
    {"start": 0.1, "end": 0.9, "text": "So we", "original_start": 0.3, "original_end": 1.2},
    {"start": 0.9, "end": 1.6, "text": "gonna win.", "original_start": 1.2, "original_end": 2.0},
]


def _clip(path: Path, seconds: float = 3.0) -> Path:
    subprocess.run([get_ffmpeg_path(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    f"testsrc=s=320x240:r=25:d={seconds}", "-f", "lavfi", "-i",
                    f"sine=f=440:d={seconds}", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


@pytest.fixture
def fake_transcription(monkeypatch):
    seen = {}

    def analyze_video(video_path, **kw):
        seen.update(kw)
        lang = seen.get("_lang", "en")
        words = [dict(w) for w in WORDS] if lang == "en" else [
            {"text": "今日", "start": 0.3, "end": 0.6}, {"text": "は", "start": 0.6, "end": 0.8},
            {"text": "晴れ", "start": 0.9, "end": 1.4}]
        return SimpleNamespace(
            segments=[(0.2, 2.2)], subtitles=[dict(u) for u in UNITS], duration=3.0,
            language=lang, scene_events=[], words=words if kw.get("include_words") else None,
            fillers=[{"start": 0.5, "end": 0.9, "word": "um"}])
    monkeypatch.setattr(pipeline, "analyze_video", analyze_video)
    import backend.llm as llm
    monkeypatch.setattr(llm, "cleanup_transcript",
                        lambda subs, language=None: {1: "going to win."})
    return seen


def test_analyze_only_builds_the_doc_and_measures(tmp_path, fake_transcription):
    src = _clip(tmp_path / "in.mp4")
    res = pipeline.analyze_only(str(src), str(tmp_path / "job"),
                                {"smartcam_enabled": False, "caption_style_hint": "clipper"})
    assert fake_transcription["include_words"] is True
    doc = res["doc"]
    assert [w["text"] for w in doc["words"]] == ["So", "um", "we", "going", "to", "win."]
    assert [w["id"] for w in doc["words"]] == [f"w{i:04d}" for i in range(1, 7)]
    um = doc["words"][1]
    # UX10: "um" is a word in a filler range, not a filler sound: cut, not hidden
    assert um["cut"] == "filler" and "hidden" not in um and um["start"] == 0.5
    # cleanup: "gonna" → "going to" shares gonna's time, the rest keeps its own
    assert doc["words"][3]["start"] == 1.2 and doc["words"][4]["end"] == 1.6
    assert doc["words"][5]["start"] == 1.7
    assert res["subtitles"][1]["text"] == "going to win."        # legacy units too
    assert doc["style"]["presetId"] == "clipper" and doc["clips"] is None
    assert (res["mezz_fps"], res["mezz_cfr"]) == (25.0, True)
    assert set(res["audio_loudness"]) == {"I", "TP", "LRA", "thresh", "offset"}
    assert abs(Path(res["peaks_path"]).stat().st_size - 300) <= 3
    assert res["font_files"] == {}
    # UT5: the first kept clip's first frame as a small JPEG (the editor's still)
    from PIL import Image
    with Image.open(res["poster_path"]) as im:
        assert im.format == "JPEG" and im.size == (320, 240)


def test_poster_is_the_first_kept_frame_and_at_most_540_wide(tmp_path):
    src = tmp_path / "wide.mp4"
    subprocess.run([get_ffmpeg_path(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=c=red:s=1280x720:r=25:d=1[r];color=c=blue:s=1280x720:r=25:d=2[b];"
                    "[r][b]concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", str(src)], check=True)
    from PIL import Image
    out = tmp_path / "poster.jpg"
    assert pipeline.make_poster(str(src), 1.5, str(out))
    with Image.open(out) as im:
        assert im.size == (540, 304)
        r, g, b = im.convert("RGB").getpixel((270, 152))
        assert b > 200 and r < 60          # the frame at 1.5 s: blue, not the red start
    assert pipeline.make_poster(str(tmp_path / "missing.mp4"), 0, str(tmp_path / "x.jpg")) is False


def test_japanese_doc_gets_a_font_subset(tmp_path, fake_transcription):
    pytest.importorskip("fontTools")
    fake_transcription["_lang"] = "ja"
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4")), str(tmp_path / "job"), {})
    assert res["doc"]["language"] == "ja"
    made = res["font_files"]["noto-sans-jp-800"]
    assert set(made["chars"]) == set("今日は晴れ")
    assert all(Path(p).is_file() for p in made["files"].values())


def _extras_result(output_dir, **extra):
    """analysis_result plus what UT3's analyze_only adds."""
    res = analysis_result(output_dir, 3.0)
    peaks = Path(output_dir) / "peaks.bin"
    peaks.write_bytes(bytes(range(100)) * 3)
    poster = Path(output_dir) / "poster.jpg"
    poster.write_bytes(b"\xff\xd8poster")
    fonts = Path(output_dir) / "fonts"
    fonts.mkdir()
    files = {}
    for kind in ("woff2", "ttf", "json"):
        f = fonts / f"noto-sans-jp-800.0123abcd.{kind}"
        f.write_bytes(b"{}" if kind == "json" else b"font")
        files[kind] = str(f)
    from backend import doc as D
    res.update(doc=D.build_doc(D.words_from_transcript(WORDS), "ja", {}),
               mezz_fps=29.97, mezz_cfr=True,
               audio_loudness={"I": -20.0, "TP": -3.0, "LRA": 4.0, "thresh": -30.0, "offset": 0.1},
               peaks_path=str(peaks), poster_path=str(poster),
               font_files={"noto-sans-jp-800": {"family": "cc-noto-sans-jp-800-0123abcd",
                                                "rev": "0123abcd", "chars": "今", "missing": "",
                                                "files": files}})
    res.update(extra)
    return res


def _assert_committed(job_id):
    got = store.get(job_id)
    assert got.status == "awaiting_review"
    assert got.doc["v"] == 2 and got.doc_rev == 0
    assert got.doc["style"]["presetId"] == "neon"          # picked while processing
    assert (got.mezz_fps, got.mezz_cfr) == (29.97, True)
    assert got.audio_loudness["I"] == -20.0
    assert got.peaks_key == f"jobs/{job_id}/peaks.bin"
    assert media.size(got.peaks_key, store=media.store_of(got)) == 300
    assert got.poster_key == f"jobs/{job_id}/poster.jpg"
    assert got.to_dict()["has_poster"] is True
    sub = got.font_subsets["noto-sans-jp-800"]
    assert sub["woff2"] == f"jobs/{job_id}/fonts/noto-sans-jp-800.0123abcd.woff2"
    assert got.media_bytes[sub["ttf"]] == 4
    d = got.to_dict()
    assert d["has_doc"] is True and d["peaks"] == {"rate": 100, "floor_db": -96}
    assert d["font_subsets"] == {"noto-sans-jp-800": {
        "family": "cc-noto-sans-jp-800-0123abcd", "rev": "0123abcd",
        "json": "noto-sans-jp-800.0123abcd.json"}}
    return got


def _new_job():
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), {"caption_style_hint": "clipper"})


def test_wp1_commit_stores_doc_and_media(client, monkeypatch):
    monkeypatch.setenv("CLEO_CAPTION_PRESETS_LIVE", "all")
    job = _new_job()

    def analyze(input_path, output_dir, settings, progress_cb, **kw):
        # the user picks a style on the processing screen meanwhile
        r = client.patch(f"/jobs/{job.id}", json={"caption_style": "neon"})
        assert r.status_code == 200, r.text
        return _extras_result(output_dir)
    monkeypatch.setattr(M, "analyze_only", analyze)
    M._run_analyze_inner(job.id)
    got = _assert_committed(job.id)
    assert got.settings["caption_style"] == {"presetId": "neon", "overrides": {}}
    r = client.get(f"/jobs/{job.id}/doc")
    assert r.status_code == 200 and r.json()["rev"] == 0 and r.json()["read_only"] is False
    r = client.get(f"/jobs/{job.id}/peaks", follow_redirects=False)
    assert r.status_code in (200, 307)
    r = client.get(f"/jobs/{job.id}/poster", follow_redirects=False)
    assert r.status_code in (200, 307)
    if r.status_code == 200:
        assert r.headers["content-type"] == "image/jpeg" and r.content == b"\xff\xd8poster"
    r = client.get(f"/jobs/{job.id}/fonts/noto-sans-jp-800.0123abcd.json",
                   follow_redirects=False)
    assert r.status_code in (200, 307)
    assert client.get(f"/jobs/{job.id}/fonts/other.woff2").status_code == 404


def test_analysis_without_doc_commits_as_before(monkeypatch):
    job = _new_job()
    monkeypatch.setattr(M, "analyze_only",
                        lambda input_path, output_dir, settings, progress_cb, **kw:
                        analysis_result(output_dir, 3.0))
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "awaiting_review"
    assert (got.doc, got.peaks_key, got.font_subsets, got.mezz_cfr) == (None, None, {}, False)
    assert got.to_dict()["has_doc"] is False
    # no poster (an analysis from before UT5): the editor seeks its video instead
    assert got.poster_key is None and got.to_dict()["has_poster"] is False


@pytest.mark.no_task_leader
def test_worker_commit_stores_doc_and_media(client, monkeypatch):
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    monkeypatch.setenv("CLEO_CAPTION_PRESETS_LIVE", "all")
    job = _new_job()
    ts = jobs.task_store()
    tid, _ = ts.enqueue(job.id, "ingest", {"v": taskq.WORKER_PROTOCOL, "job_id": job.id,
                                          "est_audio_s": 3, "size": 0},
                        owner_id=None, job_change=dict(status="processing", message="queued"))
    ts.claim_for_dispatch("ingest", 1, "L", 300, "local")

    def analyze(input_path, output_dir, settings, progress_cb, **kw):
        r = client.patch(f"/jobs/{job.id}", json={"caption_style": {"presetId": "neon"}})
        assert r.status_code == 200, r.text
        return _extras_result(output_dir)
    monkeypatch.setattr(M, "analyze_only", analyze)
    out: list = []
    t = threading.Thread(target=lambda: out.append(
        worker.run("ingest", tid, job.id, 1, taskq.WORKER_PROTOCOL)))
    t.start()
    t.join(30)
    assert out == [{"committed": True}]
    _assert_committed(job.id)


def test_poster_route_without_a_poster(client):
    """A job analysed before UT5 (or whose poster failed): 404, the editor
    seeks its video to the first clip instead."""
    job = _new_job()
    r = client.get(f"/jobs/{job.id}/poster")
    assert r.status_code == 404 and r.json()["detail"] == "poster_not_ready"


def test_a_failed_poster_upload_doesnt_fail_the_analysis(tmp_path, capsys):
    """UT5 (review 15): the poster is optional — its put fails, the rest
    is stored, no poster_key."""
    poster = tmp_path / "poster.jpg"
    poster.write_bytes(b"\xff\xd8x")
    peaks = tmp_path / "peaks.bin"
    peaks.write_bytes(b"\x01" * 10)
    stored = []

    def put(path, key, ctype):
        if key.endswith("poster.jpg"):
            raise OSError("R2 down")
        stored.append(key)
        return 10
    fields, sizes = pipeline.store_analysis_extras(
        {"poster_path": str(poster), "peaks_path": str(peaks)}, "0123456789ab", put)
    assert "poster_key" not in fields and fields["peaks_key"].endswith("peaks.bin")
    assert stored == ["jobs/0123456789ab/peaks.bin"] and list(sizes) == stored
    assert "[poster] not stored" in capsys.readouterr().out
