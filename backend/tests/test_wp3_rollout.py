"""WP3 rollout safety: everything is opt-in (the merge changes nothing
user-visible), media stay where their job put them whatever the process
setting says now, and the media GC / orphan sweep can't delete what
isn't theirs.

- defaults: media local, render_burn_concat, single-PUT uploads (init,
  parts and sign answer 409 use_single_put), no proxy-video, day-aligned
  presigning with a standard-presign lever, CLEO_TMP_ROOT on the volume;
- per-job store (Job.media_store): switching CLEO_MEDIA_BACKEND either
  way strands no job; the backfill moves keyed-local jobs to R2;
- media_gc: whitelist, per-row store, backoff;
- the orphan sweep: opt-in, bucket-owner marker, raw existence check,
  job-id format, per-run cap, seeded stamp;
- render_r2 not deployed → the volume path; the deadline's mezz term;
- preview rebuilds prefer a legacy local proxy;
- R2_BACKUP_BUCKET, botocore checksums, r2_setup's lifecycle check.
"""
from __future__ import annotations

import os
import sys
import time
import types
from pathlib import Path

import pytest

import backend.main as M
from backend import media, pipeline, r2_backfill, storage
from backend.jobs import store
from conftest import analysis_result

KEY = "uploads/user_a/0123456789abcdef0123456789abcdef.mp4"
SUBS = [{"start": 0.0, "end": 1.0, "text": "hi"}]


def _wait_for(pred, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture(autouse=True)
def rollout_state(monkeypatch):
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    for k in ("MODAL_TOKEN_ID", "CLEO_LOCAL_RENDER_FALLBACK",
              "CLEO_MEDIA_ROOT"):
        monkeypatch.delenv(k, raising=False)
    # No hook detection (LLM) in these renders.
    monkeypatch.setattr(pipeline, "detect_hooks", lambda *a, **k: [])
    shutil_rm(media.local_root())
    yield


def shutil_rm(path: Path) -> None:
    import shutil
    shutil.rmtree(path, ignore_errors=True)


def _analysed_job(r2):
    """An uploaded job (source in R2 under uploads/) run through the
    analysis worker with the process setting as it is now."""
    r2.put_object(Bucket=storage.bucket(), Key=KEY, Body=b"source-bytes")
    job = store.create(None, {}, source_key=KEY, owner_id=None)
    M._run_analyze_inner(job.id)
    return store.get(job.id)


@pytest.fixture
def analyse(monkeypatch):
    monkeypatch.setattr(M, "analyze_only",
                        lambda input_path, output_dir, **kw:
                        analysis_result(output_dir))


def _fake_render_only(seen: dict):
    def render_only(**kw):
        seen.update(kw)
        out = Path(kw["output_dir"])
        out.mkdir(parents=True, exist_ok=True)
        (out / "cleo_output.mp4").write_bytes(b"primary!")
        (out / "cleo_thumbnail.jpg").write_bytes(b"jpg")
        return {"outputs": {"primary": str(out / "cleo_output.mp4")},
                "hook_clips": []}
    return render_only


def _r2_keys(prefix: str) -> list[str]:
    return sorted(o["key"] for o in storage.list_r2(prefix))


# ── defaults: opt-in everywhere ──────────────────────────────────────


def test_defaults_change_nothing(r2, monkeypatch):
    """Production has R2_* set (for /uploads/presign): that alone must
    not move media, renders or uploads."""
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    assert media.backend() == "local"
    assert pipeline.modal_render_fn(True) == "render_burn_concat"
    assert pipeline.modal_render_fn(False) == "render_burn_concat"
    monkeypatch.setenv("CLEO_MODAL_RENDER_FN", "render_r2")
    assert pipeline.modal_render_fn(True) == "render_r2"
    # render_r2 only for a job whose media is in R2.
    assert pipeline.modal_render_fn(False) == "render_burn_concat"
    assert M._upload_mode() == "single"
    assert storage.presign_mode() == "day"


def test_tmp_root_defaults_to_the_volume(monkeypatch, tmp_path):
    monkeypatch.delenv("CLEO_TMP_ROOT", raising=False)
    assert M._default_tmp_root(tmp_path / "w") == tmp_path / "w" / "tmp"
    monkeypatch.setenv("CLEO_TMP_ROOT", "/tmp/cleo")
    assert M._default_tmp_root(tmp_path / "w") == Path("/tmp/cleo")
    assert "tmp" in M._WORK_ROOT_RESERVED


def test_single_mode_refuses_init_parts_and_sign(client, r2, monkeypatch):
    """A browser resuming a saved multipart upload calls parts / sign,
    not init: those must answer use_single_put too (the client then
    starts over with the single PUT)."""
    monkeypatch.delenv("CLEO_UPLOAD_MODE", raising=False)
    for path, body in (("init", {"size": 1000, "filename": "a.mp4"}),
                       ("parts", {"ticket": "x"}),
                       ("sign", {"ticket": "x", "part_numbers": [1]})):
        r = client.post(f"/uploads/multipart/{path}", json=body)
        assert (r.status_code, r.json()) == (
            409, {"detail": "use_single_put"}), path
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    r = client.post("/uploads/multipart/parts", json={"ticket": "x"})
    assert r.json() != {"detail": "use_single_put"}
    assert client.post("/uploads/multipart/init", json={
        "size": 1000, "filename": "a.mp4"}).status_code == 200


def test_proxy_video_is_opt_in(client, monkeypatch, tmp_path):
    d = tmp_path / "legacy"
    d.mkdir()
    (d / "normalized.mp4").write_bytes(b"N" * 10)
    (d / pipeline.PROXY_NAME).write_bytes(b"P" * 10)
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review",
                 normalized_path=str(d / "normalized.mp4"))
    monkeypatch.delenv("CLEO_PROXY_VIDEO", raising=False)
    r = client.get(f"/jobs/{job.id}/proxy-video")
    assert (r.status_code, r.json()) == (404, {"detail": "proxy_not_ready"})
    assert client.get(f"/jobs/{job.id}").json()["has_proxy"] is False
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    assert client.get(f"/jobs/{job.id}/proxy-video").status_code == 200
    assert client.get(f"/jobs/{job.id}").json()["has_proxy"] is True


def test_standard_presign_lever(r2, monkeypatch):
    r2.put_object(Bucket=storage.bucket(), Key="jobs/0123456789ab/mezz.mp4",
                  Body=b"x")
    day = storage.presign_get("jobs/0123456789ab/mezz.mp4")
    assert "T000000Z" in day and "X-Amz-Expires=172800" in day
    monkeypatch.setenv("CLEO_MEDIA_PRESIGN", "standard")
    std = storage.presign_get("jobs/0123456789ab/mezz.mp4")
    assert "X-Amz-Expires=86400" in std and "X-Amz-Expires=172800" not in std


def test_checksums_only_when_required(r2):
    for kind in ("api", "get", "get-std"):
        conf = storage._client(kind).meta.config
        assert conf.request_checksum_calculation == "when_required"
        assert conf.response_checksum_validation == "when_required"


# ── per-job store ────────────────────────────────────────────────────


def test_r2_job_stays_in_r2_after_switching_to_local(client, r2, analyse,
                                                     monkeypatch):
    job = _analysed_job(r2)
    assert job.status == "awaiting_review" and job.media_store == "r2"
    assert storage.head(job.mezz_key) == 4
    # The lever back: new jobs local — this one still lives in R2.
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "local")
    assert media.store_of(job) == "r2"
    r = client.get(f"/jobs/{job.id}/preview-video", follow_redirects=False)
    assert r.status_code == 307
    seen: dict = {}
    monkeypatch.setattr(pipeline, "render_only", _fake_render_only(seen))
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": SUBS}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    got = store.get(job.id)
    assert storage.head(got.output_keys["primary"]) == 8     # in R2
    assert not media.local_path(got.output_keys["primary"]).exists()
    r = client.get(f"/jobs/{job.id}/watch", follow_redirects=False)
    assert r.status_code == 307
    # Delete: the GC deletes in R2 (the job's store), not locally. The
    # render thread records its event after "done" and only then lets go
    # of the job (DELETE answers 409 while it holds it).
    assert _wait_for(lambda: job.id not in M._active_jobs)
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    assert _r2_keys(f"jobs/{job.id}/") == [] and store.gc_all() == []


def test_local_job_stays_local_after_switching_to_r2(client, r2, analyse,
                                                     monkeypatch):
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)  # default
    job = _analysed_job(r2)
    assert job.status == "awaiting_review" and job.media_store == "local"
    assert media.local_path(job.mezz_key).is_file()
    assert _r2_keys(f"jobs/{job.id}/") == []
    # The browser upload itself was in R2 and is gone after the commit.
    assert storage.head(KEY) is None
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    r = client.get(f"/jobs/{job.id}/preview-video", follow_redirects=False)
    assert r.status_code == 200 and r.content == b"prev"
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    assert not media.local_path(f"jobs/{job.id}/mezz.mp4").exists()
    assert store.gc_all() == []


def test_backfill_moves_keyed_local_jobs_to_r2(client, r2, analyse,
                                               monkeypatch):
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    job = _analysed_job(r2)
    assert job.media_store == "local"
    assert r2_backfill.plan(job, make_proxy=False) == []
    assert [it["key"] for it in r2_backfill.move_plan(job)] == [
        job.mezz_key, job.proxy_key, job.preview_key]
    summary = r2_backfill.run(echo=lambda line: None)
    assert summary["jobs"] == 1 and summary["local_only_left"] == 0
    got = store.get(job.id)
    assert got.media_store == "r2"
    assert (got.mezz_key, got.proxy_key, got.preview_key) == (
        job.mezz_key, job.proxy_key, job.preview_key)
    assert got.updated_at == job.updated_at
    for key in (got.mezz_key, got.proxy_key, got.preview_key):
        assert storage.head(key) == media.local_path(key).stat().st_size
    # Served from R2 now; the local copy goes a day later.
    r = client.get(f"/jobs/{job.id}/preview-video", follow_redirects=False)
    assert r.status_code == 307
    [row] = store.gc_all()
    assert (row["prefix"], row["store"]) == (f"jobs/{job.id}/", "local")
    assert row["not_before"] > time.time() + 23 * 3600
    assert M.run_media_gc(now=time.time() + 25 * 3600) == 1
    assert not media.local_path(got.mezz_key).exists()
    assert len(_r2_keys(f"jobs/{job.id}/")) == 3               # intact
    again = r2_backfill.run(echo=lambda line: None)
    assert again["jobs"] == 0


def test_backfill_commit_is_compare_and_set(r2, analyse, monkeypatch):
    """A preview rebuilt while the move uploads: nothing is committed
    (the next run moves the new key too)."""
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    job = _analysed_job(r2)
    real_put = media.put_file

    def put(path, key, **kw):
        if key == job.mezz_key:
            store.update(job.id, preview_version=2)
        return real_put(path, key, **kw)
    monkeypatch.setattr(media, "put_file", put)
    res = r2_backfill.backfill_job(store.get(job.id))
    assert res["status"] == "skipped"
    assert store.get(job.id).media_store == "local"


def test_backfill_move_fails_when_a_font_subset_changes(r2, analyse, monkeypatch):
    """A CJK font refresh (UT3) during the move: the compare-and-set sees
    the new subset keys, nothing is committed, the next run moves them."""
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    job = _analysed_job(r2)
    sub = {"family": "cc-noto-sans-jp-800-0123abcd", "rev": "0123abcd", "chars": "",
           "missing": "", **{k: f"jobs/{job.id}/fonts/noto-sans-jp-800.0123abcd.{k}"
                             for k in ("woff2", "ttf", "json")}}
    for k in ("woff2", "ttf", "json"):
        media.put_file(__file__, sub[k], content_type="font/ttf", store="local")
    store.update(job.id, font_subsets={"noto-sans-jp-800": sub})
    job = store.get(job.id)
    assert sub["woff2"] in [it["key"] for it in r2_backfill.move_plan(job)]
    real_put = media.put_file

    def put(path, key, **kw):
        if key == job.mezz_key:   # refresh lands: subset B replaces A
            b = {**sub, **{k: sub[k].replace("0123abcd", "89abcdef") for k in
                           ("woff2", "ttf", "json")}}
            store.update(job.id, font_subsets={"noto-sans-jp-800": b})
        return real_put(path, key, **kw)
    monkeypatch.setattr(media, "put_file", put)
    res = r2_backfill.backfill_job(store.get(job.id))
    assert res["status"] == "skipped"
    assert store.get(job.id).media_store == "local"


def test_rebuild_refuses_to_commit_into_a_moved_job(r2, analyse,
                                                    monkeypatch):
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    job = _analysed_job(r2)
    monkeypatch.setattr(pipeline, "_ffmpeg_cuts_preview",
                        lambda src, segs, out: Path(out).write_bytes(b"p2"))
    real_put = media.put_file

    def put(path, key, **kw):
        size = real_put(path, key, **kw)
        store.update(job.id, media_store="r2")    # the backfill committed
        return size
    monkeypatch.setattr(media, "put_file", put)
    with pytest.raises(RuntimeError, match="moved"):
        M._rebuild_preview(job.id, None, [(0.0, 1.0)])
    assert store.get(job.id).preview_key == job.preview_key


def test_gc_deletes_in_the_rows_store(r2, monkeypatch):
    b = storage.bucket()
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    r2.put_object(Bucket=b, Key="jobs/aaaaaaaaaaaa/mezz.mp4", Body=b"r")
    local = media.local_path("jobs/aaaaaaaaaaaa/mezz.mp4")
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(b"l")
    store.gc_add(["jobs/aaaaaaaaaaaa/"], store="r2")
    assert M.run_media_gc() == 1
    assert _r2_keys("jobs/aaaaaaaaaaaa/") == [] and local.exists()
    r2.put_object(Bucket=b, Key="jobs/aaaaaaaaaaaa/mezz.mp4", Body=b"r")
    store.gc_add(["jobs/aaaaaaaaaaaa/"], store="local")
    assert M.run_media_gc() == 1
    assert not local.exists() and _r2_keys("jobs/aaaaaaaaaaaa/")
    # A row from before stores were recorded: both.
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(b"l")
    store.gc_add(["jobs/aaaaaaaaaaaa/"])
    assert store.gc_all()[0]["store"] is None
    assert M.run_media_gc() == 1
    assert not local.exists() and _r2_keys("jobs/aaaaaaaaaaaa/") == []


def test_r2_row_without_r2_config_stays_queued(no_r2):
    store.gc_add(["jobs/aaaaaaaaaaaa/"], store="r2")
    assert M.run_media_gc() == 0
    [row] = store.gc_all()
    assert row["attempts"] == 1 and "not configured" in row["last_error"]


# ── GC whitelist and backoff ─────────────────────────────────────────

GOOD = ["jobs/0123456789ab/", "jobs/0123456789ab/r12/",
        "jobs/0123456789ab/preview/v3.mp4", "jobs/0123456789ab/source.mov",
        "uploads/user_a/0123456789abcdef0123456789abcdef.mp4",
        "uploads/0123456789abcdef0123456789abcdef.webm"]
BAD = ["jobs/", "uploads/", "backups/", "backups/pg/", "", "/",
       "jobs/0123456789ab/mezz.mp4", "jobs/0123456789ab/r1/primary.mp4",
       "jobs/0123456789ab", "jobs/notajobid12/", "jobs/0123456789ab/../",
       "uploads/user_a/", "uploads/user_a/x.mp4", "jobs/.owner"]


def test_gc_whitelist(no_r2):
    assert all(media.gc_entry_ok(e) for e in GOOD)
    assert not any(media.gc_entry_ok(e) for e in BAD)
    store.gc_add(BAD + GOOD[:1])
    assert [r["prefix"] for r in store.gc_all()] == GOOD[:1]
    store.delete("nosuchjob", gc=["jobs/", "backups/"])
    assert [r["prefix"] for r in store.gc_all()] == GOOD[:1]
    for entry in ("jobs/", "uploads/", "backups/"):
        with pytest.raises(ValueError):
            media.delete_any(entry)
    with pytest.raises(ValueError):
        media.delete_prefix("jobs/")


def test_bad_row_is_refused_at_delete_time(r2):
    """Even a row that got in some other way deletes nothing."""
    b = storage.bucket()
    r2.put_object(Bucket=b, Key="jobs/0123456789ab/mezz.mp4", Body=b"x")
    r2.put_object(Bucket=b, Key="backups/pg/2026-09-01.sql.gz", Body=b"x")
    _raw_gc_row("jobs/")
    assert M.run_media_gc() == 0
    assert storage.head("jobs/0123456789ab/mezz.mp4") == 1
    assert storage.head("backups/pg/2026-09-01.sql.gz") == 1
    [row] = store.gc_all()
    assert "refusing" in row["last_error"]


def _raw_gc_row(prefix: str) -> None:
    """A media_gc row written behind gc_add's whitelist."""
    if hasattr(store, "_conn"):
        with store._lock:
            store._conn.execute(
                "INSERT INTO media_gc (prefix, store, not_before, attempts, "
                "created_at) VALUES (?, '', 0, 0, 0)", (prefix,))
            store._conn.commit()
    else:
        with store._db.connection() as conn:
            conn.execute("INSERT INTO media_gc (prefix, not_before) "
                         "VALUES (%s, to_timestamp(0))", (prefix,))


def test_failed_rows_back_off_and_dont_block_newer_ones(no_r2, monkeypatch):
    now = time.time()
    store.gc_add(["jobs/aaaaaaaaaaaa/"], now - 100)     # stuck, oldest
    store.gc_add(["jobs/bbbbbbbbbbbb/"], now - 50)
    real = media.delete_any

    def delete_any(entry, where=None):
        if entry == "jobs/aaaaaaaaaaaa/":
            raise ConnectionError("down")
        return real(entry, where)
    monkeypatch.setattr(media, "delete_any", delete_any)
    assert M.run_media_gc(limit=1) == 0          # a fails …
    [a] = [r for r in store.gc_all() if r["prefix"] == "jobs/aaaaaaaaaaaa/"]
    assert a["attempts"] == 1 and a["not_before"] >= now + 250
    assert M.run_media_gc(limit=1) == 1          # … and b goes next time
    assert [r["prefix"] for r in store.gc_all()] == ["jobs/aaaaaaaaaaaa/"]
    # Doubling, capped.
    from backend.jobs import GC_BACKOFF_MAX_S, gc_backoff_s
    assert [gc_backoff_s(n) for n in (1, 2, 3)] == [300.0, 600.0, 1200.0]
    assert gc_backoff_s(50) == GC_BACKOFF_MAX_S


# ── orphan sweep ─────────────────────────────────────────────────────


def _local_prefix(job_id: str, age_s: float = 3 * 86400) -> Path:
    f = media.local_path(f"jobs/{job_id}/mezz.mp4")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(b"m")
    t = time.time() - age_s
    os.utime(f, (t, t))
    return f


@pytest.fixture
def sweep_on(no_r2, monkeypatch):
    monkeypatch.setenv("CLEO_MEDIA_ORPHAN_SWEEP", "1")
    monkeypatch.delenv("CLEO_MEDIA_ORPHAN_MAX", raising=False)


def test_orphan_sweep_refuses_a_foreign_marker(sweep_on, capsys):
    orphan = _local_prefix("aaaaaaaaaaaa")
    media.write_owner("local", "someone-else")
    assert M.sweep_media_orphans() == 0
    assert "ORPHAN SWEEP REFUSED" in capsys.readouterr().out
    assert store.gc_all() == [] and orphan.exists()


def test_orphan_sweep_without_marker_claims_only_a_known_store(sweep_on,
                                                                capsys):
    job = store.create(None, {})
    _local_prefix(job.id)
    orphan = _local_prefix("aaaaaaaaaaaa")
    # Unknown prefix, no marker: whose store is this? Refuse.
    assert M.sweep_media_orphans() == 0
    assert "ORPHAN SWEEP REFUSED" in capsys.readouterr().out
    assert media.read_owner("local") is None and orphan.exists()
    # Every prefix known: the marker is written, later sweeps run.
    import shutil
    shutil.rmtree(orphan.parent)
    assert M.sweep_media_orphans() == 0
    assert media.read_owner("local") == M._media_owner_id()
    _local_prefix("aaaaaaaaaaaa")
    assert M.sweep_media_orphans() == 1
    assert [(r["prefix"], r["store"]) for r in store.gc_all()] == [
        ("jobs/aaaaaaaaaaaa/", "local")]


def test_orphan_sweep_checks_ids_raw_rows_and_caps(sweep_on, monkeypatch):
    media.write_owner("local", M._media_owner_id())
    _local_prefix("notajobid")                  # not a job id: never
    unreadable = "cccccccccccc"
    _local_prefix(unreadable)
    _unreadable_row(unreadable)
    assert store.get(unreadable) is None and store.exists(unreadable)
    for jid in ("aaaaaaaaaaaa", "bbbbbbbbbbbb", "dddddddddddd"):
        _local_prefix(jid)
    monkeypatch.setenv("CLEO_MEDIA_ORPHAN_MAX", "2")
    assert M.sweep_media_orphans() == 2
    queued = {r["prefix"] for r in store.gc_all()}
    assert len(queued) == 2 and queued < {
        "jobs/aaaaaaaaaaaa/", "jobs/bbbbbbbbbbbb/", "jobs/dddddddddddd/"}
    _drop_row(unreadable)


def _unreadable_row(job_id: str) -> None:
    """A row the store can't parse (get() → None) — it still owns its
    media."""
    if hasattr(store, "_conn"):
        with store._lock:
            store._conn.execute("INSERT INTO jobs (id, data) VALUES (?, ?)",
                                (job_id, "{not json"))
            store._conn.commit()
    else:
        with store._db.connection() as conn:
            conn.execute("INSERT INTO jobs (id, status, data) VALUES "
                         "(%s, 'done', '\"not an object\"'::jsonb)",
                         (job_id,))


def _drop_row(job_id: str) -> None:
    if hasattr(store, "_conn"):
        with store._lock:
            store._conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
            store._conn.commit()
    else:
        with store._db.connection() as conn:
            conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


def test_orphan_sweep_refuses_a_cloned_or_restored_database(sweep_on,
                                                            monkeypatch,
                                                            capsys):
    """meta (media_owner_id) comes along in a clone, a dump or a
    restore: the id is bound to the database it was made in, so a copy
    elsewhere refuses although jobs/.owner matches — until re-armed."""
    from backend import accounts
    media.write_owner("local", M._media_owner_id())   # prod claimed it
    real = accounts.db_identity()
    # The clone: same meta, another database (or Railway environment).
    monkeypatch.setattr(accounts, "db_identity", lambda: real + "-clone")
    orphan = _local_prefix("aaaaaaaaaaaa")          # prod's newer job
    assert media.read_owner("local") == M._media_owner_id()
    assert M.sweep_media_orphans() == 0
    assert "ORPHAN SWEEP REFUSED" in capsys.readouterr().out
    assert store.gc_all() == [] and orphan.exists()
    monkeypatch.setattr(accounts, "db_identity", lambda: real)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_ID", "env-staging")
    assert M.sweep_media_orphans() == 0 and orphan.exists()
    # A restored dump: the id without its binding (pg_backup leaves
    # media_owner_fp out) refuses too.
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID")
    accounts._tx(lambda c: c.execute("DELETE FROM meta WHERE key = ?",
                                     ("media_owner_fp",)))
    assert M.sweep_media_orphans() == 0 and orphan.exists()
    assert store.gc_all() == []
    # The operator re-arms this database explicitly (a wrong value
    # doesn't).
    monkeypatch.setenv("CLEO_MEDIA_OWNER_REARM", "nope")
    assert M.sweep_media_orphans() == 0
    monkeypatch.setenv("CLEO_MEDIA_OWNER_REARM", M._owner_fingerprint())
    assert M.sweep_media_orphans() == 1
    monkeypatch.delenv("CLEO_MEDIA_OWNER_REARM")
    assert accounts.meta_get("media_owner_fp") == M._owner_fingerprint()


def test_db_identity_changes_with_a_copy(tmp_path):
    """A copied SQLite file (a clone, a backup put in its place) is
    another database; the live one keeps its identity."""
    import shutil
    from backend import accounts
    a = tmp_path / "a" / "jobs.db"
    a.parent.mkdir()
    a.write_bytes(b"x")
    b = tmp_path / "b" / "jobs.db"
    b.parent.mkdir()
    shutil.copy(a, b)
    assert accounts.sqlite_identity(str(a)) == accounts.sqlite_identity(
        str(a))
    assert accounts.sqlite_identity(str(a)) != accounts.sqlite_identity(
        str(b))
    before = accounts.sqlite_identity(str(a))
    shutil.copy(b, tmp_path / "a" / "new.db")
    os.replace(tmp_path / "a" / "new.db", a)  # a backup moved in place
    assert accounts.sqlite_identity(str(a)) != before
    ident = accounts.db_identity()
    assert ident == accounts.db_identity()
    assert ident.startswith(("sqlite:", "pg:"))
    if ident.startswith("pg:"):
        assert not ident.startswith("pg:?:")  # system_identifier readable


def test_orphan_sweep_is_off_by_default(no_r2, monkeypatch):
    monkeypatch.delenv("CLEO_MEDIA_ORPHAN_SWEEP", raising=False)
    orphan = _local_prefix("aaaaaaaaaaaa")
    media.write_owner("local", M._media_owner_id())
    M._hourly()
    assert store.gc_all() == [] and orphan.exists()


# ── renders ──────────────────────────────────────────────────────────


class NotFoundError(Exception):
    """Same class name as modal.exception.NotFoundError."""


def test_missing_render_r2_falls_back_to_the_volume_path(client, r2,
                                                         monkeypatch):
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    monkeypatch.setenv("CLEO_MODAL_RENDER_FN", "render_r2")
    monkeypatch.setenv("CLEO_MODAL_RETRY_DELAYS", "0")
    names = []

    class _Fn:
        def spawn(self, **kw):
            raise NotFoundError("Function 'render_r2' not found")

    class _Function:
        @staticmethod
        def from_name(app, name):
            names.append(name)
            return _Fn()
    monkeypatch.setitem(sys.modules, "modal",
                        types.SimpleNamespace(Function=_Function))
    seen: dict = {}
    monkeypatch.setattr(pipeline, "render_only", _fake_render_only(seen))
    job = store.create(None, {})
    mezz = f"jobs/{job.id}/mezz.mp4"
    storage.put_file(str(Path(__file__)), mezz, content_type="video/mp4")
    store.update(job.id, status="awaiting_review", mezz_key=mezz,
                 media_store="r2", segments=[(0.0, 1.0)], duration=1.0)
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": SUBS}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    assert names == ["render_r2"]
    assert seen["use_modal"] is True          # render_burn_concat
    got = store.get(job.id)
    assert storage.head(got.output_keys["primary"]) == 8


def test_deadline_has_a_term_for_the_mezz(monkeypatch):
    for k in ("CLEO_MODAL_DEADLINE_S_BASE", "CLEO_MODAL_DEADLINE_S_PER_S",
              "CLEO_MODAL_DEADLINE_S_PER_GB", "CLEO_MODAL_DEADLINE_S_MAX"):
        monkeypatch.delenv(k, raising=False)
    segs = [(0.0, 60.0)]
    assert pipeline._modal_deadline_s(segs) == 240 + 360
    assert pipeline._modal_deadline_s(segs, 5_000_000_000) == 240 + 360 + 300
    assert pipeline._modal_deadline_s(segs, 10**12) == 3720   # the cap


def test_preview_rebuilds_prefer_the_legacy_local_proxy(tmp_path):
    d = tmp_path / "legacy"
    d.mkdir()
    (d / "normalized.mp4").write_bytes(b"N")
    (d / pipeline.PROXY_NAME).write_bytes(b"P")
    job = store.create(None, {})
    # After the lazy mezz backfill of its first render (no proxy_key).
    store.update(job.id, normalized_path=str(d / "normalized.mp4"),
                 mezz_key=f"jobs/{job.id}/mezz.mp4", media_store="local")
    assert M._job_preview_source(store.get(job.id)) == str(
        d / pipeline.PROXY_NAME)
    store.update(job.id, proxy_key=f"jobs/{job.id}/proxy.mp4")
    assert M._job_preview_source(store.get(job.id)) is None


# ── backups, setup check, Modal deploy ───────────────────────────────


def test_backups_go_to_their_own_bucket(r2, monkeypatch, tmp_path):
    r2.create_bucket(Bucket="cleo-test-backups")
    monkeypatch.setenv("R2_BACKUP_BUCKET", "cleo-test-backups")
    f = tmp_path / "d.sql.gz"
    f.write_bytes(b"dump")
    storage.backup_put(str(f), "backups/pg/2026-09-29.sql.gz")
    assert storage.head("backups/pg/2026-09-29.sql.gz") is None
    assert [o["key"] for o in storage.backup_list("backups/pg/")] == [
        "backups/pg/2026-09-29.sql.gz"]
    storage.backup_get("backups/pg/2026-09-29.sql.gz", str(tmp_path / "b"))
    assert (tmp_path / "b").read_bytes() == b"dump"
    storage.backup_delete("backups/pg/2026-09-29.sql.gz")
    assert storage.backup_list("backups/pg/") == []


def test_r2_setup_lifecycle_check():
    from backend import r2_setup
    assert r2_setup.lifecycle_problems(
        r2_setup.lifecycle_config()["Rules"]) == []
    assert len(r2_setup.lifecycle_problems([])) == 2
    only_jobs = [r for r in r2_setup.lifecycle_config()["Rules"]
                 if r["Filter"]["Prefix"] == "jobs/"]
    assert len(r2_setup.lifecycle_problems(only_jobs)) == 2
    off = [dict(r, Status="Disabled")
           for r in r2_setup.lifecycle_config()["Rules"]]
    assert len(r2_setup.lifecycle_problems(off)) == 2
    assert r2_setup.BIG_BYTES > 64 * 1024 * 1024     # the multipart path


def test_r2_job_without_r2_config_is_503_not_local(client, no_r2):
    """A typo'd / partial R2_* config must not make an R2 job's routes
    look on the local disk."""
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", media_store="r2",
                 mezz_key=f"jobs/{job.id}/mezz.mp4",
                 preview_key=f"jobs/{job.id}/preview/v1.mp4")
    r = client.get(f"/jobs/{job.id}/preview-video")
    assert (r.status_code, r.json()) == (
        503, {"detail": "storage_unavailable"})
