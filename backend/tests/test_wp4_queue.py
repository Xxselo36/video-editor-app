"""WP4 phase P0: the durable task queue with the `local` executor.

Enqueue with admission (HTTP contract of WP1: 429 / 503 + Retry-After,
queue positions), the render compare-and-set as one task, the leader's
dispatcher / reaper / finalizer, the worker's fencing (attempts), crash
safety (a worker dying mid-analysis or mid-render: lease → reaper →
retry, or dead + refund / back to review), duplicate delivery, a job
deleted while its task runs, the take-over of jobs without a task (the
boot path), error classes and refund rules, provider breakers (Groq,
Anthropic), deploy skew, progress writes and finalizer idempotency.

Runs on the suite's database (SQLite, or Postgres with
CLEO_TEST_DB=postgres); the Postgres-only parts (two dispatchers on two
connections, leader election) use a server of their own.
"""
from __future__ import annotations

import threading
import time
import types
from pathlib import Path

import pytest

import backend.main as M
from backend import accounts, jobs, leader as task_leader, llm, pipeline
from backend import taskq, worker
from backend.jobs import store
from conftest import add_sub, analysis_result

pytestmark = pytest.mark.no_task_leader

V = taskq.WORKER_PROTOCOL


@pytest.fixture(autouse=True)
def queue_on(monkeypatch):
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    monkeypatch.setenv("CLEO_TASK_RETRY_BACKOFF_S", "0,0,0")
    monkeypatch.setenv("CLEO_TASK_HEARTBEAT_S", "0.05")
    monkeypatch.setenv("CLEO_PROVIDER_RETRY_MIN_S", "0")
    for k in ("CLEO_MAX_ANALYZE", "CLEO_MAX_RENDER", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_MAX_RUNNING_INGEST",
              "CLEO_MAX_RUNNING_RENDER", "CLEO_GROQ_ASH_BUDGET",
              "CLEO_PROVIDER_HOLD_S", "CLEO_LLM_OUTAGE_POLICY",
              "CLEO_FAULT_GROQ_429", "CLEO_TASK_LEASE_S", "MODAL_TOKEN_ID",
              "CLEO_DISK_FACTOR"):
        monkeypatch.delenv(k, raising=False)
    import backend.llm
    monkeypatch.setattr(backend.llm, "_client", lambda: None)


def ts():
    return jobs.task_store()


@pytest.fixture
def leader():
    """A leader driven by hand (no threads of its own besides the
    workers it spawns): dispatch_once / finalize_once / reap_once."""
    ld = task_leader.Leader(M._QueueOps(periodic=False))
    yield ld
    ld.stop(grace_s=5)


def _wait_for(pred, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _settle(ld, timeout=15.0):
    """Dispatch and finalize until nothing is in flight."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        ld.dispatch_once()
        ld.finalize_once()
        s = ts()
        if (not any(s.counts(k)[0] or s.counts(k)[1] for k in ("ingest",
                                                                "render"))
                and not s.unfinalized()):
            return True
        time.sleep(0.02)
    raise AssertionError(f"queue didn't settle: {ts().queued()} "
                         f"{ts().unfinalized()}")


def _upload_job(owner=None, seconds=None, settings=None, enqueue=True,
                source_key=None):
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"x")
    job = store.create(str(f), settings or {}, owner_id=owner,
                       source_key=source_key)
    if owner and seconds:
        accounts.charge(job.id, owner, seconds, enforce=False)
    tid = None
    if enqueue:
        tid, _ = ts().enqueue(
            job.id, "ingest", {"v": V, "job_id": job.id, "est_audio_s": 10,
                               "size": 0},
            owner_id=owner, job_change=dict(status="processing",
                                            message="queued"))
    return store.get(job.id), tid


def _review_job(**fields):
    job = store.create(None, {})
    base = dict(status="awaiting_review", segments=[(0.0, 4.0)],
                mezz_key=f"jobs/{job.id}/mezz.mp4", render_gen=0)
    base.update(fields)
    store.update(job.id, **base)
    return store.get(job.id)


def _ok_render(**kw):
    return {"outputs": {"primary": {"key": kw["out_prefix"] + "p.mp4",
                                    "size": 1}},
            "thumb": None, "hooks": []}


@pytest.fixture
def analysis(monkeypatch):
    """The analysis the worker runs (M.analyze_only, bound through
    backend.worker): behaviour per call from `plan` (a result factory
    or an exception), `gate` an optional Event it waits for."""
    state = {"plan": [], "calls": 0, "gate": None, "started": []}

    def analyze(input_path, output_dir, settings, progress_cb, **kw):
        state["calls"] += 1
        state["started"].append(output_dir)
        progress_cb("Analyzing audio…", 10)
        if state["gate"] is not None:
            assert state["gate"].wait(20)
        step = state["plan"].pop(0) if state["plan"] else None
        if isinstance(step, BaseException):
            raise step
        if callable(step):
            return step(output_dir)
        return analysis_result(output_dir, 30.0)
    monkeypatch.setattr(M, "analyze_only", analyze)
    return state


def _events(kind=None):
    return [e for e in store.events(0) if kind is None or e["kind"] == kind]


# ── store: enqueue, claim, fencing ───────────────────────────────────


def test_one_active_task_per_job_and_kind():
    job, tid = _upload_job()
    with pytest.raises(taskq.TaskActive):
        ts().enqueue(job.id, "ingest", {"v": V})
    assert [t.id for t in ts().for_job(job.id)] == [tid]
    # A task of another kind is fine; a terminal one frees the slot.
    rid, _ = ts().enqueue(job.id, "render", {"v": V})
    assert rid is not None


def test_claim_increments_attempts_and_fences_old_attempts():
    job, tid = _upload_job()
    [t] = ts().claim_for_dispatch("ingest", 5, "L", 300, "local")
    assert (t.state, t.attempts) == ("dispatching", 1)
    assert ts().worker_claim(tid, 1, "w1", 180).state == "running"
    assert ts().heartbeat(tid, 1, 180)
    # Lease lost → requeued; the old attempt is fenced out everywhere.
    assert ts().requeue(tid, expect_states=("running",), attempts=1) == "queued"
    assert not ts().heartbeat(tid, 1, 180)
    [t2] = ts().claim_for_dispatch("ingest", 5, "L", 300, "local")
    assert t2.attempts == 2
    assert ts().commit_success(tid, 1, {}, job.id, "processing",
                               {"status": "done"}) == "fenced"
    assert not ts().report_failure(tid, 1, "infra", "x", True)
    assert ts().worker_claim(tid, 1, "zombie", 180) is None
    assert store.get(job.id).status == "processing"


def test_attempts_never_decrease():
    job, tid = _upload_job()
    seen = []

    def attempts():
        seen.append(ts().get(tid).attempts)
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    attempts()
    # A spawn that never ran: back without spending the attempt.
    ts().requeue(tid, expect_states=("dispatching",), attempts=1, free=True)
    attempts()
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    ts().worker_claim(tid, 2, "w", 180)
    ts().report_failure(tid, 2, taskq.PROVIDER_GROQ, "429", True,
                        {"retry_after_s": 1})
    ts().requeue(tid, expect_states=("failed",), attempts=2, free=True,
                 provider_wait=True)
    attempts()
    t = ts().get(tid)
    assert (t.provider_waits, t.max_attempts) == (1, 5)
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    attempts()
    assert seen == sorted(seen) and seen[-1] == 3


# ── the happy path through the queue ─────────────────────────────────


def test_analysis_runs_through_the_queue(leader, analysis, auth_on):
    job, tid = _upload_job(owner="user_a", seconds=40)
    _settle(leader)
    got = store.get(job.id)
    assert got.status == "awaiting_review" and got.mezz_key
    assert got.input_path is None                       # upload freed
    assert not Path(job.input_path).exists()
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("succeeded", 1) and t.finalized_at
    assert [e["kind"] for e in _events()] == ["analysis_done"]
    assert accounts.get_usage(job.id)["seconds_actual"] == 30.0  # true-up
    # Nothing is written into jobs.data.queue_position with the queue.
    assert got.queue_position is None


def test_render_through_the_queue_and_superseded_render_gc(leader,
                                                           monkeypatch,
                                                           client):
    monkeypatch.setattr(pipeline, "render_to_keys", _ok_render)
    job = _review_job(output_keys={"primary": "jobs/x/r0/p.mp4"})
    job = _review_job()
    r = client.post(f"/jobs/{job.id}/render", json={"subtitles": []})
    assert r.status_code == 200 and r.json()["status"] == "processing"
    _settle(leader)
    got = store.get(job.id)
    assert (got.status, got.render_gen) == ("done", 1)
    [ev] = _events("render_done")
    assert ev["data"]["gen"] == 1 and ev["data"]["wall_s"] >= 0
    # Render again: the new commit queues the old r1/ for a day later.
    store.update(job.id, status="awaiting_review")
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": []}).status_code == 200
    _settle(leader)
    rows = store.gc_all()
    assert [r["prefix"] for r in rows] == [f"jobs/{job.id}/r1/"]
    assert rows[0]["not_before"] > time.time() + 86000


def test_render_cas_one_task_for_thirty_posts(client):
    job = _review_job()
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
    assert [t.kind for t in ts().for_job(job.id)] == ["render"]
    assert store.get(job.id).render_gen == 1


# ── admission over HTTP (ported from WP1) ────────────────────────────


def _body_upload(client, headers=None):
    return client.post("/jobs", headers=headers or {},
                       data={"settings": "{}"},
                       files={"file": ("clip.mp4", b"x" * 64, "video/mp4")})


def test_positions_move_and_only_the_limit_runs(client, leader, analysis,
                                                monkeypatch):
    monkeypatch.setenv("CLEO_MAX_RUNNING_INGEST", "1")
    monkeypatch.setattr(M, "_probe_duration", lambda p: 10.0)
    analysis["gate"] = threading.Event()
    ids = []
    for i in range(3):
        r = _body_upload(client)
        assert r.status_code == 200, r.text
        body = r.json()
        assert (body["status"], body["message"]) == ("processing", "queued")
        assert body["queue_position"] == (None if i == 0 else i)
        ids.append(body["job_id"])
    leader.dispatch_once()
    assert _wait_for(lambda: analysis["calls"] == 1)

    def status():
        rows = client.get("/jobs/status",
                          params={"ids": ",".join(ids)}).json()["jobs"]
        return [(j["message"], j["queue_position"]) for j in rows]
    st = status()
    assert st[0][1] is None and st[1:] == [("queued", 1), ("queued", 2)]
    analysis["gate"].set()
    _settle(leader)
    assert [store.get(i).status for i in ids] == ["awaiting_review"] * 3
    assert [s[1] for s in status()] == [None] * 3


def test_queue_cap_is_503_with_retry_after(client, monkeypatch):
    monkeypatch.setattr(M, "_probe_duration", lambda p: 10.0)
    monkeypatch.setenv("CLEO_MAX_RUNNING_INGEST", "1")
    monkeypatch.setenv("CLEO_MAX_QUEUE", "1")
    assert _body_upload(client).status_code == 200   # would run
    assert _body_upload(client).status_code == 200   # waits (1 in line)
    r = _body_upload(client)
    assert r.status_code == 503 and r.headers["retry-after"] == "120"
    assert r.json() == {"detail": "server_busy"}
    assert len(store.list_all()) == 2                 # the claim is gone
    assert client.post("/uploads/presign", json={}).json() == {
        "detail": "server_busy"}


def test_ten_concurrent_uploads_of_one_user(client, enforce, bearer,
                                            monkeypatch):
    """Exactly the per-user limit gets in; the others are refused 429
    and have no charge left in the ledger."""
    add_sub(plan="pro", period_start=time.time() - 60)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 60.0)
    monkeypatch.setattr(M, "_probe_audio", lambda p: True)
    # Past the soft check at once (it has no lock): the binding check in
    # the enqueue transaction decides.
    monkeypatch.setattr(M, "_queue_soft_check", lambda user: None)
    codes: list[int] = []
    barrier = threading.Barrier(10)

    def post():
        barrier.wait()
        codes.append(_body_upload(client, bearer()).status_code)
    threads = [threading.Thread(target=post) for _ in range(10)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(codes) == [200, 200] + [429] * 8
    active = [j for j in store.list_all()
              if j.status in ("pending", "processing")]
    assert len(active) == 2
    rows = accounts._read("SELECT * FROM usage")
    assert sum(1 for r in rows if not r["refunded"]) == 2
    assert {r["job_id"] for r in rows if not r["refunded"]} == {
        j.id for j in active}


def test_service_user_yields_in_order(monkeypatch):
    monkeypatch.setenv("CLEO_PRIORITY_OFFSETS_S", '{"service": 600}')
    svc = store.create(None, {})
    ts().enqueue(svc.id, "ingest", {"v": V},
                 sort_offset_s=taskq.priority_offset_s(None, service=True))
    user = store.create(None, {})
    ts().enqueue(user.id, "ingest", {"v": V},
                 sort_offset_s=taskq.priority_offset_s("starter"))
    studio = store.create(None, {})
    ts().enqueue(studio.id, "ingest", {"v": V},
                 sort_offset_s=taskq.priority_offset_s("studio"))
    assert [t.job_id for t in ts().queued("ingest")] == [
        studio.id, user.id, svc.id]


def test_delete_refused_while_processing_and_takes_stale_tasks_along(
        client):
    job, _tid = _upload_job()
    assert client.delete(f"/jobs/{job.id}").status_code == 409
    store.update(job.id, status="error")      # settled elsewhere
    assert client.delete(f"/jobs/{job.id}").status_code == 200
    assert ts().for_job(job.id) == []


def test_presign_per_user_limit_from_the_database(client, auth_on, bearer,
                                                  monkeypatch, r2):
    monkeypatch.setenv("CLEO_MAX_ACTIVE_PER_USER", "1")
    _upload_job(owner="user_a")
    r = client.post("/uploads/presign", headers=bearer("user_a"), json={})
    assert (r.status_code, r.json()) == (429,
                                         {"detail": "too_many_active_jobs"})
    assert client.post("/uploads/presign", headers=bearer("user_b"),
                       json={}).status_code == 200


# ── crash safety ─────────────────────────────────────────────────────


def _kill_worker_mid_task(tid, attempt):
    """A worker that claimed the task and died: no heartbeat, its lease
    is in the past."""
    assert ts().worker_claim(tid, attempt, "dead-worker", 0.01)
    time.sleep(0.05)


def test_worker_death_mid_analysis_is_retried(leader, analysis, auth_on):
    job, tid = _upload_job(owner="user_a", seconds=40)
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    _kill_worker_mid_task(tid, 1)
    assert leader.reap_once(force=True) == 1
    t = ts().get(tid)
    assert (t.state, t.attempts, t.error_code) == ("queued", 1,
                                                   "lease_expired")
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("succeeded", 2)
    assert store.get(job.id).status == "awaiting_review"
    assert len(_events("analysis_done")) == 1
    assert not accounts.get_usage(job.id)["refunded"]


def test_reaper_waits_out_its_grace(leader):
    _job, tid = _upload_job()
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    _kill_worker_mid_task(tid, 1)
    leader.leader_since = time.monotonic()
    assert leader.reap_once() == 0                  # just took over
    assert ts().get(tid).state == "running"


def test_worker_dies_every_time_analysis_dead_and_refunded_once(
        leader, auth_on):
    job, tid = _upload_job(owner="user_a", seconds=40)
    for attempt in (1, 2, 3):
        ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
        _kill_worker_mid_task(tid, attempt)
        leader.reap_once(force=True)
    t = ts().get(tid)
    assert (t.state, t.error_code) == ("dead", taskq.ATTEMPTS_EXHAUSTED)
    leader.finalize_once()
    leader.finalize_once()
    got = store.get(job.id)
    assert got.status == "error" and got.refunded is True
    assert "interrupted" in got.message
    assert accounts.get_usage(job.id)["refunded"]
    assert [e["kind"] for e in _events()] == ["analysis_failed"]
    assert {r["prefix"] for r in store.gc_all()} >= {f"jobs/{job.id}/"}


def test_worker_death_mid_render_back_to_review_when_exhausted(leader,
                                                               client):
    job = _review_job()
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": []}).status_code == 200
    [task] = ts().for_job(job.id)
    for attempt in (1, 2, 3):
        ts().claim_for_dispatch("render", 1, "L", 300, "local")
        _kill_worker_mid_task(task.id, attempt)
        leader.reap_once(force=True)
    leader.finalize_once()
    got = store.get(job.id)
    assert (got.status, got.message, got.error_code) == (
        "awaiting_review", "render_failed", "render_unavailable")
    assert got.error.startswith("render_unavailable")
    [ev] = _events("render_failed")
    assert ev["data"]["code"] == "render_unavailable"
    assert [r["prefix"] for r in store.gc_all()] == [f"jobs/{job.id}/r1/"]


def test_dispatch_never_claimed_is_taken_back(leader, analysis):
    """The leader died after the claim, before the spawn (outbox): the
    start lease runs out, the reaper requeues, the job completes."""
    job, tid = _upload_job()
    ts().claim_for_dispatch("ingest", 1, "L", 0.01, "local")
    time.sleep(0.05)
    assert leader.reap_once(force=True) == 1
    _settle(leader)
    assert store.get(job.id).status == "awaiting_review"
    assert ts().get(tid).attempts == 2


def test_duplicate_delivery_commits_once(analysis):
    """The same attempt run twice (a rerun under the same call): one
    commit, the other a fenced no-op."""
    job, tid = _upload_job()
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    analysis["gate"] = threading.Event()
    out: list[dict] = []
    runs = [threading.Thread(target=lambda: out.append(
        worker.run("ingest", tid, job.id, 1, V))) for _ in range(2)]
    [r.start() for r in runs]
    assert _wait_for(lambda: analysis["calls"] == 2)
    analysis["gate"].set()
    [r.join(20) for r in runs]
    assert sorted(map(str, out)) == sorted(map(str, [
        {"committed": True}, {"skipped": "fenced"}]))
    assert store.get(job.id).status == "awaiting_review"


def test_zombie_commit_after_reclaim_changes_nothing(analysis):
    job, tid = _upload_job()
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    analysis["gate"] = threading.Event()
    out: list[dict] = []
    th = threading.Thread(target=lambda: out.append(
        worker.run("ingest", tid, job.id, 1, V)))
    th.start()
    assert _wait_for(lambda: analysis["calls"] == 1)
    # Its lease is taken away meanwhile (a DB outage, a hang): requeued,
    # attempt 2 claimed and committed by someone else.
    assert ts().requeue(tid, expect_states=("running",),
                        attempts=1) == "queued"
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    ts().worker_claim(tid, 2, "w2", 180)
    assert ts().commit_success(tid, 2, {}, job.id, "processing", {
        "status": "awaiting_review", "mezz_key": "WINNER"}) == "ok"
    analysis["gate"].set()
    th.join(20)
    assert out == [{"skipped": "fenced"}]
    got = store.get(job.id)
    assert (got.status, got.mezz_key) == ("awaiting_review", "WINNER")


def test_job_deleted_while_its_task_runs(analysis):
    job, tid = _upload_job()
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    analysis["gate"] = threading.Event()
    out: list[dict] = []
    th = threading.Thread(target=lambda: out.append(
        worker.run("ingest", tid, job.id, 1, V)))
    th.start()
    assert _wait_for(lambda: analysis["calls"] == 1)
    M._delete_job(store.get(job.id))
    assert ts().for_job(job.id) == []
    analysis["gate"].set()
    th.join(20)
    assert out == [{"skipped": "fenced"}]
    assert store.get(job.id) is None
    assert ts().unfinalized() == []


def test_shutdown_interrupts_and_the_next_leader_reruns(analysis):
    job, tid = _upload_job()
    first = task_leader.Leader(M._QueueOps(periodic=False))
    analysis["gate"] = threading.Event()
    first.dispatch_once()
    assert _wait_for(lambda: analysis["calls"] == 1)

    def cancelled_analysis(output_dir):
        raise InterruptedError("Cancelled")
    analysis["plan"] = [cancelled_analysis]
    threading.Timer(0.3, analysis["gate"].set).start()
    first.stop(grace_s=0.1)
    t = ts().get(tid)
    assert (t.state, t.error_code) == ("failed", taskq.INTERRUPTED)
    second = task_leader.Leader(M._QueueOps(periodic=False))
    try:
        _settle(second)
    finally:
        second.stop(grace_s=5)
    t = ts().get(tid)
    assert t.state == "succeeded" and t.max_attempts == 4  # a free retry
    assert store.get(job.id).status == "awaiting_review"


# ── take-over of jobs without a task (replaces the boot scans) ───────


def test_takeover_requeues_settles_and_leaves_queued_jobs(r2, auth_on):
    key = "uploads/0123456789abcdef0123456789abcdef.mp4"
    r2.put_object(Bucket="cleo-test-media", Key=key, Body=b"v")
    resumable, _ = _upload_job(enqueue=False, source_key=key,
                               owner="user_a", seconds=30)
    Path(resumable.input_path).unlink()
    store.update(resumable.id, status="processing", message="Transcribing…")
    lost, _ = _upload_job(enqueue=False, owner="user_a", seconds=30)
    Path(lost.input_path).unlink()
    store.update(lost.id, status="processing")
    rendering = _review_job(status="processing")
    queued, qtid = _upload_job()
    claim = store.create(None, {"_accepting": True})
    M._QueueOps(periodic=False).on_leadership()
    assert store.get(resumable.id).status == "processing"
    assert ts().active_task(resumable.id, "ingest") is not None
    got = store.get(lost.id)
    assert (got.status, got.error) == ("error", "container_restart")
    assert accounts.get_usage(lost.id)["refunded"]
    assert store.get(rendering.id).status == "awaiting_review"
    assert store.get(queued.id).status == "processing"
    assert [t.id for t in ts().for_job(queued.id)] == [qtid]
    assert store.get(claim.id).status == "pending"
    M._QueueOps(periodic=False).on_leadership()      # idempotent
    assert len(ts().for_job(resumable.id)) == 1


def test_boot_in_queue_mode_does_not_fail_queued_jobs(monkeypatch):
    from fastapi.testclient import TestClient
    job, tid = _upload_job()
    monkeypatch.setattr(M, "_prerender_caption_previews", lambda: None)
    ld_cls = task_leader.Leader
    started = []

    class NoLoops(ld_cls):
        def start(self):
            started.append(self)
            return self
    monkeypatch.setattr(task_leader, "Leader", NoLoops)
    with TestClient(M.app):
        assert store.get(job.id).status == "processing"
        assert ts().get(tid).state == "queued"
    assert len(started) == 1


def test_task_of_a_job_settled_elsewhere_does_no_work(leader, analysis):
    """After queue → WP1 → queue: WP1's boot failed the job, its task is
    still queued. Dispatched again, it ends at once without work."""
    job, tid = _upload_job()
    store.update(job.id, status="error", error="container_restart")
    _settle(leader)
    assert analysis["calls"] == 0
    assert ts().get(tid).error_code == taskq.JOB_CHANGED
    assert store.get(job.id).error == "container_restart"
    assert _events() == []


# ── error classes ────────────────────────────────────────────────────


@pytest.mark.parametrize("speech,refunded", [(0.0, True), (40.0, False)])
def test_no_speech_is_content_no_retry_and_refund_rule(leader, analysis,
                                                       auth_on, speech,
                                                       refunded):
    job, tid = _upload_job(owner="user_a", seconds=100)
    analysis["plan"] = [pipeline.NoSpeechError(speech_seconds=speech)]
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.error_code, t.attempts) == (
        "failed", taskq.CONTENT_NO_SPEECH, 1)
    got = store.get(job.id)
    assert (got.status, got.error_code) == ("error", "no_speech")
    assert got.error == "No speech detected in the video."
    assert bool(accounts.get_usage(job.id)["refunded"]) is refunded
    assert got.refunded is (True if refunded else None)
    [ev] = _events("analysis_failed")
    assert ev["data"]["code"] == "no_speech"


def test_content_failure_is_trued_up_by_what_was_processed(
        leader, analysis, auth_on, monkeypatch):
    job, _tid = _upload_job(owner="user_a", seconds=100)

    def fail_after_normalize(output_dir):
        Path(output_dir, "normalized.mp4").write_bytes(b"n")
        raise ValueError("nothing to apply")
    analysis["plan"] = [fail_after_normalize]
    monkeypatch.setattr(M, "_probe_duration", lambda p: 130.0)
    _settle(leader)
    usage = accounts.get_usage(job.id)
    assert not usage["refunded"] and usage["seconds_actual"] == 130.0
    got = store.get(job.id)
    assert (got.status, got.error_code, got.refunded) == ("error", None, None)


def test_infra_failures_are_retried_then_succeed(leader, analysis,
                                                 auth_on):
    job, tid = _upload_job(owner="user_a", seconds=40)
    analysis["plan"] = [OSError("R2 hiccup"), OSError("again")]
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("succeeded", 3)
    assert store.get(job.id).status == "awaiting_review"
    assert not accounts.get_usage(job.id)["refunded"]
    assert [e["kind"] for e in _events()] == ["analysis_done"]


def test_infra_failures_exhausted_error_and_one_refund(leader, analysis,
                                                       auth_on):
    job, tid = _upload_job(owner="user_a", seconds=40)
    analysis["plan"] = [OSError("disk")] * 3
    _settle(leader)
    assert ts().get(tid).state == "dead"
    got = store.get(job.id)
    assert got.status == "error" and got.refunded is True
    assert [e["kind"] for e in _events()] == ["analysis_failed"]


def test_function_timeout_is_not_retried(leader, analysis):
    class FunctionTimeoutError(Exception):
        pass
    job, tid = _upload_job()
    analysis["plan"] = [FunctionTimeoutError("3600 s")]
    _settle(leader)
    t = ts().get(tid)
    assert (t.error_code, t.attempts) == (taskq.TIMEOUT, 1)
    assert store.get(job.id).status == "error"


def test_refused_upload_is_an_analysis_refused_event(leader, analysis,
                                                     monkeypatch):
    job, _tid = _upload_job(settings={"_measure_length": True})
    monkeypatch.setattr(M, "_probe_duration", lambda p: 99999.0)
    _settle(leader)
    got = store.get(job.id)
    assert (got.status, got.error_code) == ("error", "video_too_long")
    assert [e["kind"] for e in _events()] == ["analysis_refused"]
    assert analysis["calls"] == 0


@pytest.mark.parametrize("exc,code", [
    (RuntimeError("Render produced no output clips."), "render_failed"),
    (pipeline.RenderUnavailableError("gave up", code="render_timeout"),
     "render_timeout"),
    (pipeline.RenderUnavailableError("spend limit",
                                     code="render_unavailable"),
     "render_unavailable"),
])
def test_render_failure_codes(leader, client, monkeypatch, exc, code):
    def render(**kw):
        raise exc
    monkeypatch.setattr(pipeline, "render_to_keys", render)
    job = _review_job()
    client.post(f"/jobs/{job.id}/render", json={"subtitles": []})
    _settle(leader)
    got = store.get(job.id)
    assert (got.status, got.message, got.error_code) == (
        "awaiting_review", "render_failed", code)
    [ev] = _events("render_failed")
    assert ev["data"]["code"] == code
    assert ts().for_job(job.id)[0].attempts == 1


# ── provider breakers ────────────────────────────────────────────────


def _groq_error(retry_after):
    from backend.whisper_groq import GroqTranscriptionError
    err = GroqTranscriptionError("transcription_unavailable: 429")
    err.retry_after_s = retry_after
    return err


def test_groq_long_retry_after_opens_the_breaker_and_holds(
        leader, analysis, auth_on, monkeypatch):
    job, tid = _upload_job(owner="user_a", seconds=40)
    other, otid = _upload_job()
    monkeypatch.setenv("CLEO_MAX_RUNNING_INGEST", "1")
    analysis["plan"] = [_groq_error(900.0)]
    leader.dispatch_once()
    assert _wait_for(lambda: ts().get(tid).state == "failed")
    leader.finalize_once()
    t = ts().get(tid)
    assert (t.state, t.attempts, t.max_attempts, t.provider_waits) == (
        "queued", 1, 4, 1)
    b = ts().breaker("groq")
    assert b.state(time.time()) == "open" and b.open_until > time.time() + 800
    # Held: nothing dispatched, positions carry the capacity hint.
    assert leader.dispatch_once()["ingest"] == 0
    assert ts().position(other.id)[1] == "capacity"
    # Waiting past the hold → given up, refunded.
    monkeypatch.setenv("CLEO_PROVIDER_HOLD_S", "0")
    leader.reap_once(force=True)
    _settle(leader)
    got = store.get(job.id)
    assert got.status == "error" and got.refunded is True
    assert store.get(other.id).status == "error"


def test_groq_storm_opens_after_five_then_half_open_recovers(
        leader, analysis):
    for _ in range(5):
        _upload_job()
    analysis["plan"] = [_groq_error(None)] * 5
    for _ in range(3):   # 2 at a time (the default limit)
        leader.dispatch_once()
        _wait_for(lambda: not ts().counts("ingest")[1])
        leader.finalize_once()
    b = ts().breaker("groq")
    assert b.state(time.time()) == "open" and b.opens == 1
    # The open period passes: half-open lets one probe through.
    ts().update_breaker("groq", lambda b: taskq.Breaker(
        **{**b.__dict__, "open_until": time.time() - 1}))
    assert leader.dispatch_once()["ingest"] == 1
    _settle(leader)
    assert ts().breaker("groq").state(time.time()) == "closed"
    assert all(j.status == "awaiting_review" for j in store.list_all())


def test_groq_budget_gate_holds(leader, analysis, monkeypatch):
    monkeypatch.setenv("CLEO_GROQ_ASH_BUDGET", "15")
    a, _ = _upload_job()
    b, _ = _upload_job()
    analysis["gate"] = threading.Event()
    assert leader.dispatch_once()["ingest"] == 1     # 10 of 15 audio-s
    assert ts().position(b.id) == (1, "capacity")
    analysis["gate"].set()
    _wait_for(lambda: not ts().counts("ingest")[1])
    assert leader.dispatch_once()["ingest"] == 0     # still in the hour


class RateLimitError(Exception):
    """Same class name as anthropic.RateLimitError."""

    def __init__(self, message, body):
        super().__init__(message)
        self.message = message
        self.body = body
        self.status_code = 429


SPEND = {"type": "error", "error": {
    "type": "rate_limit_error",
    "message": "enforced_spend_limit_reached: your workspace has reached "
               "its spend limit"}}


@pytest.fixture
def spend_limited(monkeypatch):
    calls = []

    class Messages:
        def create(self, **kw):
            calls.append(kw)
            raise RateLimitError("rate limited", SPEND)
    monkeypatch.setattr(llm, "_client", lambda: types.SimpleNamespace(
        messages=Messages()))
    return calls


def test_anthropic_spend_limit_holds_then_degrades(leader, analysis,
                                                   spend_limited,
                                                   monkeypatch):
    def with_cleanup(output_dir):
        llm.cleanup_transcript([{"id": 0, "text": "hello"}])
        return analysis_result(output_dir, 30.0)
    job, tid = _upload_job()
    analysis["plan"] = [with_cleanup, with_cleanup]
    leader.dispatch_once()
    assert _wait_for(lambda: ts().get(tid).state == "failed")
    assert ts().get(tid).error_code == taskq.PROVIDER_ANTHROPIC
    leader.finalize_once()
    assert ts().breaker("anthropic").state(time.time()) == "open"
    assert ts().get(tid).state == "queued"
    assert leader.dispatch_once()["ingest"] == 0     # held (hold policy)
    monkeypatch.setenv("CLEO_PROVIDER_HOLD_S", "0")  # ... until it's over
    _settle(leader)
    got = store.get(job.id)
    assert got.status == "awaiting_review"
    assert got.processing_warnings == ["llm_skipped:cleanup"]
    assert got.to_dict()["processing_warnings"] == ["llm_skipped:cleanup"]
    assert len(spend_limited) == 1                    # skipped, not called


def test_render_proceeds_without_hooks_while_anthropic_is_out(
        leader, client, spend_limited, monkeypatch):
    ts().update_breaker("anthropic", lambda b: taskq.Breaker(
        provider="anthropic", open_until=time.time() + 3600, opens=1,
        updated_at=time.time()))
    hooks_seen = []

    def render(**kw):
        hooks_seen.append(llm.detect_hook_moments(
            [{"id": 0, "text": "x", "start": 0, "end": 30}]))
        return _ok_render(**kw)
    monkeypatch.setattr(pipeline, "render_to_keys", render)
    job = _review_job()
    client.post(f"/jobs/{job.id}/render",
                json={"subtitles": [{"text": "hello"}]})
    _settle(leader)
    got = store.get(job.id)
    assert got.status == "done" and hooks_seen == [[]]
    assert set(got.processing_warnings) == {"llm_skipped:hooks",
                                            "llm_skipped:caption"}
    assert spend_limited == []


def test_breaker_math():
    b = taskq.Breaker("groq")
    now = 1000.0
    for i in range(4):
        b, opened = taskq.breaker_failure(b, now + i)
        assert not opened
    b, opened = taskq.breaker_failure(b, now + 5)
    assert opened and b.open_until == now + 5 + 60
    # Half-open: one failed probe re-opens, backed off.
    b, opened = taskq.breaker_failure(b, now + 100)
    assert opened and b.open_until == now + 100 + 120 and b.opens == 2
    assert taskq.breaker_success(b, now + 300).state(now + 300) == "closed"
    b, opened = taskq.breaker_failure(taskq.Breaker("groq"), now,
                                      retry_after_s=900)
    assert opened and b.open_until == now + 900


def test_llm_classification():
    assert llm.classify_error(RateLimitError("x", SPEND)) == llm.SPEND_LIMIT
    assert llm.classify_error(RateLimitError("slow down", {})) == \
        llm.UNAVAILABLE
    err = RuntimeError("billing")
    err.status_code = 402
    assert llm.classify_error(err) == llm.SPEND_LIMIT
    assert llm.classify_error(ValueError("bad json")) == llm.OTHER


def test_llm_without_observer_is_unchanged(spend_limited):
    """The WP1 path: no observer — the same soft skip as before."""
    assert llm.cleanup_transcript([{"id": 0, "text": "x"}]) == {}
    assert len(spend_limited) == 1


# ── deploy skew, progress, finalizer idempotency ─────────────────────


def test_protocol_mismatch_is_retried_and_passes_after_deploy(
        leader, analysis, monkeypatch):
    job, tid = _upload_job()
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    out = worker.run("ingest", tid, job.id, 1, V + 1)
    assert out == {"failed": taskq.PROTOCOL_MISMATCH}
    leader.finalize_once()
    assert ts().get(tid).state == "queued"
    # "Deploy": the worker now speaks V + 1.
    monkeypatch.setattr(worker, "WORKER_PROTOCOL", V + 1)
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    assert worker.run("ingest", tid, job.id, 2, V + 1) == {"committed": True}
    assert store.get(job.id).status == "awaiting_review"


def test_schema_behind_is_retried(leader, analysis, monkeypatch):
    job, tid = _upload_job()
    monkeypatch.setattr(type(ts()), "schema_version", lambda self: 4)
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    assert worker.run("ingest", tid, job.id, 1, V) == {
        "failed": taskq.SCHEMA_BEHIND}
    monkeypatch.undo()
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    monkeypatch.setenv("CLEO_TASK_RETRY_BACKOFF_S", "0,0,0")
    monkeypatch.setattr(M, "analyze_only", lambda **kw: analysis_result(
        kw["output_dir"], 30.0))
    _settle(leader)
    assert store.get(job.id).status == "awaiting_review"


def test_late_progress_never_overwrites_a_result():
    job = store.create(None, {})
    store.update(job.id, status="processing")
    p = worker.ProgressWriter(job.id, interval=0.2)
    p("working", 50.0)
    p("still working", 60.0)                 # pending, flushed by a timer
    store.update(job.id, status="awaiting_review", message="Review subtitles",
                 progress=100.0)
    time.sleep(0.35)
    got = store.get(job.id)
    assert (got.status, got.message, got.progress) == (
        "awaiting_review", "Review subtitles", 100.0)
    p.close()


def test_progress_is_merged_into_the_row():
    job = store.create(None, {}, owner_id="u", filename="a.mp4")
    store.update(job.id, status="processing", subtitles=[{"text": "keep"}])
    assert store.patch_status(job.id, ("processing",), message="Halfway",
                              progress=50.0)
    got = store.get(job.id)
    assert (got.message, got.progress, got.filename) == ("Halfway", 50.0,
                                                         "a.mp4")
    assert got.subtitles == [{"text": "keep"}]
    store.update(job.id, status="done")
    assert not store.patch_status(job.id, ("processing",), message="late")


def test_finalizer_crash_between_side_effects_refunds_once(leader,
                                                           auth_on,
                                                           monkeypatch):
    job, tid = _upload_job(owner="user_a", seconds=40)
    ts().claim_for_dispatch("ingest", 1, "L", 300, "local")
    ts().worker_claim(tid, 1, "w", 180)
    ts().report_failure(tid, 1, taskq.INFRA, "boom", False,
                        {"refund": True, "infra": True, "message": "boom",
                         "error": "boom"})
    real = ts().mark_finalized
    fails = {"n": 1}

    def flaky(task_id, event=None):
        if fails["n"]:
            fails["n"] -= 1
            raise RuntimeError("crash after the side effects")
        return real(task_id, event=event)
    monkeypatch.setattr(ts(), "mark_finalized", flaky)
    assert leader.finalize_once() == 0
    assert leader.finalize_once() == 1
    assert leader.finalize_once() == 0
    rows = accounts._read("SELECT * FROM usage WHERE job_id = ?", (job.id,))
    assert len(rows) == 1 and rows[0]["refunded"]
    assert [e["kind"] for e in _events()] == ["analysis_failed"]
    assert store.get(job.id).refunded is True


def test_finalizer_success_true_up_once(leader, analysis, auth_on,
                                        monkeypatch):
    job, _tid = _upload_job(owner="user_a", seconds=10)
    analysis["plan"] = [lambda d: analysis_result(d, 100.0)]
    real = ts().mark_finalized
    fails = {"n": 1}

    def flaky(task_id, event=None):
        if fails["n"]:
            fails["n"] -= 1
            raise RuntimeError("crash")
        return real(task_id, event=event)
    monkeypatch.setattr(ts(), "mark_finalized", flaky)
    _settle(leader)
    usage = accounts.get_usage(job.id)
    assert usage["seconds_billed"] == 100 and usage["seconds_actual"] == 100
    assert len(_events("analysis_done")) == 1


# ── leaders and dispatchers ──────────────────────────────────────────


def test_two_leaders_in_one_process_elect_one():
    a = task_leader.Leader(M._QueueOps(periodic=False),
                           lock=task_leader._ProcessLock())
    b = task_leader.Leader(M._QueueOps(periodic=False),
                           lock=task_leader._ProcessLock())
    a.start()
    try:
        assert a.wait_leading(5)
        b.start()
        time.sleep(0.3)
        assert not b.leading
        a.stop()
        assert b.wait_leading(10)
    finally:
        a.stop()
        b.stop()


@pytest.fixture
def pg_tasks_db(pg_server):
    from backend import pg
    url = pg_server.fresh()
    database = pg.Database(url, max_size=6)
    database.apply_schema()
    yield url, pg.PgJobStore(database)
    database.close()


def test_postgres_two_dispatchers_claim_each_task_once(pg_tasks_db):
    _url, st = pg_tasks_db
    tasks = st.tasks
    for _ in range(100):
        job = st.create(None, {})
        tasks.enqueue(job.id, "ingest", {"v": V})
    claimed: dict[str, list[int]] = {"a": [], "b": []}

    def claimer(name):
        while True:
            rows = tasks.claim_for_dispatch("ingest", 3, name, 300, "local")
            if not rows:
                if not tasks.counts("ingest")[0]:
                    return
                continue
            claimed[name] += [t.id for t in rows]
    threads = [threading.Thread(target=claimer, args=(n,)) for n in "ab"]
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    everything = claimed["a"] + claimed["b"]
    assert len(everything) == 100 and len(set(everything)) == 100
    assert claimed["a"] and claimed["b"]


def test_postgres_leader_election_and_takeover(pg_tasks_db):
    from backend import pg_tasks
    url, _st = pg_tasks_db
    a, b = pg_tasks.LeaderLock(url), pg_tasks.LeaderLock(url)
    try:
        assert a.try_acquire() is True
        assert b.try_acquire() is False
        assert a.alive()
        # The leader's connection dies: the other one takes over.
        a.conn.close()
        assert not a.alive()
        t0 = time.monotonic()
        while not b.try_acquire():
            assert time.monotonic() - t0 < 10
            time.sleep(0.2)
        # NOTIFY from an enqueue reaches the new leader.
        from backend import pg
        database = pg.Database(url, max_size=2)
        try:
            st = pg.PgJobStore(database)
            job = st.create(None, {})
            st.tasks.enqueue(job.id, "render", {"v": V})
        finally:
            database.close()
        assert b.wait(2.0) == ["render"]
    finally:
        a.release()
        b.release()


def test_postgres_patch_status_merges(pg_tasks_db):
    _url, st = pg_tasks_db
    job = st.create(None, {}, owner_id="u")
    st.update(job.id, status="processing", subtitles=[{"text": "keep"}])
    assert st.patch_status(job.id, ("processing",), message="x",
                           progress=5.0)
    got = st.get(job.id)
    assert (got.message, got.progress, got.subtitles) == (
        "x", 5.0, [{"text": "keep"}])
    st.update(job.id, status="error")
    assert not st.patch_status(job.id, ("processing",), message="late")
