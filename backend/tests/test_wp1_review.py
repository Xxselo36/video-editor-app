"""WP1 review fixes: what a restart leaves on the work volume, real and
unique queue positions, the disk scan outside the admission lock, and
the bounds on one editor save."""
from __future__ import annotations

import asyncio
import os
import threading
import time
from pathlib import Path

import httpx
import pytest

import backend.main as M
from backend.jobs import store

REAL_RUN_ANALYZE = M._run_analyze  # conftest stubs it per test


def _wait_for(pred, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


# ── restart: interrupted analyses give their files back ──────────────


@pytest.fixture
def r2_deletes(monkeypatch):
    """Keys deleted through backend.media (the upload objects)."""
    deleted: list[str] = []
    real = M.media.delete
    monkeypatch.setattr(M.media, "delete",
                        lambda key, **kw: (deleted.append(key),
                                           real(key, **kw))[1])
    return deleted


def _upload_file(name: str, before_start: bool = False) -> Path:
    """A file in uploads/, written before this process started (by the
    previous container) or just now."""
    path = M._WORK_ROOT / "uploads" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"video")
    if before_start:
        old = M._PROCESS_START - 60
        os.utime(path, (old, old))
    return path


def test_restart_frees_interrupted_analyses(r2_deletes):
    """Boot after a restart: analyses that were queued or running can't
    be resumed, so their upload (local + R2) and partial job folder go
    right away instead of after 14–90 days. A render interrupted by the
    restart keeps everything (back to review). Uploads no job refers to
    (restart during POST /jobs) are removed; the sweep is idempotent."""
    queued = store.create(str(_upload_file("q.mp4", True)),
                          {"_r2_storage_key": "uploads/q.mp4"})
    store.update(queued.id, status="processing", message="queued",
                 queue_position=3)
    running = store.create(str(_upload_file("r.mp4", True)), {})
    store.update(running.id, status="processing", message="Transcribing…")
    (M._WORK_ROOT / running.id).mkdir(parents=True)
    (M._WORK_ROOT / running.id / "normalized.mp4").write_bytes(b"n")
    render_dir = M._WORK_ROOT / "render-job"
    render_dir.mkdir(parents=True, exist_ok=True)
    (render_dir / "normalized.mp4").write_bytes(b"n")
    rendering = store.create(None, {})
    store.update(rendering.id, status="processing", message="Rendering…",
                 normalized_path=str(render_dir / "normalized.mp4"),
                 segments=[(0.0, 1.0)])
    kept = store.create(str(_upload_file("kept.mp4", True)), {})
    store.update(kept.id, status="awaiting_review",
                 normalized_path=str(render_dir / "normalized.mp4"))
    orphan = _upload_file("orphan.mp4", True)
    fresh = _upload_file("fresh.mp4")   # this process may be accepting it

    # The boot steps of lifespan().
    assert store.mark_stuck_as_error() == 3
    M._refund_interrupted()
    M._clean_interrupted()

    for job in (queued, running):
        cur = store.get(job.id)
        assert (cur.status, cur.error) == ("error", "container_restart")
        assert cur.input_path is None
        assert not Path(job.input_path).exists()
    assert not (M._WORK_ROOT / running.id).exists()
    assert r2_deletes == ["uploads/q.mp4"]
    cur = store.get(rendering.id)
    assert (cur.status, cur.message) == ("awaiting_review", "render_failed")
    assert (render_dir / "normalized.mp4").exists()
    assert Path(kept.input_path).exists()
    assert not orphan.exists() and fresh.exists()

    M._clean_interrupted()                      # next boot: nothing to do
    assert r2_deletes == ["uploads/q.mp4"]


# ── queue positions ──────────────────────────────────────────────────


def test_concurrent_uploads_get_distinct_real_positions(monkeypatch):
    """A burst of uploads with one analysis slot: each answer carries
    its own place in line — the order the queue really serves — instead
    of mostly '#1'."""
    monkeypatch.setenv("CLEO_MAX_ANALYZE", "1")
    slots = M._SlotQueue(lambda: 1)
    monkeypatch.setattr(M, "_ANALYZE_SLOTS", slots)
    monkeypatch.setattr(M, "_run_analyze", REAL_RUN_ANALYZE)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 10.0)
    release = threading.Event()
    started: list[str] = []

    def analyze(input_path, output_dir, settings, progress_cb):
        started.append(Path(output_dir).name)
        assert release.wait(20)
        return {"normalized_path": "/n.mp4", "preview_path": "/p.mp4",
                "segments": [(0.0, 1.0)], "subtitles": [], "duration": 10.0,
                "language": "en"}
    monkeypatch.setattr(M, "analyze_only", analyze)

    async def burst():
        transport = httpx.ASGITransport(app=M.app)
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as c:
            return await asyncio.gather(*(
                c.post("/jobs", data={"settings": "{}"},
                       files={"file": (f"{i}.mp4", b"x", "video/mp4")})
                for i in range(8)))
    try:
        answers = [r.json() for r in asyncio.run(burst())]
        positions = sorted(a["queue_position"] for a in answers
                           if a["queue_position"] is not None)
        assert positions == list(range(1, 8)), positions
        # ... and they are the order in which the jobs get the slot.
        by_pos = {a["queue_position"]: a["job_id"] for a in answers}
        assert _wait_for(lambda: len(started) == 1)
        for pos in range(1, 8):
            assert slots.position(by_pos[pos]) == pos
    finally:
        release.set()
    assert _wait_for(lambda: len(started) == 8, timeout=10)
    assert started[1:] == [by_pos[p] for p in range(1, 8)]


def test_places_in_line_are_never_shown_twice():
    """While the line moves, no two jobs show the same place: the job
    that got the slot clears its '#1' (on_start) before the others move
    up, and they move up front to back."""
    q = M._SlotQueue(lambda: 1)
    shown: dict[str, int | None] = {}
    dupes: list[list[int]] = []
    stop = threading.Event()

    def on_wait(job):
        def write(pos):
            time.sleep(0.002)            # a store write takes a moment
            shown[job] = pos
        return write

    def on_start(job):
        def write():
            time.sleep(0.005)
            shown[job] = None
        return write

    def poll():
        while not stop.is_set():
            places = [p for p in list(shown.values()) if p is not None]
            if len(places) != len(set(places)):
                dupes.append(sorted(places))
            time.sleep(0.0002)

    assert q.acquire("first")
    jobs = [f"j{i}" for i in range(8)]
    got: list[str] = []
    for job in jobs:
        threading.Thread(
            target=lambda j=job: q.acquire(j, on_wait(j), on_start(j))
            and got.append(j), daemon=True).start()
        assert _wait_for(lambda j=job: shown.get(j) is not None)
    poller = threading.Thread(target=poll, daemon=True)
    poller.start()
    running = "first"
    for job in jobs:
        q.release(running)
        assert _wait_for(lambda j=job: j in got)
        running = job
    stop.set()
    poller.join(2)
    assert got == jobs
    assert dupes == []


# ── disk reservations: no filesystem work under the admission lock ───


def test_disk_scan_runs_outside_the_lock(monkeypatch):
    """reserve_disk scans the other jobs' files without holding the lock
    the event loop takes (admit / attach / release)."""
    monkeypatch.setattr(M, "_MIN_FREE_BYTES", 0.0)
    held: list[bool] = []
    real = M._bytes_on_disk

    def scan(entry):
        held.append(M._INFLIGHT._lock.locked())
        return real(entry)
    monkeypatch.setattr(M, "_bytes_on_disk", scan)
    tokens = [M._INFLIGHT.admit(None) for _ in range(3)]
    try:
        for t in tokens:
            M._INFLIGHT.reserve_disk(t, 1000, None)
        assert held and not any(held)
    finally:
        for t in tokens:
            M._INFLIGHT.release(t)


# ── one editor save has bounded work ─────────────────────────────────


def _review_job(tmp_path, duration=60.0):
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"n")
    job = store.create(None, {})
    store.update(job.id, status="awaiting_review", normalized_path=str(src),
                 segments=[(0.0, 5.0)], duration=duration)
    return job


def test_edit_save_limits(client, tmp_path, monkeypatch):
    job = _review_job(tmp_path)
    monkeypatch.setattr(M, "_rebuild_preview", lambda *a: None)
    monkeypatch.setenv("CLEO_MAX_EDIT_SEGMENTS", "50")
    many = [{"start": i * 0.5, "end": i * 0.5 + 0.2} for i in range(51)]
    r = client.post(f"/jobs/{job.id}/edit-segments", json={"segments": many})
    assert r.status_code == 400
    assert r.json() == {"detail": "too_many_segments", "max_segments": 50}
    # Clips may repeat the source, but at most twice its length (+ 1 min).
    whole = [{"start": 0, "end": 60}] * 4
    r = client.post(f"/jobs/{job.id}/edit-segments", json={"segments": whole})
    assert r.status_code == 400
    assert r.json() == {"detail": "timeline_too_long", "max_seconds": 180}
    assert store.get(job.id).segments == [(0.0, 5.0)]      # nothing stored
    ok = many[:48] + [{"start": 0, "end": 60}] * 2
    r = client.post(f"/jobs/{job.id}/edit-segments", json={"segments": ok})
    assert r.status_code == 200, r.text
