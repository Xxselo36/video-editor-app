"""DELETE /jobs/{id} while Cleo works on the job (the WP1 path, threads
of this process): the analysis or render stops at its next check,
stores nothing more and settles nothing — no error state, no failure
event, no error report — and jobs/{id}/ goes once more later in the
job's own store (what a put already under way stores after the GC).
The task queue's side (its worker fenced out) is in test_wp4_queue."""
from __future__ import annotations

import threading
import time
from pathlib import Path

import backend.main as M
from backend.jobs import store
from conftest import REAL_RUN_ANALYZE, analysis_result


def _upload_job():
    up = Path(M._WORK_ROOT) / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    f = up / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    return store.create(str(f), {}), f


def _render_job():
    job = store.create(None, {})
    store.update(job.id, status="processing", render_gen=1,
                 segments=[(0.0, 4.0)], mezz_key=f"jobs/{job.id}/mezz.mp4")
    return store.get(job.id)


def _waits_for_cancel(cancel_check, started: threading.Event) -> None:
    """Works until cancel_check() says stop, as the pipeline does."""
    started.set()
    deadline = time.monotonic() + 10
    while not cancel_check():
        assert time.monotonic() < deadline, "never cancelled"
        time.sleep(0.01)
    raise InterruptedError("Cancelled")


def _late_pass(job) -> list[dict]:
    return [r for r in store.gc_all() if r["prefix"] == f"jobs/{job.id}/"
            and r["store"] == M.media.store_of(job)]


def _reports(monkeypatch) -> list:
    seen: list = []
    monkeypatch.setattr(M.observability, "capture",
                        lambda exc, **kw: seen.append(type(exc).__name__))
    return seen


def test_analysis_deleted_midway_stops_quietly(client, monkeypatch):
    job, upload = _upload_job()
    started = threading.Event()
    calls: list[str] = []

    def analyze(input_path, output_dir, settings, progress_cb,
                on_normalized=None, cancel_check=None):
        Path(output_dir, "normalized.mp4").write_bytes(b"n")
        _waits_for_cancel(cancel_check, started)
    monkeypatch.setattr(M, "analyze_only", analyze)
    monkeypatch.setattr(M.media, "put_file",
                        lambda path, key, **kw: calls.append(key) or 1)
    reports = _reports(monkeypatch)
    th = threading.Thread(target=M._run_analyze_inner, args=(job.id,))
    th.start()
    assert started.wait(5)
    t0 = time.time()
    assert client.delete(f"/jobs/{job.id}").json() == {"deleted": job.id}
    th.join(10)
    assert not th.is_alive()
    assert store.get(job.id) is None
    assert calls == [] and reports == []
    assert store.events(t0 - 60, kinds=["analysis_failed"]) == []
    assert not M._workspace(job.id).exists() and not upload.exists()
    [late] = _late_pass(job)
    assert late["not_before"] >= t0 + M._late_write_gc_delay_s()


def test_analysis_deleted_after_it_finished_stores_nothing(client,
                                                           monkeypatch):
    """Deleted between the analysis and its uploads: not one file."""
    job, _upload = _upload_job()
    calls: list[str] = []

    def analyze(**kw):
        assert client.delete(f"/jobs/{job.id}").status_code == 200
        return analysis_result(kw["output_dir"])
    monkeypatch.setattr(M, "analyze_only", analyze)
    monkeypatch.setattr(M.media, "put_file",
                        lambda path, key, **kw: calls.append(key) or 1)
    reports = _reports(monkeypatch)
    M._run_analyze_inner(job.id)
    assert calls == [] and reports == []
    assert store.get(job.id) is None
    assert len(_late_pass(job)) == 1


def test_render_deleted_midway_stops_quietly(client, monkeypatch):
    job = _render_job()
    started = threading.Event()

    def render(**kw):
        _waits_for_cancel(kw["cancel_check"], started)
    monkeypatch.setattr(M.pipeline, "render_to_keys", render)
    reports = _reports(monkeypatch)
    th = threading.Thread(target=M._run_render_inner, args=(job.id, []))
    th.start()
    assert started.wait(5)
    t0 = time.time()
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    th.join(10)
    assert not th.is_alive()
    assert store.get(job.id) is None and reports == []
    assert store.events(t0 - 60, kinds=["render_failed"]) == []
    assert len(_late_pass(job)) == 1
    # Its own generation's prefix goes after Modal's function timeout.
    assert f"jobs/{job.id}/r1/" in {r["prefix"] for r in store.gc_all()}


def test_settled_job_has_no_second_pass(client):
    job = store.create(None, {})
    store.update(job.id, status="done")
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    assert _late_pass(store.get(job.id) or job) == []


def _start_analysis(job, owner):
    """POST /jobs' WP1 start: a place in the analysis line, the thread,
    its _INFLIGHT entry."""
    th = threading.Thread(target=REAL_RUN_ANALYZE, args=(job.id,),
                          daemon=True)
    M._ANALYZE_SLOTS.enqueue(job.id, th)
    th.start()
    M._INFLIGHT.track(job.id, owner, "analyze", th)
    return th


def _in_flight(owner: str) -> int:
    """What admission counts for `owner` (its live _INFLIGHT entries)."""
    with M._INFLIGHT._lock:
        return sum(e["owner"] == owner for e in M._INFLIGHT._live())


def test_deleted_while_waiting_in_line_leaves_it_at_once(client,
                                                         monkeypatch):
    """WP1: deleted while its analysis waits for a slot: it leaves the
    line now, not when its turn comes — its thread ends without
    analysing, and what it held for admission (its owner's jobs in
    flight, the queue, its disk reservation) is free again."""
    monkeypatch.setenv("CLEO_MAX_ANALYZE", "1")
    gate = threading.Event()
    analysed: list[str] = []

    def analyze(input_path, output_dir, settings, progress_cb,
                on_normalized=None, cancel_check=None):
        analysed.append(output_dir)
        assert gate.wait(20)
        return analysis_result(output_dir)
    monkeypatch.setattr(M, "analyze_only", analyze)
    monkeypatch.setattr(M.media, "put_file", lambda path, key, **kw: 1)
    first, _ = _upload_job()
    th1 = _start_analysis(first, "user_x")
    try:
        deadline = time.monotonic() + 5
        while not analysed and time.monotonic() < deadline:
            time.sleep(0.01)
        assert analysed, "the first analysis holds the only slot"
        job, _ = _upload_job()
        th2 = _start_analysis(job, "user_a")
        deadline = time.monotonic() + 5
        while (M._ANALYZE_SLOTS.position(job.id) != 1
               and time.monotonic() < deadline):
            time.sleep(0.01)
        assert M._ANALYZE_SLOTS.position(job.id) == 1
        assert _in_flight("user_a") == 1
        assert client.delete(f"/jobs/{job.id}").status_code == 200
        # Free at once, before its thread got round to it.
        assert _in_flight("user_a") == 0
        assert job.id not in M._INFLIGHT.job_ids()
        th2.join(5)
        assert not th2.is_alive()
        assert M._ANALYZE_SLOTS.position(job.id) is None
        assert len(analysed) == 1          # never analysed
        # A place given up for good: a worker that comes round later
        # (or this one, again) gets none.
        assert not M._ANALYZE_SLOTS.withdraw(job.id)
    finally:
        gate.set()
        th1.join(10)
    assert store.get(first.id).status == "awaiting_review"


def test_guard_stops_a_deleted_jobs_ffmpeg(tmp_path):
    """The analysis' guard asks `halt` (the job deleted) on its beat:
    this job's child processes (ffmpeg: a long encode checks nothing)
    are killed, and its checks say stop — as a cancel, not as a full
    disk."""
    import subprocess
    import sys

    from backend import worker
    ws = tmp_path / "jobs" / "abc123"
    ws.mkdir(parents=True)
    other = tmp_path / "jobs" / "other"
    other.mkdir(parents=True)
    sleep = "import time; time.sleep(30)"
    mine = subprocess.Popen([sys.executable, "-c", sleep, str(ws / "x")])
    theirs = subprocess.Popen([sys.executable, "-c", sleep, str(other)])
    gone = {"v": False}
    try:
        with worker.DiskGuard("abc123", ws, tmp_path, 0, interval=0.02,
                              halt=lambda: gone["v"]) as guard:
            check = guard.cancel_check()
            assert not check()
            gone["v"] = True
            assert mine.wait(5) is not None
            assert check()
            try:
                guard.progress(lambda msg, pct: None)("x", 1)
            except InterruptedError:
                pass
            else:
                raise AssertionError("the progress callback goes on")
            assert not guard.tripped          # not a disk failure
            assert theirs.poll() is None      # another job's: left alone
    finally:
        for p in (mine, theirs):
            p.kill()
            p.wait(5)


def test_guard_keeps_stopping_what_the_job_starts_later(tmp_path,
                                                         monkeypatch):
    """Halted is for good: what the job starts after the first kill (a
    fallback encode, the proxy) is killed too, every beat until stop() —
    and the halt is watched with the disk check off as well
    (CLEO_DISK_GUARD_S=0)."""
    import subprocess
    import sys

    from backend import worker
    monkeypatch.setenv("CLEO_DISK_GUARD_S", "0")
    monkeypatch.setattr(worker, "_HALT_BEAT_S", 0.02)
    ws = tmp_path / "jobs" / "abc123"
    ws.mkdir(parents=True)
    sleep = "import time; time.sleep(30)"
    gone = {"v": False}
    procs: list = []
    try:
        with worker.DiskGuard("abc123", ws, tmp_path, 0,
                              halt=lambda: gone["v"]) as guard:
            gone["v"] = True
            for step in ("normalize", "fallback", "proxy"):
                p = subprocess.Popen([sys.executable, "-c", sleep,
                                      str(ws / step)])
                procs.append(p)
                assert p.wait(5) is not None, step
            assert guard.cancel_check()() and not guard.tripped
    finally:
        for p in procs:
            p.kill()
            p.wait(5)
