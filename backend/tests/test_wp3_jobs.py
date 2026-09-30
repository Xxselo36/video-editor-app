"""WP3: POST /jobs answers without downloading (HEAD + header-only
duration probe over a presigned URL), the analysis worker (workspace,
fetch, store mezz / proxy / preview, one commit, source deleted after
it, failures → media_gc + refund policy), and the media routes (307 to a
presigned R2 GET after the ownership check; FileResponse with Range for
local media; legacy local jobs still served)."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import pytest

import backend.main as M
from backend import accounts, auth, pipeline, storage
from backend.jobs import store
from conftest import R2_ENDPOINT, add_sub, analysis_result

KEY = "uploads/user_a/0123456789abcdef0123456789abcdef.mp4"


@pytest.fixture(autouse=True)
def job_state(monkeypatch):
    for k in ("CLEO_MAX_UPLOAD_GB", "CLEO_MAX_MINUTES", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER"):
        monkeypatch.delenv(k, raising=False)
    # The editor proxy route is opt-in (CLEO_PROXY_VIDEO=1).
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()
    yield
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()


def _moto_key(bucket: str, key: str):
    from moto.s3.models import s3_backends
    for parts in s3_backends.values():
        for be in parts.values():
            if bucket in be.buckets and key in be.buckets[bucket].keys:
                return be.buckets[bucket].keys[key]
    raise KeyError(key)


@pytest.fixture
def upload(r2, monkeypatch):
    """The caller's finished upload in R2 (moto); POST /jobs must never
    download it (get_file fails the test)."""
    r2.put_object(Bucket=storage.bucket(), Key=KEY, Body=b"v" * 10)

    def no_download(*a, **k):
        raise AssertionError("POST /jobs downloaded the upload")
    monkeypatch.setattr(storage, "get_file", no_download)
    probes = []

    def probe(url):
        probes.append((url, threading.current_thread().name))
        return probe.seconds, None
    probe.seconds = 60.0
    probe.calls = probes
    monkeypatch.setattr(M, "_probe_remote", probe)
    return probe


def _post(client, headers=None, key=KEY, **form):
    return client.post("/jobs", headers=headers or {},
                       data={"settings": "{}", "storage_key": key, **form})


# ── POST /jobs ───────────────────────────────────────────────────────


def test_post_jobs_answers_fast_for_a_1gb_upload_without_download(
        client, auth_on, bearer, upload, clean_state):
    _moto_key(storage.bucket(), KEY).contentsize = 1_000_000_000
    assert storage.head(KEY) == 1_000_000_000
    t0 = time.monotonic()
    r = _post(client, bearer())
    took = time.monotonic() - t0
    assert r.status_code == 200, r.text
    assert took < 1.0
    job = store.get(r.json()["job_id"])
    assert job.source_key == KEY and job.input_path is None
    assert job.status == "pending" and clean_state == [job.id]
    # The probe: ffprobe over a day-aligned presigned GET of the key, in
    # its own pool (never the default threadpool).
    [(url, thread)] = upload.calls
    assert thread.startswith("probe")
    assert urlsplit(url).netloc == urlsplit(R2_ENDPOINT).netloc
    assert unquote(urlsplit(url).path).endswith(KEY)
    assert parse_qs(urlsplit(url).query)["X-Amz-Date"][0].endswith("T000000Z")


def test_probed_duration_is_charged(client, enforce, bearer, upload):
    add_sub(plan="pro", period_start=time.time() - 60)
    upload.seconds = 125.3
    r = _post(client, bearer(), duration="10")   # the probe wins
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    assert accounts.get_usage(job.id)["seconds_billed"] == 126
    assert job.settings["_max_seconds"] == 126 + accounts.TRUE_UP_TOLERANCE_S


def test_client_duration_when_the_header_has_none(client, enforce, bearer,
                                                  upload):
    """Streamed WebM: no duration in the header — the browser's reading
    is charged (the analysis never processes more than that)."""
    add_sub(plan="pro", period_start=time.time() - 60)
    upload.seconds = None
    r = _post(client, bearer(), duration="42.4")
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    assert accounts.get_usage(job.id)["seconds_billed"] == 43
    assert job.settings["_max_seconds"] == 43 + accounts.TRUE_UP_TOLERANCE_S


def test_no_duration_at_all(client, enforce, bearer, upload):
    """Neither the header nor the browser knows the length (streamed
    WebM): accepted uncharged — the analysis worker measures and charges
    it (test_wp3_hardening.py)."""
    add_sub(plan="pro", period_start=time.time() - 60)
    upload.seconds = None
    r = _post(client, bearer())
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    assert accounts.get_usage(job.id) is None
    assert job.settings == {"_measure_length": True, "_charge": "enforce",
                            "_max_seconds": 30 * 60 + 1}
    assert storage.head(KEY) == 10          # kept for the worker


def test_no_duration_without_billing_is_accepted(client, upload, r2):
    key = "uploads/0123456789abcdef0123456789abcdef.webm"
    r2.put_object(Bucket=storage.bucket(), Key=key, Body=b"w")
    upload.seconds = None
    r = _post(client, key=key)
    assert r.status_code == 200 and store.get(r.json()["job_id"]).source_key == key


def test_upload_incomplete_and_too_long(client, auth_on, bearer, upload,
                                        monkeypatch):
    r = _post(client, bearer(), key="uploads/user_a/missing.mp4")
    assert (r.status_code, r.json()) == (409, {"detail": "upload_incomplete"})
    assert store.list_all() == []
    upload.seconds = 31 * 60
    r = _post(client, bearer())
    assert (r.status_code, r.json()) == (
        413, {"detail": "video_too_long", "max_minutes": 30})
    assert storage.head(KEY) is None           # deleted: retrying can't help


def test_over_the_cap_is_deleted(client, auth_on, bearer, upload,
                                 monkeypatch):
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", str(5 / 1e9))
    r = _post(client, bearer())
    assert r.status_code == 413 and r.json()["detail"] == "file_too_large"
    assert storage.head(KEY) is None and not upload.calls


def test_same_key_is_idempotent(client, auth_on, bearer, upload,
                                clean_state):
    r1 = _post(client, bearer())
    r2_ = _post(client, bearer())
    assert r1.status_code == r2_.status_code == 200
    assert r1.json()["job_id"] == r2_.json()["job_id"]
    assert len(upload.calls) == 1 and len(clean_state) == 1
    assert _post(client, bearer("user_b")).status_code == 403


def test_storage_down_is_a_retryable_503(client, auth_on, bearer, upload,
                                         monkeypatch):
    def boom(key, **kw):
        raise ConnectionError("R2 unreachable")
    monkeypatch.setattr(M.media, "size", boom)
    r = _post(client, bearer())
    assert (r.status_code, r.json()) == (503, {"detail": "storage_unavailable"})
    assert r.headers["retry-after"] == "10"


# ── the analysis worker ──────────────────────────────────────────────


def _uploaded_job(r2, key=KEY, **fields):
    r2.put_object(Bucket=storage.bucket(), Key=key, Body=b"source-bytes")
    job = store.create(None, {}, source_key=key, owner_id="user_a", **fields)
    return job


def test_worker_stores_keys_and_commits_once(r2, monkeypatch):
    job = _uploaded_job(r2)
    seen = {}

    def analyze(input_path, output_dir, settings, progress_cb,
                on_normalized=None):
        seen["input"] = input_path
        seen["read"] = Path(input_path).read_bytes()
        assert Path(output_dir) == M._workspace(job.id)
        res = analysis_result(output_dir, 12.0)
        on_normalized()
        seen["local_copy_gone"] = not Path(input_path).exists()
        seen["object_kept"] = storage.head(KEY) == 12   # WP4 may retry
        return res
    monkeypatch.setattr(M, "analyze_only", analyze)
    writes = []
    impl_update = store.update

    def update(job_id, **kw):
        writes.append(kw)
        return impl_update(job_id, **kw)
    monkeypatch.setattr(store, "update", update)
    impl_update_if = store.update_if

    def update_if(job_id, expect, **kw):
        writes.append({**kw, "_expect": expect})
        return impl_update_if(job_id, expect, **kw)
    monkeypatch.setattr(store, "update_if", update_if)
    deleted_at = []
    real_delete = M.media.delete

    def delete(key, **kw):
        deleted_at.append((key, store.get(job.id).status))
        real_delete(key, **kw)
    monkeypatch.setattr(M.media, "delete", delete)

    M._run_analyze_inner(job.id)
    assert seen["read"] == b"source-bytes"
    assert Path(seen["input"]).parent == M._workspace(job.id)
    assert seen["local_copy_gone"] and seen["object_kept"]
    got = store.get(job.id)
    p = f"jobs/{job.id}/"
    assert (got.status, got.mezz_key, got.proxy_key, got.preview_key) == (
        "awaiting_review", p + "mezz.mp4", p + "proxy.mp4",
        p + "preview/v1.mp4")
    assert got.media_bytes == {p + "mezz.mp4": 4, p + "proxy.mp4": 5,
                               p + "preview/v1.mp4": 4}
    assert got.normalized_path is None and got.preview_path is None
    assert got.preview_version == 1 and got.duration == 12.0
    # One write sets the keys, media_bytes and the status together.
    [commit] = [w for w in writes if w.get("status") == "awaiting_review"]
    assert {"mezz_key", "proxy_key", "preview_key", "media_bytes"} <= set(commit)
    assert commit["_expect"] == "processing"     # only while still ours
    # The source object goes after that commit; the workspace is gone.
    assert deleted_at == [(KEY, "awaiting_review")]
    assert storage.head(KEY) is None
    assert not M._workspace(job.id).exists()
    head = r2.head_object(Bucket=storage.bucket(), Key=p + "mezz.mp4")
    assert head["ContentType"] == "video/mp4"
    assert head["CacheControl"] == "private, max-age=31536000, immutable"
    d = got.to_dict()
    assert d["has_proxy"] is True and d["has_output"] is False
    assert "mezz" not in str(d)          # keys are never exposed


@pytest.mark.parametrize("exc,refunded", [
    (OSError(28, "No space left on device"), True),
    # No speech at all: refunded since UX3 (less than 10 s of speech).
    (RuntimeError("No speech detected in the video."), True),
    (pipeline.NoSpeechError(speech_seconds=30.0), False),
])
def test_worker_failure_queues_media_for_gc(r2, auth_on, monkeypatch, exc,
                                            refunded):
    job = _uploaded_job(r2)
    accounts.charge(job.id, "user_a", 30, enforce=False)

    def analyze(input_path, output_dir, **kw):
        Path(output_dir, "normalized.mp4").write_bytes(b"n")
        raise exc
    monkeypatch.setattr(M, "analyze_only", analyze)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 30.0)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "error"
    assert bool(accounts.get_usage(job.id)["refunded"]) == refunded
    assert {r["prefix"] for r in store.gc_all()} == {f"jobs/{job.id}/", KEY}
    assert not M._workspace(job.id).exists()
    assert M.run_media_gc() == 2
    assert storage.head(KEY) is None and store.gc_all() == []


def test_storing_the_results_failing_is_our_fault(r2, auth_on, monkeypatch):
    job = _uploaded_job(r2)
    accounts.charge(job.id, "user_a", 30, enforce=False)
    monkeypatch.setattr(M, "analyze_only",
                        lambda output_dir, **kw: analysis_result(output_dir))

    def put_file(*a, **k):
        raise ConnectionError("R2 went away")
    monkeypatch.setattr(M.media, "put_file", put_file)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "error" and "R2 went away" in got.error
    assert accounts.get_usage(job.id)["refunded"]
    assert not M._workspace(job.id).exists()


def test_fetching_the_upload_failing_is_our_fault(r2, auth_on, monkeypatch):
    job = store.create(None, {}, source_key="uploads/user_a/gone.mp4",
                       owner_id="user_a")
    accounts.charge(job.id, "user_a", 30, enforce=False)
    monkeypatch.setattr(M, "analyze_only", lambda **kw: pytest.fail("ran"))
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "error" and "fetching the upload" in got.error
    assert accounts.get_usage(job.id)["refunded"]


def test_legacy_body_upload_goes_to_the_media_store(client, r2, monkeypatch,
                                                   clean_state):
    """≤ 100 MB through POST /jobs itself: with media in R2 it is stored
    as jobs/{id}/source{ext} and nothing stays on this box."""
    monkeypatch.setattr(M, "_probe_duration", lambda p: 5.0)
    r = client.post("/jobs", data={"settings": "{}"},
                    files={"file": ("Talk.MOV", b"x" * 64, "video/quicktime")})
    assert r.status_code == 200, r.text
    job = store.get(r.json()["job_id"])
    assert job.source_key == f"jobs/{job.id}/source.mov"
    assert job.input_path is None and storage.head(job.source_key) == 64
    assert list((M._TMP_ROOT / "uploads").glob("*")) == []
    assert list((M._WORK_ROOT / "uploads").glob("*")) == []


# ── media routes ─────────────────────────────────────────────────────


def _keyed_job(r2, owner="user_a", put=True):
    job = store.create(None, {}, owner_id=owner)
    p = f"jobs/{job.id}/"
    keys = {"proxy": p + "proxy.mp4", "preview": p + "preview/v3.mp4",
            "primary": p + "r2/primary.mp4", "square": p + "r2/1x1.mp4",
            "hook": p + "r2/hook_1.mp4", "thumb": p + "r2/thumb.jpg"}
    if put:
        for name, key in keys.items():
            r2.put_object(Bucket=storage.bucket(), Key=key,
                          Body=name.encode() * 10)
    store.update(job.id, status="done", mezz_key=p + "mezz.mp4",
                 proxy_key=keys["proxy"], preview_key=keys["preview"],
                 preview_version=3, render_gen=2,
                 output_keys={"primary": keys["primary"],
                              "9:16": keys["primary"],
                              "1:1": keys["square"], "hook_1": keys["hook"]},
                 thumb_key=keys["thumb"],
                 hook_clips=[{"key": "hook_1", "title": "H", "reason": "r",
                              "start": 1.0, "end": 5.0}])
    return store.get(job.id), keys


def _target(r):
    loc = r.headers["location"]
    return urlsplit(loc), parse_qs(urlsplit(loc).query)


def test_media_routes_redirect_to_presigned_gets(client, r2, auth_on,
                                                 bearer):
    job, keys = _keyed_job(r2)
    token = auth.media_token("user_a")
    cases = [("proxy-video", {}, keys["proxy"]),
             ("preview-video", {"v": 3}, keys["preview"]),
             ("watch", {}, keys["primary"]),
             ("watch", {"format": "9:16"}, keys["primary"]),
             ("watch", {"format": "1:1"}, keys["square"]),
             ("download", {"format": "hook_1"}, keys["hook"]),
             ("thumbnail", {}, keys["thumb"])]
    for route, params, key in cases:
        r = client.get(f"/jobs/{job.id}/{route}", params={**params, "t": token},
                       follow_redirects=False)
        assert r.status_code == 307, (route, r.text)
        assert r.headers["cache-control"] == "private, max-age=3600"
        u, q = _target(r)
        assert f"{u.scheme}://{u.netloc}" == R2_ENDPOINT
        assert unquote(u.path) == f"/{storage.bucket()}/{key}"
        assert q["X-Amz-Date"][0].endswith("T000000Z")
        assert q["X-Amz-Expires"] == ["172800"]
    # Header auth too; the same URL all day on every call.
    a = client.get(f"/jobs/{job.id}/proxy-video", headers=bearer("user_a"),
                   follow_redirects=False).headers["location"]
    b = client.get(f"/jobs/{job.id}/proxy-video", params={"t": token},
                   follow_redirects=False).headers["location"]
    assert a == b
    # Types and the download disposition.
    _, q = _target(client.get(f"/jobs/{job.id}/thumbnail", params={"t": token},
                              follow_redirects=False))
    assert q["response-content-type"] == ["image/jpeg"]
    _, q = _target(client.get(f"/jobs/{job.id}/download",
                              params={"format": "9:16", "t": token},
                              follow_redirects=False))
    assert q["response-content-disposition"] == [
        f'attachment; filename="cleo_{job.id}_9-16.mp4"']
    _, q = _target(client.get(f"/jobs/{job.id}/watch", params={"t": token},
                              follow_redirects=False))
    assert "response-content-disposition" not in q
    # Other people's jobs are 404; no token 401; unknown format 409.
    other = auth.media_token("user_b")
    for route in ("proxy-video", "preview-video", "watch", "download",
                  "thumbnail"):
        r = client.get(f"/jobs/{job.id}/{route}", params={"t": other},
                       follow_redirects=False)
        assert r.status_code == 404, route
        assert client.get(f"/jobs/{job.id}/{route}",
                          follow_redirects=False).status_code == 401
    r = client.get(f"/jobs/{job.id}/watch", params={"format": "4:5", "t": token})
    assert r.status_code == 409


def test_job_flags_come_from_the_keys(client, r2):
    job, keys = _keyed_job(r2, owner=None, put=False)
    d = client.get(f"/jobs/{job.id}").json()
    assert d["has_output"] is True and d["has_proxy"] is True
    assert d["outputs"] == ["primary", "9:16", "1:1", "hook_1"]
    assert d["hook_clips"] == [{"key": "hook_1", "title": "H", "reason": "r",
                                "start": 1.0, "end": 5.0}]
    assert "jobs/" not in str(d)
    s = client.get("/jobs/status", params={"ids": job.id}).json()["jobs"][0]
    assert s["has_output"] is True
    bare = store.create(None, {})
    store.update(bare.id, status="awaiting_review", mezz_key="jobs/x/mezz.mp4")
    d = client.get(f"/jobs/{bare.id}").json()
    assert d["has_output"] is False and d["has_proxy"] is False
    r = client.get(f"/jobs/{bare.id}/proxy-video")
    assert (r.status_code, r.json()) == (404, {"detail": "proxy_not_ready"})
    assert client.get(f"/jobs/{bare.id}/preview-video").status_code == 409
    assert client.get(f"/jobs/{bare.id}/thumbnail").status_code == 409


@pytest.mark.local_media_only
def test_local_media_is_served_with_ranges(client, no_r2, tmp_path):
    job = store.create(None, {})
    p = f"jobs/{job.id}/"
    for name, body in (("proxy.mp4", b"0123456789"),
                       ("preview/v1.mp4", b"preview!"),
                       ("r1/primary.mp4", b"primary"),
                       ("r1/thumb.jpg", b"jpg")):
        src = tmp_path / name.replace("/", "_")
        src.write_bytes(body)
        M.media.put_file(src, p + name, content_type="video/mp4")
    store.update(job.id, status="done", proxy_key=p + "proxy.mp4",
                 preview_key=p + "preview/v1.mp4",
                 output_keys={"primary": p + "r1/primary.mp4"},
                 thumb_key=p + "r1/thumb.jpg")
    r = client.get(f"/jobs/{job.id}/proxy-video", headers={"Range": "bytes=2-5"})
    assert r.status_code == 206 and r.content == b"2345"
    assert r.headers["content-range"] == "bytes 2-5/10"
    assert r.headers["accept-ranges"] == "bytes"
    r = client.get(f"/jobs/{job.id}/preview-video")
    assert r.content == b"preview!" and r.headers["cache-control"] == "no-cache"
    r = client.get(f"/jobs/{job.id}/download")
    assert r.content == b"primary"
    assert r.headers["content-disposition"].startswith("attachment;")
    assert f"cleo_{job.id}_primary.mp4" in r.headers["content-disposition"]
    r = client.get(f"/jobs/{job.id}/thumbnail")
    assert r.content == b"jpg"
    assert r.headers["cache-control"] == "public, max-age=86400"


def test_legacy_local_jobs_are_still_served(client, r2, tmp_path):
    out = M._WORK_ROOT / "legacy-media"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("normalized.mp4", "proxy.mp4", "preview.mp4",
                 "cleo_output.mp4", "cleo_thumbnail.jpg"):
        (out / name).write_bytes(name.encode())
    job = store.create(None, {})
    store.update(job.id, status="done",
                 normalized_path=str(out / "normalized.mp4"),
                 preview_path=str(out / "preview.mp4"),
                 output_path=str(out / "cleo_output.mp4"),
                 outputs={"primary": str(out / "cleo_output.mp4")})
    assert client.get(f"/jobs/{job.id}").json()["has_proxy"] is True
    for route, body in (("proxy-video", b"proxy.mp4"),
                        ("preview-video", b"preview.mp4"),
                        ("watch", b"cleo_output.mp4"),
                        ("download", b"cleo_output.mp4"),
                        ("thumbnail", b"cleo_thumbnail.jpg")):
        r = client.get(f"/jobs/{job.id}/{route}", follow_redirects=False)
        assert (r.status_code, r.content) == (200, body), route
    r = client.get(f"/jobs/{job.id}/proxy-video", headers={"Range": "bytes=0-1"})
    assert r.status_code == 206 and r.content == b"pr"


# ── editor preview rebuilds (§9) ─────────────────────────────────────


def test_preview_rebuild_uses_the_proxy_cache_and_a_new_key(client, r2,
                                                          monkeypatch):
    job = store.create(None, {})
    p = f"jobs/{job.id}/"
    r2.put_object(Bucket=storage.bucket(), Key=p + "proxy.mp4", Body=b"PROXY")
    r2.put_object(Bucket=storage.bucket(), Key=p + "preview/v1.mp4",
                  Body=b"old")
    store.update(job.id, status="awaiting_review", mezz_key=p + "mezz.mp4",
                 proxy_key=p + "proxy.mp4", preview_key=p + "preview/v1.mp4",
                 preview_version=1, duration=10.0, segments=[(0.0, 10.0)],
                 media_bytes={p + "preview/v1.mp4": 3})
    fetched, cuts = [], []
    real_get = M.media.get_file
    monkeypatch.setattr(M.media, "get_file", lambda key, path, **kw: (
        fetched.append(key), real_get(key, path, **kw))[1])

    def cut(source, segments, output):
        cuts.append((Path(source).read_bytes(), [list(s) for s in segments]))
        Path(output).write_bytes(b"preview-" + str(len(cuts)).encode())
    monkeypatch.setattr(M.pipeline, "_ffmpeg_cuts_preview", cut)
    for n, segs in ((2, [[0, 3]]), (3, [[4, 8]])):
        r = client.post(f"/jobs/{job.id}/edit-segments",
                        json={"segments": [{"start": a, "end": b}
                                           for a, b in segs]})
        assert r.status_code == 200 and r.json()["preview_ok"] is True
        got = store.get(job.id)
        assert got.preview_key == f"{p}preview/v{n}.mp4"
        assert got.preview_version == n and got.preview_segments == segs
        assert storage.head(got.preview_key) == 9
    assert fetched == [p + "proxy.mp4"]      # cached after the first miss
    assert [c[0] for c in cuts] == [b"PROXY", b"PROXY"]
    assert (M._TMP_ROOT / "proxy-cache" / f"{job.id}.mp4").is_file()
    # Superseded versions go a day later (a player may stream them).
    rows = {r["prefix"]: r["not_before"] for r in store.gc_all()}
    assert set(rows) == {p + "preview/v1.mp4", p + "preview/v2.mp4"}
    assert all(abs(v - (time.time() + 86400)) < 60 for v in rows.values())
    assert p + "preview/v1.mp4" not in store.get(job.id).media_bytes
    assert not M._workspace(job.id).exists()


def test_proxy_cache_is_lru_bounded(r2, monkeypatch):
    monkeypatch.setenv("CLEO_PROXY_CACHE_GB", str(25 / 1e9))
    jobs = []
    for i in range(3):
        job = store.create(None, {})
        key = f"jobs/{job.id}/proxy.mp4"
        r2.put_object(Bucket=storage.bucket(), Key=key, Body=b"p" * 10)
        store.update(job.id, proxy_key=key)
        jobs.append(store.get(job.id))
        M._cached_proxy(jobs[-1])
        time.sleep(0.01)
    cache = M._TMP_ROOT / "proxy-cache"
    assert sorted(p.name for p in cache.glob("*.mp4")) == sorted(
        f"{j.id}.mp4" for j in jobs[1:])
