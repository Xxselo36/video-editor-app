"""The Projects row (P3): GET /jobs?fields=summary and GET /jobs/status
tell whether a project has a poster (has_poster — never its storage key)
and how long its cut video is (output_seconds: Σ (end − start) / speed
over the saved timeline, None until stored — the web shows the source's
duration then). The stores keep output_seconds current on every write of
segments or settings (backend/jobs.py derive_fields): the analysis
commit (both paths), /edit-segments (speed changes included) and
/recompute-scenes. A poster miss is answered with Cache-Control:
no-store, so a browser doesn't keep it while the analysis makes one."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

import backend.main as M
from backend import jobs, media, taskq, worker
from backend.jobs import store
from conftest import analysis_result, pg_server_or_skip

# The analysis' cut: 2.5 s + 3.25 s.
ANALYSIS_SEGMENTS = [(0.0, 2.5), (4.0, 7.25)]
POSTER = b"\xff\xd8poster\xff\xd9"
# What a row may never carry: storage names, the editor's big fields.
NEVER_IN_ROWS = ("poster_key", "segments", "settings", "edit_segments")


@pytest.fixture(params=["active", "postgres"])
def job_store(request, monkeypatch):
    """`store` on the suite's database (SQLite unless CLEO_TEST_DB=postgres)
    and on a Postgres database of its own (skipped without pgserver)."""
    if request.param == "active":
        yield store
        return
    pg = pytest.importorskip("backend.pg")
    database = pg.Database(pg_server_or_skip().fresh(), max_size=4)
    database.apply_schema()
    monkeypatch.setattr(jobs, "_store_impl", pg.PgJobStore(database))
    try:
        yield store
    finally:
        database.close()


def _job(owner=None, **fields):
    job = store.create("/nonexistent/in.mp4", {}, owner_id=owner)
    if fields:
        store.update(job.id, **fields)
    return store.get(job.id)


def _status_row(client, job_id, **headers):
    r = client.get("/jobs/status", params={"ids": job_id}, headers=headers)
    assert r.status_code == 200, r.text
    [row] = r.json()["jobs"]
    return row


def _drop_stored_keys(job_id, *keys):
    """The row as written before these fields existed: `keys` gone from
    its stored JSON."""
    impl = jobs._open_store()
    if hasattr(impl, "_conn"):  # SQLite: one JSON blob per row
        with impl._lock:
            row = impl._conn.execute("SELECT data FROM jobs WHERE id = ?",
                                     (job_id,)).fetchone()
            data = json.loads(row["data"])
            for k in keys:
                data.pop(k, None)
            impl._conn.execute("UPDATE jobs SET data = ? WHERE id = ?",
                               (json.dumps(data), job_id))
            impl._conn.commit()
    else:  # Postgres: jsonb
        with impl._db.connection() as conn:
            conn.execute("UPDATE jobs SET data = data - %s::text[] "
                         "WHERE id = %s", (list(keys), job_id))


# ── the stored value ─────────────────────────────────────────────────


def test_a_job_without_segments_has_no_length(client):
    job = _job()
    assert job.output_seconds is None
    body = client.get(f"/jobs/{job.id}").json()
    assert (body["output_seconds"], body["has_poster"]) == (None, False)
    row = _status_row(client, job.id)
    assert (row["output_seconds"], row["has_poster"]) == (None, False)


def test_the_stores_keep_output_seconds_current(job_store):
    job = job_store.create("/in.mp4", {"caption_preset": "clean"})
    assert job_store.get(job.id).output_seconds is None
    # Segments written: their length, to 1 ms.
    job_store.update(job.id, segments=[(0.0, 4.0), (5.0, 6.0006)])
    assert job_store.get(job.id).output_seconds == 5.001
    # The speeds live in settings: one effect per segment.
    job_store.update(job.id, settings={
        "caption_preset": "clean",
        "segment_effects": [{"speed": 2.0}, {"speed": 0.5}]})
    assert job_store.get(job.id).output_seconds == 4.001
    # A compare-and-set and a modify count as writes too.
    assert job_store.update_if(job.id, "pending", segments=[(0.0, 2.0),
                                                            (3.0, 4.0)])
    assert job_store.get(job.id).output_seconds == 3.0
    job_store.modify(job.id, lambda cur: {
        "settings": {**cur.settings, "segment_effects": [{"speed": 4.0},
                                                         {"speed": 4.0}]}})
    assert job_store.get(job.id).output_seconds == 0.75
    # Effects that don't line up with the segments are not applied
    # (Job.edit_segments): every clip at 1x, as a render cuts it.
    job_store.update(job.id, segments=[(0.0, 3.0)])
    assert job_store.get(job.id).output_seconds == 3.0
    # Writes that don't touch the timeline leave it alone.
    job_store.update(job.id, progress=50.0, title="Talk")
    assert job_store.get(job.id).output_seconds == 3.0
    # Unreadable effects: no length — but the write itself goes through.
    job_store.update(job.id, settings={"segment_effects": ["junk"]},
                     message="still saved")
    got = job_store.get(job.id)
    assert (got.output_seconds, got.message) == (None, "still saved")
    job_store.update(job.id, settings={})
    assert job_store.get(job.id).output_seconds == 3.0
    # No segments any more: no length.
    job_store.update(job.id, segments=[])
    assert job_store.get(job.id).output_seconds is None
    # A job created with its segments (the stub server's seeds) has it.
    seeded = job_store.create("/in.mp4", {}, segments=[(1.0, 2.5)])
    assert seeded.output_seconds == 1.5
    assert job_store.get(seeded.id).output_seconds == 1.5


# ── GET /jobs/status ─────────────────────────────────────────────────


def test_status_rows_carry_the_poster_and_the_length(client, job_store):
    job = _job(status="awaiting_review", segments=[(0.0, 4.0), (6.0, 9.0)],
               settings={"segment_effects": [{"speed": 2.0}, {}]})
    r = client.get("/jobs/status", params={"ids": job.id})
    [row] = r.json()["jobs"]
    assert (row["has_poster"], row["output_seconds"]) == (False, 5.0)
    assert isinstance(row["output_seconds"], float)
    # The analysis stores the poster: the poll sees it (a new ETag).
    key = f"jobs/{job.id}/poster.jpg"
    store.update(job.id, poster_key=key)
    r2 = client.get("/jobs/status", params={"ids": job.id},
                    headers={"If-None-Match": r.headers["etag"]})
    assert r2.status_code == 200
    [row] = r2.json()["jobs"]
    assert (row["has_poster"], row["output_seconds"]) == (True, 5.0)
    # Never the storage name, never the timeline itself.
    assert not set(NEVER_IN_ROWS) & set(row)
    assert key not in r2.text and "poster.jpg" not in r2.text
    # A timeline write changes the length the poll shows.
    store.update(job.id, settings={"segment_effects": [{"speed": 1.0},
                                                       {"speed": 0.5}]})
    r3 = client.get("/jobs/status", params={"ids": job.id},
                    headers={"If-None-Match": r2.headers["etag"]})
    assert r3.status_code == 200
    assert r3.json()["jobs"][0]["output_seconds"] == 10.0


def test_the_status_store_reads_the_new_scalars(job_store):
    """store.status_many (SQLite JSON, Postgres jsonb_each) carries the
    two scalars the rows need, and none of the timeline."""
    job = _job(poster_key="jobs/abc/poster.jpg", segments=[(0.0, 1.25)])
    bare = _job()
    rows = job_store.status_many([job.id, bare.id])
    assert (rows[job.id]["poster_key"], rows[job.id]["output_seconds"]) == (
        "jobs/abc/poster.jpg", 1.25)
    assert (rows[bare.id]["poster_key"], rows[bare.id]["output_seconds"]) == (
        None, None)
    assert set(rows[job.id]) == set(jobs._STATUS_FIELDS)
    assert not {"segments", "settings", "edit_segments"} & set(rows[job.id])


# ── GET /jobs?fields=summary ─────────────────────────────────────────


def test_summary_rows_carry_the_poster_and_the_length(client, auth_on,
                                                       bearer, job_store):
    cut = _job(owner="user_a", status="done", duration=60.0,
               segments=[(0.0, 10.0), (20.0, 30.0)],
               settings={"segment_effects": [{"speed": 1.0}, {"speed": 4.0}]},
               poster_key="jobs/abc/poster.jpg")
    bare = _job(owner="user_a", filename="new.mp4")
    r = client.get("/jobs?fields=summary", headers=bearer("user_a"))
    assert r.status_code == 200
    rows = {row["id"]: row for row in r.json()}
    assert {"has_poster", "output_seconds"} <= set(M._SUMMARY_FIELDS)
    assert set(rows[cut.id]) == set(M._SUMMARY_FIELDS)
    assert (rows[cut.id]["has_poster"], rows[cut.id]["output_seconds"],
            rows[cut.id]["duration"]) == (True, 12.5, 60.0)
    assert (rows[bare.id]["has_poster"],
            rows[bare.id]["output_seconds"]) == (False, None)
    for row in rows.values():
        assert not set(NEVER_IN_ROWS) & set(row)
    assert "poster.jpg" not in r.text


def test_rows_written_before_read_as_unknown(client, auth_on, bearer,
                                             job_store):
    """A row from before these fields: no length (the web shows the
    source's duration), no poster — no migration needed."""
    job = _job(owner="user_a", status="done", duration=42.0,
               segments=[(0.0, 4.0)])
    _drop_stored_keys(job.id, "output_seconds", "poster_key")
    assert store.get(job.id).output_seconds is None
    row = _status_row(client, job.id, **bearer("user_a"))
    assert (row["has_poster"], row["output_seconds"], row["duration"]) == (
        False, None, 42.0)
    [tile] = client.get("/jobs?fields=summary", headers=bearer("user_a")).json()
    assert (tile["has_poster"], tile["output_seconds"]) == (False, None)


# ── every timeline write ─────────────────────────────────────────────


def _new_upload_job():
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), {})


def _analyze(monkeypatch):
    monkeypatch.setattr(M, "analyze_only",
                        lambda input_path, output_dir, settings, progress_cb, **kw:
                        analysis_result(output_dir, 10.0,
                                        segments=ANALYSIS_SEGMENTS))


def test_the_analysis_commit_stores_the_length(client, monkeypatch):
    job = _new_upload_job()
    _analyze(monkeypatch)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "awaiting_review"
    assert got.output_seconds == 5.75
    assert _status_row(client, job.id)["output_seconds"] == 5.75
    assert client.get(f"/jobs/{job.id}").json()["output_seconds"] == 5.75


@pytest.mark.no_task_leader
def test_the_workers_analysis_commit_stores_the_length(monkeypatch):
    """The task queue's worker commits through the task store (one
    transaction with its task): the same derived length."""
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    job = _new_upload_job()
    ts = jobs.task_store()
    tid, _ = ts.enqueue(job.id, "ingest", {"v": taskq.WORKER_PROTOCOL,
                                          "job_id": job.id, "est_audio_s": 3,
                                          "size": 0},
                        owner_id=None,
                        job_change=dict(status="processing", message="queued"))
    ts.claim_for_dispatch("ingest", 1, "L", 300, "local")
    _analyze(monkeypatch)
    out: list = []
    t = threading.Thread(target=lambda: out.append(
        worker.run("ingest", tid, job.id, 1, taskq.WORKER_PROTOCOL)))
    t.start()
    t.join(30)
    assert out == [{"committed": True}]
    assert store.get(job.id).output_seconds == 5.75


def _review_job(tmp_path, segments, duration=30.0):
    """A job in review the timeline routes accept (its render source on
    the local disk); preview rebuilds are stubbed by the caller."""
    src = tmp_path / f"normalized-{time.time_ns()}.mp4"
    src.write_bytes(b"n")
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", normalized_path=str(src),
                 segments=segments, duration=duration)
    return job


def _save_timeline(client, job_id, segments):
    r = client.post(f"/jobs/{job_id}/edit-segments", json={"segments": segments})
    assert r.status_code == 200, r.text
    return r.json()


def test_saving_the_timeline_updates_the_length(client, tmp_path, monkeypatch):
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    job = _review_job(tmp_path, [(0.0, 5.0)], duration=10.0)
    assert store.get(job.id).output_seconds == 5.0
    body = _save_timeline(client, job.id, [{"start": 0, "end": 4, "speed": 2},
                                           {"start": 5, "end": 9.5}])
    assert body["output_seconds"] == 6.5          # 4 s at 2x + 4.5 s
    before = client.get("/jobs/status", params={"ids": job.id})
    # Only a speed changes: the length follows.
    body = _save_timeline(client, job.id, [{"start": 0, "end": 4, "speed": 0.5},
                                           {"start": 5, "end": 9.5}])
    assert body["output_seconds"] == 12.5         # 4 s at 0.5x + 4.5 s
    got = store.get(job.id)
    assert got.output_seconds == 12.5
    # The render's own count (its settings) agrees.
    assert round(M._output_seconds(got), 3) == got.output_seconds
    after = client.get("/jobs/status", params={"ids": job.id},
                       headers={"If-None-Match": before.headers["etag"]})
    assert after.status_code == 200
    assert after.json()["jobs"][0]["output_seconds"] == 12.5


def test_recomputed_scenes_update_the_length(client, tmp_path, monkeypatch):
    """/recompute-scenes writes a new timeline: the speeds stay while the
    clip count does, and are reset with it when it changes."""
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a, **k: None)
    job = _review_job(tmp_path, [(0.0, 30.0)])
    _save_timeline(client, job.id, [{"start": 0, "end": 30, "speed": 2}])
    assert store.get(job.id).output_seconds == 15.0
    start = {"type": "start", "start": 2.0, "end": 2.6}
    r = client.post(f"/jobs/{job.id}/recompute-scenes", json={"events": [start]})
    assert r.status_code == 200, r.text
    got = store.get(job.id)
    assert [list(s) for s in got.segments] == [[2.6, 30.0]]
    assert got.output_seconds == 13.7             # one clip, still at 2x
    assert r.json()["output_seconds"] == 13.7
    keep = {"type": "keep", "start": 10.0, "end": 10.6}
    r = client.post(f"/jobs/{job.id}/recompute-scenes",
                    json={"events": [start, keep]})
    assert r.status_code == 200, r.text
    got = store.get(job.id)
    assert [list(s) for s in got.segments] == [[2.6, 10.0], [10.6, 30.0]]
    assert "segment_effects" not in got.settings
    assert got.output_seconds == 26.8             # speeds reset: 7.4 + 19.4
    assert _status_row(client, job.id)["output_seconds"] == 26.8


# ── GET /jobs/{id}/poster ────────────────────────────────────────────


def test_a_poster_miss_is_never_cached(client, no_r2, tmp_path):
    job = _job(status="processing")
    r = client.get(f"/jobs/{job.id}/poster")
    assert (r.status_code, r.json()["detail"]) == (404, "poster_not_ready")
    assert r.headers["cache-control"] == "no-store"
    # The analysis stored it: served, and kept by the browser.
    key = f"jobs/{job.id}/poster.jpg"
    src = tmp_path / "poster.jpg"
    src.write_bytes(POSTER)
    media.put_file(src, key, content_type="image/jpeg")
    store.update(job.id, poster_key=key, media_store="local")
    r = client.get(f"/jobs/{job.id}/poster")
    assert (r.status_code, r.content) == (200, POSTER)
    assert r.headers["cache-control"] == "private, max-age=604800, immutable"
    # Its file gone: 409, not kept either.
    media.local_path(key).unlink()
    r = client.get(f"/jobs/{job.id}/poster")
    assert (r.status_code, r.json()["detail"]) == (409, "poster_not_ready")
    assert r.headers["cache-control"] == "no-store"
