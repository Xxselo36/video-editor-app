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
analysis/render queues, per-user limits, disk reservations) and editor
save ordering are in-process state. A second worker would double every
limit, and the boot recovery (mark_stuck_as_error) and the orphaned-job
sweep (_sweep_orphaned_jobs) would fail the other worker's running jobs. The database is not the limit any more: with
DATABASE_URL set, Postgres (backend/db.py, backend/pg.py) is the source
of truth and safe across processes (row locks, compare-and-set, advisory
locks for the quota) — but keep --workers 1 until the task queue (WP4)
replaces the in-process state. The SQLite store (no DATABASE_URL) is
one-process only.

Job media (backend/media.py): every byte of a job — upload, mezzanine,
proxy, previews, renders — lives under jobs/{id}/ (uploads/ for browser
uploads) in the job's store (Job.media_store): the local disk
(CLEO_MEDIA_ROOT, the default) or, for jobs created while
CLEO_MEDIA_BACKEND=r2, R2 — media routes then answer with a 307 to a
presigned GET. Analyses and local renders work in a per-job workspace
under CLEO_TMP_ROOT (default <work root>/tmp), removed when they end.
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
import logging
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
from backend import accounts, auth, billing, costs, db, media, observability
from backend import storage
from backend import uploads as upl
from backend.auth import (
    User, current_user, get_owned_job, media_user, require_user,
)
from backend.jobs import (
    DEFAULT_PLAN, PLAN_RETENTION_DAYS, RUNNING_STATUSES, DuplicateKey, Job,
    new_job_id, retention_days, store,
)
from backend.pipeline import EXPORT_FORMATS, analyze_only
from backend.security_headers import SecurityHeadersMiddleware

# Media tokens (?t=) must not end up in the access log.
auth.install_log_filter()

# Error monitoring (Sentry): a no-op unless SENTRY_DSN is set.
observability.init_sentry()

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


def _analysis_cap_s() -> float | None:
    """The most of any upload that is analysed (CLEO_MAX_MINUTES, with
    _too_long's second of slack); None when the cap is off (<= 0)."""
    minutes = _max_minutes()
    return minutes * 60 + 1 if minutes > 0 else None


def _cap_settings(settings: dict) -> dict:
    """settings["_max_seconds"] no higher than _analysis_cap_s()."""
    cap = _analysis_cap_s()
    if cap is None:
        return settings
    try:
        cur = float(settings.get("_max_seconds") or 0) or None
    except (TypeError, ValueError):
        cur = None
    settings["_max_seconds"] = cap if cur is None else min(cur, cap)
    return settings


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
    """What an in-flight job has written so far (upload + workspace)."""
    total = 0
    paths = []
    if entry.get("upload"):
        paths.append(Path(entry["upload"]))
    if entry.get("job_id"):
        for job_dir in (_workspace(entry["job_id"]),
                        _WORK_ROOT / entry["job_id"]):
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
        # Where the analysis writes: its workspace (CLEO_TMP_ROOT).
        free = shutil.disk_usage(_TMP_ROOT).free
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

    def job_ids(self) -> set[str]:
        """Jobs with a live worker thread (analysis or render, also
        while it waits in line) in this process."""
        with self._lock:
            return {e["job_id"] for e in self._live() if e["job_id"]}


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
    # STARTUP: pick the database first — with DATABASE_URL this opens
    # Postgres and, on the first boot, copies the SQLite data into it
    # (backend/db.py). Raises (no start) on a bad CLEO_DB_BACKEND, or if
    # Postgres is gone after the cutover.
    try:
        db.startup()
    except (db.ConfigError, db.Unavailable) as e:
        print(f"[db] NOT STARTING: {e}", flush=True)
        raise
    try:
        media_backend = media.backend()
    except media.ConfigError as e:
        print(f"[media] NOT STARTING: {e}", flush=True)
        raise
    print(f"[media] new jobs' media: {media_backend}"
          + (f" (bucket {os.environ.get('R2_BUCKET')})"
             if media_backend == "r2" else f" ({media.local_root()})")
          + "; existing jobs stay in their own store"
          + f"; R2 {'configured' if storage.r2_available() else 'NOT configured'}"
          + f"; uploads {_upload_mode()}"
          + f"; render {os.environ.get('CLEO_MODAL_RENDER_FN') or 'render_burn_concat'}"
          + f"; proxy-video {'on' if _proxy_video_enabled() else 'off'}"
          + f"; orphan sweep {'on' if _orphan_sweep_enabled() else 'off'}"
          + f"; tmp {_TMP_ROOT}", flush=True)
    # Any job stuck in 'processing'/'pending' from the previous
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
    _clean_workspaces()
    if db.fell_back():
        threading.Thread(target=_cutover_watch, daemon=True).start()
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
    """Legacy job files (from before the media keys: upload, normalized
    source, preview, outputs), uploads of the local media backend, and
    its media root (<work root>/media, backend/media.py).

    CLEO_WORK_ROOT wins; otherwise a mounted persistent volume at /data
    (Railway volume) is used so jobs survive redeploys; /tmp only as a
    last resort (wiped on every restart)."""
    return media.work_root()


_WORK_ROOT = _default_work_root()
_WORK_ROOT.mkdir(parents=True, exist_ok=True)
# Scratch space: analysis workspaces (jobs/{id}/), the editor's proxy
# cache (proxy-cache/) and spooled legacy uploads with media in R2
# (uploads/). Nothing in it outlives the work that made it. Default:
# <work root>/tmp, i.e. on the volume, like the analysis before WP3.
# Moving it to the container disk (CLEO_TMP_ROOT=/tmp/cleo) is a later,
# separate step: only after `df -h /tmp` in the Railway shell shows the
# room (reserve_disk measures this path; on overlayfs that is the
# host's free space, not the plan's cap).
def _default_tmp_root(work_root: Path) -> Path:
    return Path(os.environ.get("CLEO_TMP_ROOT", "").strip()
                or str(work_root / "tmp"))


_TMP_ROOT = _default_tmp_root(_WORK_ROOT)
_TMP_ROOT.mkdir(parents=True, exist_ok=True)


def _workspace(job_id: str, sub: str | None = None) -> Path:
    """A job's scratch folder: CLEO_TMP_ROOT/jobs/{id}[/sub]."""
    ws = _TMP_ROOT / "jobs" / job_id
    return ws / sub if sub else ws


# Creating a sub-workspace and removing the job's (then empty) folder
# are serialized: otherwise one preview rebuild's cleanup can remove the
# folder between another's mkdir of it and of its own sub-folder.
_WS_LOCK = threading.Lock()


def _make_workspace(path: Path) -> Path:
    with _WS_LOCK:
        path.mkdir(parents=True, exist_ok=True)
    return path


def _drop_workspace(path: Path) -> None:
    """rmtree a workspace (or a sub-folder of one), and the job's folder
    when that leaves it empty."""
    shutil.rmtree(path, ignore_errors=True)
    parent = path.parent
    if parent != _TMP_ROOT / "jobs" and parent.parent == _TMP_ROOT / "jobs":
        with _WS_LOCK:
            try:
                parent.rmdir()
            except OSError:
                pass


def _clean_workspaces() -> None:
    """Boot: workspaces and spooled uploads older than this process
    belong to work that died with the previous one."""
    removed = 0
    for parent in (_TMP_ROOT / "jobs", _TMP_ROOT / "uploads"):
        if not parent.is_dir():
            continue
        for path in parent.iterdir():
            try:
                if path.stat().st_mtime >= _PROCESS_START:
                    continue
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink()
                removed += 1
            except OSError:
                pass
    if removed:
        print(f"[startup] removed {removed} stale workspace(s) in "
              f"{_TMP_ROOT}", flush=True)
# Modal volume folders of renders, until they are surely gone
# (pipeline.sweep_modal_folders, run by the retention loop).
pipeline.MODAL_LEDGER_DIR = str(_WORK_ROOT / "modal_folders")
# Free space that must remain on the work volume after an upload's disk
# reservation (_Inflight.reserve_disk) — for the job DB, previews, renders.
_MIN_FREE_BYTES = float(os.environ.get("CLEO_MIN_FREE_GB", "1")) * 1e9

def _remove_upload(path: str | None) -> None:
    """Delete an uploaded source file (only inside our work / tmp root)."""
    if not path:
        return
    resolved = Path(path).resolve()
    if (resolved.is_relative_to(_WORK_ROOT.resolve())
            or resolved.is_relative_to(_TMP_ROOT.resolve())):
        try:
            os.remove(path)
        except OSError:
            pass


# Folders of the work root that aren't job folders.
_WORK_ROOT_RESERVED = frozenset({"media", "uploads", "modal_folders", "jobs",
                                 "tmp"})


def _media_of(job: Job) -> list[str]:
    """media_gc entries that remove everything a job has stored: its
    jobs/{id}/ prefix and its upload object."""
    entries = []
    if media.valid_job_id(job.id):
        entries.append(media.job_prefix(job.id))
    src = job.source_ref()
    if src and not src.startswith(tuple(entries)):
        entries.append(src)
    return entries


def _delete_job(job) -> None:
    """Remove a job: in one transaction its row goes and its media
    (jobs/{id}/ + the upload) are queued in media_gc — in EVERY store
    (store "": local, and R2 when configured), not only the job's: a
    backfill whose commit was refused, a move that lost its
    compare-and-set, or a move committing while this runs leaves copies
    in the other store that nothing else would delete (a missing prefix
    costs one LIST). Then that GC is tried right away (best effort — the
    GC loop retries). Legacy local files (work dir, upload) are removed
    directly."""
    if job.id and job.id not in _WORK_ROOT_RESERVED and "/" not in job.id:
        shutil.rmtree(_WORK_ROOT / job.id, ignore_errors=True)
        shutil.rmtree(_workspace(job.id), ignore_errors=True)
    _remove_upload(job.input_path)
    entries = _media_of(job)
    where = None  # every store (media.gc_stores)
    store.delete(job.id, gc=entries, gc_store=where)
    _proxy_cache_drop(job.id)
    with _EDIT_GUARD:
        _EDIT_SEQ.pop(job.id, None)
        _PREVIEW_LOCKS.pop(job.id, None)
    for entry in entries:
        _gc_one(entry, where)


def delete_user_media(user_id: str) -> dict[str, int]:
    """Account deletion (for later use): each of the user's jobs removed
    like DELETE /jobs/{id} does (_delete_job: the row, jobs/{id}/ and
    the upload in the job's store, legacy files, the proxy cache —
    queued in media_gc in the row's transaction, so an R2 error mid-way
    is retried, not left half-done), then every object under the user's
    upload prefix queued the same way. Running jobs are left (their
    worker would write again): "running" says how many — call again
    once they have settled. Returns {"jobs", "uploads", "running"}."""
    with _active_lock:
        active = set(_active_jobs)
    active |= _INFLIGHT.job_ids()
    out = {"jobs": 0, "uploads": 0, "running": 0}
    for job in store.list_by_owner(user_id):
        if job.id in active or job.status in RUNNING_STATUSES:
            out["running"] += 1
            continue
        _delete_job(job)
        out["jobs"] += 1
    if storage.r2_available():
        prefix = auth.upload_prefix(User(id=user_id))
        keys = [o["key"] for o in storage.list_r2(prefix)
                if media.gc_entry_ok(o["key"])]
        if keys:
            store.gc_add(keys, store="r2")
            for key in keys:
                _gc_one(key, "r2")
        out["uploads"] = len(keys)
    return out


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
    for job in store.retention_candidates(_retention_cutoff(now)):
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


def _retention_cutoff(now: float) -> float | None:
    """Jobs idle since before this can have expired (the shortest
    retention of any plan); None: retention is off. The store only
    returns those (indexed on Postgres), purge checks each one."""
    days = [d for d in (retention_days(p) for p in (*PLAN_RETENTION_DAYS,
                                                     None)) if d > 0]
    return now - min(days) * 86400 if days else None


def _backup_tick() -> None:
    """Nightly Postgres backup to R2 (backend/pg_backup.py): runs at most
    once per 24 h across all processes, only with Postgres + R2."""
    if not db.is_postgres():
        return
    from backend import pg_backup
    key = pg_backup.maybe_run()
    if key:
        print(f"[backup] Postgres backup uploaded to R2: {key}", flush=True)


# How often a process on the SQLite fallback checks whether another one
# cut over to Postgres meanwhile (_cutover_watch).
_CUTOVER_WATCH_S = 30.0


def _exit_process(code: int) -> None:  # replaced in tests
    os._exit(code)


def _cutover_watch() -> None:
    """While this process runs on the SQLite fallback after a failed
    cutover (backend/db.py): if another process — a second worker or
    replica, or a later boot — cuts over to Postgres, what this one
    writes to SQLite from then on would never reach Postgres. Stop it
    (exit status 1, so the platform restarts it; the new boot runs on
    Postgres)."""
    while db.fell_back():
        time.sleep(_CUTOVER_WATCH_S)
        try:
            why = db.peer_cut_over()
        except Exception as e:
            print(f"[db] cutover check failed: {e}", flush=True)
            continue
        if why:
            since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(
                (db._fallback or {}).get("since", 0)))
            print(f"[db] !!! another process cut over to Postgres ({why}) "
                  f"while this one runs on the SQLite fallback (since "
                  f"{since}) — exiting, the restart runs on Postgres. What "
                  "this process wrote to SQLite since then is NOT in "
                  "Postgres. !!!", flush=True)
            _exit_process(1)
            return


# ── media GC (media_gc table, backend/jobs.py / backend/pg.py) ──────
# Deleting media is a durable queue: _delete_job, a failed analysis, a
# superseded render or preview (+24 h: someone may still stream it) add
# rows; the retention loop deletes what is due every _GC_TICK_S and
# drops the row, or counts the failure (attempts) and tries again next
# time. An entry is a `jobs/{id}/…` prefix (ends with "/") or one key.

_GC_TICK_S = 300.0
# Superseded renders / preview versions stay this long (a player may
# still stream the old one).
_SUPERSEDED_KEEP_S = 24 * 3600.0
_GC_STUCK_ATTEMPTS = 10
_GC_RUN = threading.Lock()   # one GC runner per process


def _gc_later(entries: list[str], delay_s: float = 0.0,
              store_: str | None = None) -> None:
    """Queue media (in store `store_`, the job's) for deletion (best
    effort: a failure is logged)."""
    entries = [e for e in entries if e]
    if not entries:
        return
    try:
        store.gc_add(entries, time.time() + delay_s, store=store_)
    except Exception as e:
        print(f"[media] could not queue {entries} for deletion: {e}",
              flush=True)


def _gc_one(entry: str, where: str | None = None) -> bool:
    """Delete one media_gc entry (in its store) now; drop its row on
    success, otherwise count the failure (the row's next try is pushed
    back, jobs.gc_backoff_s). True once it is gone."""
    try:
        n = media.delete_any(entry, where)
    except Exception as e:
        try:
            attempts = store.gc_failed(entry, f"{type(e).__name__}: {e}",
                                       store=where)
        except Exception:
            attempts = 0
        if attempts >= _GC_STUCK_ATTEMPTS or isinstance(e, ValueError):
            line = (f"[media] GC STUCK — {entry} ({where or 'both'}): "
                    f"{attempts} attempts, last error: {e}")
            print(line, flush=True)
            logging.getLogger("backend.media").error(line)
        else:
            print(f"[media] deleting {entry} failed (attempt {attempts}): "
                  f"{e}", flush=True)
        return False
    try:
        store.gc_done(entry, store=where)
    except Exception as e:
        print(f"[media] {entry} deleted, but its GC row stays: {e}",
              flush=True)
    if n:
        print(f"[media] deleted {entry} ({n} object(s))", flush=True)
    return True


def run_media_gc(now: float | None = None, limit: int = 500) -> int:
    """Delete the media_gc entries that are due. Returns how many went.
    One runner per process (a second caller returns 0 at once)."""
    if not _GC_RUN.acquire(blocking=False):
        return 0
    try:
        done = 0
        for row in store.gc_due(now, limit):
            if _gc_one(row["prefix"], row.get("store")):
                done += 1
        return done
    finally:
        _GC_RUN.release()


# Weekly, OPT-IN (CLEO_MEDIA_ORPHAN_SWEEP=1): jobs/{id}/ prefixes without
# a job row (a delete whose GC row was lost) older than 2 days →
# media_gc. "No row in MY database" only proves an orphan if the store
# belongs to this database: jobs/.owner must hold this database's
# media_owner_id (meta), else the sweep refuses, loudly. meta is copied
# by a clone, a dump or a restore, so the id alone proves nothing: it
# is also bound to where it was made (media_owner_fp: the database's
# physical identity + RAILWAY_ENVIRONMENT_ID, _owner_fingerprint). A
# database whose fingerprint differs (a clone, a restore, a cutover) or
# that has the id without one (the dump leaves it out) refuses until an
# operator re-arms it (CLEO_MEDIA_OWNER_REARM=<its fingerprint>). The
# first sweep runs a week after the first boot (the stamp is seeded).
_ORPHAN_SWEEP_EVERY_S = 7 * 86400.0
_ORPHAN_MIN_AGE_S = 2 * 86400.0
_ORPHAN_OWNER_META = "media_owner_id"
_ORPHAN_FP_META = "media_owner_fp"
_ORPHAN_STAMP_META = "media_orphan_sweep_at"


def _orphan_sweep_enabled() -> bool:
    return os.environ.get("CLEO_MEDIA_ORPHAN_SWEEP", "").strip() == "1"


def _orphan_max() -> int:
    """At most this many prefixes per sweep (CLEO_MEDIA_ORPHAN_MAX)."""
    return max(1, _env_int("CLEO_MEDIA_ORPHAN_MAX", 200))


def _media_owner_id() -> str:
    """meta media_owner_id; a new one is bound to where it's made
    (media_owner_fp, written before the id exists)."""
    if accounts.meta_get(_ORPHAN_OWNER_META) is None:
        accounts.meta_get_or_create(_ORPHAN_FP_META, _owner_fingerprint)
    return accounts.meta_get_or_create(_ORPHAN_OWNER_META,
                                       lambda: uuid.uuid4().hex)


def _owner_fingerprint() -> str:
    """Where this database is: its physical identity (accounts.db_identity
    — not copied by a clone or restore) and the Railway environment."""
    raw = "|".join((accounts.db_identity(),
                    os.environ.get("RAILWAY_ENVIRONMENT_ID", "").strip()))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _media_owner() -> str | None:
    """This database's media_owner_id — or None (loud) when the id isn't
    bound to this database: made elsewhere (a clone, a restored backup,
    the SQLite→Postgres cutover) and not re-armed by the operator."""
    mine = _media_owner_id()
    fp = _owner_fingerprint()
    bound = accounts.meta_get(_ORPHAN_FP_META)
    if bound == fp:
        return mine
    if os.environ.get("CLEO_MEDIA_OWNER_REARM", "").strip() == fp:
        accounts.meta_set(_ORPHAN_FP_META, fp)
        print(f"[media] orphan sweep re-armed: media owner {mine} bound to "
              f"this database ({fp}); remove CLEO_MEDIA_OWNER_REARM",
              flush=True)
        return mine
    print(f"[media] ORPHAN SWEEP REFUSED: this database is not where its "
          f"media owner id was made (bound to {bound!r}, this is {fp!r}) — "
          "a clone, a restored backup or the move to Postgres. Nothing "
          "deleted. A clone or staging copy: turn CLEO_MEDIA_ORPHAN_SWEEP "
          "off and give it its own bucket. Only if this IS the deployment "
          f"the store belongs to (and no rows were lost): set "
          f"CLEO_MEDIA_OWNER_REARM={fp} once.", flush=True)
    logging.getLogger("backend.media").error(
        "orphan sweep refused: media owner id not bound to this database")
    return None


def _claim_store_owner(where: str) -> bool:
    """Is `where`'s jobs/ ours? Writes jobs/.owner when there is none
    yet — only when the store has no job prefixes at all or every one
    of them has a row here (a fresh bucket, or ours from before the
    marker). False (loud) otherwise, and when our id isn't bound to this
    database (_media_owner: a clone or a restore)."""
    mine = _media_owner()
    if mine is None:
        return False
    owner = media.read_owner(where)
    if owner == mine:
        return True
    if owner is not None:
        print(f"[media] ORPHAN SWEEP REFUSED ({where}): jobs/.owner is "
              f"{owner!r}, this database is {mine!r} — the store belongs "
              "to another deployment. "
              "Nothing deleted. Fix: point R2_BUCKET / CLEO_MEDIA_ROOT at "
              "this deployment's own store, or turn "
              "CLEO_MEDIA_ORPHAN_SWEEP off.", flush=True)
        logging.getLogger("backend.media").error(
            "orphan sweep refused: store %s owned by %s", where, owner)
        return False
    # Known ids (and ids that aren't job ids — never swept) aren't
    # looked into; anything listed is a prefix nobody here owns.
    for job_id, _newest in media.list_job_prefixes(
            where, skip=lambda j: (not media.valid_job_id(j)
                                   or store.exists(j))):
        if not store.exists(job_id):
            print(f"[media] ORPHAN SWEEP REFUSED ({where}): no jobs/.owner "
                  f"and jobs/{job_id}/ has no row in this database — "
                  "can't tell whose store this is. Nothing deleted. If "
                  "the store is this deployment's, write "
                  f"{mine!r} to jobs/.owner.", flush=True)
            logging.getLogger("backend.media").error(
                "orphan sweep refused: store %s has no owner marker", where)
            return False
    media.write_owner(where, mine)
    print(f"[media] {where}: jobs/.owner set to this database ({mine})",
          flush=True)
    return True


def sweep_media_orphans(now: float | None = None) -> int:
    """Queue job prefixes whose job is gone (newest object older than
    _ORPHAN_MIN_AGE_S; uploads/ is left to the bucket's lifecycle rule)
    in every store — only where jobs/.owner is ours (_claim_store_owner),
    only well-formed job ids, existence checked on the raw row (a row
    get() can't read still owns its media), at most _orphan_max() per
    run. Returns how many were queued."""
    now = time.time() if now is None else now
    stores = ["local"] + (["r2"] if storage.r2_available() else [])
    cap = _orphan_max()
    queued = 0
    for where in stores:
        if not _claim_store_owner(where):
            continue
        found = []
        for job_id, newest in media.list_job_prefixes(
                where, skip=lambda j: (not media.valid_job_id(j)
                                       or store.exists(j))):
            if newest >= now - _ORPHAN_MIN_AGE_S:
                continue
            if store.exists(job_id):  # still gone? (a race with create)
                continue
            found.append(media.job_prefix(job_id))
            if queued + len(found) >= cap:
                break
        if found:
            _gc_later(found, store_=where)
            queued += len(found)
            print(f"[media] orphan sweep ({where}): {len(found)} job "
                  "prefix(es) without a job queued for deletion", flush=True)
        if queued >= cap:
            print(f"[media] orphan sweep: cap of {cap} reached, the rest "
                  "waits for the next run", flush=True)
            break
    return queued


def _orphan_sweep_due(now: float) -> bool:
    """CLEO_MEDIA_ORPHAN_SWEEP=1 and at most once per
    _ORPHAN_SWEEP_EVERY_S, across restarts and processes (a stamp in
    meta, seeded with the first boot's time: never due at once)."""
    if not _orphan_sweep_enabled():
        return False
    last = _to_float(accounts.meta_get_or_create(
        _ORPHAN_STAMP_META, lambda: repr(now)))
    if now - last < _ORPHAN_SWEEP_EVERY_S:
        return False
    accounts.meta_set(_ORPHAN_STAMP_META, repr(now))
    return True


# The uploads/ lifecycle rules (expire abandoned or refused browser
# uploads, abort open multipart uploads) are the only retention uploads/
# has — nothing else deletes an upload nobody turned into a job. Checked
# at runtime once a day while R2 is configured, not only by
# `r2_setup --check`: missing rules are logged as an error every day
# until fixed.
_LIFECYCLE_EVERY_S = 86400.0
_lifecycle_checked_at = float("-inf")


def check_uploads_lifecycle(now: float | None = None) -> list[str] | None:
    """Problems of the bucket's uploads/ lifecycle rules ([] = fine), or
    None when there is no R2 / the check isn't due / the token may not
    read them (said once a day in the log)."""
    global _lifecycle_checked_at
    if not storage.r2_available():
        return None
    now = time.monotonic() if now is None else now
    if now - _lifecycle_checked_at < _LIFECYCLE_EVERY_S:
        return None
    _lifecycle_checked_at = now
    from backend import r2_setup
    try:
        rules = storage._client().get_bucket_lifecycle_configuration(
            Bucket=storage.bucket()).get("Rules") or []
    except Exception as e:
        if "NoSuchLifecycleConfiguration" not in str(e):
            print(f"[media] can't read the R2 lifecycle rules "
                  f"({type(e).__name__}) — check that uploads/ expires "
                  "(DEPLOY.md §10, r2_setup --print-config)", flush=True)
            return None
        rules = []
    problems = r2_setup.lifecycle_problems(rules)
    if problems:
        line = ("[media] R2 LIFECYCLE MISSING: " + "; ".join(problems)
                + " — abandoned uploads stay forever. Apply "
                "`python -m backend.r2_setup --print-config`'s lifecycle "
                "rules (DEPLOY.md §10)")
        print(line, flush=True)
        logging.getLogger("backend.media").error(line)
    return problems


def _backfill_tick() -> None:
    """CLEO_BACKFILL=1: move a few legacy jobs' local files to the media
    store per hour (backend/r2_backfill.py; one runner)."""
    if os.environ.get("CLEO_BACKFILL", "").strip() != "1":
        return
    from backend import r2_backfill
    summary = r2_backfill.run(limit=_env_int("CLEO_BACKFILL_BATCH", 5),
                              max_mbps=_env_float("CLEO_BACKFILL_MBPS", 40))
    if summary and summary.get("jobs"):
        print(f"[backfill] {summary}", flush=True)


def _hourly() -> None:
    try:
        n = purge_expired_jobs()
        if n:
            print(f"[retention] deleted {n} expired job(s)", flush=True)
    except Exception as e:
        print(f"[retention] sweep failed: {e}", flush=True)
    try:
        n = _sweep_stale_claims()
        if n:
            print(f"[claims] settled {n} upload claim(s) whose request "
                  "died", flush=True)
    except Exception as e:
        print(f"[claims] sweep failed: {e}", flush=True)
    try:
        n = _sweep_orphaned_jobs()
        if n:
            print(f"[jobs] settled {n} running job(s) whose worker is "
                  "gone", flush=True)
    except Exception as e:
        print(f"[jobs] orphaned-job sweep failed: {e}", flush=True)
    try:
        _backup_tick()
    except Exception as e:
        print(f"[backup] Postgres backup FAILED: {e}", flush=True)
    try:
        n = pipeline.sweep_modal_folders()
        if n:
            print(f"[retention] removed {n} leftover Modal volume "
                  f"folder(s)", flush=True)
    except Exception as e:
        print(f"[retention] Modal volume sweep failed: {e}", flush=True)
    try:
        if _orphan_sweep_due(time.time()):
            sweep_media_orphans()
    except Exception as e:
        print(f"[media] orphan sweep failed: {e}", flush=True)
    try:
        check_uploads_lifecycle()
    except Exception as e:
        print(f"[media] lifecycle check failed: {e}", flush=True)
    try:
        _backfill_tick()
    except Exception as e:
        print(f"[backfill] failed: {e}", flush=True)


def _retention_loop() -> None:
    """Hourly: retention, stale claims, orphaned jobs, the Postgres
    backup, the Modal volume sweep, the weekly media orphan sweep and
    the backfill. Every _GC_TICK_S (5 min): the media GC."""
    last_hourly = float("-inf")
    while True:
        if time.monotonic() - last_hourly >= 3600:
            last_hourly = time.monotonic()
            _hourly()
        try:
            run_media_gc()
        except Exception as e:
            print(f"[media] GC run failed: {e}", flush=True)
        time.sleep(_GC_TICK_S)


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
    would let the same file be retried for free forever. The database
    staying down (a finished analysis that couldn't be saved) is ours
    too."""
    if msg in ("server_storage_full", "container_restart"):
        return True
    if isinstance(exc, (OSError, MemoryError)) or db.is_transient(exc):
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


def _refund(job_id: str, note: str) -> bool:
    """Give the job's minutes back (if any were charged). Blocking (a DB
    transaction): from async code only via run_in_threadpool. Returns
    False when the database call failed — the ledger is settled
    otherwise (refunded now, before, or nothing charged)."""
    if not auth.auth_enabled():
        return True
    try:
        if accounts.refund(job_id, note):
            print(f"[job {job_id}] minutes refunded ({note[:60]})",
                  flush=True)
        return True
    except Exception as e:
        print(f"[job {job_id}] refund failed: {e}", flush=True)
        return False


def _refund_interrupted() -> None:
    """Startup: analyses killed by the last restart get their minutes
    back (mark_stuck_as_error tagged them container_restart). Idempotent."""
    if not auth.auth_enabled():
        return
    for job in store.list_by_status("error", error="container_restart"):
        _refund(job.id, "container_restart")


def _discard_upload(input_path: str | None, storage_key: str | None,
                    where: str | None = None) -> None:
    """Throw away a refused upload (local copy + its object, in store
    `where`: the job's; uploads/ are in R2 anyway). An object that can't
    be deleted now goes to media_gc."""
    _remove_upload(input_path)
    if storage_key:
        try:
            media.delete(storage_key, store=where)
        except ValueError:
            pass   # not a key of ours
        except Exception as e:
            print(f"[media] deleting {storage_key} failed: {e}", flush=True)
            _gc_later([storage_key], store_=where)


# ── Upload claims (POST /jobs) ───────────────────────────────────────
# POST /jobs inserts the job row BEFORE it charges the minutes: status
# pending, settings._accepting set — a claim on the upload (its storage
# key is the row's UNIQUE idempotency key). A second request for the
# same key, in any process, runs into that constraint before it touches
# the quota and answers with the claimed job once it is accepted, or
# claims the key itself if the first request was refused (402). The
# claim becomes the job when the charge went through (update_if
# pending: settings without _accepting, the plan); a refused or failed
# request deletes it again.

# How long a request waits for another request's claim on its upload to
# be accepted or dropped (normally milliseconds: one charge).
_CLAIM_WAIT_S = 30.0
# A claim this old belongs to a request that died (process killed, the
# database failing while it cleaned up): _sweep_stale_claims settles it.
_CLAIM_STALE_S = 900.0


def _is_claim(job: Job) -> bool:
    return job.status == "pending" and bool(
        (job.settings or {}).get("_accepting"))


async def _settled(job: Job | None) -> Job | None:
    """`job` once no request is accepting it any more: as it is if it's
    not a claim, re-read until its request accepted it, None if that
    request dropped it (refused). After _CLAIM_WAIT_S as it is."""
    deadline = time.monotonic() + _CLAIM_WAIT_S
    delay = 0.02
    while (job is not None and _is_claim(job)
           and time.monotonic() < deadline):
        await asyncio.sleep(delay)
        delay = min(delay * 2, 0.5)
        job = await run_in_threadpool(store.get, job.id)
    return job


def _abandon_claim(job_id: str, input_path: str | None,
                   storage_key: str | None, refund_note: str | None) -> None:
    """POST /jobs gives up its claim (refused, or failed after claiming):
    the minutes back first (refund_note: they were charged), then the
    row, the local copy and — with storage_key — the R2 object. If the
    refund or the delete fails, the row stays a claim and
    _sweep_stale_claims settles it later. Blocking: run_in_threadpool."""
    try:
        if refund_note is None or _refund(job_id, refund_note):
            store.delete(job_id)
    except Exception as e:
        print(f"[job {job_id}] dropping the upload claim failed: {e} — "
              "the stale-claim sweep settles it", flush=True)
    try:
        _discard_upload(input_path, storage_key)
    except Exception as e:
        print(f"[job {job_id}] dropping the upload failed: {e}", flush=True)


def _sweep_stale_claims(now: float | None = None) -> int:
    """Claims older than _CLAIM_STALE_S (their POST /jobs died): minutes
    back if any were charged, then failed like a job interrupted by a
    restart (error container_restart) and their upload freed. A refund
    that fails leaves the claim for the next sweep. Returns how many
    were settled."""
    cutoff = (time.time() if now is None else now) - _CLAIM_STALE_S
    settled = 0
    for job in store.list_by_status("pending"):
        if not _is_claim(job) or (job.created_at or 0) > cutoff:
            continue
        if not _refund(job.id, "container_restart"):
            continue
        settings = {k: v for k, v in (job.settings or {}).items()
                    if k != "_accepting"}
        if not store.update_if(
                job.id, "pending", status="error", error="container_restart",
                message="Processing was interrupted. "
                        "Please upload the video again.",
                progress=0.0, queue_position=None, input_path=None,
                settings=settings):
            continue
        try:
            _discard_upload(job.input_path, job.source_ref(),
                            media.store_of(job))
        except Exception as e:  # R2 unreachable: retention later
            print(f"[claims] dropping the upload of {job.id} failed: {e}",
                  flush=True)
        _gc_later(_media_of(job), store_=media.store_of(job))
        settled += 1
    return settled


# A running job (pending / processing) with no worker thread in this
# process that hasn't changed for this long lost its worker: it died on
# a database outage its retries (_db_retry) couldn't ride out, or the
# request that started it failed half-way. _sweep_orphaned_jobs settles
# it like the boot does (mark_stuck_as_error): a render goes back to
# review, an analysis fails with its minutes refunded and its files
# freed. Relies on this backend being ONE process (module docstring).
_ORPHAN_STALE_S = 600.0


def _sweep_orphaned_jobs(now: float | None = None) -> int:
    """Settle running jobs whose worker is gone (see _ORPHAN_STALE_S)
    instead of leaving them 'processing' until the next deploy (DELETE
    and render answer 409 meanwhile). A refund that fails leaves the job
    for the next sweep. Returns how many were settled."""
    cutoff = (time.time() if now is None else now) - _ORPHAN_STALE_S
    with _active_lock:
        live = set(_active_jobs)
    live |= _INFLIGHT.job_ids()
    settled = 0
    for job in store.list_by_status(*RUNNING_STATUSES):
        if (job.id in live or _is_claim(job)
                or (job.updated_at or 0) > cutoff):
            continue
        if job.segments and job.has_mezz():
            # A render: analysis + edits are intact, back to review.
            if store.update_if(job.id, job.status, status="awaiting_review",
                               progress=100.0, message="render_failed",
                               error="container_restart",
                               queue_position=None):
                settled += 1
            continue
        if not _refund(job.id, "container_restart"):
            continue
        if not store.update_if(
                job.id, job.status, status="error", error="container_restart",
                message="Processing was interrupted. "
                        "Please upload the video again.",
                progress=0.0, queue_position=None, input_path=None):
            continue
        try:
            _discard_upload(job.input_path, job.source_ref(),
                            media.store_of(job))
        except Exception as e:  # R2 unreachable: retention later
            print(f"[jobs] dropping the upload of {job.id} failed: {e}",
                  flush=True)
        shutil.rmtree(_WORK_ROOT / job.id, ignore_errors=True)
        shutil.rmtree(_workspace(job.id), ignore_errors=True)
        _gc_later(_media_of(job), store_=media.store_of(job))
        settled += 1
    return settled


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
    for job in store.list_by_status("error", error="container_restart"):
        job_dir = _WORK_ROOT / job.id
        if job.input_path or job.source_key or job_dir.exists():
            try:
                _discard_upload(job.input_path, job.source_ref(),
                            media.store_of(job))
            except Exception as e:  # R2 unreachable: retention later
                print(f"[startup] dropping the upload of {job.id} "
                      f"failed: {e}", flush=True)
            shutil.rmtree(job_dir, ignore_errors=True)
            # Whatever the interrupted analysis had stored already.
            _gc_later(_media_of(job), store_=media.store_of(job))
            store.update(job.id, input_path=None, source_key=None,
                         updated_at=job.updated_at)
    # Uploads of all other jobs (the ones above have none any more).
    referenced = {Path(p).resolve() for p in store.input_paths()}
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

# nosniff, no-referrer, DENY, HSTS and Cross-Origin-Resource-Policy:
# cross-origin on every response (also the body limit's 413s). The
# frontend runs with COEP=require-corp (ffmpeg.wasm), so without CORP the
# browser blocks thumbnails, videos and uploads. Pure ASGI: never buffers
# streamed or Range video.
app.add_middleware(SecurityHeadersMiddleware)

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


# The worker threads' job-state writes ride out a database outage
# (Postgres restarting or failing over) this long before they give up:
# retried with backoff from _DB_RETRY_DELAY_S up to 15 s between tries.
_DB_RETRY_S = 180.0
_DB_RETRY_DELAY_S = 1.0


def _db_retry(job_id: str, what: str, fn: Callable[..., Any], /,
              *args: Any, **kwargs: Any) -> Any:
    """fn(*args, **kwargs), tried again while the database is
    unavailable (db.is_transient: Postgres down, the pool timing out),
    for up to _DB_RETRY_S. Other errors — and the last one — are
    raised. Only for reads and writes that may run twice (store.update
    sets the same fields again; update_if's expected status allows the
    state it sets)."""
    deadline = time.monotonic() + _DB_RETRY_S
    delay = _DB_RETRY_DELAY_S
    while True:
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            left = deadline - time.monotonic()
            if not db.is_transient(e) or left <= 0:
                raise
            print(f"[job {job_id}] {what}: database unavailable ({e}) — "
                  f"trying again for up to {left:.0f} s", flush=True)
            time.sleep(min(delay, left))
            delay = min(delay * 2, 15.0)


class MediaTransferError(RuntimeError):
    """Fetching the upload from / storing results in the media store
    failed (R2 unreachable, …): our fault, the minutes go back."""


def _analysis_failed(job_id: str, job_dir: Path, exc: Exception,
                     drop_upload: Callable[[], None],
                     media_entries: list[str] | None = None,
                     where: str | None = None) -> None:
    """An analysis failed (or its result couldn't be saved): the minutes
    back first when it was our fault, then the error state, then free
    the upload + partial files (the workspace, and `media_entries` —
    jobs/{id}/ and the upload object — into media_gc). Raises when the
    refund or the error state can't be written — then the job stays
    running, nothing is deleted, and _sweep_orphaned_jobs (or the next
    boot) refunds and settles it later."""
    tb = traceback.format_exc()
    print(f"[job {job_id}] ANALYZE FAILED: {exc}\n{tb}", flush=True)
    observability.capture(exc, job_id=job_id, phase="analyze")
    msg = str(exc)
    if "No space left on device" in msg:
        msg = "server_storage_full"
    if not db.is_transient(exc):
        # A content failure ("No speech detected") comes after the
        # transcription was paid for: charge what was really processed
        # (before the files go; refunds below still win).
        _true_up_from_file(job_id, job_dir)
    infra = (_is_infra_failure(exc, msg)
             or isinstance(exc, MediaTransferError))
    if infra and auth.auth_enabled():
        # Before the error state: once that is stored nothing refunds
        # the job any more (the boot and the sweep only settle running
        # jobs), so a refund that fails — or the process dying while the
        # upload is dropped below — would charge the user for our
        # failure for good. accounts.refund is idempotent.
        if _db_retry(job_id, "refunding", accounts.refund, job_id, msg):
            print(f"[job {job_id}] minutes refunded ({msg[:60]})",
                  flush=True)
    _db_retry(job_id, "saving the failure", store.update, job_id,
              status="error", message=msg[:300], error=msg[:2000],
              input_path=None)
    # Nothing of a failed analysis can be reused (the user uploads
    # again), so free the upload + partial files right away — a failed
    # 10 min job used to leave ~1.5 GB on the volume.
    drop_upload()
    shutil.rmtree(job_dir, ignore_errors=True)
    if media_entries:
        _gc_later(media_entries, store_=where)


class AnalysisRefused(Exception):
    """The analysis worker refuses an upload before transcribing it
    (_length_gate): too long, unreadable, over the minutes left. `text`
    is the job's error (the code, JSON with the limit like the HTTP
    refusals, so the web app can word it)."""

    def __init__(self, code: str, **extra: Any) -> None:
        super().__init__(code)
        self.code = code
        self.text = (json.dumps({"detail": code, **extra},
                                separators=(",", ":"))
                     if extra else code)


def _length_gate(job: Job, input_path: str,
                 progress: Callable[[str, float], None]) -> dict:
    """Before the analysis: the settings to analyse with. For an upload
    accepted without a known length (POST /jobs: _measure_length) the
    local copy is measured (packet scan) — over CLEO_MAX_MINUTES →
    video_too_long; billed (_charge) → charged here, refused
    quota_exceeded / subscription_required / unreadable_video (enforced)
    exactly like POST /jobs would have. _max_seconds is capped at
    CLEO_MAX_MINUTES for every job. Raises AnalysisRefused; the flags
    leave the stored settings (with the plan of the charge)."""
    settings = dict(job.settings or {})
    measure = bool(settings.pop("_measure_length", False))
    charge = settings.pop("_charge", None)
    changed: dict[str, Any] = {}
    if measure:
        progress("Checking the video…", 1)
        seconds = _probe_duration(input_path)
        if _too_long(seconds):
            raise AnalysisRefused("video_too_long",
                                  max_minutes=_plain(_max_minutes()))
        if charge in ("enforce", "record") and job.owner_id:
            enforce = charge == "enforce"
            if seconds is None and enforce:
                raise AnalysisRefused("unreadable_video")
            email = None
            try:
                email = (accounts.get_user(job.owner_id) or {}).get("email")
            except Exception:
                pass
            try:
                # Once (usage is keyed by the job): not through _db_retry.
                ent = accounts.charge(job.id, job.owner_id, seconds or 0.0,
                                      email=email, enforce=enforce)
            except accounts.SubscriptionRequired:
                raise AnalysisRefused("subscription_required")
            except accounts.QuotaExceeded as e:
                raise AnalysisRefused(
                    "quota_exceeded",
                    remaining_seconds=round(e.remaining_seconds),
                    needed_seconds=round(e.needed_seconds))
            if ent is not None:
                changed["plan"] = ent.plan
            if enforce:
                settings["_max_seconds"] = (
                    math.ceil(max(seconds or 0.0, 0.0))
                    + accounts.TRUE_UP_TOLERANCE_S)
    _cap_settings(settings)
    if measure or charge or settings != (job.settings or {}):
        changed["settings"] = settings
    if changed:
        _db_retry(job.id, "saving the settings", store.update, job.id,
                  **changed)
    return settings


def _analysis_refused(job_id: str, job_dir: Path, exc: AnalysisRefused,
                      drop_upload: Callable[[], None],
                      media_entries: list[str] | None = None,
                      where: str | None = None,
                      source_key: str | None = None) -> None:
    """_length_gate refused the upload: whatever was charged back, the
    error state, the upload and the workspace freed (nothing was
    transcribed; like a refused POST /jobs). Raises like
    _analysis_failed when the database won't take it."""
    print(f"[job {job_id}] refused before analysis: {exc.text}", flush=True)
    if auth.auth_enabled():
        _db_retry(job_id, "refunding", accounts.refund, job_id, exc.code)
    _db_retry(job_id, "saving the refusal", store.update, job_id,
              status="error", message=exc.text[:300], error=exc.text[:2000],
              progress=0.0, input_path=None)
    drop_upload()
    shutil.rmtree(job_dir, ignore_errors=True)
    if source_key:
        # Retrying can't help: the upload goes now (media_gc if R2 fails).
        _discard_upload(None, source_key, where)
    if media_entries:
        _gc_later([e for e in media_entries if e != source_key],
                  store_=where)


def _render_failed(job_id: str, exc: Exception) -> None:
    """A render failed (or its result couldn't be saved): back to review
    instead of a dead 'error' — the user's edits and the source are
    still on disk, so they can open the editor and render again without
    re-uploading. Raises when that can't be written (the sweep settles
    the job later)."""
    tb = traceback.format_exc()
    print(f"[job {job_id}] RENDER FAILED: {exc}\n{tb}", flush=True)
    observability.capture(exc, job_id=job_id, phase="render")
    _db_retry(job_id, "saving the failure", store.update, job_id,
              status="awaiting_review", progress=100.0,
              message="render_failed", error=str(exc)[:500])


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


def _store_analysis(job_id: str, res: dict,
                    progress: Callable[[str, float], None],
                    where: str) -> dict:
    """Upload what the analysis made — the render source (normalized or
    SmartCam output) as mezz.mp4, the editor proxy, the first preview as
    preview/v1.mp4 — into store `where` (the job's) and return the job
    fields for them, media_store included ("Saving…", 96–99 %). Raises
    MediaTransferError."""
    prefix = media.job_prefix(job_id)
    mezz = Path(res["normalized_path"])
    items = [(mezz, prefix + "mezz.mp4", "mezz_key")]
    proxy = mezz.with_name(pipeline.PROXY_NAME)
    if proxy.is_file():
        items.append((proxy, prefix + "proxy.mp4", "proxy_key"))
    preview = res.get("preview_path")
    if preview and Path(preview).is_file():
        items.append((Path(preview), prefix + "preview/v1.mp4",
                      "preview_key"))
    fields: dict[str, Any] = {"media_bytes": {}, "media_store": where}
    for i, (path, key, field_name) in enumerate(items):
        progress("Saving…", 96 + i)
        try:
            size = media.put_file(path, key, content_type="video/mp4",
                                  store=where)
        except Exception as e:
            raise MediaTransferError(
                f"storing {key} failed: {type(e).__name__}: {e}") from e
        fields[field_name] = key
        fields["media_bytes"][key] = size
    return fields


def _run_analyze_inner(job_id: str) -> None:
    """Worker: fetch the upload into the job's workspace (CLEO_TMP_ROOT/
    jobs/{id}), normalize + analyze there, store mezz / proxy / preview
    in the media store, then one write with the keys and
    status=awaiting_review; the workspace is removed in any case. Its
    state writes ride out a short database outage (_db_retry); if they
    still fail the thread ends, and _sweep_orphaned_jobs settles the job
    later."""
    _register_active(job_id)
    progress: _ProgressWriter | None = None
    ws = _workspace(job_id)
    try:
        job = _db_retry(job_id, "reading the job", store.get, job_id)
        source_key = job.source_ref() if job is not None else None
        if job is None or (job.input_path is None and not source_key):
            return
        where = media.store_of(job)
        # Start exactly once, and only while the job still waits to start.
        if not _db_retry(job_id, "starting", store.update_if, job_id,
                         ("pending", "processing"), status="processing",
                         message="Starting…", progress=1.0,
                         queue_position=None):
            return

        ws.mkdir(parents=True, exist_ok=True)
        progress = _ProgressWriter(job_id)
        upload_gone = False
        local_copy: Path | None = None
        media_entries = _media_of(job)

        def _drop_upload(*_args: Any, **_kwargs: Any) -> None:
            """The source is only needed to build normalized.mp4;
            everything after (SmartCam, transcription, editing, render,
            and a failed analysis' true-up) works from that. Free the
            LOCAL copy as soon as it exists: the workspace copy of the
            upload, or the upload itself on the work volume (local
            media, legacy body upload). The upload object stays until
            the analysis ends (WP4 may retry from it)."""
            nonlocal upload_gone
            if upload_gone:
                return
            upload_gone = True
            try:
                if local_copy is not None:
                    local_copy.unlink(missing_ok=True)
                if job.input_path:
                    _remove_upload(job.input_path)
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
            input_path = job.input_path
            if not input_path:
                progress("Fetching upload…", 1)
                local_copy = ws / ("source" + upl.upload_ext(source_key))
                try:
                    media.get_file(source_key, local_copy, store=where)
                except Exception as e:
                    raise MediaTransferError(
                        f"fetching the upload failed: "
                        f"{type(e).__name__}: {e}") from e
                input_path = str(local_copy)
            settings = _length_gate(job, input_path, progress)
            res = analyze_only(
                input_path=input_path,
                output_dir=str(ws),
                settings=settings,
                progress_cb=progress,
                **extra,
            )
            stored = _store_analysis(job_id, res, progress, where)
        except AnalysisRefused as e:
            progress.close()
            _analysis_refused(job_id, ws, e, _drop_upload, media_entries,
                              where, source_key)
            return
        except Exception as e:
            progress.close()
            _analysis_failed(job_id, ws, e, _drop_upload, media_entries,
                             where)
            return
        progress.close()
        try:
            # Pause here: status "awaiting_review" tells the UI to show the
            # subtitle editor. Render starts when client POSTs /jobs/{id}/render.
            # Only while the job is still ours to finish ("processing"):
            # a job another process settled meanwhile (error
            # container_restart, its media GC'd) or deleted must not come
            # back with keys pointing at deleted objects.
            committed = _db_retry(
                job_id, "saving the analysis", store.update_if,
                job_id, "processing",
                status="awaiting_review",
                message="Review subtitles",
                progress=100.0,
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
                **stored,
            )
            cur = None
            if not committed:
                # A retry after a write that did land (the connection
                # broke on the answer) finds its own commit: go on.
                cur = _db_retry(job_id, "reading the job", store.get, job_id)
                committed = (cur is not None
                             and cur.status == "awaiting_review"
                             and cur.mezz_key == stored.get("mezz_key")
                             and media.store_of(cur) == where)
        except Exception as e:
            # Not saved (the database stayed down, or a bad result): a
            # failed analysis — refunded when the database was the cause.
            _analysis_failed(job_id, ws, e, _drop_upload, media_entries,
                             where)
            return
        if not committed:
            # Settled elsewhere (error: nothing of it is used again) or
            # deleted: what this run stored belongs to nobody. The upload
            # object is left to whoever settled the job.
            gone = cur is None or cur.status == "error"
            print(f"[job {job_id}] analysis finished, but the job is no "
                  f"longer processing ({cur.status if cur else 'deleted'})"
                  " — not saved" + ("; its stored files queued for "
                                    "deletion" if gone else ""), flush=True)
            _drop_upload()
            if gone and media.valid_job_id(job_id):
                _gc_later([media.job_prefix(job_id)], store_=where)
            return
        _true_up(job_id, res.get("duration", 0.0))
        _drop_upload()  # if the pipeline didn't already
        if source_key:
            # Committed: the upload object isn't needed any more.
            _discard_upload(None, source_key, where)
    finally:
        if progress is not None:
            progress.close()
        shutil.rmtree(ws, ignore_errors=True)
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
    """Worker: render + concat into final MP4. Its state writes ride out
    a short database outage (_db_retry); if they still fail the thread
    ends, and _sweep_orphaned_jobs sends the job back to review later."""
    _register_active(job_id)
    progress: _ProgressWriter | None = None
    ws = _workspace(job_id, "render")
    out_prefix: str | None = None
    try:
        job = _db_retry(job_id, "reading the job", store.get, job_id)
        if job is None:
            return
        progress = _ProgressWriter(job_id)
        _db_retry(job_id, "starting the render", store.update, job_id,
                  status="processing", message="Rendering…", progress=1.0,
                  queue_position=None)
        gen = max(1, int(job.render_gen or 0))
        out_prefix = f"{media.job_prefix(job_id)}r{gen}/"
        where = media.store_of(job)
        _make_workspace(ws)
        try:
            if not job.has_mezz():
                raise FileNotFoundError("the render source is gone")
            mezz_key = job.mezz_key or _backfill_mezz(job, progress, where)
            result = pipeline.render_to_keys(
                job_id=job_id, gen=gen, mezz_key=mezz_key,
                out_prefix=out_prefix, store=where,
                mezz_bytes=(job.media_bytes or {}).get(mezz_key),
                segments=job.segments,
                subtitles=edited_subtitles,
                settings=job.settings,
                language=job.language,
                cut_ranges=job.cut_ranges,
                disabled_cuts=disabled_cuts or [],
                duration=job.duration,
                workspace=str(ws),
                progress_cb=progress,
            )
            # Social caption / hashtags from the (possibly edited)
            # transcript. Soft-fails if no ANTHROPIC_API_KEY is set.
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
                print(f"[job {job_id}] social-caption skipped: {e}",
                      flush=True)
        except Exception as e:
            progress.close()
            # Partial outputs of this generation — not before a Modal
            # call that wasn't really stopped (_cancel_modal_call doesn't
            # kill its container) can't write there any more.
            _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
            _render_failed(job_id, e)
            return
        progress.close()
        try:
            # Nothing else writes these fields while the job renders
            # (edits need awaiting_review): computed from a fresh read.
            cur = _db_retry(job_id, "reading the job", store.get, job_id)
            if cur is None:
                _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
                return
            done, superseded = _render_commit(cur, result, out_prefix, social)
            _db_retry(job_id, "saving the render", store.update, job_id,
                      **done)
        except Exception as e:
            _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
            _render_failed(job_id, e)
            return
        # The previous render stays a day: someone may still stream it.
        _gc_later(superseded, _SUPERSEDED_KEEP_S, store_=where)
    finally:
        if progress is not None:
            progress.close()
        _drop_workspace(ws)
        _release_active(job_id)


def _render_commit(cur: Job, result: dict, out_prefix: str,
                   social: dict) -> tuple[dict, list[str]]:
    """The job fields of a finished render (pipeline.render_to_keys'
    result) and the prefixes of the render(s) it supersedes."""
    output_keys = {fmt: ref["key"] for fmt, ref in result["outputs"].items()}
    sizes = {ref["key"]: int(ref["size"])
             for ref in result["outputs"].values()}
    hook_clips = []
    for h in result.get("hooks") or []:
        name = f"hook_{h['k']}"
        output_keys[name] = h["key"]
        sizes[h["key"]] = int(h["size"])
        hook_clips.append({"key": name, "title": h.get("title"),
                           "reason": h.get("reason", ""),
                           "start": h.get("start"), "end": h.get("end")})
    thumb = result.get("thumb") or None
    if thumb:
        sizes[thumb["key"]] = int(thumb["size"])
    old = set((cur.output_keys or {}).values())
    if cur.thumb_key:
        old.add(cur.thumb_key)
    superseded = sorted({media.key_prefix_of(k) for k in old
                         if not k.startswith(out_prefix)})
    media_bytes = {k: v for k, v in (cur.media_bytes or {}).items()
                   if media.key_prefix_of(k) not in superseded}
    media_bytes.update(sizes)
    return dict(
        status="done",
        message="Done",
        progress=100.0,
        output_keys=output_keys,
        thumb_key=thumb["key"] if thumb else None,
        hook_clips=hook_clips,
        media_bytes=media_bytes,
        social_caption=social.get("caption", ""),
        social_hashtags=social.get("hashtags", []),
    ), superseded


def _render_gc_delay_s() -> float:
    """How long a failed render's r{g}/ prefix waits for the GC: past
    Modal's function timeout, so a call that kept running after we gave
    up can't write into it after the delete."""
    return pipeline._MODAL_FUNCTION_TIMEOUT_S + 300.0


def _backfill_mezz(job: Job, progress: Callable[[str, float], None],
                   where: str) -> str:
    """A job from before the media keys: its local normalized file
    becomes jobs/{id}/mezz.mp4 in store `where` (lazy backfill, before
    its first render after WP3; the job's store is recorded with it).
    Returns the key."""
    key = media.job_prefix(job.id) + "mezz.mp4"
    progress("Preparing render…", 2)
    size = media.put_file(job.normalized_path, key, content_type="video/mp4",
                          store=where)

    def _set(cur: Job) -> dict | None:
        if cur.media_store and cur.media_store != where:
            return None   # moved to another store meanwhile (backfill)
        return {"mezz_key": key,
                "media_store": cur.media_store or where,
                "media_bytes": {**(cur.media_bytes or {}), key: size},
                "updated_at": cur.updated_at}
    if store.modify(job.id, _set) is None:
        raise RuntimeError(f"job {job.id} is gone or its media moved "
                           "meanwhile")
    return key


def _paywall_soft_check(user: User | None, duration: float) -> None:
    """Before any bytes are sent: with billing enforced, 402 when there
    is no plan or not enough minutes left for `duration` (the binding
    check is the charge at POST /jobs)."""
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


def _no_direct_upload() -> HTTPException:
    """503 of a deployment without R2 — not "server_busy", so the web app
    falls back to the legacy upload."""
    return HTTPException(
        503,
        "Direct upload not available on this deployment. "
        "Contact support if you need multi-GB uploads.")


# ── Resumable multipart upload (POST /uploads/multipart/*) ──────────
# The browser uploads parts straight to R2 through presigned UploadPart
# URLs (size-signed, one per part), can resume after a reload / network
# loss (IndexedDB on the client, ListParts here), and completes through
# the server, which completes with the ETags it lists itself — so R2 CORS
# needn't expose ETag. Stateless: the ticket (backend/uploads.py) carries
# everything, any replica can serve any call. Opt-in:
# CLEO_UPLOAD_MODE=multipart turns it on; unset / "single" (the default)
# → init, parts and sign answer 409 use_single_put and the web app uses
# the single presigned PUT (/uploads/presign) — a browser resuming a
# saved upload (parts / sign, no init) drops it and starts over with
# the single PUT too. complete / abort keep working (a finished or
# abandoned upload can still be settled).


def _upload_mode() -> str:
    mode = os.environ.get("CLEO_UPLOAD_MODE", "").strip().lower()
    return "multipart" if mode == "multipart" else "single"


def _require_multipart() -> None:
    if _upload_mode() != "multipart":
        raise ApiRefusal(409, "use_single_put")


def _ticket_secret() -> str:
    """Key of the upload tickets: the media secret (accounts DB) with
    accounts on; without accounts CLEO_MEDIA_SECRET or the R2 secret
    (the upload API needs R2 anyway, and auth off must not open the
    accounts DB)."""
    if auth.auth_enabled():
        return accounts.media_secret()
    return (os.environ.get("CLEO_MEDIA_SECRET", "").strip()
            or os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
            or "cleo-upload-tickets")


def _uid(user: User | None) -> str:
    return user.id if user is not None else ""


def _read_ticket(payload: dict, user: User | None) -> dict:
    try:
        claims = upl.read_ticket(_ticket_secret(), payload.get("ticket"),
                                 _uid(user))
    except upl.TicketError as e:
        raise ApiRefusal(e.status, e.code)
    if not str(claims["k"]).startswith(auth.upload_prefix(user)):
        raise ApiRefusal(403, "bad_ticket")
    return claims


def _sign_parts(t: dict, numbers: list[int]) -> list[dict]:
    expires = int(min(upl.SIGN_TTL_S, t["exp"] - time.time()))
    if expires <= 0:
        raise ApiRefusal(410, "upload_expired")
    from backend import storage
    return [{"part_number": n,
             "url": storage.mpu_sign(t["k"], t["id"], n,
                                     upl.part_length(t["s"], t["ps"],
                                                     t["n"], n),
                                     expires)}
            for n in numbers]


def _storage_call(what: str, fn: Callable, *args: Any) -> Any:
    """An R2 call of the upload API; anything but "no such upload"
    becomes 502 storage_error (retryable)."""
    from backend import storage
    try:
        return fn(*args)
    except Exception as e:
        if storage.is_no_such_upload(e):
            raise
        print(f"[upload] {what} failed: {type(e).__name__}: {e}", flush=True)
        raise ApiRefusal(502, "storage_error")


# Multipart uploads a caller may open per hour (CLEO_UPLOAD_INITS_PER_HOUR,
# 0 = no limit): each one is an open upload in R2 (Class-A operations,
# parts kept until the lifecycle rule aborts it a day later) — POST
# /jobs's admission doesn't see them. Per user; per client address with
# auth off. In-process (one uvicorn process).
def _init_limit() -> int:
    return max(0, _env_int("CLEO_UPLOAD_INITS_PER_HOUR", 30))


_INIT_RATE = upl.RateLimit(_init_limit(), 3600.0)


def _check_init_rate(user: User | None, request: Request) -> None:
    limit = _init_limit()
    if limit <= 0:
        return
    _INIT_RATE.limit = limit
    who = (f"u:{user.id}" if user is not None
           else f"ip:{request.client.host if request.client else ''}")
    if not _INIT_RATE.allow(who):
        raise ApiRefusal(429, "too_many_uploads",
                         headers={"Retry-After": "600"})


@app.post("/uploads/multipart/init")
def multipart_init(payload: dict, request: Request,
                   user: User | None = Depends(current_user)):
    """Start a resumable upload: {filename, content_type, size, duration?}
    → {ticket, storage_key, part_size, parts_total, expires_at, parts:
    [{part_number, url}] (the first up to 8)}. Refuses like
    /uploads/presign, in the same order: 402, 413, 429 / 503 server_busy,
    507, 503 without R2; then 429 too_many_uploads (+ Retry-After) past
    CLEO_UPLOAD_INITS_PER_HOUR; 409 use_single_put unless
    CLEO_UPLOAD_MODE=multipart."""
    from backend import storage
    _require_multipart()
    duration = _to_float(payload.get("duration") or 0)
    _paywall_soft_check(user, duration)
    size = _to_float(payload.get("size") or 0)
    if size <= 0 or _too_big(size):
        raise _file_too_large()
    if _too_long(duration):
        raise _video_too_long()
    _INFLIGHT.check(user)
    _INFLIGHT.reserve_disk(None, size)
    if not storage.r2_available():
        raise _no_direct_upload()
    _check_init_rate(user, request)
    size = int(size)
    ps, n = upl.part_plan(size)
    key = (auth.upload_prefix(user) + uuid.uuid4().hex
           + upl.upload_ext(payload.get("filename")))
    ct = upl.upload_content_type(payload.get("content_type"))
    upload_id = _storage_call("CreateMultipartUpload", storage.mpu_create,
                              key, ct)
    exp = int(time.time() + upl.TICKET_TTL_S)
    ticket = upl.make_ticket(_ticket_secret(), {
        "u": _uid(user), "k": key, "id": upload_id, "s": size, "ps": ps,
        "n": n, "ct": ct, "exp": exp})
    claims = {"k": key, "id": upload_id, "s": size, "ps": ps, "n": n,
              "exp": exp}
    return {"ticket": ticket, "storage_key": key, "part_size": ps,
            "parts_total": n, "expires_at": exp,
            "parts": _sign_parts(claims, list(range(1, min(n, 8) + 1)))}


@app.post("/uploads/multipart/sign")
def multipart_sign(payload: dict, user: User | None = Depends(current_user)):
    """{ticket, part_numbers: [≤ 64]} → {parts: [{part_number, url}]},
    each URL signed for exactly that part's length, valid ≤ 6 h (the
    client signs again when a PUT answers 403). 409 use_single_put
    unless CLEO_UPLOAD_MODE=multipart."""
    _require_multipart()
    t = _read_ticket(payload, user)
    numbers = payload.get("part_numbers")
    if (not isinstance(numbers, list) or not 1 <= len(numbers) <= 64
            or not all(isinstance(x, int) and not isinstance(x, bool)
                       and 1 <= x <= t["n"] for x in numbers)):
        raise ApiRefusal(400, "bad_part_numbers", parts_total=t["n"])
    return {"parts": _sign_parts(t, list(dict.fromkeys(numbers)))}


def _uploaded_parts(t: dict) -> list[dict] | None:
    """ListParts (all pages); None when the upload isn't open any more."""
    from backend import storage
    try:
        return _storage_call("ListParts", storage.mpu_list_parts,
                             t["k"], t["id"])
    except ApiRefusal:
        raise
    except Exception:  # NoSuchUpload: completed or aborted
        return None


def _completed_size(t: dict) -> int | None:
    from backend import storage
    return _storage_call("HeadObject", storage.head, t["k"])


@app.post("/uploads/multipart/parts")
def multipart_parts(payload: dict, user: User | None = Depends(current_user)):
    """{ticket} → {parts: [{part_number, size}]}: what R2 has. A resume
    trusts this list, not its own. Already completed → every part
    ("completed": true); gone → 410 upload_expired. 409 use_single_put
    unless CLEO_UPLOAD_MODE=multipart."""
    _require_multipart()
    t = _read_ticket(payload, user)
    parts = _uploaded_parts(t)
    if parts is None:
        if _completed_size(t) == t["s"]:
            return {"completed": True, "parts": [
                {"part_number": n,
                 "size": upl.part_length(t["s"], t["ps"], t["n"], n)}
                for n in range(1, t["n"] + 1)]}
        raise ApiRefusal(410, "upload_expired")
    return {"parts": [{"part_number": p["part_number"], "size": p["size"]}
                      for p in parts]}


@app.post("/uploads/multipart/complete")
def multipart_complete(payload: dict,
                       user: User | None = Depends(current_user)):
    """{ticket} → {storage_key, size}. Completes with the parts R2 lists
    (the client sends no ETags): parts 1..n, each exactly its size, else
    409 parts_missing + `missing` (≤ 100). The object must then have
    the announced size and fit the cap, else it is deleted → 413.
    Idempotent: an upload that is already complete answers the same."""
    from backend import storage
    t = _read_ticket(payload, user)
    done = {"storage_key": t["k"], "size": t["s"]}
    parts = _uploaded_parts(t)
    if parts is None:
        if _completed_size(t) == t["s"]:
            return done
        raise ApiRefusal(410, "upload_expired")
    by_number = {p["part_number"]: p for p in parts}
    missing = [n for n in range(1, t["n"] + 1)
               if by_number.get(n, {}).get("size")
               != upl.part_length(t["s"], t["ps"], t["n"], n)]
    if missing:
        raise ApiRefusal(409, "parts_missing", missing=missing[:100])
    try:
        _storage_call("CompleteMultipartUpload", storage.mpu_complete,
                      t["k"], t["id"],
                      [by_number[n] for n in range(1, t["n"] + 1)])
    except ApiRefusal:
        raise
    except Exception:  # NoSuchUpload: a parallel complete won
        if _completed_size(t) == t["s"]:
            return done
        raise ApiRefusal(410, "upload_expired")
    got = _completed_size(t)
    if got != t["s"] or _too_big(got):
        _storage_call("DeleteObject", storage.delete, t["k"])
        raise _file_too_large()
    return done


@app.post("/uploads/multipart/abort", status_code=204)
def multipart_abort(payload: dict, user: User | None = Depends(current_user)):
    """{ticket} → 204. Idempotent (an upload that is gone is fine)."""
    from backend import storage
    t = _read_ticket(payload, user)
    try:
        _storage_call("AbortMultipartUpload", storage.mpu_abort,
                      t["k"], t["id"])
    except ApiRefusal:
        raise
    except Exception:  # NoSuchUpload
        pass
    return Response(status_code=204)


_TELEMETRY = upl.RateLimit(30, 60.0)
_TELEMETRY_FIELDS = ("event", "part", "attempt", "elapsed_ms", "loaded",
                     "status", "kind", "ua")


@app.post("/uploads/telemetry", status_code=204)
async def upload_telemetry(request: Request,
                           user: User | None = Depends(current_user)):
    """{ticket?, event, part?, attempt?, elapsed_ms?, loaded?, ua?} → 204:
    one "[upload] …" log line per call (the user id, never the ticket) —
    retries and failures of browser uploads, which can't be diagnosed
    otherwise (iOS). Body ≤ 2 KB, ≤ 30 per minute per user."""
    raw = await request.body()
    if len(raw) > 2048:
        raise ApiRefusal(413, "request_too_large")
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise ApiRefusal(400, "invalid_json")
    if not isinstance(body, dict) or not isinstance(body.get("event"), str):
        raise ApiRefusal(400, "event_required")
    who = _uid(user) or (request.client.host if request.client else "-")
    if not _TELEMETRY.allow(who):
        raise ApiRefusal(429, "too_many_requests")
    fields = []
    for k in _TELEMETRY_FIELDS:
        v = body.get(k)
        if isinstance(v, bool) or not isinstance(v, (str, int, float)):
            continue
        text = str(v).replace("\n", " ").replace("\r", " ")[:200]
        fields.append(f"{k}={text!r}" if k == "ua" else f"{k}={text}")
    key = ""
    if body.get("ticket"):
        try:
            key = upl.read_ticket(_ticket_secret(), body["ticket"], _uid(user),
                                  now=0)["k"].rsplit("/", 1)[-1]
        except upl.TicketError:
            key = "?"
    print(f"[upload] user={_uid(user) or '-'} "
          + (f"obj={key} " if key else "") + " ".join(fields), flush=True)
    return Response(status_code=204)


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
    _paywall_soft_check(user, duration)
    size = _to_float(payload.get("size") or 0)
    if _too_big(size):
        raise _file_too_large()
    if _too_long(duration):
        raise _video_too_long()
    _INFLIGHT.check(user)
    if size > 0:
        _INFLIGHT.reserve_disk(None, size)
    if not r2_available():
        raise _no_direct_upload()
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
    duration: str = Form(None),
    user: User | None = Depends(current_user),
):
    """Upload + start analyze. Two paths:

    1) Small files (< ~100MB): multipart 'file' upload directly through
       Railway. Legacy path — works for everything that fits under the
       edge-router body limit.

    2) Everything else: the client uploads straight to R2
       (/uploads/multipart/*, or the single PUT of /uploads/presign),
       then calls this endpoint with `storage_key`. It answers in about a
       second whatever the size: HEAD, a header-only duration probe over
       a presigned URL (the client's `duration` form field when the
       header has none), the charge — the analysis worker downloads the
       file (409 upload_incomplete when the object isn't there).
       Idempotent on the key: repeating the call (the client gave up
       waiting, the answer got lost) returns the job the first call
       created — 200, same body — instead of a second job and charge.

    `filename`, `preset_id`, `preset_label` are stored for the Library.
    With billing on, the upload's length is probed and charged against
    the caller's minutes here, once (402 subscription_required /
    quota_exceeded when enforced; 400 unreadable_video for a body upload
    without a readable length). An R2 upload whose length neither its
    header nor the client knows (streamed WebM) is accepted; the
    analysis worker measures its copy first and refuses it there
    (error video_too_long / quota_exceeded / unreadable_video, the
    upload deleted, nothing charged) or charges it then. Every analysis
    stops at CLEO_MAX_MINUTES (settings._max_seconds).

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
    client_duration = _to_float(duration or 0) or None

    # Only keys we handed this caller out (presign) — any other key
    # would be downloaded AND deleted after analysis.
    if (not storage_key.startswith(auth.upload_prefix(user))
            or ".." in storage_key):
        raise HTTPException(403, "storage_key not yours")
    while (busy := _CREATING_KEYS.get(storage_key)) is not None:
        await busy.wait()
    claim = _CREATING_KEYS[storage_key] = asyncio.Event()
    try:
        # A request in another process may still be accepting it.
        existing = await _settled(
            await run_in_threadpool(store.find_by_key, storage_key))
        if existing is not None:
            if (user is not None and not user.is_service
                    and existing.owner_id not in (None, user.id)):
                raise HTTPException(403, "storage_key not yours")
            return {"job_id": existing.id, **existing.to_dict()}
        return await _accept_upload(parsed, None, storage_key, filename,
                                    preset_id, preset_label, user,
                                    client_duration)
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


async def _claim_upload(
    parsed: dict,
    file: UploadFile | None,
    input_path: str,
    storage_key: str | None,
    filename: str | None,
    preset_id: str | None,
    preset_label: str | None,
    user: User | None,
    job_id: str | None = None,
    source_key: str | None = None,
    media_store: str | None = None,
) -> Job | dict:
    """Insert this upload's job row as a claim (see _settled). Returns the
    claimed Job — or, when another request holds the storage key, that
    request's answer once it settled: its job (200, like a retry). If
    that request dropped its claim (refused), claim the key again."""
    job_id = job_id or new_job_id()
    for _ in range(5):
        try:
            return await run_in_threadpool(functools.partial(
                store.create,
                input_path=input_path,
                settings={**parsed, "_accepting": True},
                job_id=job_id,
                idempotency_key=storage_key,
                source_key=source_key,
                media_store=media_store,
                owner_id=user.id if user else None,
                plan=DEFAULT_PLAN,
                filename=_short(filename or (file.filename if file else None),
                                255),
                preset_id=_short(preset_id, 100),
                preset_label=_short(preset_label, 200),
            ))
        except DuplicateKey as dup:
            # Another request (another process: the in-process
            # _CREATING_KEYS guard can't see it) holds this upload.
            other = (await run_in_threadpool(store.get, dup.job_id)
                     if dup.job_id else None)
            other = await _settled(other)
            if other is None:
                continue  # it was refused and let go of the key
            if (user is not None and not user.is_service
                    and other.owner_id not in (None, user.id)):
                raise HTTPException(409, "upload_already_used")
            return {"job_id": other.id, **other.to_dict()}
    raise HTTPException(409, "upload_already_used")


async def _accept_upload(
    parsed: dict,
    file: UploadFile | None,
    storage_key: str | None,
    filename: str | None,
    preset_id: str | None,
    preset_label: str | None,
    user: User | None,
    client_duration: float | None = None,
) -> dict:
    """POST /jobs after the settings / key checks: admission, caps,
    duration, charge, job row, analysis thread.

    storage_key (the browser uploaded to R2): nothing is downloaded here
    — HEAD for the size, the length from the container header over a
    presigned URL (ffprobe, no packet scan), or the client's `duration`
    when the header has none; the analysis worker fetches the object.
    Legacy body (`file`, ≤ 100 MB): probed locally; with media in R2 it
    is stored as jobs/{id}/source{ext} and nothing stays here, otherwise
    it stays in the work root (input_path) for the worker."""
    bills = _bills(user)
    enforce = bills and billing.enforce()
    if enforce and await run_in_threadpool(
            accounts.entitlement, user.id, user.email) is None:
        await run_in_threadpool(_discard_upload, None, storage_key)
        raise _quota_error("subscription_required")

    # 429 / 503 before anything moves; the upload is kept for a retry.
    token = _INFLIGHT.admit(user)
    input_path: str | None = None
    # Our own copy of a legacy body in the media store: dropped on any
    # refusal or failure (nobody can retry with it).
    own_key: str | None = None
    job_id = new_job_id()
    job = None
    try:
        if storage_key:
            try:
                size = await run_in_threadpool(media.size, storage_key)
            except Exception as e:
                print(f"[jobs] HEAD {storage_key} failed: {e}", flush=True)
                raise ApiRefusal(503, "storage_unavailable",
                                 headers={"Retry-After": "10"})
            if size is None:
                raise ApiRefusal(409, "upload_incomplete")
            if _too_big(size):
                await run_in_threadpool(_discard_upload, None, storage_key)
                raise _file_too_large()
            # The analysis downloads + normalizes it in its workspace.
            await run_in_threadpool(_INFLIGHT.reserve_disk, token, size, None)
            seconds = await _probe_upload(storage_key)
            if seconds is None and client_duration:
                seconds = client_duration
        else:
            size = _upload_size(file)
            if _too_big(size):
                raise _file_too_large()
            r2_media = media.is_r2()
            job_input_dir = (_TMP_ROOT if r2_media else _WORK_ROOT) / "uploads"
            job_input_dir.mkdir(parents=True, exist_ok=True)
            suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
            with tempfile.NamedTemporaryFile(
                delete=False, suffix=suffix, dir=str(job_input_dir)
            ) as f:
                input_path = f.name
            # Refuse early instead of failing halfway through
            # normalization when the disk is (nearly) full.
            await run_in_threadpool(_INFLIGHT.reserve_disk, token, size or 0,
                                    input_path)
            await run_in_threadpool(_copy_upload, file, input_path)
            seconds = await run_in_threadpool(_probe_duration, input_path)

        if _too_long(seconds):
            await run_in_threadpool(_discard_upload, input_path, storage_key)
            input_path = None
            raise _video_too_long()

        plan = DEFAULT_PLAN
        # Charged in the analysis worker instead of here (see
        # _length_gate): "enforce" / "record" (billing not enforced).
        deferred: str | None = None
        if seconds is None and storage_key:
            # Neither the container header (streamed / fragmented WebM)
            # nor the browser knows the length. Accepted: the worker
            # measures its local copy (packet scan) before anything is
            # transcribed, refuses it there when it is too long (or,
            # billed, over the minutes left) and charges then.
            parsed["_measure_length"] = True
            if bills:
                deferred = "enforce" if enforce else "record"
                parsed["_charge"] = deferred
        elif bills and seconds is None:
            # A body upload was packet-scanned already: really unreadable.
            if enforce:
                await run_in_threadpool(_discard_upload, input_path,
                                        storage_key)
                input_path = None
                raise HTTPException(400, "unreadable_video")
            seconds = 0.0  # not enforced: the true-up after analysis fixes it

        source_key = storage_key
        # The job's store is recorded with its first own key (here, or
        # the analysis' mezz; media.store_of until then).
        media_store: str | None = None
        if not storage_key and media.is_r2():
            # The body goes to the media store; nothing stays on this box.
            own_key = (media.job_prefix(job_id) + "source"
                       + upl.upload_ext(file.filename or filename))
            try:
                await run_in_threadpool(functools.partial(
                    media.put_file, input_path, own_key, store="r2",
                    content_type=upl.upload_content_type(file.content_type)))
            except Exception as e:
                print(f"[jobs] storing the upload failed: {e}", flush=True)
                raise ApiRefusal(503, "storage_unavailable",
                                 headers={"Retry-After": "10"})
            await run_in_threadpool(_remove_upload, input_path)
            input_path = None
            source_key = own_key
            media_store = "r2"

        # Claim first, charge second (see _settled / _abandon_claim): a
        # parallel request for this upload in another process waits for
        # this one instead of charging — or being refused — on its own.
        claimed = await _claim_upload(parsed, file, input_path, storage_key,
                                      filename, preset_id, preset_label,
                                      user, job_id=job_id,
                                      source_key=source_key,
                                      media_store=media_store)
        if isinstance(claimed, dict):  # another request's job: a retry
            await run_in_threadpool(_remove_upload, input_path)
            input_path = None
            return claimed
        charged = False
        try:
            if bills and deferred is None:
                # Quota check + ledger insert are atomic inside charge()
                # (one transaction under the user's lock — across
                # processes with Postgres), so two uploads of one user
                # can't both spend the last minutes.
                try:
                    ent = await run_in_threadpool(functools.partial(
                        accounts.charge, job_id, user.id, seconds,
                        email=user.email, enforce=enforce))
                except accounts.SubscriptionRequired:
                    raise _quota_error("subscription_required")
                except accounts.QuotaExceeded as e:
                    raise _quota_error(
                        "quota_exceeded",
                        remaining_seconds=round(e.remaining_seconds),
                        needed_seconds=round(e.needed_seconds))
                charged = True
                if ent is not None:
                    plan = ent.plan  # fixed per job: a downgrade never shortens retention
                if enforce:
                    # The charge trusts the container's duration header
                    # (or the client's reading), which the uploader
                    # controls: analyse no more than was charged (+ the
                    # true-up tolerance), or a file claiming 1 s would be
                    # transcribed in full, however long it really is.
                    parsed["_max_seconds"] = (math.ceil(max(seconds, 0.0))
                                              + accounts.TRUE_UP_TOLERANCE_S)
            # Never more than CLEO_MAX_MINUTES, billed or not: the length
            # this was accepted with may be the uploader's claim.
            _cap_settings(parsed)
            # Accepted: the claim becomes the job.
            if not await run_in_threadpool(functools.partial(
                    store.update_if, job_id, "pending", settings=parsed,
                    plan=plan)):
                raise RuntimeError(f"job {job_id} vanished while its upload "
                                   "was being accepted")
        except HTTPException:
            # Refused (402): retrying can't help — the upload goes too.
            await run_in_threadpool(_abandon_claim, job_id, input_path,
                                    source_key, None)
            input_path = own_key = None
            raise
        except BaseException:
            # Failed: minutes back; the client's R2 object stays for a
            # retry (our own copy of a body doesn't).
            await run_in_threadpool(_abandon_claim, job_id, input_path,
                                    own_key, "create_failed" if charged else None)
            input_path = own_key = None
            raise
        claimed.settings, claimed.plan = parsed, plan
        job = claimed
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
        if job is None:
            # Refused or failed before the job existed: nothing will
            # ever read the local copy or our copy of the body (the
            # client's R2 object stays unless discarded above — the
            # client may retry with its key).
            if input_path is not None:
                _remove_upload(input_path)
            if own_key is not None:
                _gc_later([own_key], store_="r2")
        raise
    finally:
        _INFLIGHT.release(token)


# The duration probe (ffprobe over a presigned URL, header only) runs in
# a pool of its own, never in the default threadpool: a slow storage
# answer can't starve the API's other requests.
_PROBE_POOL = ThreadPoolExecutor(
    max_workers=max(1, _env_int("CLEO_PROBE_WORKERS", 4)),
    thread_name_prefix="probe")


def _probe_remote_duration(url: str) -> float | None:
    """format=duration of a remote file from its container header: a few
    ranged GETs (moov at the end of an MP4 included), no packet scan —
    that would read the whole object. None if it doesn't say (streamed
    WebM) or can't be read within 20 s."""
    from src.ffmpeg_utils import get_ffprobe_path
    try:
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-rw_timeout", "15000000",
             "-show_entries", "format=duration", "-of",
             "default=nw=1:nk=1", url],
            capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    dur = _to_float(r.stdout.strip()) if r.returncode == 0 else 0.0
    return dur if dur > 0 else None


async def _probe_upload(key: str) -> float | None:
    try:
        url = media.presign_get(key)
    except Exception as e:
        print(f"[jobs] presign for the probe of {key} failed: {e}", flush=True)
        return None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_PROBE_POOL, _probe_remote_duration, url)


# Fields of GET /jobs rows (the Library's server-side list).
_LIST_FIELDS = (
    "id", "status", "message", "progress", "error", "filename", "preset_id",
    "preset_label", "created_at", "updated_at", "expires_at", "has_output",
    "outputs", "hook_clips", "social_caption", "social_hashtags", "duration",
    "queue_position",
)


# GET /jobs reads the caller's projects in keyset pages of this many
# (index-backed on Postgres, each query bounded).
_LIST_LIMIT = 200


def _owner_jobs(owner_id: str) -> list[Job]:
    """All jobs of one account (list fields only), page by page — or in
    one call where every page would scan the whole table (SQLite)."""
    if not store.PAGES_BY_INDEX:
        return store.list_by_owner(owner_id)
    rows: list[Job] = []
    before: tuple[float, str] | None = None
    while True:
        page = store.list_by_owner(owner_id, limit=_LIST_LIMIT,
                                   before=before, summary=True)
        rows.extend(page)
        if len(page) < _LIST_LIMIT:
            return rows
        before = (page[-1].created_at, page[-1].id)


@app.get("/jobs")
def list_jobs(user: User = Depends(require_user)):
    """The caller's projects, newest first — all of them: the Library
    shows this list as the projects of every device (404 not_available
    while accounts are off — the frontend keeps its localStorage list
    then). Beta jobs show up once claimed, i.e. after any /jobs/{id}
    request."""
    rows = (store.list_all() if user.is_service else
            _owner_jobs(user.id))
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
        keys = row.get("output_keys")
        if isinstance(keys, str):  # nested JSON text (Postgres)
            try:
                keys = json.loads(keys)
            except ValueError:
                keys = None
        has_output = (bool(keys.get("primary")) if isinstance(keys, dict)
                      and keys else bool(out) and Path(out).exists())
        jobs.append({
            "id": job_id,
            "status": row["status"],
            "message": row["message"],
            "progress": row["progress"],
            "queue_position": row["queue_position"],
            "error": row["error"],
            "has_output": has_output,
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
        observability.capture(e, phase="billing_webhook")
        raise HTTPException(500, "webhook processing failed")
    print(f"[billing] webhook {event}: {result}", flush=True)
    return {"ok": True, **result}


@app.get("/admin/costs")
def admin_costs(x_admin_token: str = Header(default=""),
                exclude_tests: bool = False):
    """What processing costs us — per job and per video minute.

    Protected by CLEO_ADMIN_TOKEN (send it as X-Admin-Token); disabled
    (404) while that env var is unset. Storage is estimated for keeping
    each job's files for its plan's full retention period: the stored
    objects from job.media_bytes (R2 price when the media are in R2),
    plus legacy local files. Egress: R2 serves for free; the API's
    uploads of the analysis results (mezz / proxy / previews) and legacy
    local files served from here are Railway egress.
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
        r2 = media.store_of(job) == "r2"
        stored = {k: int(v) for k, v in (job.media_bytes or {}).items()}
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
        prefix = f"jobs/{job.id}/"
        for key, n in stored.items():
            files[key.removeprefix(prefix)] = n
        stored_bytes = sum(stored.values())
        c["usd_storage"] = (
            costs.storage_usd(size, retention_days(job.plan))
            + costs.storage_usd(stored_bytes, retention_days(job.plan),
                                rate="r2_gb_month" if r2
                                else "railway_volume_gb_month"))
        size += stored_bytes
        # Everything in the legacy job folder is sent to the browser at
        # least once (source + preview in the editor, the final
        # downloads); stored objects: the API uploaded the analysis
        # results (renders are Modal's), R2 serves them for free.
        uploaded = sum(n for k, n in stored.items()
                       if not k.removeprefix(prefix).startswith("r"))
        c["usd_egress_est"] = costs.egress_usd(
            served + (uploaded if r2 else stored_bytes))
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


# ── Media routes ─────────────────────────────────────────────────────
# media_user (header, or the ?t= day token) → get_owned_job (404 for
# other people's jobs) → the object: with media in R2 a 307 to a
# presigned GET (same URL all UTC day, valid ≥ 24 h; Range works there;
# no media bytes pass through the API), with local media a FileResponse.
# Jobs from before the media keys are still served from their local
# files.


def _media(job: Job, key: str, media_type: str, not_ready: str,
           download_name: str | None = None,
           cache: str | None = None):
    """`key` of `job`, from the job's store (media.store_of)."""
    where = media.store_of(job)
    if where == "r2" and not storage.r2_available():
        # The job's media is in R2 but R2_* are missing / incomplete:
        # never answer from the local disk instead.
        print(f"[media] job {job.id} has its media in R2, but R2 is not "
              "configured (R2_* env vars)", flush=True)
        raise ApiRefusal(503, "storage_unavailable",
                         headers={"Retry-After": "60"})
    try:
        return media.media_response(key, media_type=media_type,
                                    download_name=download_name, cache=cache,
                                    store=where)
    except FileNotFoundError:
        raise HTTPException(409, not_ready)


def _proxy_video_enabled() -> bool:
    return os.environ.get("CLEO_PROXY_VIDEO", "").strip() == "1"


@app.get("/jobs/{job_id}/proxy-video")
def proxy_video(job_id: str, user: User | None = Depends(media_user)):
    """The editor proxy: the whole normalized source at ≤ 720p (seconds =
    source seconds), which the editor plays and cuts client-side. 404
    proxy_not_ready without one (the editor then plays preview-video),
    and always unless CLEO_PROXY_VIDEO=1 (opt-in: client-side playback
    from the proxy isn't switched on by the merge)."""
    job = get_owned_job(job_id, user)
    if not _proxy_video_enabled():
        raise HTTPException(404, "proxy_not_ready")
    if job.proxy_key:
        return _media(job, job.proxy_key, "video/mp4", "proxy_not_ready",
                      cache="private, max-age=86400")
    if job.normalized_path:
        legacy = Path(job.normalized_path).with_name(pipeline.PROXY_NAME)
        if legacy.is_file():
            return FileResponse(path=str(legacy), media_type="video/mp4",
                                headers={"Accept-Ranges": "bytes",
                                         "Cache-Control":
                                         "private, max-age=86400"})
    raise HTTPException(404, "proxy_not_ready")


@app.get("/jobs/{job_id}/preview-video")
def preview_video(job_id: str, user: User | None = Depends(media_user)):
    """The current cut preview (segments concatenated, no captions) —
    preview/v{n}.mp4; `?v=` is only the client's cache-buster. Range
    works (FileResponse, or R2 behind the 307)."""
    job = get_owned_job(job_id, user)
    if job.preview_key:
        # A new version gets a new key; the local file is still answered
        # with no-cache, as before (the URL may be asked without ?v=).
        return _media(job, job.preview_key, "video/mp4", "preview video not ready",
                      cache="no-cache")
    # Legacy job: prefer the cut preview, fall back to the normalized file.
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
# already arrived (it will rebuild instead). Both are process memory
# (one worker, DEPLOY.md 8.1): across processes the save ORDER isn't
# kept — but every read-modify-write of the job itself (merged
# settings, preview_version + 1, the phrases revision check) runs in
# store.modify, under the row lock, so no process loses another's write.
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


def _preview_source(normalized_path: str | None) -> str | None:
    """What previews are cut from: the 720p proxy when the pipeline made
    one (backend.pipeline.preview_source), else the normalized source.
    None for a job with media keys: _rebuild_preview then takes it from
    the proxy cache (_cached_proxy), in the rebuild pool."""
    if not normalized_path:
        return None
    fn = getattr(pipeline, "preview_source", None)
    if fn is not None:
        try:
            src = fn(normalized_path)
            if src:
                return str(src)
        except Exception as e:
            print(f"[preview] preview_source failed: {e}", flush=True)
    return normalized_path


def _job_preview_source(job: Job) -> str | None:
    """A local file previews of `job` are cut from, or None:
    _rebuild_preview gets the source itself (in the pool, from the
    proxy cache). While the job has no proxy_key, a legacy job's local
    720p proxy (or normalized file) is still preferred — also after the
    lazy mezz backfill of its first render, which would otherwise make
    every rebuild download the full-resolution mezz."""
    if job.proxy_key or not job.normalized_path:
        return None
    local = Path(job.normalized_path)
    if job.mezz_key:
        proxy = local.with_name(pipeline.PROXY_NAME)
        if proxy.is_file():
            return str(proxy)
        return str(local) if local.is_file() else None
    return _preview_source(job.normalized_path)


async def _rebuild_in_pool(job_id: str, source: str | None, segments,
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


# ── Editor preview rebuilds (§9 of WP3: only while /edit-segments still
# rebuilds server-side; WP5's editor plays the proxy instead) ────────
# The source comes from a local LRU cache of proxies
# (CLEO_TMP_ROOT/proxy-cache/{id}.mp4, filled from proxy_key, else
# mezz_key, on a miss; CLEO_PROXY_CACHE_GB, default 5); the preview is
# encoded in the job's workspace and stored as preview/v{n+1}.mp4; one
# write then points the job at it; the old version is deleted a day
# later (media_gc).

_PROXY_CACHE_LOCKS: dict[str, threading.Lock] = {}
_PROXY_CACHE_GUARD = threading.Lock()


def _proxy_cache_dir() -> Path:
    return _TMP_ROOT / "proxy-cache"


def _proxy_cache_lock(job_id: str) -> threading.Lock:
    with _PROXY_CACHE_GUARD:
        return _PROXY_CACHE_LOCKS.setdefault(job_id, threading.Lock())


def _proxy_cache_drop(job_id: str) -> None:
    (_proxy_cache_dir() / f"{job_id}.mp4").unlink(missing_ok=True)
    with _PROXY_CACHE_GUARD:
        _PROXY_CACHE_LOCKS.pop(job_id, None)


def _proxy_cache_trim(keep: Path) -> None:
    """Oldest (mtime) first until the cache fits CLEO_PROXY_CACHE_GB."""
    limit = _env_float("CLEO_PROXY_CACHE_GB", 5) * 1e9
    try:
        entries = sorted(((p.stat().st_mtime, p.stat().st_size, p)
                          for p in _proxy_cache_dir().glob("*.mp4")),
                         key=lambda e: e[0])
    except OSError:
        return
    total = sum(size for _, size, _ in entries)
    for _, size, path in entries:
        if total <= limit:
            break
        if path == keep:
            continue
        path.unlink(missing_ok=True)
        total -= size


def _cached_proxy(job: Job) -> str:
    """Local copy of the job's preview source (proxy, else mezz), from
    the cache or fetched into it. Raises when neither is stored."""
    key = job.proxy_key or job.mezz_key
    if not key:
        raise FileNotFoundError(f"job {job.id} has no stored source")
    path = _proxy_cache_dir() / f"{job.id}.mp4"
    with _proxy_cache_lock(job.id):
        if path.is_file():
            os.utime(path)  # LRU by mtime
            return str(path)
        tmp = path.with_suffix(f".{uuid.uuid4().hex[:8]}.part")
        try:
            media.get_file(key, tmp, store=media.store_of(job))
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    _proxy_cache_trim(keep=path)
    return str(path)


def _rebuild_preview(job_id: str, source: str | None, segments) -> None:
    """Render the cut preview from `source` (a local file: the proxy or
    the normalized video of a legacy job; None: the job's stored proxy,
    via the cache) in the job's workspace, store it as
    preview/v{n+1}.mp4 and point the job at it (with the segments it
    shows). Raises on failure; the old preview stays in that case."""
    from backend.pipeline import _ffmpeg_cuts_preview
    job = store.get(job_id)
    if job is None:
        raise FileNotFoundError(f"job {job_id} is gone")
    if source is None:
        source = _cached_proxy(job)
    ws = _make_workspace(_workspace(job_id,
                                    f"preview-{threading.get_ident()}"))
    try:
        out = ws / "preview.mp4"
        _ffmpeg_cuts_preview(source, segments, str(out))
        version = (job.preview_version or 0) + 1
        key = f"{media.job_prefix(job_id)}preview/v{version}.mp4"
        where = media.store_of(job)
        size = media.put_file(out, key, content_type="video/mp4",
                              store=where)
    finally:
        _drop_workspace(ws)
    shown = [[float(s), float(e)] for s, e in segments]
    old: list[str] = []

    def _point(cur: Job) -> dict | None:
        old.clear()
        if cur.media_store and cur.media_store != where:
            return None   # moved to another store meanwhile (backfill)
        if cur.preview_key and cur.preview_key != key:
            old.append(cur.preview_key)
        sizes = {k: v for k, v in (cur.media_bytes or {}).items()
                 if k not in old}
        sizes[key] = size
        # preview_version + 1 on the stored value, under the row lock.
        return {"preview_key": key, "preview_segments": shown,
                "preview_version": (cur.preview_version or 0) + 1,
                "media_store": cur.media_store or where,
                "media_bytes": sizes}
    if store.modify(job_id, _point) is None:
        raise RuntimeError(f"job {job_id} is gone or its media moved "
                           "meanwhile — preview not stored")
    # A player may still stream the previous version for a while.
    _gc_later(old, _SUPERSEDED_KEEP_S, store_=where)


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
    if not job.has_mezz():
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

    def _save(cur: Job) -> dict:
        # On the stored job, under its row lock: settings merged into
        # what is there now, not into what we read above.
        new_settings = dict(cur.settings or {})
        new_settings["segment_effects"] = effects
        out = {"segments": [list(seg) for seg in cleaned],
               "settings": new_settings}
        if not cur.preview_segments:
            # Job from before preview_segments existed: its preview.mp4
            # was built from the segments we are about to replace.
            out["preview_segments"] = [[float(a), float(b)]
                                       for a, b in cur.segments]
        return out

    # Store under the guard so the request with the highest sequence
    # number is also the one whose segments end up in the store.
    with _EDIT_GUARD:
        seq = _EDIT_SEQ.get(job_id, 0) + 1
        _EDIT_SEQ[job_id] = seq
        store.modify(job_id, _save)
    return seq, _job_preview_source(job), cleaned


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
    # Check and write in one store.modify (row lock), so an older save
    # can't overwrite a newer one, whichever process handles either.
    try:
        rev = float(payload.get("rev") or 0)
    except (TypeError, ValueError):
        rev = 0.0
    stale = False

    def _save(cur: Job) -> dict | None:
        nonlocal stale
        if rev and rev < (cur.edited_phrases_rev or 0):
            stale = True
            return None
        return {"edited_phrases": cleaned, "edited_phrases_rev": rev}
    store.modify(job_id, _save)
    if stale:
        return {"ok": True, "count": len(cleaned), "stale": True}
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
    if not job.has_mezz():
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

    scene_events = [
        {"type": t, "start": s, "end": end, "source": "user"}
        for (t, s, end, _i) in clean
    ]

    def _save(cur: Job) -> dict:
        # On the stored job, under its row lock (store.modify): the new
        # scene cuts go next to the cut_ranges stored now, and settings
        # are merged into the stored ones.
        old_cut_ranges = list(cur.cut_ranges or [])
        next_id = (max((c.get("id", 0) for c in old_cut_ranges),
                       default=-1)) + 1
        new_cut_range_dicts = []
        for (rs, re_) in cut_ranges_scene:
            new_cut_range_dicts.append({
                "id": next_id, "start": float(rs), "end": float(re_),
                "source": "user_edit",
            })
            next_id += 1
        out = {"segments": new_segments,
               "cut_ranges": old_cut_ranges + new_cut_range_dicts,
               "scene_events": scene_events}
        # Segment count may have changed, so per-segment effects no
        # longer line up with it — reset them rather than apply them to
        # wrong clips.
        if len(new_segments) != len(cur.segments):
            settings = dict(cur.settings or {})
            settings.pop("segment_effects", None)
            out["settings"] = settings
        return out
    store.modify(job_id, _save)
    return _job_preview_source(job), new_segments


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
    # only one request gets to start the render. The same write takes
    # the render's generation (its outputs go under jobs/{id}/r{gen}/).
    def _start(cur: Job) -> dict | None:
        if cur.status != "awaiting_review":
            return None
        return dict(status="processing", message="Rendering…", progress=1.0,
                    error=None, queue_position=None,
                    render_gen=int(cur.render_gen or 0) + 1)
    if not store.modify(job_id, _start):
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
    """A rendered format as an attachment (cleo_{id}_{format}.mp4)."""
    job = get_owned_job(job_id, user)
    safe = "".join(c if c.isalnum() or c in "_-" else "-"
                   for c in format.replace(":", "-"))
    if job.output_keys:
        key = job.output_keys.get(format)
        if not key:
            raise HTTPException(409, "requested format not ready")
        return _media(job, key, "video/mp4", "requested format not ready",
                      download_name=f"cleo_{job_id}_{safe}.mp4")
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
    if job.output_keys:
        key = job.output_keys.get(format)
        if not key:
            raise HTTPException(409, "requested format not ready")
        return _media(job, key, "video/mp4", "requested format not ready")
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
    # Behind a per-user token once accounts are on: no shared caches.
    cache = ("private" if auth.auth_enabled() else "public") + ", max-age=86400"
    if job.thumb_key:
        return _media(job, job.thumb_key, "image/jpeg", "thumbnail not ready",
                      cache=cache)
    if job.output_keys:
        raise HTTPException(404, "thumbnail not ready")
    if not job.output_path:
        raise HTTPException(409, "thumbnail not ready")
    thumb = Path(job.output_path).parent / "cleo_thumbnail.jpg"
    if not thumb.exists():
        raise HTTPException(404, "thumbnail not ready")
    return FileResponse(
        path=str(thumb),
        media_type="image/jpeg",
        headers={"Cache-Control": cache},
    )
