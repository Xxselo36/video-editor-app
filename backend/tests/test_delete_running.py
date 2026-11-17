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
from conftest import analysis_result


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
