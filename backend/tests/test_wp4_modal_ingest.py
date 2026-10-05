"""WP4 phase P1: the analysis on Modal (CLEO_EXECUTOR_INGEST=modal).

The Modal call is faked like the render tests fake render_r2
(test_wp3_render.py FakeR2Modal): spawn() runs the very code analyze_r2
runs in the container — backend/modal_analyze.py run, on the moto R2 —
with the analysis itself (pipeline.analyze_only) stubbed as in
test_wp4_queue.py. Covers dispatch (no local disk gate, the running
limit), the commit, retries, Modal's timeout / crash / deadline, the
fence (in the API and in the container), progress, the parity of a
local and a Modal analysis of the same upload, and that nothing changes
with the switch unset.
"""
from __future__ import annotations

import ast
import dataclasses
import os
import subprocess
import sys
import time
import types
from pathlib import Path

import pytest

import backend.main as M
from backend import (accounts, costs, executor_modal, jobs, leader as
                     task_leader, media, modal_analyze, pipeline, storage,
                     taskq)
from backend import doc as edit_doc
from backend.jobs import store
from conftest import REPO

pytestmark = pytest.mark.no_task_leader

V = taskq.WORKER_PROTOCOL


@pytest.fixture(autouse=True)
def queue_on(monkeypatch):
    monkeypatch.setenv("CLEO_TASK_QUEUE", "1")
    monkeypatch.setenv("CLEO_TASK_RETRY_BACKOFF_S", "0,0,0")
    monkeypatch.setenv("CLEO_TASK_HEARTBEAT_S", "0.05")
    monkeypatch.setenv("CLEO_PROVIDER_RETRY_MIN_S", "0")
    monkeypatch.setenv("CLEO_MODAL_POLL_S", "0.02")
    monkeypatch.setenv("CLEO_MODAL_START_TIMEOUT_S", "0")
    for k in ("CLEO_MAX_ANALYZE", "CLEO_MAX_RENDER", "CLEO_MAX_QUEUE",
              "CLEO_MAX_ACTIVE_PER_USER", "CLEO_MAX_RUNNING_INGEST",
              "CLEO_MAX_RUNNING_RENDER", "CLEO_GROQ_ASH_BUDGET",
              "CLEO_PROVIDER_HOLD_S", "CLEO_LLM_OUTAGE_POLICY",
              "CLEO_FAULT_GROQ_429", "CLEO_TASK_LEASE_S", "MODAL_TOKEN_ID",
              "CLEO_DISK_FACTOR", "CLEO_EXECUTOR_INGEST",
              "CLEO_EXECUTOR_RENDER", "CLEO_MODAL_ANALYZE_DEADLINE_S_MAX"):
        monkeypatch.delenv(k, raising=False)
    import backend.llm
    monkeypatch.setattr(backend.llm, "_client", lambda: None)


def ts():
    return jobs.task_store()


@pytest.fixture
def leader():
    ld = task_leader.Leader(M._QueueOps(periodic=False))
    yield ld
    ld.stop(grace_s=5)


def _settle(ld, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        ld.dispatch_once()
        ld.finalize_once()
        s = ts()
        if (not any(s.counts(k)[0] or s.counts(k)[1]
                    for k in ("ingest", "render")) and not s.unfinalized()):
            return
        time.sleep(0.02)
    raise AssertionError(f"queue didn't settle: {ts().queued()} "
                         f"{ts().unfinalized()}")


def _wait_for(pred, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def _events(kind=None):
    return [e for e in store.events(0) if kind is None or e["kind"] == kind]


# ── the stubbed analysis (the same for the local and the Modal path) ──

SUBS = [{"start": 0.5, "end": 1.4, "text": "hallo zusammen",
         "original_start": 0.5, "original_end": 1.4},
        {"start": 2.0, "end": 3.1, "text": "und willkommen",
         "original_start": 2.5, "original_end": 3.6}]


def _full_result(output_dir, duration=30.0):
    """What analyze_only returns, with every artifact it stores."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, body in (("normalized.mp4", b"mezz-bytes"),
                       ("proxy.mp4", b"proxy"), ("preview.mp4", b"preview"),
                       ("peaks.bin", b"\x00\x01" * 8),
                       ("poster.jpg", b"jpg"), ("filmstrip.jpg", b"strip")):
        (out / name).write_bytes(body)
    segments = [(0.0, 1.6), (2.4, duration)]
    subs = [dict(s) for s in SUBS]
    doc = edit_doc.build_doc(edit_doc.words_from_units(subs), "de", {},
                             segments=segments)
    return {"normalized_path": str(out / "normalized.mp4"),
            "preview_path": str(out / "preview.mp4"),
            "segments": segments, "subtitles": subs, "duration": duration,
            "cut_ranges": [{"start": 1.6, "end": 2.4, "kind": "pause"}],
            "language": "de", "scene_events": [],
            "audio_warnings": ["audio_quiet"],
            "audio_levels": {"mean_db": -30.5, "max_db": -3.0},
            "doc": doc, "mezz_fps": 30.0, "mezz_cfr": True,
            "audio_loudness": {"I": -18.0}, "format_warning": None,
            "peaks_path": str(out / "peaks.bin"),
            "poster_path": str(out / "poster.jpg"), "font_files": {},
            "filmstrip_path": str(out / "filmstrip.jpg"),
            "filmstrip_meta": {"n": 4, "w": 90, "h": 160}}


@pytest.fixture
def analysis(monkeypatch):
    """analyze_only for both paths (M.analyze_only for the local
    executor, pipeline.analyze_only in the Modal container): `plan`
    holds an exception or a result factory per call."""
    state = {"plan": [], "calls": 0, "dirs": [], "gate": None}

    def analyze(input_path, output_dir, settings, progress_cb, **kw):
        state["calls"] += 1
        state["dirs"].append(output_dir)
        state.setdefault("settings", []).append(dict(settings))
        assert Path(input_path).read_bytes() == b"upload-bytes"
        progress_cb("Transcribing…", 40)
        if state["gate"] is not None:
            assert state["gate"].wait(20)
        step = state["plan"].pop(0) if state["plan"] else None
        if isinstance(step, BaseException):
            raise step
        if callable(step):
            return step(output_dir)
        return _full_result(output_dir)
    monkeypatch.setattr(M, "analyze_only", analyze)
    monkeypatch.setattr(pipeline, "analyze_only", analyze)
    return state


# ── fake Modal ───────────────────────────────────────────────────────


class FunctionTimeoutError(Exception):
    """Same class name as modal.exception.FunctionTimeoutError."""


class FakeModal:
    """modal.Function.from_name("cleocuts-render", "analyze_r2") and the
    modal.Dict channel. spawn() runs backend/modal_analyze.py as the real
    analyze_r2 does (unless `plan` says otherwise: an exception get()
    raises, "hang" = never a result, a callable(kw) = its return value)."""

    def __init__(self):
        self.plan: list = []
        self.spawns: list[dict] = []
        self.names: list[str] = []
        self.cancelled = 0
        self.data: dict = {}
        self.dict_names: list[str] = []
        self.progress_seen: list = []
        fake = self

        class _Call:
            def __init__(self, outcome):
                self.outcome = outcome

            def get(self, timeout=None):
                if self.outcome == "hang":
                    time.sleep(timeout or 0)
                    raise TimeoutError()
                if isinstance(self.outcome, BaseException):
                    raise self.outcome
                return self.outcome

            def cancel(self):
                fake.cancelled += 1

            def get_call_graph(self):
                return []

        class _Fn:
            def spawn(self, **kw):
                fake.spawns.append(kw)
                out = fake.plan.pop(0) if fake.plan else "ok"
                if out == "ok":
                    out = fake.run(kw)
                elif callable(out) and not isinstance(out, BaseException):
                    out = out(kw)
                return _Call(out)

            def get_current_stats(self):
                return types.SimpleNamespace(num_total_runners=1, backlog=0)

        class _Function:
            @staticmethod
            def from_name(app, name):
                fake.names.append(f"{app}/{name}")
                return _Fn()

        class _DictObj:
            def get(self, key, default=None):
                return fake.data.get(key, default)

            def put(self, key, value, skip_if_exists=False):
                if key.startswith("progress:"):
                    fake.progress_seen.append(value)
                fake.data[key] = value
                return True

            def pop(self, key, default=None):
                return fake.data.pop(key, default)

        class _Dict:
            @staticmethod
            def from_name(name, create_if_missing=False):
                fake.dict_names.append(name)
                return _DictObj()

        self.module = types.SimpleNamespace(Function=_Function, Dict=_Dict)

    def run(self, kw):
        """What analyze_r2 does in the container."""
        modal_analyze.apply_env(kw.get("env"))
        return modal_analyze.run(kw["job_id"], kw["source_key"],
                                 kw["settings"], token=kw["token"],
                                 degraded=kw.get("degraded", False),
                                 bucket=kw.get("bucket"))


@pytest.fixture
def fake_modal(monkeypatch):
    fake = FakeModal()
    monkeypatch.setitem(sys.modules, "modal", fake.module)
    return fake


@pytest.fixture
def modal_on(monkeypatch, r2, fake_modal):
    monkeypatch.setenv("CLEO_EXECUTOR_INGEST", "modal")
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    return fake_modal


def _r2_upload_job(r2, owner=None, seconds=None, settings=None, size=0.0):
    key = f"uploads/{os.urandom(16).hex()}.mp4"
    r2.put_object(Bucket=storage.bucket(), Key=key, Body=b"upload-bytes")
    job = store.create(None, settings or {}, owner_id=owner, source_key=key,
                       media_store="r2")
    if owner and seconds:
        accounts.charge(job.id, owner, seconds, enforce=False)
    tid, _ = ts().enqueue(
        job.id, "ingest", {"v": V, "job_id": job.id, "source_key": key,
                           "charged_s": seconds, "est_audio_s": 10,
                           "size": float(size)},
        owner_id=owner, max_attempts=taskq.max_attempts(),
        job_change=dict(status="processing", message="queued"))
    return store.get(job.id), tid


def _keys(r2, job_id):
    out = r2.list_objects_v2(Bucket=storage.bucket(),
                             Prefix=f"jobs/{job_id}/").get("Contents", [])
    return sorted(o["Key"][len(f"jobs/{job_id}/"):] for o in out)


# ── dispatch + commit ────────────────────────────────────────────────


def test_modal_analysis_dispatch_and_commit(leader, analysis, modal_on, r2,
                                            monkeypatch):
    # The local executor's disk gate would hold this upload for ever:
    # the Modal executor doesn't look at this box's disk.
    monkeypatch.setenv("CLEO_DISK_FACTOR", "1e9")
    job, tid = _r2_upload_job(r2, size=2e9, seconds=None,
                              settings={"style": "tight"})
    _settle(leader)
    [kw] = modal_on.spawns
    assert modal_on.names == ["cleocuts-render/analyze_r2"]
    assert (kw["job_id"], kw["source_key"]) == (job.id, job.source_key)
    assert kw["token"] == f"{tid}:1" and kw["bucket"] == storage.bucket()
    assert kw["settings"]["style"] == "tight"
    assert kw["settings"]["_max_seconds"] == 30 * 60 + 1   # CLEO_MAX_MINUTES
    t = ts().get(tid)
    assert (t.state, t.executor, t.attempts) == ("succeeded", "modal", 1)
    assert t.result["executor"] == "modal"
    assert set(t.result["modal_timings"]) >= {"get", "analyze", "put",
                                              "total"}
    got = store.get(job.id)
    p = f"jobs/{job.id}/"
    assert got.status == "awaiting_review" and got.media_store == "r2"
    assert (got.mezz_key, got.proxy_key, got.preview_key) == (
        p + "mezz.mp4", p + "proxy.mp4", p + "preview/v1.mp4")
    assert got.peaks_key == p + "peaks.bin" and got.poster_key
    assert got.filmstrip_key and got.filmstrip_meta == {"n": 4, "w": 90,
                                                         "h": 160}
    assert got.doc and got.doc["language"] == "de"
    assert got.segments == [(0.0, 1.6), (2.4, 30.0)]
    assert _keys(r2, job.id) == ["filmstrip.jpg", "mezz.mp4", "peaks.bin",
                                 "poster.jpg", "preview/v1.mp4", "proxy.mp4"]
    assert got.media_bytes[p + "mezz.mp4"] == len(b"mezz-bytes")
    # Ran in the "container"'s own temp dir, not in this box's workspace.
    assert not analysis["dirs"][0].startswith(str(M._TMP_ROOT))
    assert not (Path(M._TMP_ROOT) / "jobs" / job.id).exists()
    # The upload object is gone after the commit, as on the local path.
    assert media.size(job.source_key, store="r2") is None
    assert [e["kind"] for e in _events()] == ["analysis_done"]
    assert "modal_s" in got.costs and got.costs["usd_modal"] > 0
    # The progress channel is cleaned up.
    assert not [k for k in modal_on.data if k.startswith("progress:")]
    assert modal_on.data[f"fence:{job.id}"] == f"{tid}:1"


def test_parity_local_and_modal_store_the_same(leader, analysis, r2,
                                               fake_modal, monkeypatch):
    """The same upload analysed by the local executor and by the Modal
    one: identical job fields and artifact keys."""
    local, ltid = _r2_upload_job(r2, settings={"style": "tight"})
    _settle(leader)
    assert ts().get(ltid).executor == "local" and not fake_modal.spawns
    monkeypatch.setenv("CLEO_EXECUTOR_INGEST", "modal")
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    remote, rtid = _r2_upload_job(r2, settings={"style": "tight"})
    _settle(leader)
    assert ts().get(rtid).executor == "modal" and len(fake_modal.spawns) == 1
    assert analysis["settings"][0] == analysis["settings"][1]

    def norm(value, job_id):
        if isinstance(value, str):
            return value.replace(job_id, "<id>")
        if isinstance(value, dict):
            return {norm(k, job_id): norm(v, job_id) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return type(value)(norm(v, job_id) for v in value)
        return value
    skip = {"id", "created_at", "updated_at", "expires_at", "costs",
            "source_key"}

    def fields(job):
        d = dataclasses.asdict(store.get(job.id))
        return {k: norm(v, job.id) for k, v in d.items() if k not in skip}
    a, b = fields(local), fields(remote)
    assert a.keys() == b.keys()
    assert {k: (a[k], b[k]) for k in a if a[k] != b[k]} == {}
    assert a["status"] == "awaiting_review" and a["doc"]
    assert _keys(r2, local.id) == _keys(r2, remote.id)
    tl, tr = ts().get(ltid).result, ts().get(rtid).result
    assert {k: v for k, v in tl.items() if k not in ("work_s", "worker")} == {
        k: v for k, v in tr.items()
        if k not in ("work_s", "worker", "executor", "modal_timings")}


def test_job_outside_r2_is_analysed_here(leader, analysis, modal_on):
    """A job whose upload is a file on this box (from before the switch
    to R2) can't go to Modal: analysed locally, as before."""
    src = Path(M._WORK_ROOT) / "uploads"
    src.mkdir(parents=True, exist_ok=True)
    f = src / f"in-{time.time_ns()}.mp4"
    f.write_bytes(b"upload-bytes")
    job = store.create(str(f), {})
    tid, _ = ts().enqueue(job.id, "ingest", {"v": V, "job_id": job.id,
                                             "est_audio_s": 10, "size": 0},
                          job_change=dict(status="processing"))
    _settle(leader)
    assert not modal_on.spawns
    assert ts().get(tid).state == "succeeded"
    assert store.get(job.id).status == "awaiting_review"


# ── retries, timeout, crash, deadline ────────────────────────────────


def test_modal_timeout_is_retried_then_succeeds(leader, analysis, modal_on,
                                                r2, auth_on):
    job, tid = _r2_upload_job(r2, owner="user_a", seconds=40)
    modal_on.plan = [FunctionTimeoutError("7200 s"), "ok"]
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("succeeded", 2)
    assert modal_on.cancelled >= 1
    assert [s["token"] for s in modal_on.spawns] == [f"{tid}:1", f"{tid}:2"]
    assert store.get(job.id).status == "awaiting_review"
    assert not accounts.get_usage(job.id)["refunded"]
    assert [e["kind"] for e in _events()] == ["analysis_done"]


def test_modal_crash_exhausted_fails_and_refunds_once(leader, analysis,
                                                      modal_on, r2, auth_on):
    job, tid = _r2_upload_job(r2, owner="user_a", seconds=40)
    modal_on.plan = [RuntimeError("container exited (OOM)")] * 3
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("dead", 3)
    got = store.get(job.id)
    assert (got.status, got.error_code, got.refunded) == (
        "error", "processing_interrupted", True)
    assert accounts.get_usage(job.id)["refunded"]
    [ev] = _events()
    assert ev["kind"] == "analysis_failed" and ev["data"]["refunded"]
    assert analysis["calls"] == 0
    # The upload goes with the failed job (media GC), as on the local path.
    assert job.source_key in [r["prefix"] for r in store.gc_all()]


def test_no_result_within_the_deadline_cancels_and_retries(
        leader, analysis, modal_on, r2, monkeypatch):
    monkeypatch.setenv("CLEO_MODAL_ANALYZE_DEADLINE_S_MAX", "0.3")
    job, tid = _r2_upload_job(r2)
    modal_on.plan = ["hang", "ok"]
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("succeeded", 2)
    assert modal_on.cancelled == 1


def test_modal_unavailable_is_infra_not_content(leader, analysis, modal_on,
                                                r2, monkeypatch):
    class NotFoundError(Exception):
        pass
    monkeypatch.setenv("CLEO_TASK_MAX_ATTEMPTS", "1")
    job, tid = _r2_upload_job(r2)
    modal_on.plan = [NotFoundError("App 'cleocuts-render' has no analyze_r2")]
    _settle(leader)
    t = ts().get(tid)
    assert t.state == "dead" and t.error_code == taskq.ATTEMPTS_EXHAUSTED
    assert "analyze_unavailable" in t.last_error
    assert store.get(job.id).error_code == "processing_interrupted"


def test_lease_kept_while_modal_works_and_fence_cancels(leader, analysis,
                                                        modal_on, r2,
                                                        monkeypatch):
    """The worker heartbeats while it waits for Modal (the reaper takes
    nothing); a task taken away meanwhile cancels the Modal call and
    commits nothing; the next attempt runs."""
    monkeypatch.setenv("CLEO_TASK_LEASE_S", "0.3")
    job, tid = _r2_upload_job(r2)
    modal_on.plan = ["hang", "ok"]
    leader.dispatch_once()
    assert _wait_for(lambda: ts().get(tid).state == "running")
    time.sleep(0.6)                                  # 2 leases
    assert leader.reap_once(force=True) == 0
    assert ts().get(tid).state == "running"
    # Lease lost (e.g. the database said so): requeued, attempt 1 fenced.
    assert ts().requeue(tid, expect_states=("running",), attempts=1) == "queued"
    assert _wait_for(lambda: modal_on.cancelled == 1)
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("succeeded", 2)
    assert store.get(job.id).status == "awaiting_review"


# ── the analysis' own failures: classified like the local path ───────


@pytest.mark.parametrize("speech,refunded", [(0.0, True), (40.0, False)])
def test_no_speech_on_modal_is_content_with_the_refund_rule(
        leader, analysis, modal_on, r2, auth_on, monkeypatch, speech,
        refunded):
    monkeypatch.setattr(modal_analyze, "_probe_s", lambda p: 25.0)
    job, tid = _r2_upload_job(r2, owner="user_a", seconds=100)

    def fail(output_dir):
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        Path(output_dir, "normalized.mp4").write_bytes(b"n")
        raise pipeline.NoSpeechError(speech_seconds=speech)
    analysis["plan"] = [fail]
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.error_code, t.attempts) == (
        "failed", taskq.CONTENT_NO_SPEECH, 1)
    got = store.get(job.id)
    assert (got.status, got.error_code) == ("error", "no_speech")
    assert got.error == "No speech detected in the video."
    usage = accounts.get_usage(job.id)
    assert bool(usage["refunded"]) is refunded
    if not refunded:
        # Trued up by what Modal really processed.
        assert usage["seconds_actual"] == 25.0


def test_groq_failure_on_modal_waits_like_a_local_one(leader, analysis,
                                                      modal_on, r2):
    from backend.whisper_groq import GroqTranscriptionError
    err = GroqTranscriptionError("transcription_unavailable: 429")
    err.retry_after_s = 5.0
    job, tid = _r2_upload_job(r2)
    analysis["plan"] = [err]
    for _ in range(50):
        leader.dispatch_once()
        leader.finalize_once()
        if ts().get(tid).provider_waits:
            break
        time.sleep(0.02)
    t = ts().get(tid)
    assert t.state == "queued" and t.provider_waits == 1
    assert t.error_code == taskq.PROVIDER_GROQ
    assert store.get(job.id).status == "processing"


def test_upload_missing_in_r2_is_infra_retried(leader, analysis, modal_on,
                                               r2, monkeypatch):
    monkeypatch.setenv("CLEO_TASK_MAX_ATTEMPTS", "2")
    job, tid = _r2_upload_job(r2)
    r2.delete_object(Bucket=storage.bucket(), Key=job.source_key)
    _settle(leader)
    t = ts().get(tid)
    assert (t.state, t.attempts) == ("dead", 2)
    assert analysis["calls"] == 0


def test_spend_limit_on_modal_holds(leader, analysis, modal_on, r2):
    from backend import llm

    def hit_limit(output_dir):
        obs = llm._observer()
        obs.failed.append(("cleanup", llm.SPEND_LIMIT))
        obs.spend_limit, obs.detail = True, "BadRequestError in cleanup"
        return _full_result(output_dir)
    job, tid = _r2_upload_job(r2)
    analysis["plan"] = [hit_limit]
    for _ in range(50):
        leader.dispatch_once()
        leader.finalize_once()
        if ts().get(tid).provider_waits:
            break
        time.sleep(0.02)
    t = ts().get(tid)
    assert t.error_code == taskq.PROVIDER_ANTHROPIC and t.provider_waits == 1
    assert ts().breaker("anthropic").state(time.time()) == "open"


# ── the container side ───────────────────────────────────────────────


def test_tokens_order_by_attempt():
    tok = modal_analyze.attempt_token
    assert modal_analyze.newer(tok(7, 2), tok(7, 1))
    assert not modal_analyze.newer(tok(7, 1), tok(7, 2))   # a stale fence
    assert not modal_analyze.newer(tok(7, 1), tok(7, 1))
    assert not modal_analyze.newer(None, tok(7, 1))
    assert not modal_analyze.newer("garbage", tok(7, 1))


def test_container_fenced_by_a_newer_attempt_stores_nothing(
        analysis, r2, fake_modal):
    """A call the API lost track of: a later attempt wrote the fence —
    the zombie stops before its first upload."""
    job, tid = _r2_upload_job(r2)
    fake_modal.data[modal_analyze.fence_key(job.id)] = f"{tid}:2"
    out = modal_analyze.run(job.id, job.source_key, {}, token=f"{tid}:1")
    assert out["error"]["fenced"] and out["error"]["interrupted"]
    assert _keys(r2, job.id) == []
    # The attempt that owns the job stores.
    out = modal_analyze.run(job.id, job.source_key, {}, token=f"{tid}:2")
    assert "error" not in out and out["stored"]["mezz_key"]
    assert set(out["res"]) & set(modal_analyze.LOCAL_PATH_KEYS) == set()
    assert "mezz.mp4" in _keys(r2, job.id)


def test_container_without_a_channel_still_works(analysis, r2, monkeypatch):
    """No modal.Dict (or it fails): no progress, no remote fence — the
    analysis goes on."""
    class Broken:
        @staticmethod
        def from_name(*a, **k):
            raise ConnectionError("dict service down")
    monkeypatch.setitem(sys.modules, "modal",
                        types.SimpleNamespace(Dict=Broken))
    job, tid = _r2_upload_job(r2)
    out = modal_analyze.run(job.id, job.source_key, {}, token=f"{tid}:1")
    assert "error" not in out


def test_container_refuses_another_bucket(analysis, r2, fake_modal):
    job, tid = _r2_upload_job(r2)
    with pytest.raises(ValueError, match="bucket mismatch"):
        modal_analyze.run(job.id, job.source_key, {}, token="1:1",
                          bucket="someone-elses")


def test_env_forwarding(monkeypatch):
    monkeypatch.setenv("CLEO_DISFLUENT_PROMPT", "0")
    monkeypatch.setenv("GROQ_API_KEY", "secret")
    env = modal_analyze.forward_env()
    assert env == {"CLEO_DISFLUENT_PROMPT": "0"}     # never a key
    monkeypatch.setenv("CLEO_SUSTAINED_VOWEL_CUTS", "1")
    modal_analyze.apply_env(env)                       # a warm container
    assert os.environ["CLEO_DISFLUENT_PROMPT"] == "0"
    assert "CLEO_SUSTAINED_VOWEL_CUTS" not in os.environ


def test_rebuilt_errors_classify_like_local_ones():
    from backend import errors
    from backend.whisper_groq import GroqTranscriptionError
    e = executor_modal.rebuild_error(
        {"type": "GroqTranscriptionError", "message": "x",
         "retry_after_s": 7.0})
    assert isinstance(e, GroqTranscriptionError) and e.retry_after_s == 7.0
    e = executor_modal.rebuild_error(
        {"type": "NoSpeechError", "message": "No speech detected in the "
         "video.", "code": "no_speech", "speech_seconds": 3.0,
         "processed_s": 12.0})
    assert isinstance(e, pipeline.NoSpeechError) and e.speech_seconds == 3.0
    assert e._cleo_processed_s == 12.0
    e = executor_modal.rebuild_error(
        {"type": "OSError", "message": "[Errno 28] No space left on device",
         "oserror": True})
    assert errors.is_infra_failure(e, str(e))
    e = executor_modal.rebuild_error(
        {"type": "RuntimeError", "message": "ffmpeg normalize failed"})
    assert errors.analysis_error_code(e, str(e)) == "unreadable_video"
    assert not errors.is_infra_failure(e, "x")
    e = executor_modal.rebuild_error({"type": "Fenced", "message": "x",
                                      "interrupted": True, "fenced": True})
    assert isinstance(e, InterruptedError)


def test_progress_is_relayed(r2, fake_modal):
    from backend import errors
    seen = []

    def spawn_with_progress(kw):
        key = modal_analyze.progress_key(kw["job_id"], kw["token"])
        fake_modal.data[key] = {"text": "Transcribing…",
                                "code": "analyze.transcribe",
                                "params": {}, "pct": 42.0, "t": 1.0}
        return "hang"
    fake_modal.plan = [spawn_with_progress]
    job_id = jobs.new_job_id()
    with pytest.raises(executor_modal.ModalIngestError):
        os.environ["CLEO_MODAL_ANALYZE_DEADLINE_S_MAX"] = "0.2"
        try:
            executor_modal.analyze(
                job_id=job_id, source_key="uploads/x.mp4", settings={},
                token="1:1", degraded=False, seconds=60, size=1e9,
                progress=lambda m, p: seen.append((m, p)))
        finally:
            del os.environ["CLEO_MODAL_ANALYZE_DEADLINE_S_MAX"]
    assert seen and seen[0][1] == 42.0
    assert errors.stage_fields(seen[0][0])["stage"] == "analyze.transcribe"
    # One relay per new value, not per poll.
    assert len(seen) == 1


def test_deadline_scales_with_length_and_size(monkeypatch):
    d = executor_modal.deadline_s
    assert d(600, 2e9) == 900 + 3 * 600 + 120 * 2
    assert d(None, None) == 900
    assert d(10 ** 6, 0) == executor_modal.FUNCTION_TIMEOUT_S + 300
    monkeypatch.setenv("CLEO_MODAL_ANALYZE_DEADLINE_S_MAX", "100")
    assert d(600, 2e9) == 100


def test_modal_time_is_billed_at_the_analysis_size():
    bucket: dict = {}
    with costs.collecting(bucket):
        costs.record_modal(100, costs.RATES["modal_analyze_cores"],
                           costs.RATES["modal_analyze_gib"])
    assert bucket["modal_s"] == 100
    assert bucket["usd_modal"] == pytest.approx(
        100 * (8 * costs.RATES["modal_core_s"]
               + 16 * costs.RATES["modal_gib_s"]))


# ── switches, admission, defaults ────────────────────────────────────


def test_switch_unset_is_today(monkeypatch):
    assert taskq.executor("ingest") == "local"
    assert taskq.running_limit("ingest") == 2
    assert taskq.max_queue() == 20
    task_leader.check_config()


def test_modal_limits_have_their_own_defaults(monkeypatch, r2):
    monkeypatch.setenv("CLEO_EXECUTOR_INGEST", "modal")
    monkeypatch.setenv("CLEO_MAX_ANALYZE", "3")       # the local slots
    assert taskq.running_limit("ingest") == 20
    assert taskq.max_queue() == 200
    monkeypatch.setenv("CLEO_MAX_RUNNING_INGEST", "35")
    assert taskq.running_limit("ingest") == 35


def test_config_refusals(monkeypatch):
    monkeypatch.setenv("CLEO_EXECUTOR_INGEST", "modal")
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    with pytest.raises(task_leader.ConfigError, match="CLEO_MEDIA_BACKEND=r2"):
        task_leader.check_config()


def test_config_needs_modal_credentials_and_ingest_only(monkeypatch, r2):
    monkeypatch.setenv("CLEO_EXECUTOR_INGEST", "modal")
    with pytest.raises(task_leader.ConfigError, match="MODAL_TOKEN_ID"):
        task_leader.check_config()
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    task_leader.check_config()
    monkeypatch.setenv("CLEO_EXECUTOR_RENDER", "modal")
    with pytest.raises(task_leader.ConfigError, match="only ingest"):
        task_leader.check_config()


def test_admission_in_modal_mode_skips_the_disk_check(client, modal_on,
                                                      monkeypatch):
    monkeypatch.setenv("CLEO_DISK_FACTOR", "1e9")
    body = {"filename": "big.mov", "content_type": "video/quicktime",
            "size": 4e9}
    assert client.post("/uploads/presign", json=body).status_code == 200
    monkeypatch.setenv("CLEO_EXECUTOR_INGEST", "local")
    r = client.post("/uploads/presign", json=body)
    assert r.status_code == 507 and r.json()["detail"] == "server_storage_full"


def test_admin_queue_reports_the_executor(client, modal_on, monkeypatch):
    monkeypatch.setenv("CLEO_ADMIN_TOKEN", "adm")
    q = client.get("/admin/queue", headers={"X-Admin-Token": "adm"}).json()
    assert q["kinds"]["ingest"]["executor"] == "modal"
    assert q["kinds"]["ingest"]["limit"] == 20 and q["max_queue"] == 200


# ── the Modal function and its deploy ────────────────────────────────


def test_analyze_r2_definition():
    src = (REPO / "backend" / "modal_render.py").read_text()
    tree = ast.parse(src)
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    [guard] = [n for n in tree.body if isinstance(n, ast.If)
               and any(isinstance(b, ast.FunctionDef)
                       and b.name == "analyze_r2" for b in n.body)]
    assert ast.unparse(guard.test) == "WITH_ANALYZE"
    deco = ast.unparse(fns["analyze_r2"].decorator_list[0])
    assert "Secret.from_name('cleocuts-r2')" in deco
    assert "Secret.from_name('cleocuts-ai')" in deco
    assert f"timeout={int(executor_modal.FUNCTION_TIMEOUT_S)}" in deco
    assert "ephemeral_disk=" in deco and "image=analyze_image" in deco
    args = [a.arg for a in fns["analyze_r2"].args.args]
    assert args == ["job_id", "source_key", "settings", "token", "degraded",
                    "env", "bucket"]
    # The keys come from the Modal secret, never from the API.
    assert not set(modal_analyze.FORWARD_ENV) & {
        "GROQ_API_KEY", "ANTHROPIC_API_KEY"}


def test_analyze_r2_only_in_a_deploy_with_both_secrets():
    pytest.importorskip("modal")
    code = ("import backend.modal_render as m; "
            "print(sorted(m.app.registered_functions))")
    for r2_flag, an_flag, want in (
            ("0", "1", ["render_burn_concat"]),
            ("1", "0", ["render_burn_concat", "render_r2"]),
            ("1", "1", ["analyze_r2", "render_burn_concat", "render_r2"])):
        env = {**os.environ, "CLEO_MODAL_R2": r2_flag,
               "CLEO_MODAL_ANALYZE": an_flag}
        out = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env,
                             capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr[-500:]
        assert out.stdout.strip().splitlines()[-1] == repr(want)


def test_modal_deploy_checks_the_ai_secret():
    wf = (REPO / ".github" / "workflows" / "modal-deploy.yml").read_text()
    deploy = wf[wf.index("- name: Deploy"):]
    assert "has_secret cleocuts-ai" in deploy
    assert "CLEO_MODAL_ANALYZE=1" in deploy and "CLEO_MODAL_ANALYZE=0" in deploy
    assert deploy.index("CLEO_MODAL_ANALYZE=1") < deploy.index("modal deploy")


def test_worker_store_path_is_the_shared_one(monkeypatch, tmp_path):
    """worker._store_analysis and the container store through
    pipeline.store_analysis_outputs: the same keys, fields and order."""
    res = _full_result(tmp_path / "ws")
    puts = []
    fields = pipeline.store_analysis_outputs(
        res, "0123456789ab", lambda p, k, c: puts.append((k, c)) or 1)
    assert [k for k, _ in puts] == [
        "jobs/0123456789ab/mezz.mp4", "jobs/0123456789ab/proxy.mp4",
        "jobs/0123456789ab/preview/v1.mp4", "jobs/0123456789ab/peaks.bin",
        "jobs/0123456789ab/poster.jpg", "jobs/0123456789ab/filmstrip.jpg"]
    assert set(fields) == {"media_bytes", "mezz_key", "proxy_key",
                           "preview_key", "peaks_key", "poster_key",
                           "filmstrip_key", "filmstrip_meta"}
    assert jobs.LEGACY_PROXY_NAME == pipeline.PROXY_NAME


def test_container_side_needs_no_api_only_modules():
    """The Modal image has no database, web framework or job store: the
    modules analyze_r2 loads must import without them."""
    code = (
        "import sys\n"
        "for m in ('fastapi', 'psycopg', 'psycopg_pool', 'backend.jobs',\n"
        "          'backend.db', 'backend.main', 'backend.worker',\n"
        "          'backend.accounts', 'backend.auth'):\n"
        "    sys.modules[m] = None\n"
        "from backend import (modal_analyze, pipeline, llm, media, storage,\n"
        "                     uploads, costs, errors, font_subset,\n"
        "                     audio_analysis, cut_kinds, whisper_groq)\n"
        "print('ok')\n")
    out = subprocess.run([sys.executable, "-c", code], cwd=REPO,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-800:]
    assert out.stdout.strip().endswith("ok")


def test_analysis_image_has_what_the_api_image_has_for_an_analysis():
    """analyze_image vs backend/Dockerfile: the code, the fonts, the CJK
    faces font_subset cuts, the script table doc.py reads, the same font
    packages and the font_subset pins."""
    import re
    src = (REPO / "backend" / "modal_render.py").read_text()
    image = src.split("\nanalyze_image = (", 1)[1].split("\n)\n", 1)[0]
    dirs = set(re.findall(r'\.add_local_dir\(\s*"([^"]+)"\s*,\s*'
                          r'remote_path\s*=\s*"([^"]+)"', image))
    files = set(re.findall(r'\.add_local_file\(\s*"([^"]+)"\s*,\s*"([^"]+)"',
                           image))
    docker = (REPO / "backend" / "Dockerfile").read_text()
    copies = set(re.findall(r"^COPY\s+(\S+)\s+(/app/\S+)\s*$", docker, re.M))
    assert copies - {(a, b) for a, b in dirs | files} == set()
    assert (set(re.findall(r"fonts-[a-z0-9-]+", image))
            == set(re.findall(r"fonts-[a-z0-9-]+", docker)))
    reqs = (REPO / "backend" / "requirements.txt").read_text()
    for pin in ("fonttools==4.66.0", "brotli==1.2.0", "anthropic==0.111.0",
                "moviepy==1.0.3"):
        assert pin in reqs and f'"{pin}"' in image, pin
    assert '"CLEO_LOCAL_WHISPER": "0"' in image


def test_length_gate_measures_over_a_presigned_link(leader, analysis,
                                                    modal_on, r2,
                                                    monkeypatch):
    """An upload POST /jobs couldn't measure is measured here (ffprobe
    over a presigned GET) before anything goes to Modal; too long →
    refused, nothing spawned."""
    seen = []

    def probe(target):
        seen.append(target)
        return 99999.0
    monkeypatch.setattr(M, "_probe_duration", probe)
    job, _tid = _r2_upload_job(r2, settings={"_measure_length": True})
    _settle(leader)
    got = store.get(job.id)
    assert (got.status, got.error_code) == ("error", "video_too_long")
    assert seen and seen[0].startswith("https://")
    assert job.source_key in seen[0]
    assert not modal_on.spawns and analysis["calls"] == 0
    assert [e["kind"] for e in _events()] == ["analysis_refused"]
