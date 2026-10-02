"""UX5 contracts: the error / stage code catalogue (backend/errors.py),
what GET /jobs/{id} and the status rows serve of a job, the HTTP error
bodies, GET /config — pinned as snapshots, so a change is deliberate.

The code list is exported to web/src/lib/errorCodes.json, where the web
app's i18n check asserts every code has a message in every language.
After changing backend/errors.py run this file with
CLEO_UPDATE_SNAPSHOTS=1 to rewrite the JSON, then add the keys
(web/src/lib/errorKeys.ts + messages)."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import backend.main as M
from backend import errors, pipeline
from backend.jobs import store

REPO = Path(__file__).resolve().parents[2]
CODES_JSON = REPO / "web" / "src" / "lib" / "errorCodes.json"
ADMIN = {"X-Admin-Token": "s3cret"}
UNREADABLE = errors.JOB_ERRORS["unreadable_video"]


# ── the catalogue ────────────────────────────────────────────────────


def test_error_codes_json_is_in_sync():
    want = json.dumps(errors.catalogue(), indent=2) + "\n"
    if os.environ.get("CLEO_UPDATE_SNAPSHOTS") == "1":
        CODES_JSON.write_text(want)
    assert CODES_JSON.read_text() == want, (
        "web/src/lib/errorCodes.json is stale: rerun with CLEO_UPDATE_SNAPSHOTS=1")


def test_catalogue_shape():
    cat = errors.catalogue()
    # The codes the plan names (PLAN_TECH §1.5) are all there.
    for code in ("no_speech", "no_audio", "no_video", "video_too_short",
                 "audio_silent", "unreadable_video", "transcription_unavailable",
                 "server_storage_full", "render_failed", "render_unavailable",
                 "render_timeout", "media_expired", "media_unavailable",
                 "quota_exceeded", "subscription_required", "file_too_large",
                 "video_too_long", "server_busy", "too_many_renders",
                 "render_limit", "stale_rev", "doc_not_ready",
                 "already_rendering"):
        assert code in cat["errors"], code
    assert cat["warnings"] == ["script_unsupported", "smartcam_failed"]
    assert cat["audio_warnings"] == ["audio_clipping", "audio_quiet", "audio_silent"]
    for stage in ("analyze.normalize", "analyze.transcribe", "analyze.cleanup",
                  "analyze.cuts", "analyze.smartcam", "analyze.captions",
                  "analyze.done", "render.prepare", "render.captions",
                  "render.encode", "render.hooks", "render.finish"):
        assert stage in cat["stages"], stage
    # A code is user-facing or protocol, never both.
    assert not set(cat["protocol"]) & set(cat["errors"])


def test_stage_messages_keep_the_english_text():
    msg = errors.stage_message("render.captions", i=2, n=5)
    assert msg == "Rendering captions 2/5…" and isinstance(msg, str)
    assert errors.stage_fields(msg) == {
        "message": "Rendering captions 2/5…", "stage": "render.captions",
        "stage_params": {"i": 2, "n": 5}}
    # A finer text keeps the stage; a plain message keeps the job's stage.
    assert errors.stage_fields(errors.stage_message(
        "analyze.transcribe", "Transcribing (35%)…"))["stage"] == "analyze.transcribe"
    assert errors.stage_fields("Transcribing (35%)…") == {"message": "Transcribing (35%)…"}
    assert errors.stage("queued") == {"message": "queued", "stage": "queued",
                                      "stage_params": {}}
    with pytest.raises(KeyError):
        errors.stage_message("analyze.nope")


@pytest.mark.parametrize("exc,msg,code", [
    (pipeline.NoSpeechError(), "No speech detected in the video.", "no_speech"),
    (RuntimeError("x"), "Video has no audio track", "no_audio"),
    (OSError(), "server_storage_full", "server_storage_full"),
    (RuntimeError(), "container_restart", "processing_interrupted"),
    (RuntimeError(), "transcription_unavailable: Groq failed after 3 tries",
     "transcription_unavailable"),
    (RuntimeError(), "ffmpeg normalize failed: Invalid data", "unreadable_video"),
    (RuntimeError(), "boom", None),
])
def test_analysis_classification(exc, msg, code):
    assert errors.analysis_error_code(exc, msg) == code


def test_render_classification():
    assert errors.render_error_code(RuntimeError("x")) == "render_failed"
    assert errors.render_error_code(pipeline.RenderUnavailableError(
        "late", code="render_timeout")) == "render_timeout"
    assert errors.render_error_code(pipeline.RenderUnavailableError(
        "down", code="modal_unavailable")) == "render_unavailable"


def test_audio_warnings_are_codes(monkeypatch):
    """_precheck_audio answers codes; older jobs' sentences are mapped."""
    class R:
        stderr = "[Parsed_volumedetect] mean_volume: -60.0 dB\nmax_volume: -0.1 dB\n"
    monkeypatch.setattr(pipeline.subprocess, "run", lambda *a, **k: R())
    assert pipeline._precheck_audio("x.mp4")["warnings"] == ["audio_quiet",
                                                             "audio_clipping"]
    assert errors.audio_warning_codes([
        "Audio looks silent — check your microphone is on and not muted.",
        "Audio is on the quiet side but should still work.",
        "audio_clipping", "audio_clipping", "junk"]) == ["audio_silent",
                                                          "audio_clipping"]


# ── GET /jobs/{id}: the job as served ────────────────────────────────

# Every key GET /jobs/{id} answers with (snapshot: additive changes are
# fine, but deliberate).
JOB_KEYS = sorted([
    "id", "status", "plan", "expires_at", "message", "progress", "error",
    "error_code", "error_params", "refunded", "stage", "stage_params",
    "has_output", "has_proxy", "outputs", "social_caption",
    "social_hashtags", "hook_clips", "audio_warnings", "audio_warning_codes",
    "audio_levels",
    "duration", "cut_ranges", "scene_events", "edit_segments",
    "preview_segments", "preview_version", "caption_preset", "filename",
    "preset_id", "preset_label", "created_at", "updated_at",
    "queue_position", "has_doc", "font_subsets", "peaks",
    "caption_engine",   # UT4: v1 / v2 / None, no content
    "has_poster",       # UT5: GET /jobs/{id}/poster answers
    "fps",              # UX10: the editor's trim frame grid (mezz_fps)
    "format_warning",   # UX6: e.g. smartcam_failed
    "filmstrip",        # UX7b: {n, interval, tileW, tileH} or None
    "title",            # UX12: the name the user gave the project
    # UX11: exports (to_dict) + the fair-use numbers of the asker (API)
    "renders_ok", "downloads", "social_caption_edited", "has_captions_file",
    "spec_status", "fair_use", "free_renders_left",
    "next_render_cost_seconds", "spec_ready", "download_names", "output_aspect",
])


def _failed_job(**fields):
    job = store.create(None, {}, filename="music.mp4")
    store.update(job.id, status="error", progress=0.0,
                 error="ffmpeg -i /data/jobs/abc/source.mov failed: moov atom",
                 refunded=True, **{**errors.job_error("unreadable_video"), **fields})
    return store.get(job.id)


def test_to_dict_snapshot_and_no_raw_error(client):
    job = _failed_job()
    body = client.get(f"/jobs/{job.id}").json()
    assert sorted(body) == JOB_KEYS
    assert {k: body[k] for k in ("status", "message", "error", "error_code",
                                 "error_params", "refunded", "stage")} == {
        "status": "error", "message": UNREADABLE,
        # The catalogue's text (what old clients show), never the raw
        # text (paths, provider answers); the code next to it.
        "error": UNREADABLE, "error_code": "unreadable_video",
        "error_params": {}, "refunded": True, "stage": None}
    assert "/data/" not in json.dumps(body)


def test_raw_error_only_for_admins(client, auth_on, bearer, monkeypatch):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
    job = _failed_job()
    store.update(job.id, owner_id="user_a")
    assert client.get(f"/jobs/{job.id}", headers=bearer()).json()["error"] == \
        UNREADABLE
    admin = client.get(f"/jobs/{job.id}", headers=ADMIN).json()
    assert admin["error"].startswith("ffmpeg -i /data/jobs/")
    rows = client.get(f"/jobs/status?ids={job.id}", headers=bearer()).json()
    assert rows["jobs"][0]["error"] == UNREADABLE
    assert admin["message"] == UNREADABLE   # (the stored message)


def test_status_rows_snapshot(client):
    job = store.create(None, {}, filename="talk.mp4")
    store.update(job.id, status="processing", progress=35.0,
                 **errors.stage_fields(errors.stage_message(
                     "analyze.transcribe", "Transcribing (35%)…")))
    failed = _failed_job(error_params={"x": 1})
    body = client.get(f"/jobs/status?ids={job.id},{failed.id}").json()
    rows = {r["id"]: r for r in body["jobs"]}
    assert sorted(rows[job.id]) == sorted([
        "id", "status", "message", "progress", "queue_position", "error",
        "error_code", "error_params", "refunded", "stage", "stage_params",
        "has_output", "updated_at", "preview_version",
        # UX12: the Projects tile
        "title", "duration", "created_at", "expires_at"])
    assert (rows[job.id]["stage"], rows[job.id]["stage_params"],
            rows[job.id]["message"]) == ("analyze.transcribe", {},
                                         "Transcribing (35%)…")
    assert (rows[failed.id]["error"], rows[failed.id]["message"],
            rows[failed.id]["error_params"]) == (UNREADABLE, UNREADABLE, {"x": 1})


QUIET = "Audio is very quiet — speak closer to the microphone for best results."


def test_rows_written_before_ux5_read_fine(client):
    """A stored row without the UX5 fields (a job from before)."""
    job = store.create(None, {}, filename="old.mp4")
    store.update(job.id, status="error", error="No speech detected in the video.",
                 message="No speech detected in the video.", error_code="no_speech",
                 audio_warnings=[QUIET])
    body = client.get(f"/jobs/{job.id}").json()
    assert (body["error"], body["error_params"], body["stage"],
            body["audio_warnings"], body["audio_warning_codes"]) == (
        "No speech detected in the video.", {}, None, [QUIET], ["audio_quiet"])


def test_old_clients_get_english_never_codes_or_internals(client):
    """Web builds from before UX5 show audio_warnings and error/message as
    they come: English sentences, never codes, never raw exception text
    (review findings 5, 9, 10, 12)."""
    job = store.create(None, {}, filename="new.mp4")
    store.update(job.id, status="awaiting_review",
                 audio_warnings=["audio_quiet", "audio_clipping"])
    body = client.get(f"/jobs/{job.id}").json()
    assert body["audio_warnings"] == [QUIET, errors.AUDIO_WARNINGS["audio_clipping"]]
    assert body["audio_warning_codes"] == ["audio_quiet", "audio_clipping"]
    # A job that failed before UX5: raw text in message and error.
    old = store.create(None, {}, filename="old.mp4")
    store.update(old.id, status="error",
                 message="Groq 500: /tmp/cleo/jobs/x/audio.flac transcript 'hallo'",
                 error="Groq 500: /tmp/cleo/jobs/x/audio.flac transcript 'hallo'")
    body = client.get(f"/jobs/{old.id}").json()
    assert body["message"] == body["error"] == errors.JOB_ERRORS["processing_failed"]
    assert "/tmp/" not in json.dumps(body)
    rows = client.get(f"/jobs/status?ids={old.id}").json()["jobs"]
    assert rows[0]["message"] == errors.JOB_ERRORS["processing_failed"]
    # A failed render (back in review) keeps the message old clients match.
    rf = store.create(None, {}, filename="rf.mp4")
    store.update(rf.id, status="awaiting_review", message="render_failed",
                 error="Render worker unavailable (modal 500 at /x)",
                 error_code="render_unavailable")
    body = client.get(f"/jobs/{rf.id}").json()
    assert body["message"] == "render_failed"
    assert body["error"] == errors.JOB_ERRORS["render_unavailable"]


@pytest.mark.parametrize("code", sorted(errors.JOB_ERRORS))
def test_catalogue_texts_word_well_in_old_clients(code):
    """The pre-UX5 friendlyError shows a sentence with "Please" as it is
    and maps the others by keyword: every catalogue text must be one of
    the two, so an old client never shows a generic or odd text."""
    text = errors.public_text(code, {"min_seconds": 3, "max_minutes": 30,
                                     "max_gb": 4})
    assert "{" not in text
    keywords = ("no speech detected", "no audio track", "audio", "render")
    assert ("please" in text.lower() and text.endswith(".")) or any(
        k in text.lower() for k in keywords), text


# ── HTTP error bodies ────────────────────────────────────────────────


def test_error_bodies(client):
    """{detail (as before), code, params} on every error."""
    r = client.get("/jobs/nope123")
    assert (r.status_code, r.json()) == (404, {
        "detail": "job not found", "code": "not_found", "params": {}})
    r = client.post("/jobs/nope123/render", content=b"[1]",
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert (r.json()["code"], r.json()["params"]) == ("invalid_request", {})
    assert isinstance(r.json()["detail"], list)   # FastAPI's, unchanged
    r = client.post("/uploads/telemetry", content=b"x" * (2 * 1024 * 1024),
                    headers={"Content-Type": "application/json"})
    assert (r.status_code, r.json()) == (413, {
        "detail": "request_too_large", "code": "request_too_large", "params": {}})


@pytest.mark.parametrize("status,detail,body", [
    (409, "job not in review state (status=done)",
     {"detail": "job not in review state (status=done)", "code": "not_in_review",
      "params": {}}),
    (402, {"code": "quota_exceeded", "remaining_seconds": 5, "needed_seconds": 60},
     {"detail": {"code": "quota_exceeded", "remaining_seconds": 5,
                 "needed_seconds": 60},
      "code": "quota_exceeded",
      "params": {"remaining_seconds": 5, "needed_seconds": 60}}),
    (400, "no_audio", {"detail": "no_audio", "code": "no_audio", "params": {}}),
    (410, "normalized video no longer on disk",
     {"detail": "normalized video no longer on disk", "code": "media_expired",
      "params": {}}),
    (500, "something odd happened",
     {"detail": "something odd happened", "code": "server_error", "params": {}}),
])
def test_http_body_mapping(status, detail, body):
    assert errors.http_body(status, detail) == body


def test_refusal_body_keeps_the_fields_next_to_detail():
    assert errors.http_body(413, "file_too_large", {"max_gb": 4}) == {
        "detail": "file_too_large", "max_gb": 4, "code": "file_too_large",
        "params": {"max_gb": 4}}


# ── GET /config ──────────────────────────────────────────────────────


def test_config(client, monkeypatch):
    r = client.get("/config")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=60"
    c = r.json()
    assert sorted(c) == ["billing", "caption_presets", "formats", "free_renders",
                         "incident", "limits", "spoken_languages"]
    assert c["limits"] == {"max_upload_bytes": 4_000_000_000, "max_seconds": 1800,
                           "min_seconds": 3}
    assert c["formats"] == ["9:16", "1:1", "16:9"]
    assert c["caption_presets"][0] == {"id": "clean", "name_key": "app.captions.clean",
                                       "status": "live", "scripts": None}
    assert c["billing"] == {"enabled": False} and c["incident"] is None
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", "0.5")
    monkeypatch.setenv("CLEO_MAX_MINUTES", "0")
    monkeypatch.setenv("CLEO_MIN_SECONDS", "0")
    assert client.get("/config").json()["limits"] == {
        "max_upload_bytes": 500_000_000, "max_seconds": None, "min_seconds": 0}


# ── stages through the progress writers ─────────────────────────────


def test_progress_writer_stores_the_stage():
    job = store.create(None, {})
    store.update(job.id, status="processing")
    w = M._ProgressWriter(job.id, interval=0)
    w(errors.stage_message("analyze.cleanup"), 85.0)
    w("a finer note", -1)
    w.close()
    cur = store.get(job.id)
    assert (cur.stage, cur.message, cur.progress) == (
        "analyze.cleanup", "a finer note", 85.0)


@pytest.mark.parametrize("minutes,seconds,too_long", [
    ("30", 1801.5, True), ("30", 1800.5, False), ("0", 99999.0, False),
    ("-1", 99999.0, False), ("30", None, False),
])
def test_length_cap_is_the_same_in_api_and_worker(monkeypatch, minutes,
                                                   seconds, too_long):
    """CLEO_MAX_MINUTES <= 0 is "no cap" for POST /jobs and the queue's
    worker alike (and GET /config says so)."""
    from backend import worker
    monkeypatch.setenv("CLEO_MAX_MINUTES", minutes)
    assert M._too_long(seconds) is too_long
    assert worker._too_long(seconds) is too_long


def test_queue_upload_gone_keeps_its_code_and_message():
    """The worker found no upload (a non-retryable INFRA failure, task
    state 'failed'): the job gets processing_interrupted and its
    message, not a code-less "Processing failed."."""
    from backend import taskq
    job = store.create(None, {}, filename="gone.mp4")
    store.update(job.id, status="processing")
    t = taskq.Task(id=1, job_id=job.id, kind="ingest", state="failed",
                   error_code=taskq.INFRA, last_error="the upload is gone",
                   result={"refund": True, "infra": True,
                           "job_code": "processing_interrupted",
                           "message": "Processing was interrupted. "
                                      "Please upload the video again.",
                           "error": "upload_missing"})
    M._QueueOps(periodic=False)._ingest_ended(t)
    cur = store.get(job.id)
    assert (cur.status, cur.error_code) == ("error", "processing_interrupted")
    assert cur.message == errors.JOB_ERRORS["processing_interrupted"]
