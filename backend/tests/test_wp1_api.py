"""WP1 API: admission control over HTTP (queue cap 503, per-user 429),
size/length caps (413), idempotent POST /jobs, the render
compare-and-set, body limits, the batch status endpoint, the settings
whitelist, /ready, and deleting the upload right after normalization."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import httpx
import pytest

import backend.main as M
from backend import accounts, auth
from backend.jobs import store
from conftest import add_sub, analysis_result

REAL_RUN_ANALYZE = M._run_analyze  # conftest stubs it per test


@pytest.fixture(autouse=True)
def wp1_state(monkeypatch):
    for k in ("CLEO_MAX_ANALYZE", "CLEO_MAX_RENDER", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_MAX_UPLOAD_GB",
              "CLEO_MAX_MINUTES", "CLEO_MAX_BODY_KB",
              "CLEO_MAX_FORM_UPLOAD_MB", "CLEO_DISK_FACTOR"):
        monkeypatch.delenv(k, raising=False)
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()
    yield
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()


@pytest.fixture
def fake_r2(monkeypatch, r2):
    """R2 configured (moto), uploads of state["size"] bytes (HEAD is
    faked: no multi-GB objects in memory), presign handing out a fixed
    key. POST /jobs never downloads; state["probes"] / "deleted" record
    the header probes and deleted upload objects, state["delay"] makes a
    probe slow."""
    import backend.storage as storage
    monkeypatch.setattr(storage, "presign_upload",
                        lambda filename, content_type, prefix: {
                            "storage_key": f"{prefix}abc.mp4"})
    state = {"size": 1000, "downloads": [], "deleted": [], "delay": 0.0,
             "probes": []}
    real_size, real_delete = M.media.size, M.media.delete

    def size(key, **kw):
        return (state["size"] if key.startswith("uploads/")
                else real_size(key, **kw))

    def delete(key, **kw):
        state["deleted"].append(key)
        real_delete(key, **kw)

    def get_file(key, path, **kw):
        state["downloads"].append(key)
        Path(path).write_bytes(b"v" * 16)
    monkeypatch.setattr(M.media, "size", size)
    monkeypatch.setattr(M.media, "delete", delete)
    monkeypatch.setattr(M.media, "get_file", get_file)
    return state


@pytest.fixture
def probe(monkeypatch):
    """Duration the probes report: of a legacy body (local file) and of
    an R2 upload (ffprobe over a presigned URL, header only)."""
    seconds = {"value": 60.0}
    monkeypatch.setattr(M, "_probe_duration", lambda p: seconds["value"])

    def remote(url):
        state = seconds.get("state")
        if state is not None:
            state["probes"].append(url)
            time.sleep(state["delay"])
        return seconds["value"], None, None
    monkeypatch.setattr(M, "_probe_remote", remote)
    return seconds


def _blocker():
    """A live worker-thread stand-in for _INFLIGHT entries."""
    ev = threading.Event()
    t = threading.Thread(target=ev.wait, daemon=True)
    t.start()
    return ev, t


def _wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _upload(client, headers=None, settings="{}", **form):
    return client.post("/jobs", headers=headers or {},
                       data={"settings": settings, **form},
                       files={"file": ("clip.mp4", b"x" * 64, "video/mp4")})


# ── settings whitelist ───────────────────────────────────────────────


def test_settings_whitelist(client, probe):
    settings = {
        "caption_preset": "clipper", "style": "tight",
        "voice_triggers": True, "remove_fillers": False,
        "smartcam_enabled": True, "smartcam_format": "portrait",
        "resolution": "1080", "output_formats": ["9:16", "9:16", "4:3", 5],
        "whisper_model": "large-v3", "segment_effects": [{"speed": 4}],
        "cut_keywords": ["x"], "_r2_storage_key": "uploads/other.mp4",
        "_max_seconds": 99999,
    }
    r = _upload(client, settings=json.dumps(settings))
    assert r.status_code == 200, r.text
    got = store.get(r.json()["job_id"]).settings
    assert got == {
        "caption_preset": "clipper", "style": "tight",
        "voice_triggers": True, "remove_fillers": False,
        "smartcam_enabled": True, "smartcam_format": "portrait",
        "resolution": "1080", "output_formats": ["9:16"],
        # set by the server, not the client's 99999: the probed length
        # (60 s) + the true-up tolerance (under CLEO_MAX_MINUTES)
        "_max_seconds": 60 + 5}


@pytest.mark.parametrize("value,kept", [
    ("2160", "2160"), ("4K", "4k"), (1440, "1440"), ("720", None),
    (True, None), ("../../x", None)])
def test_settings_resolution_values(value, kept):
    out = M._clean_settings({"resolution": value, "smartcam_format": "x",
                             "voice_triggers": "yes"}, None)
    assert out.get("resolution") == kept
    assert "smartcam_format" not in out and "voice_triggers" not in out


def test_cost_test_flag_only_for_service_or_auth_off():
    assert M._clean_settings({"_cost_test": True}, None) == {"_cost_test": True}
    assert M._clean_settings({"_cost_test": True},
                             auth.SERVICE_USER) == {"_cost_test": True}
    assert M._clean_settings({"_cost_test": True}, auth.User("u")) == {}


# ── caps (413) ───────────────────────────────────────────────────────


def test_presign_caps(client, fake_r2, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", "4")
    r = client.post("/uploads/presign", json={"size": 4.2e9})
    assert r.status_code == 413
    assert r.json() == {"detail": "file_too_large", "max_gb": 4, "code": "file_too_large", "params": {"max_gb": 4}}
    r = client.post("/uploads/presign", json={"duration": 31 * 60})
    assert r.status_code == 413
    assert r.json() == {"detail": "video_too_long", "max_minutes": 30, "code": "video_too_long", "params": {"max_minutes": 30}}
    r = client.post("/uploads/presign",
                    json={"size": 1e8, "duration": 29 * 60})
    assert r.status_code == 200, r.text


def test_post_jobs_size_cap_uses_r2_head(client, fake_r2, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", "0.5")
    fake_r2["size"] = 600_000_000
    r = client.post("/jobs", data={"settings": "{}",
                                   "storage_key": "uploads/big.mp4"})
    assert r.status_code == 413
    assert r.json() == {"detail": "file_too_large", "max_gb": 0.5, "code": "file_too_large", "params": {"max_gb": 0.5}}
    assert fake_r2["downloads"] == []           # nothing is downloaded
    assert fake_r2["deleted"] == ["uploads/big.mp4"]
    assert store.list_all() == []


def test_post_jobs_size_cap_legacy_upload(client, monkeypatch, probe):
    monkeypatch.setenv("CLEO_MAX_UPLOAD_GB", str(32 / 1e9))
    r = _upload(client)
    assert r.status_code == 413 and r.json()["detail"] == "file_too_large"
    assert store.list_all() == []
    assert not list((M._WORK_ROOT / "uploads").glob("*"))


def test_post_jobs_duration_cap(client, fake_r2, probe):
    probe["value"] = 30 * 60 + 30
    r = client.post("/jobs", data={"settings": "{}",
                                   "storage_key": "uploads/long.mp4"})
    assert r.status_code == 413
    assert r.json() == {"detail": "video_too_long", "max_minutes": 30, "code": "video_too_long", "params": {"max_minutes": 30}}
    assert fake_r2["deleted"] == ["uploads/long.mp4"]
    assert store.list_all() == []
    assert not list((M._WORK_ROOT / "uploads").glob("*"))
    probe["value"] = 30 * 60
    r = client.post("/jobs", data={"settings": "{}",
                                   "storage_key": "uploads/ok.mp4"})
    assert r.status_code == 200


# ── admission: queue cap (503) and per-user limit (429) ──────────────


@pytest.mark.wp1_only("fills _INFLIGHT / _SlotQueue by hand; ported: test_wp4_queue.py::test_queue_cap_is_503_with_retry_after")
def test_queue_cap_is_503_with_retry_after(client, fake_r2, probe,
                                           monkeypatch):
    monkeypatch.setenv("CLEO_MAX_ANALYZE", "1")
    monkeypatch.setenv("CLEO_MAX_QUEUE", "2")
    slots = M._SlotQueue(lambda: 1)
    monkeypatch.setattr(M, "_ANALYZE_SLOTS", slots)
    ev, t = _blocker()
    try:
        for i in range(3):  # 1 running + 2 waiting
            M._INFLIGHT.track(f"busy{i}", None, "analyze", t)
        # busy0 holds the slot, busy1 waits in line (busy2 leaves below).
        assert slots.acquire("busy0")
        threading.Thread(target=slots.acquire, args=("busy1",),
                         daemon=True).start()
        assert _wait_for(lambda: slots.position("busy1") == 1)
        r = client.post("/jobs", data={"settings": "{}",
                                       "storage_key": "uploads/k.mp4"})
        assert r.status_code == 503
        assert r.json() == {"detail": "server_busy", "code": "server_busy", "params": {}}
        assert r.headers["retry-after"] == "120"
        assert fake_r2["downloads"] == [] and fake_r2["deleted"] == []
        assert client.post("/uploads/presign", json={}).json() == {
            "detail": "server_busy", "code": "server_busy", "params": {}}
        M._INFLIGHT.release("busy2")
        r = client.post("/jobs", data={"settings": "{}",
                                       "storage_key": "uploads/k.mp4"})
        assert r.status_code == 200, r.text
        # It had to wait: answered with its place in line.
        body = r.json()
        assert (body["status"], body["message"], body["queue_position"]) == (
            "processing", "queued", 2)
    finally:
        ev.set()
        slots.close()


@pytest.mark.wp1_only("fills _INFLIGHT by hand; ported: test_wp4_queue.py::test_ten_concurrent_uploads_of_one_user")
def test_per_user_limit_is_429(client, auth_on, bearer, fake_r2, probe,
                               monkeypatch):
    monkeypatch.setenv("CLEO_MAX_ACTIVE_PER_USER", "2")
    ev, t = _blocker()
    try:
        M._INFLIGHT.track("a1", "user_a", "analyze", t)
        M._INFLIGHT.track("a2", "user_a", "render", t)
        r = client.post("/jobs", headers=bearer("user_a"),
                        data={"settings": "{}",
                              "storage_key": "uploads/user_a/k.mp4"})
        assert r.status_code == 429
        assert r.json() == {"detail": "too_many_active_jobs", "code": "too_many_active_jobs", "params": {}}
        r = client.post("/uploads/presign", headers=bearer("user_a"), json={})
        assert r.status_code == 429
        # Other users aren't affected, nor is the service user.
        r = client.post("/jobs", headers=bearer("user_b"),
                        data={"settings": "{}",
                              "storage_key": "uploads/user_b/k.mp4"})
        assert r.status_code == 200
        monkeypatch.setenv("CLEO_ADMIN_TOKEN", "s3cret")
        M._INFLIGHT.track("s1", "svc:admin", "analyze", t)
        M._INFLIGHT.track("s2", "svc:admin", "analyze", t)
        r = _upload(client, {"X-Admin-Token": "s3cret"})
        assert r.status_code == 200
    finally:
        ev.set()
    # Finished jobs drop out by themselves.
    t.join(2)
    r = client.post("/jobs", headers=bearer("user_a"),
                    data={"settings": "{}",
                          "storage_key": "uploads/user_a/k2.mp4"})
    assert r.status_code == 200


def test_disk_reservation_is_size_aware(client, fake_r2, probe, monkeypatch):
    monkeypatch.setattr(M, "_MIN_FREE_BYTES", 1e9)
    free = {"bytes": 6e9}
    real = M.shutil.disk_usage
    monkeypatch.setattr(M.shutil, "disk_usage",
                        lambda p: real(p)._replace(free=free["bytes"]))
    # Length unknown (no header, no client reading): CLEO_DISK_FACTOR ×
    # the upload, as before.
    probe["value"] = None
    fake_r2["size"] = 2e9  # needs 7 GB + 1 GB floor
    r = client.post("/jobs", data={"settings": "{}",
                                   "storage_key": "uploads/a.mp4"})
    assert r.status_code == 507 and r.json()["detail"] == "server_storage_full"
    assert fake_r2["downloads"] == [] and fake_r2["deleted"] == []
    fake_r2["size"] = 1e9  # 3.5 GB + 1 GB floor fits in 6 GB
    assert client.post("/jobs", data={"settings": "{}",
                                      "storage_key": "uploads/b.mp4"}
                       ).status_code == 200
    r = client.post("/uploads/presign", json={"size": 2e9})
    assert r.status_code == 507
    # Length known: what the analysis really writes (test_capacity.py) —
    # 2 GB of 60 s fits now, also at presign with the browser's reading.
    probe["value"] = 60.0
    fake_r2["size"] = 2e9
    assert client.post("/jobs", data={"settings": "{}",
                                      "storage_key": "uploads/c.mp4"}
                       ).status_code == 200
    assert client.post("/uploads/presign",
                       json={"size": 2e9, "duration": 60}).status_code == 200


# ── idempotent POST /jobs ────────────────────────────────────────────


def test_post_jobs_is_idempotent_on_storage_key(client, enforce, bearer,
                                                fake_r2, probe, clean_state):
    add_sub(plan="pro", period_start=time.time() - 60)
    probe["state"] = fake_r2
    form = {"settings": "{}", "storage_key": "uploads/user_a/v.mp4"}
    r1 = client.post("/jobs", headers=bearer(), data=form)
    r2 = client.post("/jobs", headers=bearer(), data=form)
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["job_id"] == r2.json()["job_id"]
    assert len(store.list_all()) == 1
    assert len(fake_r2["probes"]) == 1 and fake_r2["downloads"] == []
    assert clean_state == [r1.json()["job_id"]]  # one analysis
    rows = accounts._read("SELECT * FROM usage")
    assert len(rows) == 1 and rows[0]["seconds_billed"] == 60
    # Deleting the project frees the key (a new upload is a new job).
    store.update(r1.json()["job_id"], status="done")
    assert client.delete(f"/jobs/{r1.json()['job_id']}",
                         headers=bearer()).status_code == 200
    assert store.find_by_key("uploads/user_a/v.mp4") is None


def test_concurrent_posts_of_one_key_make_one_job(fake_r2, probe,
                                                  clean_state):
    probe["state"] = fake_r2
    fake_r2["delay"] = 0.3  # the first POST is still probing

    async def main():
        transport = httpx.ASGITransport(app=M.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            form = {"settings": "{}", "storage_key": "uploads/same.mp4"}
            return await asyncio.gather(*(c.post("/jobs", data=form)
                                          for _ in range(5)))
    responses = asyncio.run(main())
    assert [r.status_code for r in responses] == [200] * 5
    assert len({r.json()["job_id"] for r in responses}) == 1
    assert len(fake_r2["probes"]) == 1 and fake_r2["downloads"] == []
    assert len(clean_state) == 1 and len(store.list_all()) == 1


# ── render compare-and-set ───────────────────────────────────────────


@pytest.mark.wp1_only("counts WP1 render threads (M._run_render); ported: test_wp4_queue.py::test_render_cas_one_task_for_thirty_posts")
def test_concurrent_render_posts_start_one_render(client, monkeypatch):
    started = []
    monkeypatch.setattr(M, "_run_render",
                        lambda job_id, subs, cuts: started.append(job_id))
    for _ in range(3):
        job = store.create("/x.mp4", {})
        store.update(job.id, status="awaiting_review", normalized_path="/n",
                     segments=[(0.0, 1.0)])
        codes: list[int] = []
        barrier = threading.Barrier(30)

        def post():
            barrier.wait()
            codes.append(client.post(f"/jobs/{job.id}/render",
                                     json={"subtitles": []}).status_code)
        threads = [threading.Thread(target=post) for _ in range(30)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert sorted(codes) == [200] + [409] * 29
    assert len(started) == 3


def test_update_if_is_atomic():
    job = store.create("/x.mp4", {})
    store.update(job.id, status="awaiting_review")
    wins: list[bool] = []
    barrier = threading.Barrier(20)

    def flip():
        barrier.wait()
        wins.append(store.update_if(job.id, "awaiting_review",
                                    status="processing"))
    threads = [threading.Thread(target=flip) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert wins.count(True) == 1
    assert store.update_if(job.id, ("done", "error"), status="x") is False
    assert store.update_if("nope", "pending", status="x") is False


# ── body limits ──────────────────────────────────────────────────────


def test_json_body_over_1mb_is_413_before_the_handler(client, monkeypatch):
    called = []
    job = store.create("/x.mp4", {})
    monkeypatch.setattr(M, "get_owned_job",
                        lambda *a: called.append(1) or store.get(job.id))
    big = b'{"phrases": [' + b"1," * 600_000 + b"1]}"
    r = client.post(f"/jobs/{job.id}/phrases", content=big,
                    headers={"Content-Type": "application/json",
                             "Origin": "http://localhost:3000"})
    assert r.status_code == 413
    assert r.json() == {"detail": "request_too_large", "code": "request_too_large", "params": {}}
    # CORS wraps the limiter: the browser can read the 413.
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert called == []


def test_chunked_body_is_cut_off_while_streaming(client):
    def chunks():
        for _ in range(40):
            yield b"x" * 64 * 1024  # 2.5 MB, no Content-Length
    job = store.create("/x.mp4", {})
    r = client.post(f"/jobs/{job.id}/edit-segments", content=chunks(),
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 413
    assert r.json() == {"detail": "request_too_large", "code": "request_too_large", "params": {}}


def test_huge_content_length_is_refused_without_reading():
    """400 MB announced → 413 without a single receive() call."""
    sent: list[dict] = []

    async def receive():
        raise AssertionError("body must not be read")

    async def send(message):
        sent.append(message)
    scope = {"type": "http", "method": "POST", "path": "/jobs/x/render",
             "headers": [(b"content-length", b"400000000"),
                         (b"content-type", b"application/json")],
             "query_string": b"", "root_path": ""}
    t0 = time.perf_counter()
    asyncio.run(M._BodyLimitMiddleware(M.app.router)(scope, receive, send))
    assert time.perf_counter() - t0 < 0.05
    assert sent[0]["status"] == 413
    assert json.loads(sent[1]["body"]) == {"detail": "request_too_large", "code": "request_too_large", "params": {}}


def test_webhook_and_upload_limits(client, billing_on, monkeypatch):
    r = client.post("/billing/webhook", content=b"x" * (300 * 1024))
    assert r.status_code == 413
    monkeypatch.setenv("CLEO_MAX_FORM_UPLOAD_MB", "0.01")  # ~10 KB
    r = client.post("/jobs", data={"settings": "{}"},
                    files={"file": ("a.mp4", b"x" * 20_000, "video/mp4")})
    assert r.status_code == 413
    assert r.json() == {"detail": "file_too_large", "max_gb": 0.0, "code": "file_too_large", "params": {"max_gb": 0.0}}
    assert store.list_all() == []


# ── batch status ─────────────────────────────────────────────────────


def test_batch_status_with_etag(client):
    a = store.create("/a.mp4", {})
    b = store.create("/b.mp4", {})
    store.update(b.id, status="processing", message="queued",
                 queue_position=3, progress=0.0)
    r = client.get("/jobs/status", params={"ids": f"{a.id},{b.id},nope"})
    assert r.status_code == 200
    body = r.json()
    assert [j["id"] for j in body["jobs"]] == [a.id, b.id]
    assert body["missing"] == ["nope"]
    assert set(body["jobs"][0]) == {
        "id", "status", "message", "progress", "queue_position", "error",
        "error_code", "error_params", "refunded", "stage", "stage_params",
        "has_output", "updated_at",
        "preview_version",
        # UX12: the Projects tile
        "title", "duration", "created_at", "expires_at"}
    assert body["jobs"][1]["queue_position"] == 3
    etag = r.headers["etag"]
    assert etag.startswith('W/"')
    r2 = client.get("/jobs/status", params={"ids": f"{a.id},{b.id},nope"},
                    headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.content == b""
    store.update(b.id, message="Starting…", queue_position=None)
    r3 = client.get("/jobs/status", params={"ids": f"{a.id},{b.id},nope"},
                    headers={"If-None-Match": etag})
    assert r3.status_code == 200 and r3.headers["etag"] != etag
    ids = ",".join(f"id{i}" for i in range(51))
    assert client.get("/jobs/status", params={"ids": ids}).status_code == 400


def test_batch_status_ownership(client, auth_on, bearer):
    mine = store.create("/a.mp4", {}, owner_id="user_a")
    theirs = store.create("/b.mp4", {}, owner_id="user_b")
    beta = store.create("/c.mp4", {})
    r = client.get("/jobs/status", headers=bearer("user_a"),
                   params={"ids": f"{mine.id},{theirs.id},{beta.id}"})
    assert [j["id"] for j in r.json()["jobs"]] == [mine.id, beta.id]
    assert r.json()["missing"] == [theirs.id]
    assert store.get(beta.id).owner_id == "user_a"  # claimed, like GET /jobs/{id}
    assert client.get("/jobs/status", params={"ids": mine.id}).status_code == 401


# ── health / ready ───────────────────────────────────────────────────


def test_health_and_ready(client, monkeypatch):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json() == {"status": "ready"}

    def hang():
        time.sleep(2.5)
    monkeypatch.setattr(store, "ping", hang)
    t0 = time.monotonic()
    r = client.get("/ready")
    assert r.status_code == 503 and r.json()["reason"] == "db_timeout"
    assert time.monotonic() - t0 < 2.4
    time.sleep(0.6)  # let the single ready thread finish


def test_caption_previews_are_cached(client, monkeypatch):
    from src import caption_preview as cp
    calls = []
    real = cp.render_caption_preview
    monkeypatch.setattr(cp, "render_caption_preview",
                        lambda *a, **k: calls.append(1) or real(*a, **k))
    M._caption_png.clear()
    for _ in range(3):
        r = client.get("/caption-previews/clipper.png", params={"w": 321,
                                                                 "h": 111})
        assert r.status_code == 200 and r.content[:4] == b"\x89PNG"
    assert len(calls) == 1
    assert ("clipper", (321, 111)) not in getattr(cp, "_CACHE", {})
    for i in range(M._CAPTION_CACHE_MAX + 5):
        M._render_caption_png("none", 100 + i, 50)
    assert len(M._caption_png) == M._CAPTION_CACHE_MAX


# ── upload deleted right after normalization ─────────────────────────


# A browser upload key as storage.presign_upload makes them (the media
# GC only takes keys of that shape).
SRC_KEY = "uploads/0123456789abcdef0123456789abcdef.mp4"


def _src_job(tmp_key=SRC_KEY):
    up = Path(M._WORK_ROOT) / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    f = up / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), {"_r2_storage_key": tmp_key}), f


def _media_deletes(monkeypatch) -> list:
    deleted: list[str] = []
    real = M.media.delete
    monkeypatch.setattr(M.media, "delete",
                        lambda key, **kw: (deleted.append(key),
                                           real(key, **kw))[1])
    return deleted


def test_upload_is_dropped_after_normalize_and_failure_tolerates_it(
        monkeypatch):
    """on_normalized frees the LOCAL copy right away; the upload object
    stays until the analysis ends (WP3 §6) — here a failure, which
    queues it for deletion (media_gc) with the job's prefix."""
    deleted = _media_deletes(monkeypatch)
    job, f = _src_job()
    seen = {}

    def analyze(input_path, output_dir, settings, progress_cb,
                on_normalized=None):
        Path(output_dir, "normalized.mp4").write_bytes(b"n")
        on_normalized()
        seen["gone"] = not f.exists()
        seen["input_path"] = store.get(job.id).input_path
        seen["deleted"] = list(deleted)
        raise RuntimeError("No speech detected in the video.")
    monkeypatch.setattr(M, "analyze_only", analyze)
    M._run_analyze_inner(job.id)
    assert seen == {"gone": True, "input_path": None, "deleted": []}
    got = store.get(job.id)
    assert got.status == "error" and got.input_path is None
    queued = {r["prefix"] for r in store.gc_all()}
    assert queued == {SRC_KEY, f"jobs/{job.id}/"}
    assert not M._workspace(job.id).exists()


def test_upload_dropped_after_success_without_the_hook(monkeypatch):
    deleted = _media_deletes(monkeypatch)
    job, f = _src_job()
    monkeypatch.setattr(M, "analyze_only", lambda input_path, output_dir,
                        settings, progress_cb: analysis_result(output_dir))
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "awaiting_review" and got.input_path is None
    assert not f.exists() and deleted == [SRC_KEY]


# ── WAL ──────────────────────────────────────────────────────────────


@pytest.mark.sqlite_only
def test_both_connections_use_wal():
    with store._lock:
        mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]
        timeout = store._conn.execute("PRAGMA busy_timeout").fetchone()[0]
    assert mode == "wal" and timeout >= 5000
    conn = accounts._db()
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] >= 5000
