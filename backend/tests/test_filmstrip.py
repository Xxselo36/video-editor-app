"""UX7b: the timeline filmstrip — one JPEG sprite of the proxy (pipeline.
make_filmstrip) made at the analysis' end, stored as jobs/{id}/filmstrip.jpg
with filmstrip_meta {n, interval, tileW, tileH}, served by GET
/jobs/{id}/filmstrip like the other media, made lazily for older jobs —
and never the reason an analysis fails."""
from __future__ import annotations

import math
import subprocess
import time
from pathlib import Path

import pytest

import backend.main as M
from backend import jobs, media, pipeline, r2_backfill, taskq, worker
from backend.jobs import store
from conftest import analysis_result
from src.ffmpeg_utils import get_ffmpeg_path
from test_analysis_doc import _clip, fake_transcription  # noqa: F401 (fixture)


def _sprite_size(path: Path) -> tuple[int, int]:
    return pipeline._image_size(str(path))


# ── the sprite ───────────────────────────────────────────────────────


@pytest.mark.parametrize("duration,n,interval", [
    (0.4, 1, 1.0), (3.0, 3, 1.0), (3.2, 4, 1.0), (200.0, 200, 1.0),
    (200.5, 199, 1.01), (600.0, 200, 3.0), (1800.0, 200, 9.0),
    (7213.0, 200, 36.07),
])
def test_plan_keeps_at_most_200_tiles(duration, n, interval):
    assert pipeline.filmstrip_plan(duration) == (n, interval)
    assert n <= pipeline.FILMSTRIP_MAX_TILES
    assert n * interval >= duration - 1e-9       # the tiles cover the video


def test_make_filmstrip_tiles_the_video(tmp_path):
    src = _clip(tmp_path / "in.mp4", seconds=4.0)          # 320x240
    out = tmp_path / "filmstrip.jpg"
    meta = pipeline.make_filmstrip(str(src), str(out), 4.0)
    assert meta == {"n": 4, "interval": 1.0, "tileW": 120, "tileH": 90}
    assert _sprite_size(out) == (4 * 120, 90)
    assert not list(tmp_path.glob("*.tmp.jpg"))


def test_make_filmstrip_probes_the_duration_and_reads_portrait(tmp_path):
    src = tmp_path / "tall.mp4"
    subprocess.run([get_ffmpeg_path(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc=s=180x320:r=30:d=2.5", "-c:v", "libx264", "-preset",
                    "ultrafast", "-g", "30", str(src)], check=True)
    meta = pipeline.make_filmstrip(str(src), str(tmp_path / "f.jpg"))
    assert meta == {"n": 3, "interval": 1.0, "tileW": 50, "tileH": 90}


def test_make_filmstrip_failure_is_none_and_leaves_nothing(tmp_path, capsys):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video")
    out = tmp_path / "filmstrip.jpg"
    assert pipeline.make_filmstrip(str(bad), str(out), 3.0) is None
    assert pipeline.make_filmstrip(str(tmp_path / "missing.mp4"), str(out)) is None
    assert list(tmp_path.iterdir()) == [bad]
    assert "[filmstrip] not made" in capsys.readouterr().out


# ── at analysis time ─────────────────────────────────────────────────


def test_analyze_only_makes_the_filmstrip(tmp_path, fake_transcription):  # noqa: F811
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4")), str(tmp_path / "job"),
                                {"smartcam_enabled": False})
    assert res["filmstrip_meta"] == {"n": 3, "interval": 1.0, "tileW": 120, "tileH": 90}
    assert Path(res["filmstrip_path"]).name == "filmstrip.jpg"
    assert _sprite_size(Path(res["filmstrip_path"])) == (360, 90)


def test_analyze_only_without_a_filmstrip_still_succeeds(tmp_path, monkeypatch,
                                                         fake_transcription):  # noqa: F811
    monkeypatch.setattr(pipeline, "make_filmstrip", lambda *a, **k: None)
    res = pipeline.analyze_only(str(_clip(tmp_path / "in.mp4")), str(tmp_path / "job"), {})
    assert res["filmstrip_path"] is None and res["filmstrip_meta"] is None
    assert res["doc"] is not None and res["segments"]


def _with_filmstrip(output_dir, duration: float = 3.0) -> dict:
    res = analysis_result(output_dir, duration)
    src = _clip(Path(output_dir) / "clip.mp4", seconds=duration)
    sprite = Path(output_dir) / "filmstrip.jpg"
    res["filmstrip_meta"] = pipeline.make_filmstrip(str(src), str(sprite), duration)
    res["filmstrip_path"] = str(sprite)
    return res


def _new_job():
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), {})


def test_store_extras_takes_the_filmstrip(tmp_path):
    res = _with_filmstrip(tmp_path)
    put_calls = []

    def put(path, key, ctype):
        put_calls.append((key, ctype))
        return Path(path).stat().st_size
    fields, sizes = pipeline.store_analysis_extras(res, "0123456789ab", put)
    assert put_calls == [("jobs/0123456789ab/filmstrip.jpg", "image/jpeg")]
    assert fields == {"filmstrip_key": "jobs/0123456789ab/filmstrip.jpg",
                      "filmstrip_meta": res["filmstrip_meta"]}
    assert sizes["jobs/0123456789ab/filmstrip.jpg"] > 0


def test_store_extras_survives_a_failed_upload(tmp_path, capsys):
    res = _with_filmstrip(tmp_path)

    def put(path, key, ctype):
        raise M.MediaTransferError("R2 said no")
    assert pipeline.store_analysis_extras(res, "0123456789ab", put) == ({}, {})
    assert "[filmstrip] not stored" in capsys.readouterr().out

    def fenced(path, key, ctype):
        raise InterruptedError("fenced out")
    with pytest.raises(InterruptedError):       # a fence still ends the attempt
        pipeline.store_analysis_extras(res, "0123456789ab", fenced)


def test_wp1_commit_stores_the_filmstrip(client, monkeypatch):
    job = _new_job()
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir, settings,
                        progress_cb, **kw: _with_filmstrip(output_dir))
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "awaiting_review"
    key = f"jobs/{job.id}/filmstrip.jpg"
    assert got.filmstrip_key == key and got.media_bytes[key] > 0
    meta = {"n": 3, "interval": 1.0, "tileW": 120, "tileH": 90}
    assert got.filmstrip_meta == meta
    assert client.get(f"/jobs/{job.id}").json()["filmstrip"] == meta
    assert key in media._job_keys(got)
    r = client.get(f"/jobs/{job.id}/filmstrip", follow_redirects=False)
    assert r.status_code in (200, 307), r.text
    if r.status_code == 200:    # (R2: the 307's own caching, as for every media key)
        assert r.headers["cache-control"] == "private, max-age=604800, immutable"
        assert r.headers["content-type"] == "image/jpeg" and r.content[:2] == b"\xff\xd8"
    r = client.get(f"/jobs/{job.id}/filmstrip", params={"meta": 1})
    assert (r.status_code, r.json()) == (200, meta)


def test_wp1_analysis_with_a_failed_filmstrip_upload_succeeds(client, monkeypatch):
    job = _new_job()
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir, settings,
                        progress_cb, **kw: _with_filmstrip(output_dir))
    real_put = media.put_file

    def put_file(path, key, **kw):
        if key.endswith("filmstrip.jpg"):
            raise OSError("disk full")
        return real_put(path, key, **kw)
    monkeypatch.setattr(media, "put_file", put_file)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "awaiting_review" and got.mezz_key and got.preview_key
    assert (got.filmstrip_key, got.filmstrip_meta) == (None, None)
    assert client.get(f"/jobs/{job.id}").json()["filmstrip"] is None


@pytest.mark.no_task_leader
def test_worker_analysis_with_a_failed_filmstrip_upload_succeeds(monkeypatch):
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    job = _new_job()
    ts = jobs.task_store()
    tid, _ = ts.enqueue(job.id, "ingest", {"v": taskq.WORKER_PROTOCOL, "job_id": job.id,
                                          "est_audio_s": 3, "size": 0},
                        owner_id=None, job_change=dict(status="processing", message="queued"))
    ts.claim_for_dispatch("ingest", 1, "L", 300, "local")
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir, settings,
                        progress_cb, **kw: _with_filmstrip(output_dir))
    real_put = media.put_file

    def put_file(path, key, **kw):
        if key.endswith("filmstrip.jpg"):
            raise OSError("R2 timeout")
        return real_put(path, key, **kw)
    monkeypatch.setattr(media, "put_file", put_file)
    assert worker.run("ingest", tid, job.id, 1, taskq.WORKER_PROTOCOL) == {"committed": True}
    got = store.get(job.id)
    assert got.status == "awaiting_review" and got.filmstrip_key is None


# ── the route: auth ──────────────────────────────────────────────────


def _job_with_filmstrip(owner: str | None = None, tmp: Path | None = None):
    job = store.create(None, {}, owner_id=owner)
    where = media.backend()
    key = f"jobs/{job.id}/filmstrip.jpg"
    work = Path(M._TMP_ROOT) / f"fs-{job.id}"
    work.mkdir(parents=True, exist_ok=True)
    meta = pipeline.make_filmstrip(str(_clip(work / "c.mp4", 2.0)), str(work / "f.jpg"), 2.0)
    size = media.put_file(work / "f.jpg", key, content_type="image/jpeg", store=where)
    store.update(job.id, status="awaiting_review", filmstrip_key=key, filmstrip_meta=meta,
                 media_store=where, media_bytes={key: size})
    return store.get(job.id)


def test_route_has_the_media_auth(client, auth_on, bearer):
    job = _job_with_filmstrip(owner="user_a")
    url = f"/jobs/{job.id}/filmstrip"
    assert client.get(url).status_code == 401
    assert client.get(url, headers=bearer("user_b")).status_code == 404
    from backend import auth
    assert client.get(url, params={"t": auth.media_token("user_b")}).status_code == 404
    assert client.get(url, params={"t": "garbage"}).status_code == 401
    for kw in ({"headers": bearer("user_a")},
               {"params": {"t": auth.media_token("user_a")}}):
        r = client.get(url, follow_redirects=False, **kw)
        assert r.status_code in (200, 307), r.text
    r = client.get(url, params={"meta": 1, "t": auth.media_token("user_a")})
    assert r.status_code == 200 and r.json()["n"] == 2
    # GET /jobs/{id} names it for the owner only
    assert client.get(f"/jobs/{job.id}", headers=bearer("user_a")).json()["filmstrip"]
    assert client.get(f"/jobs/{job.id}", headers=bearer("user_b")).status_code == 404


def test_unknown_job_is_404(client):
    assert client.get("/jobs/0123456789ab/filmstrip").status_code == 404


# ── older jobs: made on the first request ────────────────────────────


def _old_job(proxy: bytes | Path | None, duration: float = 3.0):
    """A job analysed before UX7b: a stored proxy (or none), no filmstrip."""
    job = store.create(None, {})
    where = media.backend()
    fields = dict(status="awaiting_review", duration=duration, media_store=where,
                  updated_at=1_700_000_000.0)
    if proxy is not None:
        key = f"jobs/{job.id}/proxy.mp4"
        work = Path(M._TMP_ROOT) / f"old-{job.id}"
        work.mkdir(parents=True, exist_ok=True)
        src = proxy if isinstance(proxy, Path) else work / "p.mp4"
        if not isinstance(proxy, Path):
            src.write_bytes(proxy)
        media.put_file(src, key, content_type="video/mp4", store=where)
        fields["proxy_key"] = key
    store.update(job.id, **fields)
    return store.get(job.id)


def _drain_pool():
    M._FILMSTRIP_POOL.submit(lambda: None).result(timeout=60)


def test_old_job_gets_its_filmstrip_lazily(client, tmp_path):
    job = _old_job(_clip(tmp_path / "proxy.mp4", 3.0))
    assert client.get(f"/jobs/{job.id}").json()["filmstrip"] is None
    r = client.get(f"/jobs/{job.id}/filmstrip", params={"meta": 1})
    assert r.status_code == 202, r.text
    assert r.json()["code"] == "filmstrip_pending" and r.headers["retry-after"] == "3"
    _drain_pool()
    got = store.get(job.id)
    meta = {"n": 3, "interval": 1.0, "tileW": 120, "tileH": 90}
    assert (got.filmstrip_key, got.filmstrip_meta) == (f"jobs/{job.id}/filmstrip.jpg", meta)
    assert got.updated_at == 1_700_000_000.0          # not a use of the project
    assert got.media_bytes[got.filmstrip_key] > 0
    r = client.get(f"/jobs/{job.id}/filmstrip", params={"meta": 1})
    assert (r.status_code, r.json()) == (200, meta)
    r = client.get(f"/jobs/{job.id}/filmstrip", follow_redirects=False)
    assert r.status_code in (200, 307)
    assert media.size(got.filmstrip_key, store=media.store_of(got)) > 0


def test_old_job_that_cannot_get_one(client):
    none = _old_job(None)
    r = client.get(f"/jobs/{none.id}/filmstrip")
    assert (r.status_code, r.json()["code"]) == (404, "filmstrip_unavailable")
    broken = _old_job(b"not a video")
    assert client.get(f"/jobs/{broken.id}/filmstrip").status_code == 202
    _drain_pool()
    assert store.get(broken.id).filmstrip_key is None
    # failed here: not tried again for a while
    r = client.get(f"/jobs/{broken.id}/filmstrip")
    assert (r.status_code, r.json()["code"]) == (404, "filmstrip_unavailable")
    assert client.get(f"/jobs/{broken.id}").status_code == 200


def test_lazy_filmstrip_the_job_didnt_take_goes_to_the_gc(client, tmp_path, monkeypatch):
    job = _old_job(_clip(tmp_path / "proxy.mp4", 2.0))
    real = pipeline.make_filmstrip

    def and_then_deleted(*a, **k):
        meta = real(*a, **k)
        store.delete(job.id)        # the user deleted the project meanwhile
        return meta
    monkeypatch.setattr(pipeline, "make_filmstrip", and_then_deleted)
    assert M._filmstrip_lazy(job.id) is False
    key = f"jobs/{job.id}/filmstrip.jpg"
    assert key in {row["prefix"] for row in store.gc_all()}
    assert media.gc_entry_ok(key)


def test_lazy_commit_keeps_a_filmstrip_made_meanwhile(tmp_path, monkeypatch):
    job = _old_job(_clip(tmp_path / "proxy.mp4", 2.0))
    real = pipeline.make_filmstrip

    def raced(*a, **k):
        meta = real(*a, **k)
        store.update(job.id, filmstrip_key=f"jobs/{job.id}/filmstrip.jpg",
                     filmstrip_meta=dict(meta, n=99))
        return meta
    monkeypatch.setattr(pipeline, "make_filmstrip", raced)
    assert M._filmstrip_lazy(job.id) is True
    assert store.get(job.id).filmstrip_meta["n"] == 99
    assert not store.gc_all()


# ── keys: GC, backfill ───────────────────────────────────────────────


def test_filmstrip_key_is_one_of_the_jobs_keys():
    job = jobs.Job(id="0123456789ab", status="done", mezz_key="jobs/0123456789ab/mezz.mp4",
                   filmstrip_key="jobs/0123456789ab/filmstrip.jpg")
    assert "jobs/0123456789ab/filmstrip.jpg" in media._job_keys(job)
    assert media.gc_entry_ok("jobs/0123456789ab/filmstrip.jpg")
    assert not media.gc_entry_ok("jobs/0123456789ab/filmstrip.png")
    assert r2_backfill._ctype("jobs/0123456789ab/filmstrip.jpg") == "image/jpeg"
    # the backfill's compare-and-set sees a filmstrip made during a move
    before = r2_backfill._keys_of(jobs.Job(id="0123456789ab", status="done",
                                           mezz_key="jobs/0123456789ab/mezz.mp4"))
    assert r2_backfill._keys_of(job) != before


def test_backfill_moves_the_filmstrip_with_the_job(no_r2, monkeypatch):
    # a keyed-local job: every key (the filmstrip too) is copied to R2
    job = _job_with_filmstrip()
    if media.store_of(job) != "local":
        pytest.skip("needs local media")
    moving = {it["key"]: it for it in r2_backfill.move_plan(job)}
    assert moving[job.filmstrip_key]["ctype"] == "image/jpeg"
    assert moving[job.filmstrip_key]["path"].is_file()


def test_meta_matches_the_sprite_for_a_long_video(tmp_path):
    # 250 s at 1 fps → 200 tiles 1.25 s apart, the sprite 200 tiles wide
    src = tmp_path / "long.mp4"
    subprocess.run([get_ffmpeg_path(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc=s=64x36:r=5:d=250", "-c:v", "libx264", "-preset", "ultrafast",
                    "-g", "5", str(src)], check=True)
    meta = pipeline.make_filmstrip(str(src), str(tmp_path / "f.jpg"), 250.0)
    assert meta == {"n": 200, "interval": 1.25, "tileW": 160, "tileH": 90}
    assert _sprite_size(tmp_path / "f.jpg") == (200 * 160, 90)
    assert math.ceil(250 / meta["interval"]) == meta["n"]
