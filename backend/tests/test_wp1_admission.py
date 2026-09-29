"""WP1 admission internals: the FIFO analysis/render slots and queue
positions, coalesced progress writes that never overwrite a finished
job, disk reservations, the rebuild executor behind the async editor
routes, and JWT checks that stay off the threadpool."""
from __future__ import annotations

import asyncio
import threading
import time

import httpx
import jwt
import pytest

import backend.main as M
from backend import auth
from backend.jobs import store
from conftest import analysis_result

REAL_RUN_ANALYZE = M._run_analyze  # conftest stubs it per test


@pytest.fixture(autouse=True)
def wp1_state(monkeypatch):
    for k in ("CLEO_MAX_ANALYZE", "CLEO_MAX_RENDER", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_DISK_FACTOR"):
        monkeypatch.delenv(k, raising=False)
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()
    yield
    with M._INFLIGHT._lock:
        M._INFLIGHT._entries.clear()


def _wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


# ── slots ────────────────────────────────────────────────────────────


def test_slot_queue_is_fifo_with_positions():
    q = M._SlotQueue(lambda: 1)
    seen: dict[str, list[int]] = {"a": [], "b": [], "c": []}
    order: list[str] = []
    assert q.acquire("first")

    def run(name):
        if q.acquire(name, on_wait=seen[name].append):
            order.append(name)
    threads = []
    for name in ("a", "b", "c"):
        threads.append(threading.Thread(target=run, args=(name,)))
        threads[-1].start()
        assert _wait_for(lambda: q.position(name) is not None)
    assert [q.position(n) for n in "abc"] == [1, 2, 3]
    assert q.acquire("a") is False  # already waiting
    q.release("first")
    assert _wait_for(lambda: order == ["a"])
    assert [q.position(n) for n in "bc"] == [1, 2]
    q.release("a")
    assert _wait_for(lambda: order == ["a", "b"])
    q.close()  # shutdown: c never starts
    [t.join(2) for t in threads]
    assert order == ["a", "b"]
    assert seen == {"a": [1], "b": [2, 1], "c": [3, 2, 1]}
    assert q.acquire("d") is False


def test_uploads_queue_up_and_positions_move(client, monkeypatch):
    """CLEO_MAX_ANALYZE=1: the second and third upload wait in line and
    GET /jobs/status shows their moving queue_position."""
    monkeypatch.setenv("CLEO_MAX_ANALYZE", "1")
    monkeypatch.setattr(M, "_run_analyze", REAL_RUN_ANALYZE)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 10.0)
    gates: dict[str, threading.Event] = {}

    def analyze(input_path, output_dir, settings, progress_cb):
        ev = gates.setdefault(output_dir, threading.Event())
        progress_cb("Analyzing audio…", 10)
        assert ev.wait(10)
        return analysis_result(output_dir, 10.0)
    monkeypatch.setattr(M, "analyze_only", analyze)

    def ws(job_id):
        return str(M._workspace(job_id))

    ids = []
    for i in range(3):
        r = client.post("/jobs", data={"settings": "{}"},
                        files={"file": (f"{i}.mp4", b"x", "video/mp4")})
        assert r.status_code == 200, r.text
        ids.append(r.json()["job_id"])
        if i == 0:
            assert _wait_for(lambda: ws(ids[0]) in gates)

    def status():
        body = client.get("/jobs/status",
                          params={"ids": ",".join(ids)}).json()
        return [(j["status"], j["message"], j["queue_position"])
                for j in body["jobs"]]
    assert _wait_for(lambda: status()[1:] == [("processing", "queued", 1),
                                              ("processing", "queued", 2)])
    assert _wait_for(lambda: status()[0][:2] == ("processing",
                                                 "Analyzing audio…"))
    assert client.get(f"/jobs/{ids[2]}").json()["queue_position"] == 2

    gates[ws(ids[0])].set()
    assert _wait_for(lambda: ws(ids[1]) in gates)
    assert _wait_for(lambda: status()[2] == ("processing", "queued", 1))
    assert status()[0] == ("awaiting_review", "Review subtitles", None)
    for job_id in ids[1:]:
        _wait_for(lambda: ws(job_id) in gates)
        gates[ws(job_id)].set()
    assert _wait_for(lambda: [s[0] for s in status()] == ["awaiting_review"] * 3)


def test_twenty_uploads_two_run_eighteen_wait(client, monkeypatch):
    """Defaults (2 slots, queue cap 20): 20 uploads → 2 analysing and 18
    in line with positions 1..18; 22 fit, the 23rd gets 503."""
    monkeypatch.setattr(M, "_run_analyze", REAL_RUN_ANALYZE)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 120.0)
    release = threading.Event()
    running = []

    def analyze(input_path, output_dir, settings, progress_cb):
        running.append(output_dir)
        assert release.wait(20)
        return analysis_result(output_dir, 120.0)
    monkeypatch.setattr(M, "analyze_only", analyze)

    def upload(i):
        return client.post("/jobs", data={"settings": "{}"},
                           files={"file": (f"{i}.mp4", b"x", "video/mp4")})
    try:
        ids = [upload(i).json()["job_id"] for i in range(20)]
        assert _wait_for(lambda: len(running) == 2)

        def positions():
            body = client.get("/jobs/status",
                              params={"ids": ",".join(ids)}).json()
            return sorted(j["queue_position"] for j in body["jobs"]
                          if j["message"] == "queued")
        assert _wait_for(lambda: positions() == list(range(1, 19)))
        assert upload(20).status_code == 200
        assert upload(21).status_code == 200
        r = upload(22)
        assert r.status_code == 503 and r.headers["retry-after"] == "120"
    finally:
        release.set()
    assert _wait_for(lambda: all(
        j["status"] == "awaiting_review" for j in client.get(
            "/jobs/status", params={"ids": ",".join(ids)}).json()["jobs"]),
        timeout=20)


def test_render_waits_for_a_render_slot(client, monkeypatch):
    monkeypatch.setenv("CLEO_MAX_RENDER", "1")
    release = threading.Event()

    def render(**kw):
        assert release.wait(10)
        return {"outputs": {"primary": {"key": kw["out_prefix"] + "p.mp4",
                                        "size": 1}},
                "thumb": None, "hooks": []}
    monkeypatch.setattr(M.pipeline, "render_to_keys", render)
    import backend.llm as llm
    monkeypatch.setattr(llm, "generate_social_caption",
                        lambda text, language=None: {"caption": "",
                                                     "hashtags": []})
    ids = []
    for _ in range(2):
        job = store.create("/x.mp4", {})
        store.update(job.id, status="awaiting_review",
                     mezz_key=f"jobs/{job.id}/mezz.mp4",
                     segments=[(0.0, 1.0)])
        ids.append(job.id)
    assert client.post(f"/jobs/{ids[0]}/render",
                       json={"subtitles": []}).json()["message"] == "Rendering…"
    r = client.post(f"/jobs/{ids[1]}/render", json={"subtitles": []}).json()
    assert (r["status"], r["message"], r["queue_position"]) == (
        "processing", "queued", 1)
    release.set()
    assert _wait_for(lambda: store.get(ids[1]).status == "done")
    assert store.get(ids[1]).queue_position is None


# ── progress writes ──────────────────────────────────────────────────


def test_progress_is_coalesced_and_trailing_tick_written(monkeypatch):
    job = store.create("/x.mp4", {})
    store.update(job.id, status="processing")
    writes = []
    real = store.update_if
    monkeypatch.setattr(store, "update_if",
                        lambda *a, **k: writes.append(k) or real(*a, **k))
    p = M._ProgressWriter(job.id, interval=0.3)
    for i in range(100):
        p(f"step {i}", float(i))
    assert len(writes) == 1                 # the first tick, at once
    assert _wait_for(lambda: len(writes) == 2)
    assert writes[1] == {"message": "step 99", "progress": 99.0}
    time.sleep(0.4)
    assert len(writes) == 2                 # nothing pending any more
    p("keep progress", -1)                  # -1: message only
    assert writes[2] == {"message": "keep progress"}
    assert store.get(job.id).progress == 99.0
    p.close()


def test_late_progress_never_overwrites_a_finished_job():
    job = store.create("/x.mp4", {})
    store.update(job.id, status="processing")
    p = M._ProgressWriter(job.id, interval=0.2)
    p("working", 50.0)
    p("still working", 60.0)                # pending, flushed by a timer
    store.update(job.id, status="awaiting_review", message="Review subtitles",
                 progress=100.0)
    time.sleep(0.35)                        # the timer fired: CAS refused it
    got = store.get(job.id)
    assert (got.status, got.message, got.progress) == (
        "awaiting_review", "Review subtitles", 100.0)
    p("way too late", 70.0)
    assert store.get(job.id).message == "Review subtitles"
    p.close()


# ── disk reservation ─────────────────────────────────────────────────


def test_disk_reservation_shrinks_as_the_upload_lands(monkeypatch, tmp_path):
    monkeypatch.setattr(M, "_MIN_FREE_BYTES", 0.0)
    real = M.shutil.disk_usage
    monkeypatch.setattr(M.shutil, "disk_usage",
                        lambda p: real(p)._replace(free=10_000))
    upload = M._WORK_ROOT / "uploads" / "resv.bin"
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_bytes(b"")
    try:
        t1 = M._INFLIGHT.admit(None)
        M._INFLIGHT.reserve_disk(t1, 2000, str(upload))    # needs 7000
        t2 = M._INFLIGHT.admit(None)
        with pytest.raises(M.HTTPException) as e:
            M._INFLIGHT.reserve_disk(t2, 1000, None)       # 3500 > 3000 left
        assert e.value.status_code == 507
        upload.write_bytes(b"x" * 2000)                    # 2000 of it written
        M._INFLIGHT.reserve_disk(t2, 1000, None)           # 5000 reserved now
        M._INFLIGHT.release(t1)
        M._INFLIGHT.release(t2)
    finally:
        upload.unlink(missing_ok=True)


# ── editor rebuilds in their own executor ────────────────────────────


def _review_job(tmp_path):
    tmp_path.mkdir(parents=True, exist_ok=True)
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"n")
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", normalized_path=str(src),
                 segments=[(0.0, 5.0)], duration=10.0)
    return job, src


def test_rebuilds_run_in_the_bounded_pool_and_health_stays_fast(
        monkeypatch, tmp_path):
    """42 concurrent saves (rebuild stubbed at 0.2 s): at most
    CLEO_REBUILD_WORKERS encodes at once, none on the event loop or the
    request threadpool, and /health answers right away throughout."""
    jobs = [_review_job(tmp_path / str(i)) for i in range(42)]
    running, peak, threads = [0], [0], set()
    lock = threading.Lock()
    proxies = []
    monkeypatch.setattr(M.pipeline, "preview_source",
                        lambda p: proxies.append(p) or p + ".proxy",
                        raising=False)

    def rebuild(job_id, source, segments):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
            threads.add(threading.current_thread().name)
        time.sleep(0.2)
        with lock:
            running[0] -= 1
        assert source.endswith(".proxy")
        store.update(job_id, preview_version=7)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)

    async def main():
        transport = httpx.ASGITransport(app=M.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            saves = [asyncio.create_task(c.post(
                f"/jobs/{job.id}/edit-segments",
                json={"segments": [{"start": 0, "end": 2}]}))
                for job, _ in jobs]
            health = []
            while not all(t.done() for t in saves):
                t0 = time.perf_counter()
                assert (await c.get("/health")).status_code == 200
                health.append(time.perf_counter() - t0)
                await asyncio.sleep(0.05)
            return [t.result() for t in saves], health
    results, health = asyncio.run(main())
    assert all(r.status_code == 200 and r.json()["preview_ok"]
               for r in results)
    assert peak[0] == 2
    assert all(name.startswith("rebuild") for name in threads)
    assert len(proxies) == 42
    health.sort()
    assert health[int(len(health) * 0.99) - 1] < 0.05, health[-5:]


def test_newest_save_wins_and_older_ones_are_superseded(monkeypatch,
                                                        tmp_path):
    job, _src = _review_job(tmp_path)
    first_started, release = threading.Event(), threading.Event()
    built = []

    def rebuild(job_id, source, segments):
        built.append(segments)
        if len(built) == 1:
            first_started.set()
            assert release.wait(5)
    monkeypatch.setattr(M, "_rebuild_preview", rebuild)

    async def main():
        transport = httpx.ASGITransport(app=M.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            def save(end):
                return asyncio.create_task(c.post(
                    f"/jobs/{job.id}/edit-segments",
                    json={"segments": [{"start": 0, "end": end}]}))
            a = save(1)
            while not first_started.is_set():
                await asyncio.sleep(0.01)
            b = save(2)
            await asyncio.sleep(0.2)
            c3 = save(3)
            await asyncio.sleep(0.2)
            release.set()
            return [(await t).json() for t in (a, b, c3)]
    a, b, c3 = asyncio.run(main())
    assert a["preview_ok"] and not a["superseded"]
    assert b["superseded"] and not b["preview_ok"]
    assert c3["preview_ok"] and not c3["superseded"]
    assert [s[-1][1] for s in built] == [1.0, 3.0]
    assert store.get(job.id).segments == [(0.0, 3.0)]


# ── auth stays on the event loop ─────────────────────────────────────


class _NoPool:
    def submit(self, *a, **k):
        raise AssertionError("cached keys must not need the JWKS pool")


def test_cached_jwks_verifies_on_the_loop(client, auth_on, bearer,
                                          monkeypatch):
    assert client.get("/me", headers=bearer()).status_code == 200
    assert len(auth_on) == 1                  # fetched once (in the pool)
    real_pool = auth._JWKS_POOL
    monkeypatch.setattr(auth, "_JWKS_POOL", _NoPool())
    for _ in range(3):
        assert client.get("/me", headers=bearer()).status_code == 200
    # Expired key set / unknown kid → fetched again, in the pool.
    auth._jwks[1].jwk_set_cache.put(None)
    monkeypatch.setattr(auth, "_JWKS_POOL", real_pool)
    assert client.get("/me", headers=bearer()).status_code == 200
    assert len(auth_on) == 2
    unknown = bearer(headers={"kid": "rotated"})
    assert client.get("/me", headers=unknown).status_code == 401


def test_slow_jwks_fetch_does_not_block_the_loop(monkeypatch, bearer, jwks):
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.test.example")

    def slow(self):
        time.sleep(0.5)
        return jwks
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", slow)

    async def main():
        transport = httpx.ASGITransport(app=M.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            me = asyncio.create_task(c.get("/me", headers=bearer()))
            await asyncio.sleep(0.05)
            t0 = time.perf_counter()
            assert (await c.get("/health")).status_code == 200
            health = time.perf_counter() - t0
            return (await me).status_code, health
    code, health = asyncio.run(main())
    assert code == 200 and health < 0.2
