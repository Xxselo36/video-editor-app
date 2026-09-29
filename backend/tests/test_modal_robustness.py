"""A Modal render never hangs: bounded wait with a (rare) heartbeat, a
deadline that cancels the call (render_timeout), bounded volume uploads
and downloads, capped throttle retries, and workspace problems
(spend limit, auth, not deployed, nothing scheduled) that fail at once
without retries (render_unavailable) — with the volume folder, ledger,
render slot and job state cleaned up exactly like any render failure.

Everything external is faked — no network, no Modal account.
"""
from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from backend import costs, pipeline


# ── fake `modal` ─────────────────────────────────────────────────────


class ResourceExhaustedError(Exception):
    """Same class name as modal.exception.ResourceExhaustedError."""


class AuthError(Exception):
    """Same class name as modal.exception.AuthError."""


class NotFoundError(Exception):
    """Same class name as modal.exception.NotFoundError."""


class OutputExpiredError(Exception):
    """Same class name as modal.exception.OutputExpiredError."""


HANG = "hang"   # get() never has a result (a call Modal never runs)


class Late:
    """get() has no result for the first `polls` polls, then `result`."""

    def __init__(self, polls: int, result):
        self.polls = polls
        self.result = result


class AtSpawn:
    """spawn() itself raises `exc`."""

    def __init__(self, exc: BaseException):
        self.exc = exc


OK_RESULT = {"primary": "output.mp4", "_thumbnail": "thumbnail.jpg"}


class FakeModal:
    """Volume + Function.from_name; `plan` holds one outcome per spawn:
    a result map, an exception get() raises, HANG, Late(...) or
    AtSpawn(...). get(timeout) blocks (real time) like the real client
    and raises the builtin TimeoutError when there is no result yet."""

    def __init__(self, plan, runners: int = 0, task_id: str = ""):
        self.plan = list(plan)
        self.spawns = 0
        self.polls = 0
        self.poll_timeouts: list[float | None] = []
        self.cancelled = 0
        self.stats_calls = 0
        self.runners = runners
        self.task_id = task_id
        self.uploads: list[str] = []
        self.removed: list[str] = []
        self.files = {"output.mp4": b"primary", "thumbnail.jpg": b"jpg"}
        fake = self

        class _Batch:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def put_file(self, local, remote):
                fake.uploads.append(remote)

        class _Volume:
            @staticmethod
            def from_name(name):
                return _Volume()

            def batch_upload(self, force=False):
                return _Batch()

            def read_file(self, remote):
                yield fake.files[remote.rsplit("/", 1)[1]]

            def remove_file(self, path, recursive=False):
                fake.removed.append(path)

        class _Call:
            def __init__(self, outcome):
                self.outcome = outcome
                self._never = threading.Event()

            def get(self, timeout=None):
                fake.polls += 1
                fake.poll_timeouts.append(timeout)
                out = self.outcome
                if isinstance(out, Late):
                    if out.polls > 0:
                        out.polls -= 1
                        self._never.wait(timeout)
                        raise TimeoutError()
                    return out.result
                if out == HANG:
                    assert timeout is not None, "unbounded call.get()"
                    self._never.wait(timeout)
                    raise TimeoutError()
                if isinstance(out, BaseException):
                    raise out
                return out

            def get_call_graph(self):
                return [types.SimpleNamespace(task_id=fake.task_id, status=0)]

            def cancel(self):
                fake.cancelled += 1

        class _Fn:
            def spawn(self, **kw):
                fake.spawns += 1
                out = fake.plan.pop(0)
                if isinstance(out, AtSpawn):
                    raise out.exc
                return _Call(out)

            def get_current_stats(self):
                fake.stats_calls += 1
                return types.SimpleNamespace(num_total_runners=fake.runners,
                                             backlog=1)

        class _Function:
            @staticmethod
            def from_name(app, name):
                return _Fn()

        self.module = types.SimpleNamespace(Volume=_Volume, Function=_Function)


@pytest.fixture
def modal_env(monkeypatch, tmp_path):
    """Modal on, default retry delays (10 s, 30 s — recorded, not slept),
    fast polls. Returns install(plan, **kw) → FakeModal."""
    monkeypatch.setenv("MODAL_TOKEN_ID", "tok")
    # These tests are about the volume path (render_burn_concat, kept for
    # rollback); render_r2 has tests of its own (test_wp3_render.py).
    monkeypatch.setenv("CLEO_MODAL_RENDER_FN", "render_burn_concat")
    monkeypatch.setattr(pipeline, "MODAL_LEDGER_DIR", str(tmp_path / "ledger"))
    for k in ("CLEO_LOCAL_RENDER_FALLBACK", "CLEO_MODAL_RETRY_DELAYS",
              "CLEO_MODAL_DEADLINE_S_BASE", "CLEO_MODAL_DEADLINE_S_PER_S",
              "CLEO_MODAL_DEADLINE_S_MAX", "CLEO_MODAL_START_TIMEOUT_S",
              "CLEO_MODAL_HEARTBEAT_S", "CLEO_MODAL_TRANSFER_S_MAX",
              "CLEO_MODAL_TRANSFER_IDLE_S"):
        monkeypatch.delenv(k, raising=False)
    # Unset, and restored afterwards although the render sets it.
    monkeypatch.setenv("MODAL_MAX_THROTTLE_WAIT", "")
    monkeypatch.delenv("MODAL_MAX_THROTTLE_WAIT")
    monkeypatch.setenv("CLEO_MODAL_POLL_S", "0.05")
    sleeps: list[float] = []
    # Only the pipeline's clock: retry backoff is recorded, not slept.
    monkeypatch.setattr(pipeline, "time", types.SimpleNamespace(
        monotonic=time.monotonic, time=time.time, sleep=sleeps.append))
    billed: list[float] = []
    monkeypatch.setattr(costs, "record_modal", billed.append)

    def install(plan, **kw):
        fake = FakeModal(plan, **kw)
        monkeypatch.setitem(sys.modules, "modal", fake.module)
        return fake
    install.sleeps = sleeps
    install.billed = billed
    install.ledger = tmp_path / "ledger"
    return install


@pytest.fixture
def no_local_render(monkeypatch):
    def burn(**kw):
        raise AssertionError("local render reached")
    monkeypatch.setattr(pipeline, "_multi_clip_burn", burn)


def _render(tmp_path, segments=((0.0, 1.0),), progress=None, cancel=None):
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"x")
    return pipeline.render_only(
        normalized_path=str(src), output_dir=str(tmp_path / "out"),
        segments=list(segments), subtitles=[], settings={},
        progress_cb=None if progress is None
        else (lambda msg, pct: progress.append(msg)),
        cancel_check=cancel,
    )


def _cleaned_up(fake) -> bool:
    """Volume folder removed, not marked active any more."""
    return (len(fake.removed) == 1 and fake.removed[0].lstrip("/")
            not in pipeline._MODAL_ACTIVE)


# ── render_unavailable: fail at once ─────────────────────────────────


def test_spend_limit_fails_at_once_without_retry(tmp_path, modal_env,
                                                  no_local_render, caplog):
    fake = modal_env([AtSpawn(ResourceExhaustedError(
        "Function call failed: workspace billing cycle spend limit reached"))])
    caplog.set_level(logging.ERROR, logger="backend.pipeline")
    t0 = time.monotonic()
    with pytest.raises(pipeline.RenderUnavailableError) as ei:
        _render(tmp_path)
    assert time.monotonic() - t0 < 1.0
    assert ei.value.code == "render_unavailable"
    assert str(ei.value).startswith(
        "render_unavailable: ResourceExhaustedError: Function call failed")
    assert fake.spawns == 1 and modal_env.sleeps == []   # no 10/30 s backoff
    assert _cleaned_up(fake)
    # spawn raised: nothing ran, nothing billed.
    assert modal_env.billed == []
    alerts = [r for r in caplog.records
              if r.getMessage().startswith("[modal] RENDER UNAVAILABLE — ")]
    assert len(alerts) == 1 and alerts[0].levelno == logging.ERROR
    assert "spend limit" in alerts[0].getMessage()


@pytest.mark.parametrize("exc", [
    AuthError("Token missing"),
    NotFoundError("Lookup failed for Function 'render_burn_concat'"),
])
def test_auth_and_not_deployed_are_not_retried(tmp_path, modal_env,
                                               no_local_render, exc):
    fake = modal_env([AtSpawn(exc)])
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="^render_unavailable: " + type(exc).__name__):
        _render(tmp_path)
    assert fake.spawns == 1 and modal_env.sleeps == []


def test_spend_limit_during_the_wait_is_not_retried(tmp_path, modal_env,
                                                    no_local_render):
    fake = modal_env([ResourceExhaustedError("spend limit reached")])
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="^render_unavailable"):
        _render(tmp_path)
    assert fake.spawns == 1 and fake.cancelled == 1
    assert modal_env.sleeps == []
    assert list(modal_env.ledger.iterdir()) == []   # cancelled: marker gone


def test_missing_output_file_is_still_retried(tmp_path, modal_env,
                                              no_local_render, monkeypatch):
    """NotFoundError while downloading is a missing file, not a missing
    deployment: the normal retry policy applies."""
    monkeypatch.setenv("CLEO_MODAL_RETRY_DELAYS", "0")
    fake = modal_env([OK_RESULT, OK_RESULT])
    calls = []

    def read_file(self, remote):
        calls.append(remote)
        if len(calls) == 1:
            raise NotFoundError(remote)
        yield fake.files[remote.rsplit("/", 1)[1]]
    monkeypatch.setattr(fake.module.Volume, "read_file", read_file)
    _render(tmp_path)
    assert fake.spawns == 2


def test_call_modal_never_starts_fails_fast(tmp_path, modal_env,
                                            no_local_render, monkeypatch):
    """Nothing scheduled (spend limit hit right after spawn, no
    capacity): no container at all and no task for the input → cancel
    and fail after the start timeout, long before the deadline."""
    monkeypatch.setenv("CLEO_MODAL_START_TIMEOUT_S", "0.2")
    fake = modal_env([HANG], runners=0)
    t0 = time.monotonic()
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="^render_unavailable: Modal hasn't started"):
        _render(tmp_path)
    assert time.monotonic() - t0 < 3.0          # deadline would be 246 s
    assert fake.cancelled == 1 and fake.spawns == 1
    assert fake.stats_calls >= 2                 # two probes in a row
    assert modal_env.sleeps == [] and modal_env.billed == []
    assert _cleaned_up(fake)
    assert list(modal_env.ledger.iterdir()) == []


@pytest.mark.parametrize("runners,task_id", [(1, ""), (0, "ta-123")])
def test_start_check_leaves_a_running_or_queued_call_alone(
        tmp_path, modal_env, no_local_render, monkeypatch, runners, task_id):
    """Other renders' containers running (it may wait in line), or the
    call graph shows a container for this input: keep waiting."""
    monkeypatch.setenv("CLEO_MODAL_START_TIMEOUT_S", "0.05")
    fake = modal_env([Late(8, OK_RESULT)], runners=runners, task_id=task_id)
    _render(tmp_path)
    assert fake.cancelled == 0 and fake.spawns == 1
    assert (tmp_path / "out" / "cleo_output.mp4").read_bytes() == b"primary"


# ── render_timeout: bounded wait ─────────────────────────────────────


def test_hung_call_heartbeats_then_times_out(tmp_path, modal_env,
                                             no_local_render, monkeypatch,
                                             caplog):
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_BASE", "0.5")
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_PER_S", "0")
    monkeypatch.setenv("CLEO_MODAL_START_TIMEOUT_S", "0")   # off
    monkeypatch.setenv("CLEO_MODAL_HEARTBEAT_S", "0.1")
    caplog.set_level(logging.ERROR, logger="backend.pipeline")
    fake = modal_env([HANG, OK_RESULT])
    progress: list[str] = []
    t0 = time.monotonic()
    with pytest.raises(pipeline.RenderUnavailableError) as ei:
        _render(tmp_path, progress=progress)
    took = time.monotonic() - t0
    assert 0.5 <= took < 3.0
    assert ei.value.code == "render_timeout"
    assert str(ei.value).startswith("render_timeout: no result from Modal")
    # Cancelled, and not retried (see _modal_give_up).
    assert fake.cancelled == 1 and fake.spawns == 1
    assert modal_env.sleeps == []
    # Every poll was bounded; the job showed it's alive meanwhile, but
    # only every CLEO_MODAL_HEARTBEAT_S, not on every poll.
    assert fake.polls >= 5
    assert all(t is not None and t <= 0.05 + 1e-9 for t in fake.poll_timeouts)
    beats = [m for m in progress if m.startswith("Rendering 1 clip(s) on Modal… 0:")]
    assert 2 <= len(beats) < fake.polls
    assert modal_env.billed and modal_env.billed[0] >= 0.5
    assert _cleaned_up(fake)
    assert list(modal_env.ledger.iterdir()) == []
    assert any(r.getMessage().startswith("[modal] RENDER TIMEOUT — ")
               for r in caplog.records)


def test_heartbeat_is_rare_enough_for_the_dashboard_backoff(monkeypatch):
    """A 10-min render polled every 10 s (simulated clock): one job
    write at 5:00, not one per poll — the dashboard backs its status
    polling off after 60 s without a change, and cost_test's stall
    check (900 s) still sees the job move."""
    for k in ("CLEO_MODAL_POLL_S", "CLEO_MODAL_HEARTBEAT_S"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("CLEO_MODAL_START_TIMEOUT_S", "0")
    clock = [1000.0]
    monkeypatch.setattr(pipeline, "time",
                        types.SimpleNamespace(monotonic=lambda: clock[0]))

    class Call:
        polls = 0

        def get(self, timeout=None):
            self.polls += 1
            clock[0] += timeout
            if clock[0] - 1000.0 >= 600:
                return OK_RESULT
            raise TimeoutError()
    call = Call()
    writes: list[tuple[float, str]] = []
    res = pipeline._await_modal_call(
        None, call, 1000.0, 1920.0, 3,
        lambda msg, pct: writes.append((clock[0] - 1000.0, msg)))
    assert res == OK_RESULT and call.polls == 60
    assert writes == [(300.0, "Rendering 3 clip(s) on Modal… 5:00")]


def test_modal_function_timeout_is_render_timeout(tmp_path, modal_env,
                                                  no_local_render):
    class FunctionTimeoutError(Exception):
        pass
    fake = modal_env([FunctionTimeoutError("1800 s")])
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="^render_timeout: FunctionTimeoutError"):
        _render(tmp_path)
    assert fake.spawns == 1 and modal_env.sleeps == []


def test_expired_output_is_an_ordinary_failure(tmp_path, modal_env,
                                               no_local_render, monkeypatch):
    """OutputExpiredError (a modal TimeoutError subclass) is no 'keep
    polling' — it fails the attempt, which is retried as before."""
    monkeypatch.setenv("CLEO_MODAL_RETRY_DELAYS", "0")
    fake = modal_env([OutputExpiredError(), OK_RESULT])
    _render(tmp_path)
    assert fake.spawns == 2 and fake.cancelled == 1


def test_remote_timeout_error_is_a_failed_attempt_not_a_poll(
        tmp_path, modal_env, no_local_render):
    """The render itself raised a builtin TimeoutError: get() returns it
    at once on every poll. That is an ordinary failed attempt (cancel,
    retry) — not "no result yet", which would spin on get() until the
    deadline."""
    fake = modal_env([TimeoutError(), OK_RESULT])
    t0 = time.monotonic()
    _render(tmp_path)
    assert time.monotonic() - t0 < 2.0
    assert fake.spawns == 2 and fake.polls == 2 and fake.cancelled == 1
    assert sum(modal_env.sleeps) == 10.0        # the normal retry backoff


def test_user_cancel_during_the_wait(tmp_path, modal_env, no_local_render):
    fake = modal_env([HANG])
    polls = []

    def cancel():
        polls.append(1)
        return len(polls) > 3
    with pytest.raises(InterruptedError):
        _render(tmp_path, cancel=cancel)
    assert fake.cancelled == 1 and fake.spawns == 1


def test_deadline_scales_with_output(monkeypatch):
    for k in ("CLEO_MODAL_DEADLINE_S_BASE", "CLEO_MODAL_DEADLINE_S_PER_S",
              "CLEO_MODAL_DEADLINE_S_MAX"):
        monkeypatch.delenv(k, raising=False)
    assert pipeline._modal_deadline_s([(0, 30), (40, 70)]) == 240 + 6 * 60
    # Capped just above Modal's own 3600 s function timeout (render_r2).
    assert pipeline._modal_deadline_s([(0, 3600)]) == 3720
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_BASE", "10")
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_PER_S", "2")
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_MAX", "nonsense")
    assert pipeline._modal_deadline_s([(0, 5)]) == 20
    # 0 is no "off" switch that fails every render at once.
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_MAX", "0")
    assert pipeline._modal_deadline_s([(0, 5)]) == 20
    assert pipeline._modal_deadline_s([(0, 3600)]) == 3720
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_BASE", "0")
    monkeypatch.setenv("CLEO_MODAL_DEADLINE_S_PER_S", "0")
    assert pipeline._modal_deadline_s([(0, 10)]) == 240 + 6 * 10


def test_real_modal_exception_classes():
    """The names the policy keys on exist in the installed client, and
    FunctionCall.get(timeout=…) raises the builtin TimeoutError."""
    exc = pytest.importorskip("modal.exception")
    give_up = pipeline._modal_give_up
    assert give_up(exc.ResourceExhaustedError("x"), "render")[0] == \
        "render_unavailable"
    assert give_up(exc.AuthError("x"), "upload")[0] == "render_unavailable"
    assert give_up(exc.NotFoundError("x"), "render")[0] == "render_unavailable"
    assert give_up(exc.NotFoundError("x"), "download") is None
    assert give_up(exc.FunctionTimeoutError("x"), "render")[0] == \
        "render_timeout"
    assert give_up(exc.InternalError("x"), "render") is None
    assert pipeline._is_poll_timeout(TimeoutError())
    assert not pipeline._is_poll_timeout(exc.OutputExpiredError())
    assert not pipeline._is_poll_timeout(exc.FunctionTimeoutError())
    import inspect
    import modal._functions as mf
    assert "raise TimeoutError()" in inspect.getsource(
        mf._Invocation.poll_function)
    assert "TimeoutError" not in vars(mf)   # i.e. the builtin one


# ── volume transfers: bounded too ────────────────────────────────────


def test_stalled_download_gives_up_and_writes_nothing_later(
        tmp_path, modal_env, no_local_render, monkeypatch):
    """modal's block GET has no read timeout: a body that stalls after
    the first block would block the render thread forever. No new block
    for CLEO_MODAL_TRANSFER_IDLE_S → render_timeout, not retried; the
    download left behind never replaces the previous output."""
    monkeypatch.setenv("CLEO_MODAL_TRANSFER_IDLE_S", "0.2")
    fake = modal_env([OK_RESULT, OK_RESULT])
    out = tmp_path / "out"
    out.mkdir()
    (out / "cleo_output.mp4").write_bytes(b"old render")
    release = threading.Event()

    def read_file(self, remote):
        yield b"first block"
        release.wait()           # the connection stalls
        yield b"late block"
    monkeypatch.setattr(fake.module.Volume, "read_file", read_file)
    t0 = time.monotonic()
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="^render_timeout: Modal download stalled"):
        _render(tmp_path)
    assert time.monotonic() - t0 < 3.0
    assert fake.spawns == 1 and modal_env.sleeps == []
    assert _cleaned_up(fake)
    assert list(modal_env.ledger.iterdir()) == []   # a download only reads
    release.set()
    assert _wait_for(lambda: not list(out.glob("*.part")))
    assert (out / "cleo_output.mp4").read_bytes() == b"old render"


def test_stalled_upload_gives_up_and_keeps_its_marker(
        tmp_path, modal_env, no_local_render, monkeypatch):
    """The upload (done when batch_upload exits) is bounded as well; the
    one left behind may still land in the folder, so its ledger marker
    stays for the sweep."""
    monkeypatch.setenv("CLEO_MODAL_TRANSFER_S_MAX", "0.2")
    fake = modal_env([OK_RESULT])
    release = threading.Event()

    class StalledBatch:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            release.wait()
            return False

        def put_file(self, local, remote):
            fake.uploads.append(remote)
    monkeypatch.setattr(fake.module.Volume, "batch_upload",
                        lambda self, force=False: StalledBatch())
    t0 = time.monotonic()
    with pytest.raises(pipeline.RenderUnavailableError,
                       match="^render_timeout: Modal upload not done"):
        _render(tmp_path)
    assert time.monotonic() - t0 < 3.0
    assert fake.spawns == 0 and modal_env.sleeps == []
    assert _cleaned_up(fake)
    assert len(list(modal_env.ledger.iterdir())) == 1
    release.set()


def test_user_cancel_during_a_stalled_download(tmp_path, modal_env,
                                               no_local_render, monkeypatch):
    fake = modal_env([OK_RESULT])
    release = threading.Event()

    def read_file(self, remote):
        release.wait()
        yield b""
    monkeypatch.setattr(fake.module.Volume, "read_file", read_file)
    cancelled = threading.Event()
    threading.Timer(0.2, cancelled.set).start()
    t0 = time.monotonic()
    with pytest.raises(InterruptedError):
        _render(tmp_path, cancel=cancelled.is_set)
    assert time.monotonic() - t0 < 3.0 and fake.spawns == 1
    assert _cleaned_up(fake)
    release.set()


# ── throttled RPCs: bounded by MODAL_MAX_THROTTLE_WAIT ───────────────


def test_render_caps_modal_throttle_retries(tmp_path, modal_env,
                                            no_local_render, monkeypatch):
    fake = modal_env([OK_RESULT, OK_RESULT])
    _render(tmp_path)
    assert os.environ["MODAL_MAX_THROTTLE_WAIT"] == "60"
    monkeypatch.setenv("MODAL_MAX_THROTTLE_WAIT", "15")   # operator's value
    _render(tmp_path)
    assert os.environ["MODAL_MAX_THROTTLE_WAIT"] == "15"
    assert fake.spawns == 2


def test_real_client_throttle_retries_stop_at_the_cap(monkeypatch):
    """modal retries a throttled RPC with no limit unless
    max_throttle_wait is set; the env var is the knob that stops it (and
    the error it then raises is RESOURCE_EXHAUSTED → render_unavailable)."""
    grpc_utils = pytest.importorskip("modal._utils.grpc_utils")
    import grpclib.client
    from grpclib import GRPCError, Status
    from modal_proto import api_pb2

    class Throttled(grpclib.client.UnaryUnaryMethod):
        def __init__(self):
            self.name = "/modal.client.ModalClient/FunctionGetOutputs"
            self.calls = 0

        async def __call__(self, req, *, timeout=None, metadata=None):
            self.calls += 1
            raise GRPCError(Status.RESOURCE_EXHAUSTED, "throttled", details=[
                api_pb2.RPCRetryPolicy(retry_after_secs=0.05)])

    def run(limit):
        fn = Throttled()
        return fn, asyncio.run(asyncio.wait_for(
            grpc_utils._retry_transient_errors(
                fn, api_pb2.FunctionGetOutputsRequest(),
                retry=grpc_utils.Retry(attempt_timeout=0.5)), limit))

    monkeypatch.delenv("MODAL_MAX_THROTTLE_WAIT", raising=False)
    with pytest.raises(asyncio.TimeoutError):
        run(0.5)                  # uncapped: still retrying
    monkeypatch.setenv("MODAL_MAX_THROTTLE_WAIT", "1")
    t0 = time.monotonic()
    with pytest.raises(GRPCError) as ei:
        run(10)
    assert time.monotonic() - t0 < 3.0
    assert ei.value.status == Status.RESOURCE_EXHAUSTED


# ── normal path unchanged ────────────────────────────────────────────


def test_success_path_unchanged(tmp_path, modal_env, no_local_render):
    fake = modal_env([OK_RESULT])
    progress: list[str] = []
    res = _render(tmp_path, progress=progress)
    out = tmp_path / "out"
    assert res["outputs"]["primary"] == str(out / "cleo_output.mp4")
    assert (out / "cleo_output.mp4").read_bytes() == b"primary"
    assert fake.spawns == 1 and fake.polls == 1 and fake.cancelled == 0
    assert fake.stats_calls == 0
    assert progress[:3] == ["Uploading to Modal storage…",
                            "Rendering 1 clip(s) on Modal…",
                            "Downloading from Modal…"]
    assert len(modal_env.billed) == 1 and modal_env.sleeps == []
    assert _cleaned_up(fake)
    assert list(modal_env.ledger.iterdir()) == []


# ── the job: back to review with the code, slot freed ────────────────


def _wait_for(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        threading.Event().wait(0.01)
    return False


def test_job_ends_render_failed_with_code_and_frees_its_slot(
        tmp_path, modal_env, client, monkeypatch):
    import backend.main as M
    from backend.jobs import store
    fake = modal_env([AtSpawn(ResourceExhaustedError("spend limit reached"))])
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"x")
    job = store.create("/x.mp4", {})
    store.update(job.id, status="awaiting_review", normalized_path=str(src),
                 segments=[(0.0, 2.0)])
    r = client.post(f"/jobs/{job.id}/render", json={"subtitles": []})
    assert r.status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "awaiting_review")
    cur = store.get(job.id)
    assert (cur.status, cur.message, cur.progress) == (
        "awaiting_review", "render_failed", 100.0)
    assert cur.error.startswith("render_unavailable: ResourceExhaustedError")
    assert fake.spawns == 1 and modal_env.sleeps == []
    assert _wait_for(lambda: job.id not in M._RENDER_SLOTS._running
                     and job.id not in M._active_jobs)
    assert _cleaned_up(fake)
    # The user can render again right away.
    fake.plan.append(OK_RESULT)
    import backend.llm as llm
    monkeypatch.setattr(llm, "generate_social_caption",
                        lambda text, language=None: {"caption": "",
                                                     "hashtags": []})
    assert client.post(f"/jobs/{job.id}/render",
                       json={"subtitles": []}).status_code == 200
    assert _wait_for(lambda: store.get(job.id).status == "done")
    assert store.get(job.id).error is None


# ── cost test: stalled jobs ──────────────────────────────────────────


def _cost_test_module():
    path = Path(__file__).resolve().parents[2] / ".github/scripts/cost_test.py"
    spec = importlib.util.spec_from_file_location("cost_test_mod", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_cost_test_wait_detects_a_stall(monkeypatch):
    ct = _cost_test_module()
    monkeypatch.setattr(ct, "POLL_S", 0.01)
    monkeypatch.setenv("CLEO_STALL_S", "0.2")
    frozen = {"status": "processing", "message": "Rendering 9 clip(s) on Modal…",
              "progress": 10.0, "updated_at": 1.0}
    monkeypatch.setattr(ct, "http", lambda method, path, *a, **k: dict(frozen))
    t0 = time.monotonic()
    with pytest.raises(RuntimeError, match="stalled"):
        ct.wait("job1", "done", 60)
    assert time.monotonic() - t0 < 2.0

    # A job that keeps moving is not a stall.
    n = {"i": 0}

    def moving(method, path, *a, **k):
        n["i"] += 1
        if n["i"] > 40:
            return {"status": "done"}
        return {**frozen, "updated_at": float(n["i"])}
    monkeypatch.setattr(ct, "http", moving)
    assert ct.wait("job1", "done", 60)["status"] == "done"


def test_cost_test_wait_does_not_count_time_in_line(monkeypatch):
    """A queued job is written only when its place changes: waiting at
    place 1 longer than CLEO_STALL_S is no stall. Once out of the line
    the stall check applies again."""
    ct = _cost_test_module()
    monkeypatch.setattr(ct, "POLL_S", 0.01)
    monkeypatch.setenv("CLEO_STALL_S", "0.2")
    queued = {"status": "processing", "message": "queued", "progress": 1.0,
              "queue_position": 1, "updated_at": 1.0}
    t0 = time.monotonic()

    def in_line_then_done(method, path, *a, **k):
        if time.monotonic() - t0 < 0.6:      # 3 × the stall time
            return dict(queued)
        return {"status": "done"}
    monkeypatch.setattr(ct, "http", in_line_then_done)
    assert ct.wait("job1", "done", 60)["status"] == "done"

    t0 = time.monotonic()
    frozen = {"status": "processing", "message": "Analyzing…",
              "progress": 5.0, "queue_position": None, "updated_at": 2.0}

    def in_line_then_frozen(method, path, *a, **k):
        return dict(queued if time.monotonic() - t0 < 0.4 else frozen)
    monkeypatch.setattr(ct, "http", in_line_then_frozen)
    with pytest.raises(RuntimeError, match="stalled"):
        ct.wait("job1", "done", 60)
    assert time.monotonic() - t0 >= 0.6
