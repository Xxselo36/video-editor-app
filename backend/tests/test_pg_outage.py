"""A database outage while jobs run (backend/main.py _db_retry,
_analysis_failed, _render_failed, _sweep_orphaned_jobs) and the pool
coming back after one (backend/pg.py RECONNECT_TIMEOUT_S).

The worker tests inject the errors Postgres gives while it is down
(psycopg_pool.PoolTimeout, psycopg.OperationalError) into the active
store, so they run in both suite modes; the reconnect test stops and
restarts a Postgres server of its own (skipped without pgserver).
"""
from __future__ import annotations

import os
import shutil
import signal
import threading
import time
from pathlib import Path

import pytest

import backend.main as M
from backend import accounts, jobs
from backend.jobs import store
from conftest import analysis_result

psycopg = pytest.importorskip("psycopg")
from psycopg_pool import PoolTimeout  # noqa: E402

DOWN = "couldn't get a connection after 30.00 sec"


@pytest.fixture
def fast_retry(monkeypatch):
    """_db_retry without the real waits: a few quick tries."""
    monkeypatch.setattr(M, "_DB_RETRY_DELAY_S", 0.01)
    monkeypatch.setattr(M, "_DB_RETRY_S", 0.2)


def _charged_job(owner="user_a", seconds=100):
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    job = store.create(str(f), {}, owner_id=owner)
    accounts.charge(job.id, owner, seconds, enforce=False)
    return job, f


def _analysis(output_dir, on_normalized=None, **kw):
    res = analysis_result(output_dir)
    if on_normalized is not None:
        on_normalized()
    return res


def _gc_prefixes() -> set[str]:
    return {r["prefix"] for r in store.gc_all()}


def _failing(monkeypatch, method, when, times=None, exc=None):
    """Make store.<method> raise `exc` (a PoolTimeout) while when(kwargs)
    holds — `times` times, or always."""
    impl = jobs._open_store()
    real = getattr(impl, method)
    left = {"n": times}

    def fake(*args, **kwargs):
        if when(kwargs) and (left["n"] is None or left["n"] > 0):
            if left["n"] is not None:
                left["n"] -= 1
            raise exc or PoolTimeout(DOWN)
        return real(*args, **kwargs)
    monkeypatch.setattr(impl, method, fake)
    return left


def _refunded(job_id) -> bool:
    return bool(accounts.get_usage(job_id)["refunded"])


# ── analysis ─────────────────────────────────────────────────────────


def test_analysis_result_write_rides_out_a_short_outage(
        auth_on, fast_retry, monkeypatch):
    job, _ = _charged_job()
    monkeypatch.setattr(M, "analyze_only", _analysis)
    left = _failing(monkeypatch, "update",
                    lambda kw: kw.get("status") == "awaiting_review",
                    times=2)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert left["n"] == 0
    assert got.status == "awaiting_review" and got.segments
    assert M.media.size(got.mezz_key) == 4      # stored, workspace gone
    assert not M._workspace(job.id).exists()
    assert not _refunded(job.id)
    assert job.id not in M._active_jobs


def test_analysis_that_cant_be_saved_fails_as_our_fault(
        auth_on, fast_retry, monkeypatch):
    """The database stays down past the retries when the analysis is
    done: an error (not a spinner), the minutes back — files freed only
    once that error state is stored."""
    job, upload = _charged_job()
    monkeypatch.setattr(M, "analyze_only", _analysis)
    _failing(monkeypatch, "update",
             lambda kw: kw.get("status") == "awaiting_review")
    impl = jobs._open_store()
    real = impl.update
    seen = {}

    def update(job_id, **kw):
        if kw.get("status") == "error":
            seen["dir_at_error_write"] = M._workspace(job_id).exists()
        return real(job_id, **kw)
    monkeypatch.setattr(impl, "update", update)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert (got.status, got.error) == ("error", DOWN)
    assert seen == {"dir_at_error_write": True}
    assert not M._workspace(job.id).exists() and not upload.exists()
    # What it had stored already goes (media_gc).
    assert f"jobs/{job.id}/" in _gc_prefixes()
    assert _refunded(job.id)
    assert M._is_infra_failure(PoolTimeout(DOWN), DOWN)
    assert M._is_infra_failure(psycopg.OperationalError("lost"), "lost")


def test_analysis_left_running_by_an_outage_is_settled_by_the_sweep(
        auth_on, fast_retry, monkeypatch):
    """Both the result and the error write fail: nothing is deleted, the
    thread ends (not stuck in _active_jobs), and the sweep — not the
    next deploy — fails the job, refunds it and frees its files."""
    job, upload = _charged_job()
    monkeypatch.setattr(M, "analyze_only",
                        lambda output_dir, **kw: _analysis(output_dir))
    with monkeypatch.context() as outage:
        _failing(outage, "update",
                 lambda kw: kw.get("status") in ("awaiting_review", "error"))
        with pytest.raises(PoolTimeout):
            M._run_analyze_inner(job.id)
    # the database is back
    got = store.get(job.id)
    # (the last progress tick: its results were being stored)
    assert (got.status, got.message) == ("processing", "Saving…")
    # The workspace goes in any case (WP3); the upload stays.
    assert not M._workspace(job.id).exists()
    assert upload.exists()
    assert _refunded(job.id)                # the minutes went back first
    assert job.id not in M._active_jobs
    assert M._sweep_orphaned_jobs() == 0    # not idle long enough yet
    later = time.time() + M._ORPHAN_STALE_S + 1
    assert M._sweep_orphaned_jobs(now=later) == 1
    got = store.get(job.id)
    assert (got.status, got.error) == ("error", "container_restart")
    assert got.input_path is None
    assert _refunded(job.id)
    assert not upload.exists()
    assert f"jobs/{job.id}/" in _gc_prefixes()
    assert M._sweep_orphaned_jobs(now=later) == 0


def _failing_refund(monkeypatch, times=None):
    """accounts.refund raising PoolTimeout `times` times, or always."""
    real = accounts.refund
    calls = []

    def refund(job_id, note=""):
        calls.append(note)
        if times is None or len(calls) <= times:
            raise PoolTimeout(DOWN)
        return real(job_id, note)
    monkeypatch.setattr(accounts, "refund", refund)
    return calls


def test_refund_of_a_failed_analysis_rides_out_a_short_outage(
        auth_on, fast_retry, monkeypatch):
    """The refund of an analysis that failed as our fault is retried like
    the job-state writes: one more blip right after Postgres came back
    used to lose it for good (the job was already 'error', which nothing
    refunds later)."""
    job, upload = _charged_job()
    monkeypatch.setattr(M, "analyze_only", _analysis)
    _failing(monkeypatch, "update",
             lambda kw: kw.get("status") == "awaiting_review")
    calls = _failing_refund(monkeypatch, times=1)
    M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert (got.status, got.error) == ("error", DOWN)
    assert len(calls) == 2 and _refunded(job.id)
    assert not M._workspace(job.id).exists() and not upload.exists()


def test_refund_that_cant_be_written_leaves_the_job_to_the_sweep(
        auth_on, fast_retry, monkeypatch):
    """The refund still fails after its retries: no error state and
    nothing deleted — the job stays running for the sweep, which gives
    the minutes back and frees the files."""
    job, upload = _charged_job()
    monkeypatch.setattr(M, "analyze_only",
                        lambda output_dir, **kw: _analysis(output_dir))
    with monkeypatch.context() as outage:
        _failing(outage, "update",
                 lambda kw: kw.get("status") == "awaiting_review")
        _failing_refund(outage)
        with pytest.raises(PoolTimeout):
            M._run_analyze_inner(job.id)
    got = store.get(job.id)
    assert got.status == "processing" and not _refunded(job.id)
    assert upload.exists()          # (the workspace goes in any case)
    assert job.id not in M._active_jobs
    later = time.time() + M._ORPHAN_STALE_S + 1
    assert M._sweep_orphaned_jobs(now=later) == 1
    got = store.get(job.id)
    assert (got.status, got.error) == ("error", "container_restart")
    assert _refunded(job.id)
    assert not upload.exists()
    assert f"jobs/{job.id}/" in _gc_prefixes()


class _Killed(BaseException):
    """The process dying (SIGKILL after the shutdown grace, OOM kill)."""


def test_kill_while_dropping_the_upload_keeps_the_refund(
        auth_on, fast_retry, monkeypatch):
    """An ffmpeg failure (ours: refund due) before normalizing, and the
    process dies while the upload is deleted: the minutes are already
    back — the job is 'error' by then, which no boot or sweep refunds."""
    job, upload = _charged_job()

    def analysis(output_dir, **kw):
        raise RuntimeError("ffmpeg exited with 1 while normalizing")
    monkeypatch.setattr(M, "analyze_only", analysis)
    seen = {}

    def remove(path):
        got = store.get(job.id)
        seen.update(status=got.status, refunded=_refunded(job.id))
        raise _Killed()
    with monkeypatch.context() as m:
        m.setattr(M, "_remove_upload", remove)
        with pytest.raises(_Killed):
            M._run_analyze_inner(job.id)
    assert seen == {"status": "error", "refunded": True}
    assert store.get(job.id).error.startswith("ffmpeg exited")


def test_start_of_an_analysis_rides_out_a_short_outage(
        fast_retry, monkeypatch):
    job, _ = _charged_job()
    monkeypatch.setattr(M, "analyze_only", _analysis)
    left = _failing(monkeypatch, "get", lambda kw: True, times=2)
    M._run_analyze_inner(job.id)
    assert left["n"] == 0
    assert store.get(job.id).status == "awaiting_review"


# ── render ───────────────────────────────────────────────────────────


def _review_job(tmp_path):
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"n")
    job = store.create("/in.mp4", {}, owner_id="user_a")
    store.update(job.id, status="processing", message="queued",
                 normalized_path=str(src), segments=[(0.0, 1.0)],
                 input_path=None)
    return job


@pytest.fixture
def fake_render(monkeypatch, tmp_path):
    import backend.llm as llm

    def render(**kw):
        key = kw["out_prefix"] + "primary.mp4"
        return {"outputs": {"primary": {"key": key, "size": 1}},
                "thumb": None, "hooks": []}
    monkeypatch.setattr(M.pipeline, "render_to_keys", render)
    monkeypatch.setattr(llm, "generate_social_caption",
                        lambda text, language=None: {"caption": "c",
                                                     "hashtags": []})
    return render


def test_render_rides_out_a_short_outage(fast_retry, fake_render, tmp_path,
                                         monkeypatch):
    job = _review_job(tmp_path)
    got_left = _failing(monkeypatch, "get", lambda kw: True, times=2)
    done_left = _failing(monkeypatch, "update",
                         lambda kw: kw.get("status") == "done", times=2)
    M._run_render_inner(job.id, [{"text": "hi"}])
    assert got_left["n"] == 0 and done_left["n"] == 0
    got = store.get(job.id)
    assert got.status == "done"
    assert got.output_keys == {"primary": f"jobs/{job.id}/r1/primary.mp4"}
    # The legacy job's normalized file became its mezz (lazy backfill).
    assert got.mezz_key == f"jobs/{job.id}/mezz.mp4"


def test_render_left_running_by_an_outage_goes_back_to_review(
        fast_retry, fake_render, tmp_path, monkeypatch):
    job = _review_job(tmp_path)
    with monkeypatch.context() as outage:
        _failing(outage, "update",
                 lambda kw: kw.get("status") in ("done", "awaiting_review"))
        with pytest.raises(PoolTimeout):
            M._run_render_inner(job.id, [{"text": "hi"}])
    assert store.get(job.id).status == "processing"
    assert job.id not in M._active_jobs     # shutdown won't wait for it
    later = time.time() + M._ORPHAN_STALE_S + 1
    assert M._sweep_orphaned_jobs(now=later) == 1
    got = store.get(job.id)
    assert (got.status, got.message) == ("awaiting_review", "render_failed")
    assert Path(got.normalized_path).exists()


def test_render_start_failing_releases_the_job(fast_retry, tmp_path,
                                               monkeypatch):
    """store.get failing for good at the start: the job id doesn't stay
    in _active_jobs (it used to be registered outside the try)."""
    job = _review_job(tmp_path)
    _failing(monkeypatch, "get", lambda kw: True)
    with pytest.raises(PoolTimeout):
        M._run_render_inner(job.id, [])
    assert job.id not in M._active_jobs


def test_sweep_leaves_live_and_fresh_jobs_alone(tmp_path, monkeypatch):
    later = time.time() + M._ORPHAN_STALE_S + 1
    live = store.create("/a.mp4", {})
    store.update(live.id, status="processing")
    waiting = store.create("/b.mp4", {})
    store.update(waiting.id, status="processing", message="queued")
    claim = store.create("/c.mp4", {"_accepting": True})
    done = store.create("/d.mp4", {})
    store.update(done.id, status="done")
    gate = threading.Event()
    worker = threading.Thread(target=gate.wait, daemon=True)
    worker.start()
    try:
        M._INFLIGHT.track(waiting.id, None, "analyze", worker)
        monkeypatch.setattr(M, "_active_jobs", {live.id})
        assert M._sweep_orphaned_jobs(now=later) == 0
        assert M._sweep_orphaned_jobs() == 0
    finally:
        gate.set()
        worker.join()
        M._INFLIGHT.release(waiting.id)
    assert {store.get(j.id).status for j in (live, waiting)} == \
        {"processing"}
    assert store.get(claim.id).status == "pending"
    assert store.get(done.id).status == "done"


# ── the pool after an outage ─────────────────────────────────────────


def _stop(server) -> None:
    pid = server.get_pid()
    os.kill(pid, signal.SIGINT)              # fast shutdown
    for _ in range(200):
        try:
            os.kill(pid, 0)
        except OSError:
            return
        time.sleep(0.05)
    raise AssertionError("postgres did not stop")


def test_pool_serves_again_soon_after_postgres_is_back(pg_server,
                                                       monkeypatch):
    """psycopg_pool's reconnect backoff doubles (1, 2, 4, 8, 16 s …);
    uncapped (reconnect_timeout 300 s), a 17 s outage left the pool down
    until its attempt at ~31 s. With RECONNECT_TIMEOUT_S each cycle
    gives up early and the next request starts a new one from 1 s (the
    cycle is shortened here to keep the test short)."""
    import pgserver
    from conftest import _TMP
    pg = pytest.importorskip("backend.pg")
    assert pg.RECONNECT_TIMEOUT_S <= 30
    monkeypatch.setattr(pg, "RECONNECT_TIMEOUT_S", 3.0)
    data = _TMP / f"pg_outage_{os.getpid()}"
    server = pgserver.get_server(str(data), cleanup_mode=None)
    database = None
    try:
        database = pg.Database(server.get_uri(), max_size=2, name="outage")
        assert database.pool.reconnect_timeout == 3.0
        st = pg.PgJobStore(database)
        st.ping()
        _stop(server)
        down = time.monotonic()
        ok: dict[str, float] = {}

        def load():               # a request every 0.5 s, like /ready polls
            while "at" not in ok and time.monotonic() - down < 120:
                try:
                    st.ping()
                    ok["at"] = time.monotonic()
                except Exception:
                    time.sleep(0.5)
        poller = threading.Thread(target=load, daemon=True)
        poller.start()
        time.sleep(max(0.0, down + 17 - time.monotonic()))
        assert "at" not in ok
        server.ensure_postgres_running()
        up = time.monotonic()
        poller.join(timeout=60)
        assert "at" in ok, "the pool never served again"
        assert ok["at"] - up < 8, f"served {ok['at'] - up:.1f} s after " \
                                  "Postgres was back"
    finally:
        if database is not None:
            database.close()
        try:
            _stop(server)
        except Exception:
            pass
        shutil.rmtree(data, ignore_errors=True)
