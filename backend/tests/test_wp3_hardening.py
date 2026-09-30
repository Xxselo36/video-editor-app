"""WP3 review follow-ups: the length cap and the charge of uploads whose
length nobody knows at POST /jobs (measured in the analysis worker), the
per-caller limit on multipart inits, the analysis commit that only lands
while the job is still processing, the backfill's commit against the
job as it is now (and --delete-local only with verified copies),
remembered proxy failures, account deletion through the media GC and
the runtime check of the uploads/ lifecycle rules.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

import backend.main as M
from backend import accounts, media, pipeline, r2_backfill, storage
from backend.jobs import store
from conftest import add_sub, analysis_result
from test_wp3_render import _legacy_job

KEY = "uploads/user_a/0123456789abcdef0123456789abcdef.webm"
ANON_KEY = "uploads/0123456789abcdef0123456789abcdef.webm"
_REAL_GET_FILE = storage.get_file


@pytest.fixture(autouse=True)
def hardening_state(monkeypatch):
    for k in ("CLEO_MAX_UPLOAD_GB", "CLEO_MAX_MINUTES", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_UPLOAD_INITS_PER_HOUR"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    monkeypatch.setattr(pipeline, "detect_hooks", lambda *a, **k: [])
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()
    r2_backfill._proxy_failed_here.clear()
    yield
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()


# ── length cap + charge when the length is unknown at POST /jobs ──────


@pytest.fixture
def headerless(r2, monkeypatch):
    """A finished browser upload whose container header has no duration
    (streamed WebM); the worker's packet scan says `measured.seconds`."""
    for key in (KEY, ANON_KEY):
        r2.put_object(Bucket=storage.bucket(), Key=key, Body=b"w" * 64)
    monkeypatch.setattr(M, "_probe_remote", lambda url: (None, None))
    measured = type("Measured", (), {"seconds": 60.0, "calls": []})()

    def probe(path):
        measured.calls.append(path)
        return measured.seconds
    monkeypatch.setattr(M, "_probe_duration", probe)
    analysed = []

    def analyze(input_path, output_dir, settings, **kw):
        analysed.append(dict(settings))
        return analysis_result(output_dir, measured.seconds or 1.0)
    monkeypatch.setattr(M, "analyze_only", analyze)
    measured.analysed = analysed
    return measured


def _post(client, headers=None, key=KEY):
    return client.post("/jobs", headers=headers or {},
                       data={"settings": "{}", "storage_key": key})


def _refused(job_id, code):
    got = store.get(job_id)
    assert got.status == "error" and code in got.error, got.error
    assert got.input_path is None
    assert not M._workspace(job_id).exists()
    return got


def test_headerless_upload_is_capped_without_billing(client, headerless):
    """Auth / billing off (the repro): the job is accepted, the worker
    measures its copy before transcribing and refuses 45 minutes."""
    r = _post(client, key=ANON_KEY)
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    assert job.settings == {"_measure_length": True,
                            "_max_seconds": 30 * 60 + 1}
    headerless.seconds = 45 * 60
    M._run_analyze_inner(job.id)
    got = _refused(job.id, "video_too_long")
    assert '"max_minutes":30' in got.error        # the web app words it
    assert headerless.analysed == []              # nothing transcribed
    assert storage.head(ANON_KEY) is None         # the upload went
    assert len(headerless.calls) == 1


def test_headerless_upload_within_the_cap_is_analysed_capped(client,
                                                             headerless):
    r = _post(client, key=ANON_KEY)
    job_id = r.json()["job_id"]
    headerless.seconds = 12.0
    M._run_analyze_inner(job_id)
    got = store.get(job_id)
    assert got.status == "awaiting_review"
    assert headerless.analysed == [{"_max_seconds": 30 * 60 + 1}]
    assert got.settings == {"_max_seconds": 30 * 60 + 1}   # flags gone


def test_every_analysis_is_capped_even_an_old_job(headerless, r2):
    """A job accepted before the cap existed (no _max_seconds) still
    stops at CLEO_MAX_MINUTES; a lower charged cap stays."""
    job = store.create(None, {"style": "tight"}, source_key=ANON_KEY)
    M._run_analyze_inner(job.id)
    assert headerless.analysed[-1] == {"style": "tight",
                                       "_max_seconds": 30 * 60 + 1}
    r2.put_object(Bucket=storage.bucket(), Key=ANON_KEY, Body=b"w")
    job = store.create(None, {"_max_seconds": 65}, source_key=ANON_KEY)
    M._run_analyze_inner(job.id)
    assert headerless.analysed[-1] == {"_max_seconds": 65}
    assert headerless.calls == []                 # known length: no scan


def test_headerless_upload_is_charged_in_the_worker(client, enforce, bearer,
                                                    headerless):
    add_sub(plan="starter", period_start=time.time() - 60)
    r = _post(client, bearer())
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    assert accounts.get_usage(job_id) is None      # not at POST /jobs
    headerless.seconds = 61.2
    M._run_analyze_inner(job_id)
    got = store.get(job_id)
    assert got.status == "awaiting_review", got.error
    assert accounts.get_usage(job_id)["seconds_billed"] == 62
    assert got.plan == "starter"
    cap = 62 + accounts.TRUE_UP_TOLERANCE_S
    assert headerless.analysed == [{"_max_seconds": cap}]


def test_headerless_upload_over_the_quota_is_refused_cleanly(
        client, enforce, bearer, headerless):
    add_sub(plan="starter", period_start=time.time() - 60)
    left = accounts.limit_seconds("starter") - 30
    accounts.charge("otherjob", "user_a", left, enforce=False)
    r = _post(client, bearer())
    job_id = r.json()["job_id"]
    headerless.seconds = 60.0
    M._run_analyze_inner(job_id)
    got = _refused(job_id, "quota_exceeded")
    assert '"remaining_seconds":30' in got.error
    assert accounts.get_usage(job_id) is None      # nothing charged
    assert headerless.analysed == []
    assert storage.head(KEY) is None


def test_headerless_too_long_with_billing_charges_nothing(
        client, enforce, bearer, headerless):
    add_sub(plan="pro", period_start=time.time() - 60)
    job_id = _post(client, bearer()).json()["job_id"]
    headerless.seconds = 31 * 60
    M._run_analyze_inner(job_id)
    _refused(job_id, "video_too_long")
    assert accounts.get_usage(job_id) is None
    assert storage.head(KEY) is None


def test_headerless_unreadable_when_enforced(client, enforce, bearer,
                                             headerless):
    add_sub(plan="pro", period_start=time.time() - 60)
    job_id = _post(client, bearer()).json()["job_id"]
    headerless.seconds = None
    M._run_analyze_inner(job_id)
    _refused(job_id, "unreadable_video")
    assert accounts.get_usage(job_id) is None and headerless.analysed == []
    assert storage.head(KEY) is None


def test_headerless_not_enforced_is_recorded_and_capped(
        client, billing_on, bearer, headerless):
    """Billing on, not enforced: recorded (the true-up fixes the length),
    never refused, capped at CLEO_MAX_MINUTES only."""
    job_id = _post(client, bearer()).json()["job_id"]
    assert store.get(job_id).settings["_charge"] == "record"
    headerless.seconds = None
    M._run_analyze_inner(job_id)
    got = store.get(job_id)
    assert got.status == "awaiting_review"
    assert headerless.analysed == [{"_max_seconds": 30 * 60 + 1}]
    # charged 0 in the worker, trued up to the analysed length (1 s)
    assert accounts.get_usage(job_id)["seconds_actual"] == 1.0


# ── multipart init: per-caller limit ─────────────────────────────────


def _init(client, headers=None):
    return client.post("/uploads/multipart/init", headers=headers or {},
                       json={"filename": "a.mp4", "content_type": "video/mp4",
                             "size": 1000})


def test_multipart_inits_are_rate_limited_per_caller(client, r2, auth_on,
                                                      bearer, monkeypatch):
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    monkeypatch.setenv("CLEO_UPLOAD_INITS_PER_HOUR", "3")
    for _ in range(3):
        assert _init(client, bearer()).status_code == 200
    r = _init(client, bearer())
    assert (r.status_code, r.json()) == (429, {"detail": "too_many_uploads"})
    assert r.headers["Retry-After"] == "600"
    # No upload was opened for the refused call.
    open_ = r2.list_multipart_uploads(Bucket=storage.bucket()).get("Uploads")
    assert len(open_ or []) == 3
    # Another user isn't affected; 0 turns the limit off.
    assert _init(client, bearer("user_b")).status_code == 200
    monkeypatch.setenv("CLEO_UPLOAD_INITS_PER_HOUR", "0")
    assert _init(client, bearer()).status_code == 200


def test_multipart_init_limit_without_auth_is_per_address(client, r2,
                                                          monkeypatch):
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    monkeypatch.setenv("CLEO_UPLOAD_INITS_PER_HOUR", "2")
    assert [_init(client).status_code for _ in range(3)] == [200, 200, 429]


# ── the analysis commit: only while the job is still processing ──────


def _uploaded(r2, **fields):
    r2.put_object(Bucket=storage.bucket(), Key=ANON_KEY, Body=b"src")
    return store.create(None, {"_max_seconds": 60}, source_key=ANON_KEY,
                        **fields)


def test_analysis_commit_doesnt_resurrect_a_settled_job(r2, monkeypatch):
    """Another process settled the job (error container_restart, its
    media queued for GC) while this worker analysed: the result isn't
    written, what it stored goes to the GC."""
    job = _uploaded(r2)

    def analyze(input_path, output_dir, **kw):
        store.update(job.id, status="error", error="container_restart")
        return analysis_result(output_dir)
    monkeypatch.setattr(M, "analyze_only", analyze)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert (got.status, got.error, got.mezz_key) == (
        "error", "container_restart", None)
    assert (f"jobs/{job.id}/", "r2") in {
        (r["prefix"], r["store"]) for r in store.gc_all()}
    assert M.run_media_gc() >= 1
    assert storage.list_r2(f"jobs/{job.id}/") == []


def test_analysis_commit_of_a_deleted_job_writes_nothing(r2, monkeypatch):
    job = _uploaded(r2)

    def analyze(input_path, output_dir, **kw):
        store.delete(job.id)
        return analysis_result(output_dir)
    monkeypatch.setattr(M, "analyze_only", analyze)
    M._run_analyze_inner(job.id)
    assert store.get(job.id) is None
    assert f"jobs/{job.id}/" in {r["prefix"] for r in store.gc_all()}


def test_analysis_commit_that_landed_before_a_retry_counts(r2, monkeypatch):
    """The write landed but its answer was lost: the retry's update_if
    finds 'awaiting_review' — the worker sees its own commit and goes on
    (source consumed, nothing GC'd)."""
    job = _uploaded(r2)
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir,
                        **kw: analysis_result(output_dir))
    real = store.update_if
    calls = []

    def update_if(job_id, expect, **kw):
        calls.append(kw.get("status"))
        ok = real(job_id, expect, **kw)
        if kw.get("status") == "awaiting_review" and len(calls) == 2:
            return False              # "lost answer": applied, says no
        return ok
    monkeypatch.setattr(store, "update_if", update_if)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "awaiting_review" and got.mezz_key
    assert storage.head(got.mezz_key) == 4
    assert store.gc_all() == [] or all(
        not r["prefix"].startswith(f"jobs/{job.id}/") for r in store.gc_all())
    assert storage.head(ANON_KEY) is None


# ── backfill: commit against the job as it is now ────────────────────


def test_backfill_keeps_a_concurrent_edit(r2, tmp_path, monkeypatch):
    """M2: a user edit (new preview v5, updated_at now) lands while the
    backfill uploads: the edit wins — the backfill sets only keys that
    are still unset, merges media_bytes, keeps updated_at and queues its
    now useless preview v4 for deletion."""
    job, _ = _legacy_job(tmp_path, status="awaiting_review")
    p = f"jobs/{job.id}/"
    real = media.put_file
    edited_at = time.time()

    def put(path, key, **kw):
        size = real(path, key, **kw)
        if key == p + "mezz.mp4":     # the user edits meanwhile
            real(Path(path), p + "preview/v5.mp4", store="r2",
                 content_type="video/mp4")
            store.update(job.id, preview_version=5,
                         preview_key=p + "preview/v5.mp4",
                         media_store="r2",
                         media_bytes={p + "preview/v5.mp4": 100},
                         updated_at=edited_at)
        return size
    monkeypatch.setattr(media, "put_file", put)
    res = r2_backfill.backfill_job(store.get(job.id))
    assert res["status"] == "done", res
    assert "not committed, the job changed: v4.mp4" in res["detail"]
    got = store.get(job.id)
    assert (got.preview_key, got.preview_version) == (
        p + "preview/v5.mp4", 5)
    assert got.updated_at == edited_at            # not rolled back
    assert got.mezz_key == p + "mezz.mp4" and got.media_store == "r2"
    assert got.media_bytes[p + "preview/v5.mp4"] == 100
    assert p + "preview/v4.mp4" not in got.media_bytes
    [row] = [r for r in store.gc_all() if r["prefix"].startswith(p)]
    assert (row["prefix"], row["store"]) == (p + "preview/v4.mp4", "r2")
    assert row["not_before"] > time.time() + 23 * 3600
    # Retention runs on the user's clock, not the snapshot's.
    assert M.purge_expired_jobs(now=time.time() + 3600) == 0


def test_backfill_of_a_job_deleted_meanwhile_queues_its_copies(
        r2, tmp_path, monkeypatch):
    job, _ = _legacy_job(tmp_path)
    real = media.put_file
    p = f"jobs/{job.id}/"

    def put(path, key, **kw):
        size = real(path, key, **kw)
        if key == p + "mezz.mp4":
            store.delete(job.id)
        return size
    monkeypatch.setattr(media, "put_file", put)
    res = r2_backfill.backfill_job(store.get(job.id))
    assert res["status"] == "skipped" and store.get(job.id) is None
    assert (p, "r2") in {(r["prefix"], r["store"]) for r in store.gc_all()}


def test_delete_after_a_refused_backfill_commit_removes_its_copies(
        r2, tmp_path, monkeypatch, client):
    """A backfill whose commit is refused (the job changed meanwhile)
    leaves its R2 copies to the job's delete — which must look in R2
    although the job's own store is still local."""
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)  # local
    job, _ = _legacy_job(tmp_path)
    real = media.put_file
    p = f"jobs/{job.id}/"

    def put(path, key, **kw):
        size = real(path, key, **kw)
        store.update(job.id, status="awaiting_review")  # the user edits
        return size
    monkeypatch.setattr(media, "put_file", put)
    res = r2_backfill.backfill_job(store.get(job.id))
    monkeypatch.setattr(media, "put_file", real)
    assert res["status"] == "skipped" and storage.list_r2(p)
    assert media.store_of(store.get(job.id)) == "local"
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    M.run_media_gc(now=time.time() + 10)
    assert storage.list_r2(p) == []


def test_backfill_proxy_failure_is_reported_and_remembered(
        r2, tmp_path, monkeypatch):
    """Minor 5: a job whose only missing piece is a proxy that can't be
    made isn't "done", isn't tried again, and doesn't eat the batch."""
    job, jd = _legacy_job(tmp_path, proxy=False)
    monkeypatch.setenv("CLEO_BACKFILL_MAKE_PROXY", "0")
    r2_backfill.run(echo=lambda line: None)
    monkeypatch.delenv("CLEO_BACKFILL_MAKE_PROXY")
    # Everything but the proxy is in R2 now; making it fails.
    assert store.get(job.id).mezz_key and not store.get(job.id).proxy_key
    calls = []

    def make_proxy(src, dst):
        calls.append(src)
        return False
    monkeypatch.setattr(pipeline, "_make_proxy", make_proxy)
    others = [_legacy_job(tmp_path / f"o{i}")[0] for i in range(2)]
    for o in others:                     # newest first: after the job
        store.update(o.id, updated_at=1_600_000_000.0)
    lines = []
    first = r2_backfill.run(limit=1, echo=lines.append)
    assert calls == [str(jd / "normalized.mp4")]
    assert first["jobs"] == 0 and first["skipped"] == 1
    assert "proxy could not be made" in lines[0]
    assert store.get(job.id).proxy_key is None
    assert r2_backfill.proxy_failed(store.get(job.id))
    # Remembered in the database too (a restart doesn't retry it).
    r2_backfill._proxy_failed_here.clear()
    assert r2_backfill.proxy_failed(store.get(job.id))
    second = r2_backfill.run(limit=1, echo=lines.append)
    assert calls == [str(jd / "normalized.mp4")]   # not tried again
    assert second["jobs"] == 1                     # the batch moves on


def test_delete_local_needs_a_verified_copy_of_every_file(
        r2, tmp_path, monkeypatch):
    """Minor 1: after a lazy mezz backfill (mezz_key only) the local
    proxy / preview / outputs have no copy: nothing is deleted."""
    job, jd = _legacy_job(tmp_path)
    p = f"jobs/{job.id}/"
    media.put_file(jd / "normalized.mp4", p + "mezz.mp4", store="r2",
                   content_type="video/mp4")
    store.update(job.id, mezz_key=p + "mezz.mp4", media_store="r2",
                 media_bytes={p + "mezz.mp4": 100})
    res = r2_backfill.delete_local(store.get(job.id))
    assert res["status"] == "skipped" and "not fully backfilled" in res["detail"]
    assert all((jd / n).exists() for n in ("normalized.mp4", "proxy.mp4",
                                           "preview.mp4"))
    assert store.get(job.id).normalized_path is not None


def test_delete_local_commits_before_deleting_and_keeps_updated_at(
        r2, tmp_path, monkeypatch):
    job, jd = _legacy_job(tmp_path)
    r2_backfill.run(echo=lambda line: None)
    store.update(job.id, updated_at=1_750_000_000.0)   # the user, later
    snap = store.get(job.id)
    store.update(job.id, preview_path=str(jd / "preview-new.mp4"),
                 updated_at=1_750_000_000.0)
    res = r2_backfill.delete_local(snap)              # stale snapshot
    assert res["status"] == "skipped" and "changed" in res["detail"]
    assert (jd / "normalized.mp4").exists()
    store.update(job.id, preview_path=str(jd / "preview.mp4"),
                 updated_at=1_750_000_000.0)
    res = r2_backfill.delete_local(store.get(job.id))
    assert res["status"] == "done", res
    got = store.get(job.id)
    assert got.updated_at == 1_750_000_000.0
    assert got.normalized_path is None and not (jd / "normalized.mp4").exists()


# ── account deletion ─────────────────────────────────────────────────


def test_delete_user_media_goes_through_the_gc(r2, tmp_path, monkeypatch):
    """Minor 7: every job the way DELETE /jobs removes it (legacy files,
    the beta-era _r2_storage_key upload, the proxy cache), the user's
    uploads/ prefix — through media_gc, so an R2 error is retried."""
    b = storage.bucket()
    beta = "uploads/user_a/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4"
    r2.put_object(Bucket=b, Key=beta, Body=b"beta")
    stray = "uploads/user_a/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mov"
    r2.put_object(Bucket=b, Key=stray, Body=b"x")
    old = store.create(None, {"_r2_storage_key": beta}, owner_id="user_a")
    store.update(old.id, status="done")
    legacy_dir = M._WORK_ROOT / old.id
    legacy_dir.mkdir(parents=True, exist_ok=True)
    (legacy_dir / "normalized.mp4").write_bytes(b"n")
    new = store.create(None, {}, owner_id="user_a", media_store="r2")
    r2.put_object(Bucket=b, Key=f"jobs/{new.id}/mezz.mp4", Body=b"m")
    store.update(new.id, status="awaiting_review",
                 mezz_key=f"jobs/{new.id}/mezz.mp4")
    busy = store.create(None, {}, owner_id="user_a")
    store.update(busy.id, status="processing")
    other = store.create(None, {}, owner_id="user_b")
    real = storage.delete_prefix
    fail = {"n": 1}

    def flaky(prefix):
        if fail["n"]:
            fail["n"] -= 1
            raise RuntimeError("R2 down")
        return real(prefix)
    monkeypatch.setattr(storage, "delete_prefix", flaky)
    out = M.delete_user_media("user_a")
    # (the beta upload went with its job; the stray one by the prefix)
    assert out == {"jobs": 2, "uploads": 1, "running": 1}
    assert {j.id for j in store.list_all()} == {busy.id, other.id}
    assert not legacy_dir.exists()
    assert storage.head(beta) is None and storage.head(stray) is None
    # The failed delete stayed queued and goes on the next GC run.
    assert store.gc_all()
    assert M.run_media_gc(now=time.time() + 7200) >= 1
    assert storage.list_r2(f"jobs/{new.id}/") == []


# ── uploads/ lifecycle, checked at runtime ───────────────────────────


def test_uploads_lifecycle_is_checked_at_runtime(r2, monkeypatch, capsys):
    from backend import r2_setup
    monkeypatch.setattr(M, "_lifecycle_checked_at", float("-inf"))
    problems = M.check_uploads_lifecycle(now=1000.0)
    assert problems and "expires uploads/" in problems[0]
    assert "R2 LIFECYCLE MISSING" in capsys.readouterr().out
    assert M.check_uploads_lifecycle(now=2000.0) is None   # once a day
    r2.put_bucket_lifecycle_configuration(
        Bucket=storage.bucket(),
        LifecycleConfiguration=r2_setup.lifecycle_config())
    assert M.check_uploads_lifecycle(now=1000.0 + 86400) == []


def test_uploads_lifecycle_check_needs_r2(no_r2, monkeypatch):
    monkeypatch.setattr(M, "_lifecycle_checked_at", float("-inf"))
    assert M.check_uploads_lifecycle() is None


def test_backfill_failing_after_a_delete_queues_the_late_copies(
        r2, tmp_path, monkeypatch):
    """The job is deleted (and its GC runs) mid-upload: the verification
    fails, and the copies uploaded after the delete are queued anyway."""
    job, _ = _legacy_job(tmp_path)
    p = f"jobs/{job.id}/"
    real = media.put_file

    def put(path, key, **kw):
        size = real(path, key, **kw)
        if key == p + "mezz.mp4":
            M._delete_job(store.get(job.id))      # row + GC now
        return size
    monkeypatch.setattr(media, "put_file", put)
    res = r2_backfill.backfill_job(store.get(job.id))
    assert res["status"] == "failed"
    assert storage.list_r2(p)                      # late copies
    assert (p, "r2") in {(r["prefix"], r["store"]) for r in store.gc_all()}
    M.run_media_gc(now=time.time() + 25 * 3600)
    assert storage.list_r2(p) == []
