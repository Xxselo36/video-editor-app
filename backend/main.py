"""Cleo Web Backend — FastAPI app.

Replaces the standalone HTTP server in plugins/premiere/ for web-app use.
Imports the same pipeline code from src/ so there is exactly one
implementation of analyze/render/SmartCam/voice-triggers across both
the desktop plugin and the web app.

Loads repo-root .env on import so ANTHROPIC_API_KEY (and other secrets)
are available to backend.llm without manual `export` per shell.

Accounts (backend/auth.py, Clerk) and billing (backend/billing.py +
backend/accounts.py, Lemon Squeezy) are off until their env vars are set;
while off, every route works anonymously exactly as before. Those three
modules are imported only here — the desktop app and the Modal image
load backend.pipeline & co. without them (and without PyJWT).

Run dev server:
    ./venv313/bin/uvicorn backend.main:app --reload --port 8000

Production:
    ./venv313/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8000 \\
        --workers 1

Exactly ONE process: jobs run as threads of it, admission control (the
analysis/render queues, per-user limits, disk reservations), editor
save ordering and the SQLite job store are all in-process state. A
second worker would double every limit and silently lose job updates.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow `from src...` imports when run from repo root
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Load repo-root .env so ANTHROPIC_API_KEY etc. are available without
# requiring an explicit `export` in every shell.
try:
    from dotenv import load_dotenv
    load_dotenv(_REPO_ROOT / ".env")
except ImportError:
    pass

import asyncio
import functools
import hashlib
import hmac
import inspect
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import threading
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from contextlib import asynccontextmanager
import time

from fastapi import (
    Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

import backend.pipeline as pipeline
from backend import accounts, auth, billing, costs
from backend.auth import (
    User, current_user, get_owned_job, media_user, require_user,
)
from backend.jobs import DEFAULT_PLAN, new_job_id, retention_days, store
from backend.pipeline import EXPORT_FORMATS, analyze_only, render_only

# Media tokens (?t=) must not end up in the access log.
auth.install_log_filter()

# Track active worker threads so shutdown can wait for them before
# letting the container die. Deploys used to kill mid-flight jobs;
# now they wait up to _SHUTDOWN_GRACE_SEC for work in progress.
_active_jobs: set[str] = set()
_active_lock = threading.Lock()
_shutdown_grace_sec = float(os.environ.get("CLEO_SHUTDOWN_GRACE_SEC", "180"))


def _register_active(job_id: str) -> None:
    with _active_lock:
        _active_jobs.add(job_id)


def _release_active(job_id: str) -> None:
    with _active_lock:
        _active_jobs.discard(job_id)


# ── Admission control ────────────────────────────────────────────────
# Overload becomes a visible queue instead of a crash. At most
# CLEO_MAX_ANALYZE analyses and CLEO_MAX_RENDER renders run at once; the
# others wait in line (status "processing", message "queued", with a
# queue_position). Beyond CLEO_MAX_QUEUE waiting analyses new uploads get
# 503 server_busy (+ Retry-After), one account may have at most
# CLEO_MAX_ACTIVE_PER_USER jobs in flight (429 too_many_active_jobs),
# uploads are capped in size and length (413) and each one reserves disk
# space for what its analysis will write (507). All in-process state —
# this backend is exactly one process (module docstring).


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return float(default)


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, default))


def _plain(n: float) -> float | int:
    """4.0 → 4 in error bodies."""
    return int(n) if float(n).is_integer() else n


class ApiRefusal(Exception):
    """A deliberate refusal, answered as {"detail": code, **extra} with
    `headers` (exception handler below)."""

    def __init__(self, status: int, detail: str,
                 headers: dict[str, str] | None = None, **extra: Any) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.headers = headers
        self.extra = extra


def _max_upload_gb() -> float:
    return _env_float("CLEO_MAX_UPLOAD_GB", 4)


def _max_minutes() -> float:
    return _env_float("CLEO_MAX_MINUTES", 30)


def _too_big(size: float | None) -> bool:
    return size is not None and size > _max_upload_gb() * 1e9


def _too_long(seconds: float | None) -> bool:
    # +1 s: container durations and the browser's reading round a bit.
    return seconds is not None and seconds > _max_minutes() * 60 + 1


def _file_too_large() -> ApiRefusal:
    return ApiRefusal(413, "file_too_large", max_gb=_plain(_max_upload_gb()))


def _video_too_long() -> ApiRefusal:
    return ApiRefusal(413, "video_too_long", max_minutes=_plain(_max_minutes()))


def _server_busy() -> ApiRefusal:
    return ApiRefusal(503, "server_busy", headers={"Retry-After": "120"})


class _SlotQueue:
    """Work slots handed out in arrival order: at most limit() jobs hold
    one, the others wait and know their 1-based place in line — a fair
    threading.BoundedSemaphore that can tell positions."""

    def __init__(self, limit: Callable[[], int]) -> None:
        self._limit = limit
        self._cond = threading.Condition()
        self._running: set[str] = set()
        self._waiting: list[str] = []
        # enqueue()d places whose worker hasn't called acquire() yet.
        self._owners: dict[str, threading.Thread] = {}
        # Place each waiter last reported through on_wait.
        self._published: dict[str, int] = {}
        # Winners still writing their start status (on_start).
        self._starting = 0
        self._closed = False

    def limit(self) -> int:
        return max(1, self._limit())

    def _prune(self) -> None:
        """Drop enqueue()d places whose worker ended without taking them."""
        dead = [j for j, t in self._owners.items()
                if t.ident is not None and not t.is_alive()]
        for job_id in dead:
            del self._owners[job_id]
            self._published.pop(job_id, None)
            if job_id in self._waiting:
                self._waiting.remove(job_id)
        if dead:
            self._cond.notify_all()

    def _position(self, job_id: str) -> int | None:
        self._prune()
        if job_id not in self._waiting:
            return None
        free = max(0, self.limit() - len(self._running))
        pos = self._waiting.index(job_id) + 1 - free
        return pos if pos > 0 else None

    def _may_publish(self, job_id: str) -> bool:
        """New places are shown front to back, and only once the jobs
        that just got a slot no longer show theirs (on_start): no two
        jobs ever show the same place in line."""
        if self._starting:
            return False
        for other in self._waiting[:self._waiting.index(job_id)]:
            if self._published.get(other) != self._position(other):
                return False
        return True

    def enqueue(self, job_id: str, worker: threading.Thread) -> int | None:
        """Take `job_id`'s place in line now, from the request handler,
        for `worker` (a thread about to start and call acquire(), which
        takes the place over). Returns the real position — concurrent
        requests can't compute the same one — or None: a slot is free."""
        with self._cond:
            if (self._closed or job_id in self._running
                    or job_id in self._waiting):
                return None
            self._waiting.append(job_id)
            self._owners[job_id] = worker
            pos = self._position(job_id)
            if pos is not None:  # what the handler answers and shows
                self._published[job_id] = pos
            return pos

    def acquire(self, job_id: str,
                on_wait: Callable[[int], None] | None = None,
                on_start: Callable[[], None] | None = None) -> bool:
        """Block until `job_id` may run. on_wait(position) is called
        (without the lock) whenever its place in line changes; on_start()
        once it got a slot, before the others in line publish their new
        places (_may_publish: two jobs never both show #1). False, with
        nothing acquired, for a job that is already queued or running
        (unless enqueue()d for this thread), and once the queue is
        closed (shutdown)."""
        with self._cond:
            if self._owners.get(job_id) is threading.current_thread():
                del self._owners[job_id]
            elif (self._closed or job_id in self._running
                    or job_id in self._waiting):
                return False
            else:
                self._waiting.append(job_id)
        reported: int | None = None
        try:
            while True:
                with self._cond:
                    while True:
                        if self._closed:
                            return False
                        pos = self._position(job_id)
                        if pos is None:
                            self._waiting.remove(job_id)
                            self._running.add(job_id)
                            self._starting += 1
                            break
                        if pos != reported and self._may_publish(job_id):
                            break
                        self._cond.wait()
                if pos is None:
                    break
                reported = pos
                if on_wait is not None:
                    try:
                        on_wait(pos)
                    except Exception as e:
                        print(f"[queue] position update for {job_id} "
                              f"failed: {e}", flush=True)
                with self._cond:
                    self._published[job_id] = pos
                    self._cond.notify_all()
        finally:
            with self._cond:
                self._published.pop(job_id, None)
                if job_id in self._waiting:
                    self._waiting.remove(job_id)
                    self._cond.notify_all()
        try:
            if on_start is not None:
                on_start()
        except Exception as e:
            print(f"[queue] start update for {job_id} failed: {e}",
                  flush=True)
        finally:
            with self._cond:
                self._starting -= 1
                self._cond.notify_all()
        return True

    def cancel(self, job_id: str) -> None:
        """Give up an enqueue()d place whose worker never started."""
        with self._cond:
            if self._owners.pop(job_id, None) is not None:
                self._published.pop(job_id, None)
                if job_id in self._waiting:
                    self._waiting.remove(job_id)
                self._cond.notify_all()

    def release(self, job_id: str) -> None:
        with self._cond:
            self._running.discard(job_id)
            self._cond.notify_all()

    def position(self, job_id: str) -> int | None:
        with self._cond:
            if job_id not in self._waiting:
                return None
            return self._position(job_id)

    def close(self) -> None:
        """Shutdown: nobody waiting starts any more (the boot after the
        restart fails / refunds those jobs, like interrupted ones)."""
        with self._cond:
            self._closed = True
            self._cond.notify_all()


_ANALYZE_SLOTS = _SlotQueue(lambda: _env_int("CLEO_MAX_ANALYZE", 2))
# Modal renders mostly wait on Modal (a thread + the mezzanine upload
# each); without Modal a render is a local MoviePy encode, as heavy as
# an analysis.
_RENDER_SLOTS = _SlotQueue(lambda: _env_int(
    "CLEO_MAX_RENDER", 4 if os.environ.get("MODAL_TOKEN_ID") else 2))


def _bytes_on_disk(entry: dict) -> int:
    """What an in-flight job has written so far (upload + job folder)."""
    total = 0
    paths = []
    if entry.get("upload"):
        paths.append(Path(entry["upload"]))
    if entry.get("job_id"):
        job_dir = _WORK_ROOT / entry["job_id"]
        if job_dir.is_dir():
            paths.extend(p for p in job_dir.iterdir())
    for path in paths:
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            pass
    return total


class _Inflight:
    """This process's work in flight, per owner: uploads being accepted
    by POST /jobs (kind "upload") and analysis / render worker threads.
    Feeds the per-user limit, the queue cap, queue-position hints and
    the disk reservations. Entries of worker threads drop out by
    themselves once the thread has ended."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}

    def _live(self) -> list[dict]:
        dead = [k for k, e in self._entries.items()
                if e["thread"] is not None and not e["thread"].is_alive()]
        for k in dead:
            del self._entries[k]
        return list(self._entries.values())

    @staticmethod
    def _entry(owner: str | None, kind: str) -> dict:
        return {"owner": owner, "kind": kind, "thread": None, "need": 0.0,
                "upload": None, "job_id": None}

    def _check(self, user: User | None) -> None:
        live = self._live()
        if user is not None and not user.is_service:
            limit = _env_int("CLEO_MAX_ACTIVE_PER_USER", 2)
            if limit > 0 and sum(e["owner"] == user.id for e in live) >= limit:
                raise ApiRefusal(429, "too_many_active_jobs")
        backlog = sum(e["kind"] in ("upload", "analyze") for e in live)
        waiting = backlog + 1 - _ANALYZE_SLOTS.limit()
        if waiting > _env_int("CLEO_MAX_QUEUE", 20):
            raise _server_busy()

    def check(self, user: User | None) -> None:
        """Would one more upload be admitted? (presign: say no before the
        bytes are sent). Raises ApiRefusal 429 / 503."""
        with self._lock:
            self._check(user)

    def admit(self, user: User | None) -> str:
        """Hold a place for one upload (POST /jobs) or refuse it (429 /
        503). Returns the token for reserve_disk / attach / release."""
        with self._lock:
            self._check(user)
            token = f"upload:{uuid.uuid4().hex}"
            self._entries[token] = self._entry(user.id if user else None,
                                               "upload")
            return token

    def reserve_disk(self, token: str | None, size: float,
                     upload_path: str | None = None) -> None:
        """Size-aware free-space check: CLEO_DISK_FACTOR (3.5) × the
        upload must fit beside what the other jobs in flight will still
        write, plus the CLEO_MIN_FREE_GB floor — so parallel uploads
        can't all pass the same check. Recorded under `token` (None =
        only check, for presign). Raises 507 server_storage_full."""
        need = _env_float("CLEO_DISK_FACTOR", 3.5) * max(0.0, size or 0.0)
        # The filesystem is scanned WITHOUT the lock: the event loop takes
        # it too (admit / attach / release), and a scan per entry per
        # upload under it turned a burst of uploads into loop stalls.
        with self._lock:
            self._live()
            snapshot = [e for k, e in self._entries.items() if k != token]
        written = {id(e): _bytes_on_disk(e) for e in snapshot}
        free = shutil.disk_usage(_WORK_ROOT).free
        with self._lock:
            # Entries that came in meanwhile count in full; bytes written
            # since the scan are both in `free` and in the reservations,
            # so the stale numbers still add up.
            others = sum(max(0.0, e["need"] - written.get(id(e), 0))
                         for k, e in self._entries.items() if k != token)
            if free - others < need + _MIN_FREE_BYTES:
                print(f"[jobs] refusing upload: {free / 1e9:.1f} GB free, "
                      f"{others / 1e9:.1f} GB reserved, "
                      f"{need / 1e9:.1f} GB needed", flush=True)
                raise HTTPException(507, "server_storage_full")
            entry = self._entries.get(token) if token else None
            if entry is not None:
                entry["need"] = need
                entry["upload"] = upload_path

    def attach(self, token: str, job_id: str,
               thread: threading.Thread) -> None:
        """The upload became job `job_id`, analysed by `thread`."""
        with self._lock:
            entry = self._entries.pop(token, None) or self._entry(None, "")
            entry.update(kind="analyze", job_id=job_id, thread=thread)
            self._entries[job_id] = entry

    def track(self, job_id: str, owner: str | None, kind: str,
              thread: threading.Thread) -> None:
        with self._lock:
            entry = self._entry(owner, kind)
            entry.update(job_id=job_id, thread=thread)
            self._entries[job_id] = entry

    def release(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)


_INFLIGHT = _Inflight()


class _ProgressWriter:
    """progress_cb of a worker: at most one store write per
    CLEO_PROGRESS_INTERVAL_S (1 s) per job — ticks in between are
    coalesced and the newest is written when the interval ends. Writes
    only while the job is still 'processing', so a late tick can never
    overwrite the result (awaiting_review / done / error) the worker
    stored; close() before storing it."""

    def __init__(self, job_id: str, interval: float | None = None) -> None:
        self.job_id = job_id
        self.interval = (_env_float("CLEO_PROGRESS_INTERVAL_S", 1.0)
                         if interval is None else interval)
        self._lock = threading.Lock()
        self._last = float("-inf")
        self._pending: tuple[str, float] | None = None
        self._timer: threading.Timer | None = None
        self._closed = False

    def __call__(self, msg: str, pct: float) -> None:
        with self._lock:
            if self._closed:
                return
            self._pending = (msg, pct)
            wait = self._last + self.interval - time.monotonic()
            if wait > 0:
                if self._timer is None:
                    self._timer = threading.Timer(wait, self._flush)
                    self._timer.daemon = True
                    self._timer.start()
                return
        self._flush()

    def _flush(self) -> None:
        # The write happens under our lock: ticks stay in order, and
        # close() returns only after an in-progress write is done.
        with self._lock:
            self._timer = None
            if self._closed or self._pending is None:
                return
            msg, pct = self._pending
            self._pending = None
            self._last = time.monotonic()
            fields: dict[str, Any] = {"message": msg}
            if pct is not None and pct >= 0:
                fields["progress"] = pct
            try:
                store.update_if(self.job_id, "processing", **fields)
            except Exception as e:
                print(f"[job {self.job_id}] progress write failed: {e}",
                      flush=True)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._pending = None
            timer, self._timer = self._timer, None
        if timer is not None:
            timer.cancel()


def _queued_writer(job_id: str, expect: tuple[str, ...]
                   ) -> Callable[[int], None]:
    """on_wait for _SlotQueue.acquire: show the job as waiting in line."""
    def _write(pos: int) -> None:
        store.update_if(job_id, expect, status="processing",
                        message="queued", queue_position=pos)
    return _write


def _start_writer(job_id: str, expect: tuple[str, ...], message: str
                  ) -> Callable[[], None]:
    """on_start for _SlotQueue.acquire: the job left the line."""
    def _write() -> None:
        store.update_if(job_id, expect, status="processing", message=message,
                        progress=1.0, queue_position=None)
    return _write


def _accepts(fn: Callable, name: str) -> bool:
    """Does fn take keyword `name`? (analyze_only's on_normalized.)"""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params or any(p.kind is p.VAR_KEYWORD
                                 for p in params.values())


@asynccontextmanager
async def lifespan(app_: FastAPI):
    # STARTUP: any job stuck in 'processing'/'pending' from the previous
    # container generation is unrecoverable — its worker thread died
    # with the process. Surface it as a real error so the frontend can
    # show a retry button instead of polling forever, refund it and free
    # its files.
    stuck = store.mark_stuck_as_error()
    if stuck:
        print(f"[startup] marked {stuck} stuck job(s) as error "
              f"(container restart)", flush=True)
    _refund_interrupted()
    _clean_interrupted()
    threading.Thread(target=_retention_loop, daemon=True).start()
    threading.Thread(target=_prerender_caption_previews, daemon=True).start()
    auth.install_log_filter()
    auth.log_status()
    billing.log_status()
    if billing.enabled():
        threading.Thread(target=billing.reconcile_loop, daemon=True).start()
    yield
    # SHUTDOWN: wait for in-flight worker threads to finish before
    # letting Uvicorn exit. Railway sends SIGTERM, then SIGKILL after
    # RAILWAY_DEPLOYMENT_DRAINING_SECONDS (default 0!) — set that to
    # match CLEO_SHUTDOWN_GRACE_SEC (default 180 s). Jobs still waiting
    # in line don't start any more; the next boot fails (and refunds)
    # them like other interrupted jobs, and frees their uploads.
    _ANALYZE_SLOTS.close()
    _RENDER_SLOTS.close()
    deadline = time.monotonic() + _shutdown_grace_sec
    while True:
        with _active_lock:
            remaining = len(_active_jobs)
        if remaining == 0:
            print("[shutdown] all jobs completed, exiting cleanly",
                  flush=True)
            break
        if time.monotonic() > deadline:
            print(f"[shutdown] grace period expired, "
                  f"{remaining} job(s) will be killed", flush=True)
            break
        print(f"[shutdown] waiting for {remaining} job(s) to finish "
              f"(grace {int(deadline - time.monotonic())}s left)",
              flush=True)
        await asyncio.sleep(2.0)


app = FastAPI(
    title="Cleo Web Backend",
    version="0.1.0",
    description="Voice-first AI video editor — backend for web app.",
    lifespan=lifespan,
)

# Where uploads + outputs live during processing. Phase 2: local disk.
# Phase 3: swap for S3 / Cloudflare R2.
def _default_work_root() -> Path:
    """Job files (upload, normalized source, preview, outputs).

    CLEO_WORK_ROOT wins; otherwise a mounted persistent volume at /data
    (Railway volume) is used so jobs survive redeploys; /tmp only as a
    last resort (wiped on every restart)."""
    env = os.environ.get("CLEO_WORK_ROOT")
    if env:
        return Path(env)
    data = Path("/data")
    if data.is_dir() and os.access(data, os.W_OK):
        return data / "cleo_jobs"
    return Path(tempfile.gettempdir()) / "cleo_jobs"


_WORK_ROOT = _default_work_root()
_WORK_ROOT.mkdir(parents=True, exist_ok=True)
# Modal volume folders of renders, until they are surely gone
# (pipeline.sweep_modal_folders, run by the retention loop).
pipeline.MODAL_LEDGER_DIR = str(_WORK_ROOT / "modal_folders")
# Free space that must remain on the work volume after an upload's disk
# reservation (_Inflight.reserve_disk) — for the job DB, previews, renders.
_MIN_FREE_BYTES = float(os.environ.get("CLEO_MIN_FREE_GB", "1")) * 1e9

def _remove_upload(path: str | None) -> None:
    """Delete an uploaded source file (only inside our work root)."""
    if path and Path(path).resolve().is_relative_to(_WORK_ROOT.resolve()):
        try:
            os.remove(path)
        except OSError:
            pass


def _delete_job(job) -> None:
    """Remove a job's files (work dir, uploaded source, R2 object) and row."""
    shutil.rmtree(_WORK_ROOT / job.id, ignore_errors=True)
    _remove_upload(job.input_path)
    key = (job.settings or {}).get("_r2_storage_key")
    if key:
        from backend.storage import delete_from_r2
        delete_from_r2(key)
    store.delete(job.id)
    with _EDIT_GUARD:
        _EDIT_SEQ.pop(job.id, None)
        _PREVIEW_LOCKS.pop(job.id, None)


def purge_expired_jobs(now: float | None = None) -> int:
    """Delete jobs idle longer than their plan's retention period
    (backend.jobs.PLAN_RETENTION_DAYS; the privacy page states the same).

    Legacy jobs without updated_at get stamped now, so they get the
    full retention period instead of being wiped on the first sweep.
    Returns the number of deleted jobs.
    """
    now = time.time() if now is None else now
    with _active_lock:
        active = set(_active_jobs)
    deleted = 0
    for job in store.list_all():
        if job.id in active or job.status in ("processing", "pending"):
            continue
        if not job.updated_at:
            store.update(job.id, updated_at=now)
            continue
        expires = job.expires_at()
        if expires is None or expires > now:
            continue
        _delete_job(job)
        deleted += 1
    return deleted


def _retention_loop() -> None:
    while True:
        try:
            n = purge_expired_jobs()
            if n:
                print(f"[retention] deleted {n} expired job(s)", flush=True)
        except Exception as e:
            print(f"[retention] sweep failed: {e}", flush=True)
        try:
            n = pipeline.sweep_modal_folders()
            if n:
                print(f"[retention] removed {n} leftover Modal volume "
                      f"folder(s)", flush=True)
        except Exception as e:
            print(f"[retention] Modal volume sweep failed: {e}", flush=True)
        time.sleep(3600)


# ── Minutes quota (backend/accounts.py) ──────────────────────────────
# Charged once, at POST /jobs, from the probed length of the upload;
# trued up after analysis; refunded only when WE failed.


def _bills(user: User | None) -> bool:
    """Does this caller's upload count against a minutes quota? Not with
    auth off, not for the service user, not while billing is off."""
    return user is not None and not user.is_service and billing.enabled()


def _to_float(value: str) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if v == v else 0.0  # NaN


def _probe_duration(path: str) -> float | None:
    """Length of an upload in seconds, or None if ffprobe can't tell.

    Streamed WebM (MediaRecorder) has no duration in its header
    (format=duration is N/A), so fall back to the last packet timestamp.
    """
    from src.ffmpeg_utils import get_ffprobe_path
    ffprobe = get_ffprobe_path()

    def _run(args: list[str], timeout: float) -> str:
        try:
            r = subprocess.run([ffprobe, "-v", "error", *args, path],
                               capture_output=True, text=True,
                               timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return r.stdout if r.returncode == 0 else ""

    dur = _to_float(_run(["-show_entries", "format=duration", "-of",
                          "default=noprint_wrappers=1:nokey=1"], 30).strip())
    if dur > 0:
        return dur
    out = _run(["-show_entries", "packet=pts_time", "-of", "csv=p=0"], 180)
    dur = max((_to_float(line.strip().strip(","))
               for line in out.splitlines()), default=0.0)
    return dur if dur > 0 else None


def _is_infra_failure(exc: BaseException, msg: str) -> bool:
    """Analysis failures that are our fault (full disk, IO, ffmpeg,
    restart) give the minutes back. Content problems ("No speech
    detected") don't — they already cost Groq/Claude time, and a refund
    would let the same file be retried for free forever."""
    if msg in ("server_storage_full", "container_restart"):
        return True
    if isinstance(exc, (OSError, MemoryError)):
        return True
    return msg.lower().startswith("ffmpeg")


def _true_up(job_id: str, duration: float) -> None:
    if not auth.auth_enabled():
        return
    try:
        extra = accounts.true_up(job_id, float(duration or 0))
        if extra:
            print(f"[job {job_id}] video longer than probed: charged "
                  f"{extra:.0f}s more", flush=True)
    except Exception as e:  # never fail a job over bookkeeping
        print(f"[job {job_id}] usage true-up failed: {e}", flush=True)


def _true_up_from_file(job_id: str, job_dir: Path) -> None:
    """True-up for an analysis that failed after normalizing: its result
    (with the duration) never came, so probe the normalized file."""
    if not auth.auth_enabled():
        return
    for name in ("normalized.mp4", "normalized_smartcam.mp4"):
        path = job_dir / name
        if not path.exists():
            continue
        try:
            seconds = _probe_duration(str(path))
        except Exception as e:
            print(f"[job {job_id}] duration probe failed: {e}", flush=True)
            return
        if seconds:
            _true_up(job_id, seconds)
        return


def _refund(job_id: str, note: str) -> None:
    if not auth.auth_enabled():
        return
    try:
        if accounts.refund(job_id, note):
            print(f"[job {job_id}] minutes refunded ({note[:60]})",
                  flush=True)
    except Exception as e:
        print(f"[job {job_id}] refund failed: {e}", flush=True)


def _refund_interrupted() -> None:
    """Startup: analyses killed by the last restart get their minutes
    back (mark_stuck_as_error tagged them container_restart). Idempotent."""
    if not auth.auth_enabled():
        return
    for job in store.list_all():
        if job.status == "error" and job.error == "container_restart":
            _refund(job.id, "container_restart")


def _discard_upload(input_path: str | None, storage_key: str | None) -> None:
    """Throw away a refused upload (local copy + R2 object)."""
    _remove_upload(input_path)
    if storage_key:
        from backend.storage import delete_from_r2
        delete_from_r2(storage_key)


# Process start: files in uploads/ older than this can't belong to an
# upload this process is accepting.
_PROCESS_START = time.time()


def _clean_interrupted() -> None:
    """Startup, after mark_stuck_as_error: analyses the last restart
    killed or never started (error container_restart) can't be resumed —
    the user uploads again — so free their upload (local copy + R2
    object) and partial job folder now, like a failed analysis does,
    instead of keeping them for the whole retention period. Then delete
    files in uploads/ that no job refers to (a restart in the middle of
    POST /jobs). Idempotent."""
    referenced: set[Path] = set()
    for job in store.list_all():
        if job.status == "error" and job.error == "container_restart":
            job_dir = _WORK_ROOT / job.id
            if job.input_path or job_dir.exists():
                try:
                    _discard_upload(job.input_path,
                                    (job.settings or {}).get("_r2_storage_key"))
                except Exception as e:  # R2 unreachable: retention later
                    print(f"[startup] dropping the upload of {job.id} "
                          f"failed: {e}", flush=True)
                shutil.rmtree(job_dir, ignore_errors=True)
                store.update(job.id, input_path=None,
                             updated_at=job.updated_at)
        elif job.input_path:
            referenced.add(Path(job.input_path).resolve())
    uploads = _WORK_ROOT / "uploads"
    if not uploads.is_dir():
        return
    removed = 0
    for path in uploads.iterdir():
        try:
            if (path.is_file() and path.resolve() not in referenced
                    and path.stat().st_mtime < _PROCESS_START):
                path.unlink()
                removed += 1
        except OSError:
            pass
    if removed:
        print(f"[startup] removed {removed} upload(s) no job refers to",
              flush=True)


# Values backend.pipeline understands; anything else falls back to its
# defaults. 1080 is what the web app sends; 4K stays opt-in.
_RESOLUTIONS = ("1080", "1440", "2160", "4k")
_SMARTCAM_FORMATS = ("portrait", "landscape")


def _clean_settings(parsed: dict, user: User | None) -> dict:
    """Only the settings the web app sends, with sane values. Everything
    else is dropped: internal keys (a forged _r2_storage_key would make
    us delete someone else's upload), whisper_model (server default —
    the client must not pick a local model size), unknown resolutions
    and formats. _cost_test (cost_test.py tagging) stays for the service
    user, and while auth is off."""
    out: dict[str, Any] = {}
    for key in ("caption_preset", "style"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()[:64]
    for key in ("voice_triggers", "remove_fillers", "smartcam_enabled"):
        if isinstance(parsed.get(key), bool):
            out[key] = parsed[key]
    if parsed.get("smartcam_format") in _SMARTCAM_FORMATS:
        out["smartcam_format"] = parsed["smartcam_format"]
    resolution = parsed.get("resolution")
    if (isinstance(resolution, (str, int)) and not isinstance(resolution, bool)
            and str(resolution).strip().lower() in _RESOLUTIONS):
        out["resolution"] = str(resolution).strip().lower()
    formats = parsed.get("output_formats")
    if isinstance(formats, list):
        out["output_formats"] = list(dict.fromkeys(
            f for f in formats if isinstance(f, str) and f in EXPORT_FORMATS))
    if "_cost_test" in parsed and (user is None or user.is_service):
        out["_cost_test"] = parsed["_cost_test"]
    return out


def _short(value: str | None, limit: int) -> str | None:
    value = (value or "").strip()
    return value[:limit] or None


def _quota_error(code: str, **extra) -> HTTPException:
    return HTTPException(402, {"code": code, **extra})


@app.exception_handler(ApiRefusal)
async def _api_refusal(request: Request, exc: ApiRefusal):
    return JSONResponse({"detail": exc.detail, **exc.extra},
                        status_code=exc.status, headers=exc.headers)


# ── Request body limits ──────────────────────────────────────────────
# FastAPI reads (and parses) the whole body before auth runs: one 400 MB
# JSON POST used to cost ~1 GB of RAM before its 401. Bodies over the
# limit get 413 straight from Content-Length, or as soon as a chunked
# body grows past it.

_KIB = 1024
_MIB = 1024 * 1024


def _body_limit(scope) -> tuple[int, dict]:
    """(max body bytes, 413 answer) for a request."""
    method, path = scope.get("method"), scope.get("path")
    if method == "POST" and path == "/billing/webhook":
        return 256 * _KIB, {"detail": "request_too_large"}
    if method == "POST" and path == "/jobs":
        # Legacy multipart upload through Railway; big files go to R2.
        limit = int(_env_float("CLEO_MAX_FORM_UPLOAD_MB", 100) * _MIB)
        return limit, {"detail": "file_too_large",
                       "max_gb": _plain(round(limit / 1e9, 2))}
    return (int(_env_float("CLEO_MAX_BODY_KB", 1024) * _KIB),
            {"detail": "request_too_large"})


class _BodyTooLarge(StarletteHTTPException):
    """Raised from the body stream; an HTTPException so FastAPI's body
    parsing passes it on instead of turning it into a 400."""

    def __init__(self, body: dict) -> None:
        super().__init__(413, body.get("detail"))
        self.body = body


@app.exception_handler(_BodyTooLarge)
async def _body_too_large(request: Request, exc: _BodyTooLarge):
    return JSONResponse(exc.body, status_code=413,
                        headers={"Connection": "close"})


class _BodyLimitMiddleware:
    """Pure ASGI (no buffering). Added before CORSMiddleware, so CORS
    wraps it and the browser can read the 413."""

    def __init__(self, app_) -> None:
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit, answer = _body_limit(scope)
        for name, value in scope.get("headers") or ():
            if name == b"content-length":
                try:
                    too_big = int(value) > limit
                except ValueError:
                    too_big = False
                if too_big:
                    response = JSONResponse(answer, status_code=413,
                                            headers={"Connection": "close"})
                    return await response(scope, receive, send)
                break
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body") or b"")
                if received > limit:
                    raise _BodyTooLarge(answer)
            return message

        started = False

        async def tracking_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge as e:
            if started:
                raise
            response = JSONResponse(e.body, status_code=413,
                                    headers={"Connection": "close"})
            await response(scope, receive, send)


app.add_middleware(_BodyLimitMiddleware)

# CORS configuration:
#   - Dev (default): allow LAN IPs on :3000 for phone/tablet testing.
#   - Prod: set CLEO_ALLOWED_ORIGINS="https://cleo.video,https://www.cleo.video"
#     and the regex falls away in favor of an explicit allow-list.
# ETag (GET /jobs/status) and Retry-After (503 server_busy) are exposed
# so the web app can read them.
import os as _cors_os

_allowed_origins_env = _cors_os.environ.get("CLEO_ALLOWED_ORIGINS", "").strip()
if _allowed_origins_env:
    _origins = [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag", "Retry-After"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=(
            r"http://(localhost|127\.0\.0\.1|192\.168\.[0-9]+\.[0-9]+|"
            r"10\.[0-9]+\.[0-9]+\.[0-9]+):3000"
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag", "Retry-After"],
    )


# Cross-Origin-Resource-Policy on every response so the frontend
# (which runs with COEP=require-corp for ffmpeg.wasm's SharedArrayBuffer)
# can load /jobs/*/thumbnail, /jobs/*/watch, and POST uploads to us.
# Without this the browser blocks the response at the network layer
# and the upload just hangs at 0%.
@app.middleware("http")
async def add_corp_header(request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    return response


@app.get("/")
def root():
    return {
        "service": "cleo-backend",
        "version": app.version,
        "status": "ok",
    }


@app.get("/health")
async def health():
    """Liveness: answered on the event loop, whatever the threads do."""
    return {"status": "ok"}


# One thread: a hung DB makes checks queue up and time out (not ready)
# instead of piling up threads.
_READY_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ready")


@app.get("/ready")
async def ready():
    """Readiness: the job DB answers a trivial query within 2 s."""
    loop = asyncio.get_running_loop()
    try:
        await asyncio.wait_for(loop.run_in_executor(_READY_POOL, store.ping),
                               timeout=2.0)
    except asyncio.TimeoutError:
        return JSONResponse({"status": "not_ready", "reason": "db_timeout"},
                            status_code=503)
    except Exception as e:
        print(f"[ready] db check failed: {e}", flush=True)
        return JSONResponse({"status": "not_ready", "reason": "db_error"},
                            status_code=503)
    return {"status": "ready"}


# Caption-style previews are pre-rendered as PIL images, used by the
# style picker in the configure screen so the user sees the actual
# typeface/effect rather than a CSS approximation.
CAPTION_PRESETS = [
    "clean", "classic", "clipper", "highlight",
    "flash", "punch", "elegant", "subtle", "none",
]
# Sizes the web app asks for (page.tsx) and the route's default.
_CAPTION_SIZES = ((320, 110), (200, 72), (240, 90), (280, 100))
_CAPTION_CACHE_MAX = 64
_caption_png: OrderedDict[tuple[str, int, int], bytes] = OrderedDict()
_caption_lock = threading.Lock()


def _caption_cached(key: tuple[str, int, int]) -> bytes | None:
    with _caption_lock:
        png = _caption_png.get(key)
        if png is not None:
            _caption_png.move_to_end(key)
        return png


def _render_caption_png(preset: str, w: int, h: int) -> bytes:
    """PNG bytes of one preview, kept in an LRU of _CAPTION_CACHE_MAX."""
    key = (preset, w, h)
    png = _caption_cached(key)
    if png is not None:
        return png
    from src import caption_preview as cp
    img = cp.render_caption_preview(preset, size=(w, h))
    # src.caption_preview keeps every image it ever rendered; w/h come
    # from the (public) query string, so keep only our bounded cache.
    getattr(cp, "_CACHE", {}).pop((preset, (w, h)), None)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png = buf.getvalue()
    with _caption_lock:
        _caption_png[key] = png
        _caption_png.move_to_end(key)
        while len(_caption_png) > _CAPTION_CACHE_MAX:
            _caption_png.popitem(last=False)
    return png


def _prerender_caption_previews() -> None:
    """Startup: fill the cache with every preset at the web app's sizes,
    so requests never wait for PIL."""
    try:
        for w, h in _CAPTION_SIZES:
            for preset in CAPTION_PRESETS:
                _render_caption_png(preset, w, h)
    except Exception as e:
        print(f"[caption-previews] prerender failed: {e}", flush=True)


@app.get("/caption-previews/{preset}.png")
async def caption_preview(preset: str, w: int = 280, h: int = 100):
    if preset not in CAPTION_PRESETS:
        raise HTTPException(404, "unknown caption preset")
    w = max(80, min(800, w))
    h = max(40, min(400, h))
    png = _caption_cached((preset, w, h))
    if png is None:
        png = await run_in_threadpool(_render_caption_png, preset, w, h)
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def _run_analyze(job_id: str) -> None:
    """Worker thread: wait in line for an analysis slot, then analyze.
    The wait isn't billed to the job's costs."""
    try:
        waiting = ("pending", "processing")
        if not _ANALYZE_SLOTS.acquire(
                job_id, on_wait=_queued_writer(job_id, waiting),
                on_start=_start_writer(job_id, waiting, "Starting…")):
            return
        try:
            with costs.tracking(job_id, "analyze"):
                _run_analyze_inner(job_id)
        finally:
            _ANALYZE_SLOTS.release(job_id)
    finally:
        _INFLIGHT.release(job_id)


def _run_analyze_inner(job_id: str) -> None:
    """Worker: normalize + analyze. Job pauses on success awaiting render."""
    _register_active(job_id)
    progress: _ProgressWriter | None = None
    try:
        job = store.get(job_id)
        if job is None or job.input_path is None:
            return
        # Start exactly once, and only while the job still waits to start.
        if not store.update_if(job_id, ("pending", "processing"),
                               status="processing", message="Starting…",
                               progress=1.0, queue_position=None):
            return

        job_dir = _WORK_ROOT / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        progress = _ProgressWriter(job_id)
        key = (job.settings or {}).get("_r2_storage_key")
        upload_gone = False

        def _drop_upload(*_args: Any, **_kwargs: Any) -> None:
            """The original upload is only needed to build normalized.mp4;
            everything after (SmartCam, transcription, editing, render,
            and a failed analysis' true-up) works from that. Free the
            space — local copy and R2 object — as soon as it exists."""
            nonlocal upload_gone
            if upload_gone:
                return
            upload_gone = True
            try:
                _discard_upload(job.input_path, key)
                store.update(job_id, input_path=None)
            except Exception as e:
                print(f"[job {job_id}] dropping the upload failed: {e}",
                      flush=True)

        # backend.pipeline calls on_normalized right after normalizing
        # (older pipelines don't know it: then the upload goes below).
        extra: dict[str, Any] = {}
        if _accepts(analyze_only, "on_normalized"):
            extra["on_normalized"] = _drop_upload
        try:
            res = analyze_only(
                input_path=job.input_path,
                output_dir=str(job_dir),
                settings=job.settings,
                progress_cb=progress,
                **extra,
            )
            progress.close()
            # Pause here: status "awaiting_review" tells the UI to show the
            # subtitle editor. Render starts when client POSTs /jobs/{id}/render.
            store.update(
                job_id,
                status="awaiting_review",
                message="Review subtitles",
                progress=100.0,
                normalized_path=res["normalized_path"],
                preview_path=res["preview_path"],
                segments=res["segments"],
                preview_segments=[list(s) for s in res["segments"]],
                preview_version=1,
                subtitles=res["subtitles"],
                duration=res.get("duration", 0.0),
                cut_ranges=res.get("cut_ranges", []),
                language=res["language"],
                audio_warnings=res.get("audio_warnings", []),
                audio_levels=res.get("audio_levels", {}),
                scene_events=res.get("scene_events", []),
            )
            _true_up(job_id, res.get("duration", 0.0))
            _drop_upload()  # if the pipeline didn't already
        except Exception as e:
            progress.close()
            tb = traceback.format_exc()
            print(f"[job {job_id}] ANALYZE FAILED: {e}\n{tb}", flush=True)
            # A content failure ("No speech detected") comes after the
            # transcription was paid for: charge what was really
            # processed (before the files go; refunds below still win).
            _true_up_from_file(job_id, job_dir)
            # Nothing of a failed analysis can be reused (the user uploads
            # again), so free the upload + partial files right away — a
            # failed 10 min job used to leave ~1.5 GB on the volume.
            _drop_upload()
            shutil.rmtree(job_dir, ignore_errors=True)
            msg = str(e)
            if "No space left on device" in msg:
                msg = "server_storage_full"
            store.update(job_id, status="error", message=msg[:300],
                         error=msg[:2000], input_path=None)
            if _is_infra_failure(e, msg):
                _refund(job_id, msg)
    finally:
        if progress is not None:
            progress.close()
        _release_active(job_id)


def _run_render(
    job_id: str,
    edited_subtitles: list,
    disabled_cuts: list[int] | None = None,
) -> None:
    """Worker thread: wait in line for a render slot, then render."""
    try:
        if not _RENDER_SLOTS.acquire(
                job_id, on_wait=_queued_writer(job_id, ("processing",)),
                on_start=_start_writer(job_id, ("processing",),
                                       "Rendering…")):
            return
        try:
            with costs.tracking(job_id, "render"):
                _run_render_inner(job_id, edited_subtitles, disabled_cuts)
        finally:
            _RENDER_SLOTS.release(job_id)
    finally:
        _INFLIGHT.release(job_id)


def _run_render_inner(
    job_id: str,
    edited_subtitles: list,
    disabled_cuts: list[int] | None = None,
) -> None:
    """Worker: render + concat into final MP4."""
    _register_active(job_id)
    job = store.get(job_id)
    if job is None or job.normalized_path is None:
        _release_active(job_id)
        return
    job_dir = _WORK_ROOT / job_id
    _progress = _ProgressWriter(job_id)

    store.update(job_id, status="processing", message="Rendering…",
                 progress=1.0, queue_position=None)
    try:
        render_result = render_only(
            normalized_path=job.normalized_path,
            output_dir=str(job_dir),
            segments=job.segments,
            subtitles=edited_subtitles,
            settings=job.settings,
            language=job.language,
            cut_ranges=job.cut_ranges,
            disabled_cuts=disabled_cuts or [],
            duration=job.duration,
            progress_cb=_progress,
        )
        outputs = render_result["outputs"]
        hook_clips = render_result.get("hook_clips", [])
        # Social caption / hashtags from the (possibly edited) transcript.
        # Soft-fails if no ANTHROPIC_API_KEY is set.
        social = {"caption": "", "hashtags": []}
        try:
            from backend.llm import generate_social_caption
            full = " ".join(
                (s.get("text") or "").strip()
                for s in edited_subtitles
                if (s.get("text") or "").strip()
            )
            social = generate_social_caption(full, language=job.language)
        except Exception as e:
            print(f"[job {job_id}] social-caption skipped: {e}", flush=True)

        _progress.close()
        store.update(
            job_id,
            status="done",
            message="Done",
            progress=100.0,
            output_path=outputs.get("primary"),
            outputs=outputs,
            hook_clips=hook_clips,
            social_caption=social.get("caption", ""),
            social_hashtags=social.get("hashtags", []),
        )
    except Exception as e:
        _progress.close()
        tb = traceback.format_exc()
        print(f"[job {job_id}] RENDER FAILED: {e}\n{tb}", flush=True)
        # Back to review instead of a dead 'error': the user's edits and
        # the source are still on disk, so they can open the editor and
        # render again without re-uploading.
        store.update(job_id, status="awaiting_review", progress=100.0,
                     message="render_failed", error=str(e)[:500])
    finally:
        _progress.close()
        _release_active(job_id)


# /uploads/multipart/* (resumable R2 multipart upload) was never used by
# the web app and had no ownership checks — removed, so those paths 404.
# backend/storage.py still has the helpers.


@app.post("/uploads/presign")
def presign_upload_endpoint(
    payload: dict,
    user: User | None = Depends(current_user),
):
    """Return a presigned URL for direct-to-R2 upload.

    Client PUTs the video body straight to R2 (bypasses Railway edge
    for multi-GB files), then calls POST /jobs with the returned
    storage_key. Falls back with 503 if R2 isn't configured.

    With accounts on, keys are namespaced `uploads/<user id>/…` (POST
    /jobs only accepts the caller's own). With billing enforced this
    refuses early when there is no plan / no minutes left — UX only, the
    binding check is at POST /jobs. An optional `duration` (seconds, as
    the browser reads it) is compared with the minutes left.

    Before any bytes are sent it also refuses what POST /jobs would:
    `size` (bytes) / `duration` over the caps (413 file_too_large +
    max_gb / video_too_long + max_minutes), too many jobs of this user
    in flight (429 too_many_active_jobs), a full queue (503 server_busy
    + Retry-After) and too little disk for `size` (507). The 503 of a
    deployment without R2 has a different detail (not "server_busy").
    """
    from backend.storage import r2_available, presign_upload
    # Paywall first, also without R2: the frontend falls back to the
    # legacy upload on 503, which would send the whole file before
    # POST /jobs could say "no plan".
    duration = _to_float(payload.get("duration") or 0)
    if _bills(user) and billing.enforce():
        ent = accounts.entitlement(user.id, user.email)
        if ent is None:
            raise _quota_error("subscription_required")
        remaining = accounts.minutes_summary(user.id, ent)["remaining_seconds"]
        needed = math.ceil(duration)
        if remaining <= 0 or needed > remaining:
            raise _quota_error("quota_exceeded",
                               remaining_seconds=round(remaining),
                               needed_seconds=needed or None)
    size = _to_float(payload.get("size") or 0)
    if _too_big(size):
        raise _file_too_large()
    if _too_long(duration):
        raise _video_too_long()
    _INFLIGHT.check(user)
    if size > 0:
        _INFLIGHT.reserve_disk(None, size)
    if not r2_available():
        raise HTTPException(
            503,
            "Direct upload not available on this deployment. "
            "Contact support if you need multi-GB uploads."
        )
    filename = str(payload.get("filename") or "upload.mp4").strip()
    content_type = str(
        payload.get("content_type") or "video/mp4"
    ).strip() or "video/mp4"
    try:
        info = presign_upload(filename=filename, content_type=content_type,
                              prefix=auth.upload_prefix(user))
    except Exception as e:
        raise HTTPException(500, f"presign failed: {e}") from e
    return info


# POST /jobs requests in progress, per storage key (one at a time).
_CREATING_KEYS: dict[str, asyncio.Event] = {}


@app.post("/jobs")
async def create_job(
    file: UploadFile = File(None),
    settings: str = Form("{}"),
    storage_key: str = Form(None),
    filename: str = Form(None),
    preset_id: str = Form(None),
    preset_label: str = Form(None),
    user: User | None = Depends(current_user),
):
    """Upload + start analyze. Two paths:

    1) Small files (< ~100MB): multipart 'file' upload directly through
       Railway. Legacy path — works for everything that fits under the
       edge-router body limit.

    2) Large files: client first hits POST /uploads/presign, uploads
       the body directly to R2 with the returned URL, then calls this
       endpoint with `storage_key` set to the R2 object key. Backend
       downloads from R2 into local /tmp before starting analyze.
       Idempotent on the key: repeating the call (the client gave up
       waiting, the answer got lost) returns the job the first call
       created — 200, same body — instead of a second job and charge.

    `filename`, `preset_id`, `preset_label` are stored for the Library.
    With billing on, the upload's length is probed and charged against
    the caller's minutes here, once (402 subscription_required /
    quota_exceeded when enforced; 400 unreadable_video if it has no
    readable length).

    Refusals (see presign): 413 file_too_large / video_too_long, 429
    too_many_active_jobs, 503 server_busy + Retry-After, 507
    server_storage_full. The upload is thrown away only when retrying
    can't help (402, 400, 413). When the analysis has to wait for a
    slot the job comes back as status "processing", message "queued"
    with its queue_position.
    """
    try:
        parsed = json.loads(settings)
    except json.JSONDecodeError:
        raise HTTPException(400, "settings must be valid JSON")
    if not isinstance(parsed, dict):
        raise HTTPException(400, "settings must be a JSON object")
    parsed = _clean_settings(parsed, user)

    if not storage_key:
        if file is None:
            raise HTTPException(
                400, "Either 'file' (multipart) or 'storage_key' (R2) required."
            )
        return await _accept_upload(parsed, file, None, filename, preset_id,
                                    preset_label, user)

    # Only keys we handed this caller out (presign) — any other key
    # would be downloaded AND deleted after analysis.
    if (not storage_key.startswith(auth.upload_prefix(user))
            or ".." in storage_key):
        raise HTTPException(403, "storage_key not yours")
    while (busy := _CREATING_KEYS.get(storage_key)) is not None:
        await busy.wait()
    claim = _CREATING_KEYS[storage_key] = asyncio.Event()
    try:
        existing = await run_in_threadpool(store.find_by_key, storage_key)
        if existing is not None:
            if (user is not None and not user.is_service
                    and existing.owner_id not in (None, user.id)):
                raise HTTPException(403, "storage_key not yours")
            return {"job_id": existing.id, **existing.to_dict()}
        return await _accept_upload(parsed, None, storage_key, filename,
                                    preset_id, preset_label, user)
    finally:
        _CREATING_KEYS.pop(storage_key, None)
        claim.set()


def _upload_size(file: UploadFile) -> int | None:
    size = getattr(file, "size", None)
    if size is not None:
        return int(size)
    try:
        pos = file.file.tell()
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
        file.file.seek(pos)
        return size
    except (AttributeError, OSError, ValueError):
        return None


def _copy_upload(file: UploadFile, dest: str) -> None:
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)


async def _accept_upload(
    parsed: dict,
    file: UploadFile | None,
    storage_key: str | None,
    filename: str | None,
    preset_id: str | None,
    preset_label: str | None,
    user: User | None,
) -> dict:
    """POST /jobs after the settings / key checks: admission, caps,
    download, charge, job row, analysis thread."""
    bills = _bills(user)
    enforce = bills and billing.enforce()
    if enforce and await run_in_threadpool(
            accounts.entitlement, user.id, user.email) is None:
        await run_in_threadpool(_discard_upload, None, storage_key)
        raise _quota_error("subscription_required")

    # 429 / 503 before any bytes move; the upload is kept for a retry.
    token = _INFLIGHT.admit(user)
    input_path: str | None = None
    job = None
    try:
        # Size cap with the real size: R2 HEAD, or the parsed multipart.
        if storage_key:
            from backend.storage import object_size
            size = await run_in_threadpool(object_size, storage_key)
        else:
            size = _upload_size(file)
        if _too_big(size):
            await run_in_threadpool(_discard_upload, None, storage_key)
            raise _file_too_large()

        job_input_dir = _WORK_ROOT / "uploads"
        job_input_dir.mkdir(parents=True, exist_ok=True)
        if storage_key:
            # Preserve extension from original filename if given, else
            # from the storage_key (which we generated).
            suffix = (
                Path(filename or "").suffix.lower()
                or Path(storage_key).suffix.lower()
                or ".mp4"
            )
        else:
            suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=suffix, dir=str(job_input_dir)
        ) as f:
            input_path = f.name
        # Refuse early instead of failing halfway through a multi-GB
        # download or normalization when the volume is (nearly) full.
        await run_in_threadpool(_INFLIGHT.reserve_disk, token, size or 0,
                                input_path)

        if storage_key:
            from backend.storage import download_from_r2
            try:
                # In a worker thread: a multi-GB download inside this
                # async handler used to block the event loop.
                await run_in_threadpool(download_from_r2, storage_key,
                                        input_path)
            except Exception as e:
                raise HTTPException(
                    502, f"failed to fetch upload from storage: {e}"
                ) from e
            if size is None:  # HEAD failed: check the file we got
                size = os.path.getsize(input_path)
                if _too_big(size):
                    await run_in_threadpool(_discard_upload, input_path,
                                            storage_key)
                    raise _file_too_large()
                await run_in_threadpool(_INFLIGHT.reserve_disk, token, size,
                                        input_path)
            # Stash storage_key on the job settings so we can clean up R2
            # after normalization.
            parsed["_r2_storage_key"] = storage_key
        else:
            await run_in_threadpool(_copy_upload, file, input_path)

        seconds = await run_in_threadpool(_probe_duration, input_path)
        if _too_long(seconds):
            await run_in_threadpool(_discard_upload, input_path, storage_key)
            raise _video_too_long()

        job_id = new_job_id()
        plan = DEFAULT_PLAN
        if bills:
            if seconds is None:
                if enforce:
                    await run_in_threadpool(_discard_upload, input_path,
                                            storage_key)
                    raise HTTPException(400, "unreadable_video")
                seconds = 0.0  # not enforced: the true-up after analysis fixes it
            # Quota check + ledger insert are atomic inside charge() (the
            # accounts lock), so two uploads of one user can't both spend
            # the last minutes.
            try:
                ent = await run_in_threadpool(functools.partial(
                    accounts.charge, job_id, user.id, seconds,
                    email=user.email, enforce=enforce))
            except accounts.SubscriptionRequired:
                await run_in_threadpool(_discard_upload, input_path,
                                        storage_key)
                raise _quota_error("subscription_required")
            except accounts.QuotaExceeded as e:
                await run_in_threadpool(_discard_upload, input_path,
                                        storage_key)
                raise _quota_error("quota_exceeded",
                                   remaining_seconds=round(e.remaining_seconds),
                                   needed_seconds=round(e.needed_seconds))
            if ent is not None:
                plan = ent.plan  # fixed per job: a downgrade never shortens retention
            if enforce:
                # The charge trusts the container's duration header, which
                # the uploader controls: analyse no more than was charged
                # (+ the true-up tolerance), or a file claiming 1 s would be
                # transcribed in full, however long it really is.
                parsed["_max_seconds"] = (math.ceil(max(seconds, 0.0))
                                          + accounts.TRUE_UP_TOLERANCE_S)

        try:
            job = await run_in_threadpool(functools.partial(
                store.create,
                input_path=input_path,
                settings=parsed,
                job_id=job_id,
                idempotency_key=storage_key,
                owner_id=user.id if user else None,
                plan=plan,
                filename=_short(filename or (file.filename if file else None),
                                255),
                preset_id=_short(preset_id, 100),
                preset_label=_short(preset_label, 200),
            ))
        except Exception:
            if bills:
                _refund(job_id, "create_failed")
            raise
        thread = threading.Thread(target=_run_analyze, args=(job.id,),
                                  daemon=True)
        # The place in line is taken right here (no await in between), so
        # concurrent uploads get distinct, real positions; the worker's
        # acquire() takes it over.
        pos = _ANALYZE_SLOTS.enqueue(job.id, thread)
        try:
            thread.start()
        except BaseException:
            _ANALYZE_SLOTS.cancel(job.id)
            raise
        _INFLIGHT.attach(token, job.id, thread)
        if pos is not None:
            # Answer with the place in line right away — unless the
            # worker already wrote its own state (the row isn't 'pending'
            # any more); it keeps the position current while it waits.
            await run_in_threadpool(functools.partial(
                store.update_if, job.id, "pending", status="processing",
                message="queued", queue_position=pos))
            job = await run_in_threadpool(store.get, job.id) or job
        return {"job_id": job.id, **job.to_dict()}
    except BaseException:
        if job is None and input_path is not None:
            # Refused or failed before the job existed: nothing will
            # ever read the local copy (the R2 object stays unless
            # discarded above — the client may retry with its key).
            _remove_upload(input_path)
        raise
    finally:
        _INFLIGHT.release(token)


# Fields of GET /jobs rows (the Library's server-side list).
_LIST_FIELDS = (
    "id", "status", "message", "progress", "error", "filename", "preset_id",
    "preset_label", "created_at", "updated_at", "expires_at", "has_output",
    "outputs", "hook_clips", "social_caption", "social_hashtags", "duration",
    "queue_position",
)


@app.get("/jobs")
def list_jobs(user: User = Depends(require_user)):
    """The caller's projects, newest first (404 not_available while
    accounts are off — the frontend keeps its localStorage list then).
    Beta jobs show up once claimed, i.e. after any /jobs/{id} request."""
    rows = store.list_all() if user.is_service else store.list_by_owner(user.id)
    rows.sort(key=lambda j: j.created_at or j.updated_at, reverse=True)
    out = []
    for job in rows:
        d = job.to_dict()
        out.append({k: d.get(k) for k in _LIST_FIELDS})
    return out


# GET /jobs/status: at most this many ids per call.
_STATUS_MAX_IDS = 50


def _status_rows(ids: list[str], user: User | None) -> dict:
    """Body of GET /jobs/status. Same visibility as GET /jobs/{id}
    (get_owned_job, including claiming beta jobs); jobs the caller can't
    see — or that are gone — are listed under "missing"."""
    rows = store.status_many(ids)
    jobs, missing = [], []
    for job_id in ids:
        row = rows.get(job_id)
        if row is not None and user is not None and not user.is_service:
            owner = row["owner_id"]
            if owner is None:
                owner = store.claim(job_id, user.id)
            if owner != user.id:
                row = None
        if row is None:
            missing.append(job_id)
            continue
        out = row.get("output_path")
        jobs.append({
            "id": job_id,
            "status": row["status"],
            "message": row["message"],
            "progress": row["progress"],
            "queue_position": row["queue_position"],
            "error": row["error"],
            "has_output": bool(out) and Path(out).exists(),
            "updated_at": row["updated_at"] or None,
            "preview_version": row["preview_version"],
        })
    return {"jobs": jobs, "missing": missing}


def _etag_matches(if_none_match: str, etag: str) -> bool:
    """Weak comparison (RFC 9110 §13.1.2)."""
    opaque = etag.removeprefix("W/")
    for tag in if_none_match.split(","):
        tag = tag.strip()
        if tag == "*" or tag.removeprefix("W/") == opaque:
            return True
    return False


@app.get("/jobs/status")
async def jobs_status(request: Request, ids: str = "",
                      user: User | None = Depends(current_user)):
    """Status of several jobs in one request, for the dashboard poll:
    `?ids=a,b,c` (at most 50) → {"jobs": [{id, status, message, progress,
    queue_position, error, has_output, updated_at, preview_version}],
    "missing": [ids that don't exist or aren't the caller's]}. With a
    weak ETag: send it back as If-None-Match and an unchanged answer is
    an empty 304."""
    wanted = list(dict.fromkeys(i.strip() for i in ids.split(",")
                                if i.strip()))
    if len(wanted) > _STATUS_MAX_IDS:
        raise HTTPException(400, "too_many_ids")
    body = await run_in_threadpool(_status_rows, wanted, user)
    raw = json.dumps(body, separators=(",", ":")).encode()
    etag = f'W/"{hashlib.sha1(raw).hexdigest()}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match", ""), etag):
        return Response(status_code=304, headers=headers)
    return Response(content=raw, media_type="application/json",
                    headers=headers)


@app.get("/jobs/{job_id}")
def get_job(job_id: str, user: User | None = Depends(current_user)):
    return get_owned_job(job_id, user).to_dict()


@app.get("/me")
def me(user: User | None = Depends(current_user)):
    """Who is signed in, their plan and minutes, and the media token for
    <video>/<img> URLs (`?t=`). {"auth_enabled": false} with auth off."""
    if user is None:
        return {"auth_enabled": False}
    on, reason = billing.status()
    out: dict = {
        "user": {"id": user.id, "email": None},
        "auth_enabled": True,
        "billing": {"enabled": on, "enforce": billing.enforce(),
                    "test_mode": accounts.test_mode()},
        "plan": None,
        "subscription": None,
        "minutes": None,
        "media_token": auth.media_token(user.id),
    }
    if reason:
        out["billing"]["reason"] = reason
    if user.is_service:
        return out
    email = billing.user_email(user)
    out["user"]["email"] = email
    if not on:
        return out
    billing.refresh_user(user.id)
    ent = accounts.entitlement(user.id, email)
    sub = (ent.subscription if ent and ent.subscription
           else accounts.latest_subscription(user.id))
    out["plan"] = ent.plan if ent else None
    out["subscription"] = accounts.subscription_public(sub)
    if ent is not None:
        out["minutes"] = accounts.minutes_summary(user.id, ent)
        out["comp"] = ent.source == "comp"
    return out


def _require_billing() -> None:
    if not billing.enabled():
        raise HTTPException(404, "billing_disabled")


@app.get("/billing/config")
def billing_config():
    """Public: is billing on, and the plans (price, minutes, retention)."""
    return billing.config()


@app.post("/billing/checkout")
def billing_checkout(payload: dict, user: User = Depends(require_user)):
    """{plan} → {url} of a Lemon Squeezy checkout. 409 already_subscribed
    (with a portal_url) when a subscription already grants access —
    plan changes happen in the customer portal."""
    _require_billing()
    plan = str(payload.get("plan") or "").strip().lower()
    if user.is_service or plan not in billing.variants():
        raise HTTPException(400, "unknown_plan")
    client_email = payload.get("email")
    client_email = (client_email.strip()[:254]
                    if isinstance(client_email, str) else None)
    try:
        url = billing.create_checkout(user, plan, client_email=client_email)
    except billing.TestersOnly:
        raise HTTPException(403, {"code": "test_mode_testers_only"})
    except billing.AlreadySubscribed as e:
        raise HTTPException(409, {"code": "already_subscribed",
                                  "portal_url": e.portal_url})
    except (billing.LemonSqueezyError, KeyError, TypeError) as e:
        print(f"[billing] checkout failed: {e}", flush=True)
        raise HTTPException(502, "checkout_failed")
    return {"url": url}


@app.get("/billing/portal")
def billing_portal(user: User = Depends(require_user)):
    """Fresh customer-portal URL (they are signed and expire)."""
    _require_billing()
    url = None if user.is_service else billing.portal_url(user.id)
    if not url:
        raise HTTPException(404, "no_subscription")
    return {"url": url}


@app.post("/billing/webhook")
async def billing_webhook(request: Request):
    """Lemon Squeezy webhook. Signature over the raw body; 200 once
    applied (or deliberately ignored), 400 bad signature, 500 when
    processing failed so LS retries."""
    _require_billing()
    raw = await request.body()
    if not billing.verify_signature(raw, request.headers.get("x-signature", "")):
        raise HTTPException(400, "bad signature")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "invalid json")
    if not isinstance(payload, dict):
        raise HTTPException(400, "invalid payload")
    event = (payload.get("meta") or {}).get("event_name")
    try:
        result = await run_in_threadpool(billing.process_event, payload)
    except Exception as e:
        print(f"[billing] webhook {event} FAILED: {e}\n"
              f"{traceback.format_exc()}", flush=True)
        raise HTTPException(500, "webhook processing failed")
    print(f"[billing] webhook {event}: {result}", flush=True)
    return {"ok": True, **result}


@app.get("/admin/costs")
def admin_costs(x_admin_token: str = Header(default=""),
                exclude_tests: bool = False):
    """What processing costs us — per job and per video minute.

    Protected by CLEO_ADMIN_TOKEN (send it as X-Admin-Token); disabled
    (404) while that env var is unset. Storage is estimated for keeping
    each job's files for its plan's full retention period.
    """
    token = os.environ.get("CLEO_ADMIN_TOKEN", "")
    if not token:
        raise HTTPException(404, "not found")
    if not hmac.compare_digest(x_admin_token, token):
        raise HTTPException(401, "bad admin token")
    rows = []
    for job in store.list_all():
        c = dict(job.costs or {})
        if not c:
            continue
        job_dir = _WORK_ROOT / job.id
        files = {
            str(f.relative_to(job_dir)): f.stat().st_size
            for f in job_dir.rglob("*") if f.is_file()
        } if job_dir.exists() else {}
        served = sum(files.values())
        if job.input_path and Path(job.input_path).exists():
            files["(original upload)"] = Path(job.input_path).stat().st_size
        # Disk use counts hard-linked files once (a same-size format
        # export is a link to the primary, see pipeline._export_format).
        inodes: dict[tuple[int, int], int] = {}
        for f in (job_dir.rglob("*") if job_dir.exists() else []):
            if f.is_file():
                st = f.stat()
                inodes[(st.st_dev, st.st_ino)] = st.st_size
        size = sum(inodes.values()) + files.get("(original upload)", 0)
        c["usd_storage"] = costs.storage_usd(size, retention_days(job.plan))
        # Everything in the job folder is sent to the browser at least
        # once (source + preview in the editor, the final downloads).
        c["usd_egress_est"] = costs.egress_usd(served)
        total = c.get("usd_total", 0.0) + c["usd_storage"] + c["usd_egress_est"]
        minutes = (job.duration or 0) / 60
        is_test = bool((job.settings or {}).get("_cost_test"))
        if exclude_tests and is_test:
            continue
        rows.append({
            "job_id": job.id,
            "owner_id": job.owner_id,
            "test": is_test,
            "status": job.status,
            "plan": job.plan,
            "video_minutes": round(minutes, 2),
            "storage_mb": round(size / 1e6, 1),
            "files_mb": {k: round(v / 1e6, 1) for k, v in
                         sorted(files.items(), key=lambda kv: -kv[1])},
            "usd": {k: round(v, 5) for k, v in c.items() if k.startswith("usd_")},
            "usd_all_in": round(total, 5),
            "usd_per_video_minute": round(total / minutes, 5) if minutes else None,
            "usage": {k: round(v, 2) for k, v in c.items() if not k.startswith("usd_")},
        })
    minutes = sum(r["video_minutes"] for r in rows)
    spent = sum(r["usd_all_in"] for r in rows)
    parts: dict[str, float] = {}
    for r in rows:
        for k, v in r["usd"].items():
            if k != "usd_total":
                parts[k] = parts.get(k, 0.0) + v
    return {
        "note": "Estimates from backend/costs.py RATES — check provider prices.",
        "jobs": len(rows),
        "video_minutes": round(minutes, 2),
        "usd_total": round(spent, 4),
        "usd_per_video_minute": round(spent / minutes, 5) if minutes else None,
        "usd_per_video_minute_by_part": {
            k: round(v / minutes, 5) for k, v in parts.items()
        } if minutes else {},
        "rows": sorted(rows, key=lambda r: -r["usd_all_in"]),
    }


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str, user: User | None = Depends(current_user)):
    """Delete a project and all its files right away (user request)."""
    job = get_owned_job(job_id, user)
    with _active_lock:
        busy = job_id in _active_jobs
    if busy or job.status in ("processing", "pending"):
        raise HTTPException(409, "job is still processing")
    _delete_job(job)
    return {"deleted": job_id}


@app.get("/jobs/{job_id}/subtitles")
def get_subtitles(job_id: str, user: User | None = Depends(current_user)):
    """Subtitles produced by analyze, for the review editor."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not ready for review (status={job.status})")
    return {
        "subtitles": job.subtitles,
        "language": job.language,
        # Transcript as edited in review, if the user changed anything.
        "phrases": job.edited_phrases,
    }


@app.get("/jobs/{job_id}/preview-video")
def preview_video(job_id: str, user: User | None = Depends(media_user)):
    """Stream the rotation-normalized source for in-browser preview.

    Starlette's FileResponse handles HTTP Range requests so the <video>
    element can seek without downloading the full file.
    """
    job = get_owned_job(job_id, user)
    # Prefer the cut preview (segments concatenated, no captions). Falls
    # back to the normalized file if the preview render isn't there yet.
    path = job.preview_path if job.preview_path else job.normalized_path
    if not path or not Path(path).exists():
        raise HTTPException(409, "preview video not ready")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        # The file is rebuilt in place on every edit; make the browser
        # revalidate instead of reusing a stale copy on re-entry.
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )


# Per-job ordering for timeline saves. Each /edit-segments request gets
# a sequence number and stores its segments under _EDIT_GUARD, so the
# newest request always wins even when several run at once. Preview
# rebuilds are serialized per job and skipped when a newer request has
# already arrived (it will rebuild instead).
_EDIT_GUARD = threading.Lock()
_EDIT_SEQ: dict[str, int] = {}
_PREVIEW_LOCKS: dict[str, asyncio.Lock] = {}

# Preview rebuilds (an ffmpeg encode each) run here, behind async
# handlers: waiting saves hold no threadpool token, so a burst of edits
# can't starve every other request (42 concurrent saves used to take
# /health to 54 s).
_REBUILD_POOL = ThreadPoolExecutor(
    max_workers=max(1, _env_int("CLEO_REBUILD_WORKERS", 2)),
    thread_name_prefix="rebuild")


def _preview_lock(job_id: str) -> asyncio.Lock:
    """Per-job rebuild lock. Only used on the event loop — no _EDIT_GUARD
    here, that one is held across DB writes; setdefault is atomic."""
    return _PREVIEW_LOCKS.setdefault(job_id, asyncio.Lock())


def _preview_source(normalized_path: str) -> str:
    """What previews are cut from: the 720p proxy when the pipeline made
    one (backend.pipeline.preview_source), else the normalized source."""
    fn = getattr(pipeline, "preview_source", None)
    if fn is not None:
        try:
            src = fn(normalized_path)
            if src:
                return str(src)
        except Exception as e:
            print(f"[preview] preview_source failed: {e}", flush=True)
    return normalized_path


async def _rebuild_in_pool(job_id: str, source: str, segments,
                           seq: int | None = None) -> tuple[bool, bool]:
    """_rebuild_preview in _REBUILD_POOL, one at a time per job.
    With `seq`, skipped when a newer /edit-segments save arrived.
    Returns (preview_ok, superseded).

    The job's lock is held until the encode really ends, even if the
    request is cancelled meanwhile: two rebuilds of one job must never
    overlap (preview.mp4 and preview_segments would disagree)."""
    lock = _preview_lock(job_id)
    await lock.acquire()
    try:
        # A plain read (atomic in CPython): seqs only grow, and a save
        # that increments it after this check rebuilds after us.
        if seq is not None and _EDIT_SEQ.get(job_id) != seq:
            lock.release()
            return False, True
        fut = asyncio.get_running_loop().run_in_executor(
            _REBUILD_POOL, _rebuild_preview, job_id, source, segments)
    except BaseException:
        lock.release()
        raise

    def _done(f: asyncio.Future) -> None:
        lock.release()
        if not f.cancelled():
            f.exception()  # retrieved: no "never retrieved" warning
    fut.add_done_callback(_done)
    try:
        await asyncio.shield(fut)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[preview] rebuild failed for {job_id}: {e}", flush=True)
        return False, False
    return True, False


def _effect(value, default: float, lo: float, hi: float) -> float:
    """Parse one effect value. Only a missing value means "default" —
    `x or default` used to turn volume 0 (mute) into 1.0."""
    if value is None or value == "":
        return default
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return max(lo, min(hi, v))


def _rebuild_preview(job_id: str, source: str, segments) -> None:
    """Render the cut preview from `source` (_preview_source: the proxy
    or the normalized video) to a temp file and swap it in atomically,
    then record which segments it shows. Raises on ffmpeg failure; the
    old preview stays untouched in that case."""
    from backend.pipeline import _ffmpeg_cuts_preview
    job_dir = Path(_WORK_ROOT) / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    final_path = job_dir / "preview.mp4"
    tmp_path = job_dir / f"preview.{threading.get_ident()}.tmp.mp4"
    try:
        _ffmpeg_cuts_preview(source, segments, str(tmp_path))
        os.replace(tmp_path, final_path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
    cur = store.get(job_id)
    store.update(
        job_id,
        preview_path=str(final_path),
        preview_segments=[[float(s), float(e)] for s, e in segments],
        preview_version=(cur.preview_version if cur else 0) + 1,
    )


@app.post("/jobs/{job_id}/edit-segments")
async def post_edit_segments(job_id: str, payload: dict,
                             user: User | None = Depends(current_user)):
    """Accept a user-edited segment list and rebuild the preview video.

    Frontend sends the segment list (with per-segment effects) after the
    user has trimmed, split, deleted, reordered or changed effects in the
    timeline editor. We clamp against the normalized video duration,
    keep the user's ORDER, store segments + effects, then re-render the
    preview MP4 so the player reflects the edit.

    Payload:
        {"segments": [{"start", "end", "speed"?, "fadeIn"?, "fadeOut"?,
                       "volume"?}, ...]}

    Response: the job dict plus
        preview_ok  – the preview now shows exactly these segments
        superseded  – a newer save arrived; its response is authoritative
    """
    seq, source, cleaned = await run_in_threadpool(
        _save_edit_segments, job_id, payload, user)
    preview_ok, superseded = await _rebuild_in_pool(job_id, source, cleaned,
                                                    seq=seq)
    job = await run_in_threadpool(store.get, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    out = job.to_dict()
    out["preview_ok"] = preview_ok
    out["superseded"] = superseded
    return out


def _max_edit_segments() -> int:
    """Most segments a timeline save may have. Analysis of a 30 min
    video gives a few hundred; each one costs a preview rebuild ~15 ms
    (pipeline._concat_preview) in the shared rebuild pool."""
    return max(1, _env_int("CLEO_MAX_EDIT_SEGMENTS", 2000))


def _check_timeline_length(segments, duration: float) -> None:
    """A timeline may repeat parts of the source (trimmed clips can
    overlap), but not balloon: at most twice the source (+ 1 min) — the
    preview rebuild encodes all of it. 400 timeline_too_long."""
    source = duration if duration > 0 else _max_minutes() * 60
    limit = 2 * source + 60
    if sum(float(e) - float(s) for s, e in segments) > limit:
        raise ApiRefusal(400, "timeline_too_long",
                         max_seconds=_plain(round(limit, 3)))


def _save_edit_segments(job_id: str, payload: dict, user: User | None
                        ) -> tuple[int, str, list[tuple[float, float]]]:
    """The quick part of /edit-segments (threadpool): validate, store the
    segments + effects. Returns (seq, preview source, segments)."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(
            409, f"job not in review state (status={job.status})"
        )
    if not job.normalized_path or not Path(job.normalized_path).exists():
        raise HTTPException(410, "normalized video no longer on disk")

    raw = payload.get("segments") or []
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, "segments must be a non-empty list")
    if len(raw) > _max_edit_segments():
        raise ApiRefusal(400, "too_many_segments",
                         max_segments=_max_edit_segments())

    dur = float(job.duration or 0.0)
    cleaned: list[tuple[float, float]] = []
    effects: list[dict] = []
    for s in raw:
        if not isinstance(s, dict):
            continue
        try:
            ss = max(0.0, float(s.get("start") or 0))
            ee = float(s.get("end") or 0)
        except (TypeError, ValueError):
            continue
        if dur > 0:
            ee = min(ee, dur)
        if ee - ss < 0.05:
            continue
        cleaned.append((round(ss, 3), round(ee, 3)))
        # Per-segment effects. Clamped to safe ranges — render step
        # applies these via ffmpeg atempo / fade / volume filters.
        effects.append({
            "speed": _effect(s.get("speed"), 1.0, 0.25, 4.0),
            "fadeIn": _effect(s.get("fadeIn"), 0.0, 0.0, 2.0),
            "fadeOut": _effect(s.get("fadeOut"), 0.0, 0.0, 2.0),
            "volume": _effect(s.get("volume"), 1.0, 0.0, 2.5),
        })
    if not cleaned:
        raise HTTPException(400, "no valid segments after cleaning")
    _check_timeline_length(cleaned, dur)

    # Store under the guard so the request with the highest sequence
    # number is also the one whose segments end up in the store.
    with _EDIT_GUARD:
        seq = _EDIT_SEQ.get(job_id, 0) + 1
        _EDIT_SEQ[job_id] = seq
        cur = store.get(job_id) or job
        new_settings = dict(cur.settings or {})
        new_settings["segment_effects"] = effects
        extra = {}
        if not cur.preview_segments:
            # Job from before preview_segments existed: its preview.mp4
            # was built from the segments we are about to replace.
            extra["preview_segments"] = [[float(a), float(b)] for a, b in cur.segments]
        store.update(
            job_id,
            segments=[list(seg) for seg in cleaned],
            settings=new_settings,
            **extra,
        )
    return seq, _preview_source(job.normalized_path), cleaned


@app.post("/jobs/{job_id}/phrases")
def post_phrases(job_id: str, payload: dict,
                 user: User | None = Depends(current_user)):
    """Save the review transcript (edited text, deleted lines) so it
    survives leaving and re-entering the job. GET /subtitles returns it
    as `phrases`. The render still takes the subtitles the client sends."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(
            409, f"job not in review state (status={job.status})"
        )
    raw = payload.get("phrases")
    if not isinstance(raw, list) or len(raw) > 20000:
        raise HTTPException(400, "phrases must be a list")
    cleaned: list[dict] = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        try:
            item = {
                "start": float(p.get("start") or 0),
                "end": float(p.get("end") or 0),
                "original_start": float(p.get("original_start") or 0),
                "original_end": float(p.get("original_end") or 0),
                "confidence": float(
                    1.0 if p.get("confidence") is None else p.get("confidence")
                ),
                "text": str(p.get("text") or "")[:2000],
            }
        except (TypeError, ValueError):
            continue
        cleaned.append(item)
    # Saves can arrive out of order (slow network, flush on leave while
    # a debounced save is still in flight): keep the newest revision.
    try:
        rev = float(payload.get("rev") or 0)
    except (TypeError, ValueError):
        rev = 0.0
    with _EDIT_GUARD:
        cur = store.get(job_id)
        if cur is not None and rev and rev < (cur.edited_phrases_rev or 0):
            return {"ok": True, "count": len(cleaned), "stale": True}
        store.update(job_id, edited_phrases=cleaned, edited_phrases_rev=rev)
    return {"ok": True, "count": len(cleaned)}


@app.post("/jobs/{job_id}/recompute-scenes")
async def post_recompute_scenes(job_id: str, payload: dict,
                                user: User | None = Depends(current_user)):
    """Recompute cut segments from an edited scene-event list.

    Frontend sends the user-edited event list (some toggled off, maybe
    some new ones added). We recompute the cut ranges from scratch,
    remap subtitles onto the new timeline, and update the job so the
    preview + review UI refresh.

    Payload:
        {"events": [{"type": "start"|"restart"|"keep"|"finish",
                     "start": float, "end": float}, ...]}
    """
    source, new_segments = await run_in_threadpool(
        _save_recomputed_scenes, job_id, payload, user)
    # Rebuild the preview video so the review UI reflects the new cuts.
    await _rebuild_in_pool(job_id, source, new_segments)
    job = await run_in_threadpool(store.get, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job.to_dict()


def _save_recomputed_scenes(job_id: str, payload: dict, user: User | None
                            ) -> tuple[str, list]:
    """The quick part of /recompute-scenes (threadpool): recompute and
    store the cuts. Returns (preview source, new segments)."""
    job = get_owned_job(job_id, user)
    if job.status not in ("awaiting_review",):
        raise HTTPException(
            409, f"job not in review state (status={job.status})"
        )
    if not job.normalized_path or not Path(job.normalized_path).exists():
        raise HTTPException(410, "normalized video no longer on disk")

    events_in = payload.get("events") or []
    try:
        clean: list[tuple[str, float, float, int]] = []
        for i, e in enumerate(events_in):
            t = str(e.get("type") or "").lower()
            if t not in ("start", "restart", "keep", "finish"):
                continue
            s = float(e.get("start") or 0)
            end = float(e.get("end") or s)
            clean.append((t, s, end, i))
        clean.sort(key=lambda x: x[1])
    except Exception as e:
        raise HTTPException(400, f"invalid events payload: {e}") from e

    # Re-apply scene semantics to compute cut ranges + kept segments.
    from src.scene_triggers import find_scene_cut_ranges
    # Trick: our scene fn expects whisper-words. We synthesize a
    # minimal word list that matches the requested command phrases so
    # the existing state-machine logic can be re-used unchanged.
    fake_words: list[dict] = []
    for (t, s, end, _i) in clean:
        # Two-token phrase: "cleo <type>"
        cleo_start = max(0.0, s)
        cleo_end = s + max(0.05, (end - s) / 2)
        cmd_start = cleo_end + 0.01
        cmd_end = max(end, cmd_start + 0.05)
        fake_words.append({"word": "cleo", "start": cleo_start, "end": cleo_end})
        fake_words.append({"word": t, "start": cmd_start, "end": cmd_end})
    cut_ranges_scene, _events_out = find_scene_cut_ranges(
        fake_words, clip_duration=job.duration or None,
    )

    # Merge with the existing full pipeline: start from the original
    # analyze segments then apply the NEW scene cuts.
    from src.filler_detection import FillerDetector
    _det = FillerDetector()
    # We need the ORIGINAL segments (pre-scene). We didn't store them
    # separately, so we rebuild from cut_ranges + duration: take
    # `job.segments` and re-expand the scene cuts we previously applied.
    # Simpler: recompute cut_ranges as inverse of current segments and
    # apply the new scene cuts on top of a "no cuts" baseline.
    # For MVP we simply add the new scene cuts to the existing segments.
    base_segments = [tuple(s) for s in job.segments]
    new_segments = _det.filter_segments(base_segments, cut_ranges_scene)
    if len(new_segments) > _max_edit_segments():
        raise ApiRefusal(400, "too_many_segments",
                         max_segments=_max_edit_segments())

    # Update cut_ranges to include the new scene cuts alongside existing
    old_cut_ranges = list(job.cut_ranges or [])
    next_id = (max((c.get("id", 0) for c in old_cut_ranges), default=-1)) + 1
    new_cut_range_dicts = []
    for (rs, re_) in cut_ranges_scene:
        new_cut_range_dicts.append({
            "id": next_id, "start": float(rs), "end": float(re_),
            "source": "user_edit",
        })
        next_id += 1

    store.update(
        job_id,
        segments=new_segments,
        cut_ranges=old_cut_ranges + new_cut_range_dicts,
        scene_events=[
            {"type": t, "start": s, "end": end, "source": "user"}
            for (t, s, end, _i) in clean
        ],
    )

    # Segment count may have changed, so per-segment effects no longer
    # line up with it — reset them rather than apply them to wrong clips.
    if len(new_segments) != len(base_segments):
        cur = store.get(job_id)
        settings = dict((cur.settings if cur else job.settings) or {})
        settings.pop("segment_effects", None)
        store.update(job_id, settings=settings)
    return _preview_source(job.normalized_path), new_segments


@app.post("/jobs/{job_id}/render")
def post_render(job_id: str, payload: dict,
                user: User | None = Depends(current_user)):
    """Kick off the render with (possibly edited) subtitles. Never
    blocked by billing: the minutes were charged at upload. Exactly one
    of several concurrent calls (double click, second tab, retry) starts
    it; the others get 409. When all render slots are taken the job
    waits in line (message "queued", queue_position)."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not in review state (status={job.status})")

    edited = payload.get("subtitles")
    if not isinstance(edited, list):
        raise HTTPException(400, "payload.subtitles must be a list")
    disabled_cuts = payload.get("disabled_cuts") or []
    if not isinstance(disabled_cuts, list):
        raise HTTPException(400, "payload.disabled_cuts must be a list")

    # Flip to processing right away (and clear a previous render error)
    # so a poll between this response and the worker start can't see
    # the old 'awaiting_review + error' state — as a compare-and-set, so
    # only one request gets to start the render.
    if not store.update_if(job_id, "awaiting_review", status="processing",
                           message="Rendering…", progress=1.0, error=None,
                           queue_position=None):
        cur = store.get(job_id)
        raise HTTPException(
            409, f"job not in review state (status={cur.status if cur else None})")
    thread = threading.Thread(
        target=_run_render,
        args=(job_id, edited, disabled_cuts),
        daemon=True,
    )
    # Only the winner of the compare-and-set takes a place in line.
    pos = _RENDER_SLOTS.enqueue(job_id, thread)
    try:
        if pos is not None:
            store.update_if(job_id, "processing", message="queued",
                            queue_position=pos)
        thread.start()
    except BaseException:
        _RENDER_SLOTS.cancel(job_id)
        raise
    _INFLIGHT.track(job_id, job.owner_id, "render", thread)
    return store.get(job_id).to_dict()


@app.get("/jobs/{job_id}/download")
def download_job(job_id: str, format: str = "primary",
                 user: User | None = Depends(media_user)):
    job = get_owned_job(job_id, user)
    path = job.outputs.get(format) or (
        job.output_path if format == "primary" else None
    )
    if not path or not Path(path).exists():
        raise HTTPException(409, "requested format not ready")
    safe = format.replace(":", "-")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        filename=f"cleo_{job_id}_{safe}.mp4",
    )


@app.get("/jobs/{job_id}/watch")
def watch_job(job_id: str, format: str = "primary",
              user: User | None = Depends(media_user)):
    """Same file as /download but without the attachment header, so
    the Library modal can play it inline via <video src=...>. Supports
    HTTP Range so seeking works without downloading the whole file."""
    job = get_owned_job(job_id, user)
    path = job.outputs.get(format) or (
        job.output_path if format == "primary" else None
    )
    if not path or not Path(path).exists():
        raise HTTPException(409, "requested format not ready")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"},
    )


@app.get("/jobs/{job_id}/thumbnail")
def job_thumbnail(job_id: str, user: User | None = Depends(media_user)):
    """Serve the poster-frame JPG generated at render time. The file
    lives next to the primary output at a fixed filename so we can
    derive the path without storing it on the Job."""
    job = get_owned_job(job_id, user)
    if not job.output_path:
        raise HTTPException(409, "thumbnail not ready")
    thumb = Path(job.output_path).parent / "cleo_thumbnail.jpg"
    if not thumb.exists():
        raise HTTPException(404, "thumbnail not ready")
    return FileResponse(
        path=str(thumb),
        media_type="image/jpeg",
        # Behind a per-user token once accounts are on: no shared caches.
        headers={"Cache-Control": ("private" if auth.auth_enabled()
                                   else "public") + ", max-age=86400"},
    )
