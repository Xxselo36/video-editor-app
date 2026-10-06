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
import copy  # noqa: E402
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

from contextlib import asynccontextmanager, contextmanager
import time

from fastapi import (
    Body, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

import backend.pipeline as pipeline
from backend import accounts, auth, billing, costs, db, media, observability
from backend import doc as edit_doc  # noqa: E402
from backend import captions_v2  # noqa: E402
from backend import font_subset  # noqa: E402
from backend import errors  # noqa: E402
from backend import exports  # noqa: E402
from backend import storage
from backend import taskq  # noqa: E402
from backend import leader as task_leader  # noqa: E402
from backend import uploads as upl
from backend import prefs as user_prefs  # noqa: E402
from backend import span_transcribe as span_tx  # noqa: E402
from backend.whisper_groq import SPOKEN_LANGUAGES  # noqa: E402
from backend import worker as task_worker  # noqa: E402
from backend.auth import (
    User, current_user, get_owned_job, media_user, require_user,
)
from backend.jobs import (
    DEFAULT_PLAN, EVENTS_KEEP_DAYS, PLAN_RETENTION_DAYS, RUNNING_STATUSES,
    DuplicateKey, Job, expiry_time, new_job_id, retention_days, store,
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
    # CLEO_MAX_MINUTES <= 0: no cap (like _analysis_cap_s and GET /config).
    return (seconds is not None and _max_minutes() > 0
            and seconds > _max_minutes() * 60 + 1)


def _min_seconds() -> float:
    """The shortest upload that is analysed (CLEO_MIN_SECONDS, default 3;
    0 turns the check off)."""
    return _env_float("CLEO_MIN_SECONDS", 3)


def _too_short(seconds: float | None) -> bool:
    # 0.1 s of slack for how containers round their length. Unknown
    # (None) passes: the analysis finds out.
    return (seconds is not None and _min_seconds() > 0
            and seconds < _min_seconds() - 0.1)


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

    def waiting_count(self) -> int:
        """How many wait for a slot now (beyond the free ones)."""
        with self._cond:
            self._prune()
            free = max(0, self.limit() - len(self._running))
            return max(0, len(self._waiting) - free)

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


# What the analysis of an R2 upload writes into its workspace
# (_run_analyze_inner + pipeline.analyze_only): the downloaded source
# (S); normalized.mp4, the mezz (M: libx264 crf 18 "fast" at the job's
# resolution, 1080p by default — its size follows the length and the
# resolution, not the upload); the 720p proxy (same pass) and the cut
# preview. The source is deleted right after the normalize
# (on_normalized), so the peak is S + M (normalizing) or M + M' (SmartCam
# writing its reframed copy next to the mezz), plus proxy + preview:
# max(S, M) + M + small (S + M + small without SmartCam).
# Measured (10 s clips through _normalize_orientation, 1080p mezz):
# 4K30 / 4K60 HEVC phone clips (46 / 56 Mbit/s) → 9–11 Mbit/s mezz (0.2×
# the upload); 1080p30 H.264 16 Mbit/s → 15; 1080p60 HEVC 18 → 16; a
# pathological 1080p60 of pure sensor noise 33 → 45; proxy ≤ 0.6.
# CLEO_DISK_MEZZ_MBPS (40) is M's ceiling at 1080p (scaled by pixel area
# for 1440p / 4K jobs), CLEO_DISK_PREVIEW_MBPS (10) that of proxy +
# preview together. Without a known length (a legacy body upload, a
# streamed WebM) the need stays the old CLEO_DISK_FACTOR × S, and it is
# never more than that either.
_RES_SIDE = {"1080": 1920, "1440": 2560, "2160": 3840, "4k": 3840}


def _disk_factor() -> float:
    return _env_float("CLEO_DISK_FACTOR", 3.5)


def _disk_mezz_mbps() -> float:
    return _env_float("CLEO_DISK_MEZZ_MBPS", 40)


def _disk_preview_mbps() -> float:
    return _env_float("CLEO_DISK_PREVIEW_MBPS", 10)


def _disk_need(size: float | None, seconds: float | None = None,
               resolution: Any = None, smartcam: bool = True) -> float:
    """Bytes the analysis of an upload of `size` bytes and `seconds`
    length writes at its peak (see above); `smartcam` False (the job's
    settings ask for no reframe): no second mezz, S + M + small."""
    size = max(0.0, float(size or 0.0))
    legacy = _disk_factor() * size
    try:
        secs = float(seconds or 0.0)
    except (TypeError, ValueError):
        secs = 0.0
    if not (secs > 0 and math.isfinite(secs)):
        return legacy
    side = _RES_SIDE.get(str(resolution or "1080").strip().lower(), 1920)
    mezz = (secs * _disk_mezz_mbps() * 1e6 / 8
            * (side / 1920) ** 2)
    small = secs * _disk_preview_mbps() * 1e6 / 8
    peak = (max(size, mezz) + mezz) if smartcam else size + mezz
    return min(legacy, peak + small)


class DiskRefusal(HTTPException):
    """507 server_storage_full (the same body as before) with the numbers
    behind it, for the upload_refused event — never sent to the client."""

    def __init__(self, free: float, reserved: float, need: float) -> None:
        super().__init__(507, "server_storage_full")
        self.free, self.reserved, self.need = free, reserved, need


def _upload_entry_ttl_s() -> float:
    """An upload being accepted (kind "upload", no thread) older than
    this is a leftover (CLEO_UPLOAD_ENTRY_TTL_S, default 2 h; 0 = never
    swept): POST /jobs releases its entry in a finally, within seconds."""
    return _env_float("CLEO_UPLOAD_ENTRY_TTL_S", 7200)


class _Inflight:
    """This process's work in flight, per owner: uploads being accepted
    by POST /jobs (kind "upload") and analysis / render worker threads.
    Feeds the per-user limit, the queue cap, queue-position hints and
    the disk reservations. Entries of worker threads drop out by
    themselves once the thread has ended; thread-less ones when released
    — or, should one ever be left behind, after _upload_entry_ttl_s (it
    would otherwise count against the queue cap and hold its disk
    reservation against every upload until a restart)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}

    def _live(self) -> list[dict]:
        now = time.monotonic()
        ttl = _upload_entry_ttl_s()
        dead = [k for k, e in self._entries.items()
                if (e["thread"] is not None and not e["thread"].is_alive())
                or (e["thread"] is None and ttl > 0
                    and now - e.get("at", now) > ttl)]
        for k in dead:
            e = self._entries.pop(k)
            if e["thread"] is None:
                print(f"[jobs] dropped a stale {e['kind'] or 'upload'} "
                      f"entry ({now - e.get('at', now):.0f} s old, "
                      f"{e['need'] / 1e9:.1f} GB reserved)", flush=True)
        return list(self._entries.values())

    @staticmethod
    def _entry(owner: str | None, kind: str) -> dict:
        return {"owner": owner, "kind": kind, "thread": None, "need": 0.0,
                "upload": None, "job_id": None, "at": time.monotonic()}

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
                     upload_path: str | None = None,
                     seconds: float | None = None,
                     resolution: Any = None,
                     smartcam: bool = True) -> None:
        """Size-aware free-space check: what the upload's analysis will
        write (_disk_need: from its length and resolution when known,
        else CLEO_DISK_FACTOR (3.5) × the upload) must fit beside what
        the other jobs in flight will still write, plus the
        CLEO_MIN_FREE_GB floor — so parallel uploads can't all pass the
        same check. The editor's proxy cache (on the same disk) is
        emptied first when that makes it fit. Recorded under `token`
        (None = only check, for presign / multipart init). Raises 507
        server_storage_full (DiskRefusal)."""
        need = _disk_need(size, seconds, resolution, smartcam)
        for attempt in (1, 2):
            # The filesystem is scanned WITHOUT the lock: the event loop
            # takes it too (admit / attach / release), and a scan per
            # entry per upload under it turned a burst of uploads into
            # loop stalls.
            with self._lock:
                self._live()
                snapshot = [e for k, e in self._entries.items()
                            if k != token]
            written = {id(e): _bytes_on_disk(e) for e in snapshot}
            # Where the analysis writes: its workspace (CLEO_TMP_ROOT).
            free = shutil.disk_usage(_TMP_ROOT).free
            with self._lock:
                # Entries that came in meanwhile count in full; bytes
                # written since the scan are both in `free` and in the
                # reservations, so the stale numbers still add up.
                others = sum(max(0.0, e["need"] - written.get(id(e), 0))
                             for k, e in self._entries.items() if k != token)
                short = need + _MIN_FREE_BYTES - (free - others)
                if short <= 0:
                    entry = self._entries.get(token) if token else None
                    if entry is not None:
                        entry["need"] = need
                        entry["upload"] = upload_path
                    return
            # A cache, not work: give its room to the upload when that is
            # enough (it refills from the media store on demand). Only
            # for a real reservation: a check (token None) deletes
            # nothing — it passes when the room could be made.
            if attempt == 1 and token is None:
                if _proxy_cache_reclaim(short, dry_run=True) >= short:
                    return
                break
            if attempt == 1 and _proxy_cache_reclaim(short) >= short:
                continue
            break
        print(f"[jobs] refusing upload: {free / 1e9:.1f} GB free, "
              f"{others / 1e9:.1f} GB reserved, "
              f"{need / 1e9:.1f} GB needed", flush=True)
        raise DiskRefusal(free, others, need)

    def room(self) -> tuple[float, float]:
        """(free bytes on CLEO_TMP_ROOT, bytes the jobs in flight will
        still write there) — reserve_disk's numbers, for reports."""
        with self._lock:
            self._live()
            snapshot = list(self._entries.values())
        others = sum(max(0.0, e["need"] - _bytes_on_disk(e))
                     for e in snapshot)
        return float(shutil.disk_usage(_TMP_ROOT).free), others

    def snapshot(self) -> list[dict[str, Any]]:
        """The live entries, for /admin/capacity and the upload_refused
        events: kind, age, reservation, whether a worker thread runs —
        no owners, no job ids."""
        now = time.monotonic()
        with self._lock:
            live = self._live()
            return [{"kind": e["kind"] or "upload",
                     "age_s": round(now - e.get("at", now), 1),
                     "need_gb": round(e["need"] / 1e9, 3),
                     "has_thread": e["thread"] is not None}
                    for e in live]

    def counts(self) -> dict[str, Any]:
        """Live entries per kind and their reservations in all (GB)."""
        out: dict[str, Any] = {"n_upload": 0, "n_analyze": 0, "n_render": 0}
        reserved = 0.0
        for e in self.snapshot():
            key = f"n_{e['kind']}"
            out[key] = out.get(key, 0) + 1
            reserved += e["need_gb"]
        out["reserved_gb"] = round(reserved, 3)
        return out

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
            # message, plus stage / stage_params for a StageMessage.
            fields: dict[str, Any] = errors.stage_fields(msg)
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
                        **errors.stage("queued"), queue_position=pos)
    return _write


def _start_writer(job_id: str, expect: tuple[str, ...], message: str
                  ) -> Callable[[], None]:
    """on_start for _SlotQueue.acquire: the job left the line.
    `message`: its progress text (a StageMessage writes the stage too)."""
    def _write() -> None:
        store.update_if(job_id, expect, status="processing",
                        **errors.stage_fields(message),
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
    # STARTUP: never with test auth (CLEO_AUTH_TEST) in production or next
    # to a live Clerk secret — it would let anyone sign in as anyone.
    try:
        auth.check_test_auth()
    except auth.TestAuthRefused as e:
        print(f"[auth] NOT STARTING: {e}", flush=True)
        raise
    # Then pick the database — with DATABASE_URL this opens
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
    global _LEADER
    queue = taskq.enabled()
    if queue:
        # The task queue (WP4): interrupted work lives on as tasks; the
        # leader re-dispatches it (reaper) and re-enqueues or settles
        # jobs left without a task (_QueueOps.on_leadership) — the WP1
        # boot scans below would fail jobs that only wait in line.
        try:
            task_leader.check_config()
        except task_leader.ConfigError as e:
            print(f"[queue] NOT STARTING: {e}", flush=True)
            raise
    else:
        # Any job stuck in 'processing'/'pending' from the previous
        # container generation is unrecoverable — its worker thread died
        # with the process. Surface it as a real error so the frontend
        # can show a retry button instead of polling forever, refund it
        # and free its files.
        stuck = _mark_stuck_and_refund()
        if stuck:
            print(f"[startup] marked {stuck} stuck job(s) as error "
                  f"(container restart)", flush=True)
        _refund_interrupted()
        _clean_interrupted()
    _clean_workspaces()
    _exports_maintenance(boot=True)
    if db.fell_back():
        threading.Thread(target=_cutover_watch, daemon=True).start()
    if queue:
        # Retention, media GC, the Postgres backup and the Lemon Squeezy
        # reconcile run under the leader (one process at a time).
        _LEADER = task_leader.Leader(_QueueOps()).start()
        print(f"[queue] task queue ON (CLEO_TASK_QUEUE=1): executors "
              f"ingest={taskq.executor('ingest')} "
              f"render={taskq.executor('render')}, running limits "
              f"{taskq.running_limit('ingest')}/"
              f"{taskq.running_limit('render')}, queue cap "
              f"{taskq.max_queue()}", flush=True)
    else:
        threading.Thread(target=_retention_loop, daemon=True).start()
    threading.Thread(target=_prerender_caption_previews, daemon=True).start()
    auth.install_log_filter()
    auth.log_status()
    billing.log_status()
    if billing.enabled() and not queue:
        threading.Thread(target=billing.reconcile_loop, daemon=True).start()
    yield
    if queue and _LEADER is not None:
        # SHUTDOWN: no new dispatches; running local tasks get the grace
        # period, then they are interrupted and the next leader runs
        # them again (their tasks are durable).
        leader, _LEADER = _LEADER, None
        left = await asyncio.to_thread(leader.stop, _shutdown_grace_sec)
        print("[shutdown] task queue: all local tasks finished" if not left
              else f"[shutdown] task queue: {left} task(s) interrupted — "
                   "the next leader runs them again", flush=True)
        return
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
    if taskq.enabled():
        active |= _tasks().unsettled_job_ids()
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
    if taskq.enabled():
        active |= _tasks().unsettled_job_ids()
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
    _exports_maintenance()
    try:
        # With the task queue the reaper settles lost work (leases);
        # this sweep would fail jobs that are only waiting in line.
        n = 0 if taskq.enabled() else _sweep_orphaned_jobs()
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
    try:
        store.prune_events(time.time() - EVENTS_KEEP_DAYS * 86400)
    except Exception as e:
        print(f"[events] pruning failed: {e}", flush=True)


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


# Failure classification: backend/errors.py (shared with the task
# queue's worker, backend/worker.py).
_is_infra_failure = errors.is_infra_failure
_analysis_error_code = errors.analysis_error_code
_render_error_code = errors.render_error_code

# A "no speech" failure with less detected speech than this gets its
# minutes back (owner decision, PLAN 6.1 #10): the user uploaded music
# or a silent screen recording by mistake — nothing was worth charging.
NO_SPEECH_REFUND_S = _env_float("CLEO_NO_SPEECH_REFUND_S", 10.0)


def _refund_content_failure(exc: BaseException, code: str | None) -> bool:
    """errors.refund_content_failure with NO_SPEECH_REFUND_S."""
    return errors.refund_content_failure(exc, code, NO_SPEECH_REFUND_S)


# ── Job events (reliability numbers, GET /admin/metrics) ─────────────
# analysis_done / analysis_failed / analysis_refused, render_done /
# render_failed: one row each in the store's job_events log (kept
# EVENTS_KEEP_DAYS, outlives the jobs). Only codes, durations and flags —
# no content, no user data.


def _since(t: float | None) -> float | None:
    return round(time.time() - t, 3) if t else None


def _record_event(kind: str, job_id: str | None, **data: Any) -> None:
    """Append one job event. Never raises: statistics must not fail a
    job. `test` (a cost-test job, settings._cost_test) is looked up when
    the caller doesn't pass it."""
    try:
        if "test" not in data and job_id:
            job = store.get(job_id)
            data["test"] = bool(job and (job.settings or {}).get("_cost_test"))
        clean = {k: v for k, v in data.items()
                 if v is None or isinstance(v, (str, int, float, bool))}
        store.record_event(kind, job_id, clean)
    except Exception as e:
        print(f"[events] {kind} for {job_id} not recorded: {e}", flush=True)


def _output_seconds(job: Job) -> float:
    """Length of the video a render of `job` makes: its saved timeline,
    each segment at its speed."""
    total = 0.0
    for seg in job.edit_segments():
        try:
            speed = max(0.05, float(seg.get("speed") or 1.0))
            total += max(0.0, float(seg["end"]) - float(seg["start"])) / speed
        except (TypeError, ValueError, KeyError):
            continue
    return total


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
                **errors.job_error("processing_interrupted"),
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
                               error_code="render_failed",
                               queue_position=None):
                _refund_render(job.id, job.render_gen)
                settled += 1
            continue
        if not _refund(job.id, "container_restart"):
            continue
        if not store.update_if(
                job.id, job.status, status="error", error="container_restart",
                **errors.job_error("processing_interrupted"),
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
    # As before UX6 (additive only): any style string is kept — the
    # pipeline maps tight / balanced / smooth, and UX6's "none" (no cuts);
    # anything else analyses as smooth.
    for key in ("caption_preset", "style", "caption_style_hint"):
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()[:64]
    if parsed.get("target_aspect") in edit_doc.ASPECTS:
        out["target_aspect"] = parsed["target_aspect"]
    # The spoken language (ISO 639-1); "auto" = detect it (not stored).
    lang = parsed.get("spoken_language")
    if isinstance(lang, str) and lang.strip().lower() in SPOKEN_LANGUAGES:
        out["spoken_language"] = lang.strip().lower()
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


# ── Error bodies: {"detail", "code", "params"} (backend/errors.py) ────
# `detail` exactly as before (clients from before UX5 read it), the
# refusals' extra fields next to it as before; `code` is always a
# catalogue code and `params` its numbers.


@app.exception_handler(ApiRefusal)
async def _api_refusal(request: Request, exc: ApiRefusal):
    return JSONResponse(errors.http_body(exc.status, exc.detail, exc.extra),
                        status_code=exc.status, headers=exc.headers)


@app.exception_handler(StarletteHTTPException)
async def _http_error(request: Request, exc: StarletteHTTPException):
    headers = getattr(exc, "headers", None)
    if exc.status_code in (204, 304):
        return Response(status_code=exc.status_code, headers=headers)
    return JSONResponse(errors.http_body(exc.status_code, exc.detail),
                        status_code=exc.status_code, headers=headers)


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError):
    body = errors.http_body(422, jsonable_encoder(exc.errors()))
    return JSONResponse(body, status_code=422)


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
        return 256 * _KIB, errors.refusal_body("request_too_large")
    if method == "POST" and path == "/jobs":
        # Legacy multipart upload through Railway; big files go to R2.
        limit = int(_env_float("CLEO_MAX_FORM_UPLOAD_MB", 100) * _MIB)
        return limit, errors.refusal_body(
            "file_too_large", max_gb=_plain(round(limit / 1e9, 2)))
    return (int(_env_float("CLEO_MAX_BODY_KB", 1024) * _KIB),
            errors.refusal_body("request_too_large"))


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


def public_config() -> dict[str, Any]:
    """Body of GET /config: what the web app needs to know about this
    deployment before it sends anything (it used to be baked into the
    build as NEXT_PUBLIC_MAX_*)."""
    max_minutes = _max_minutes()
    return {
        "limits": {
            "max_upload_bytes": int(_max_upload_gb() * 1e9),
            # None: no length cap (CLEO_MAX_MINUTES <= 0).
            "max_seconds": _plain(max_minutes * 60) if max_minutes > 0 else None,
            "min_seconds": _plain(_min_seconds()),
        },
        "formats": list(EXPORT_FORMATS),
        # v1 engine presets (the configure screen's picker). `scripts`:
        # null = not declared per preset yet (UT4/UT5 fill it for the v2
        # engine).
        "caption_presets": [
            {"id": p, "name_key": f"app.captions.{p}", "status": "live",
             "scripts": None}
            for p in CAPTION_PRESETS
        ],
        # What the upload may name as its spoken language (UX6); "auto"
        # = Whisper detects it.
        "spoken_languages": ["auto", *SPOKEN_LANGUAGES],
        # Renders are free today: no fair-use count (UX11).
        "free_renders": None,
        "billing": {"enabled": billing.enabled()},
        # Incident banner (UX20: admin-editable).
        "incident": None,
    }


@app.get("/config")
async def get_config():
    """Public deployment settings for the web app; cacheable a minute."""
    return JSONResponse(await run_in_threadpool(public_config),
                        headers={"Cache-Control": "public, max-age=60"})


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
    code = _analysis_error_code(exc, msg)
    if not db.is_transient(exc):
        # A content failure ("No speech detected") comes after the
        # transcription was paid for: charge what was really processed
        # (before the files go; refunds below still win).
        _true_up_from_file(job_id, job_dir)
    infra = (_is_infra_failure(exc, msg)
             or isinstance(exc, MediaTransferError))
    refunded: bool | None = None
    if (infra or _refund_content_failure(exc, code)) and auth.auth_enabled():
        # Before the error state: once that is stored nothing refunds
        # the job any more (the boot and the sweep only settle running
        # jobs), so a refund that fails — or the process dying while the
        # upload is dropped below — would charge the user for our
        # failure for good. accounts.refund is idempotent.
        if _db_retry(job_id, "refunding", accounts.refund, job_id,
                     code or msg):
            print(f"[job {job_id}] minutes refunded ({(code or msg)[:60]})",
                  flush=True)
            refunded = True
    # The raw text only in `error` (admins; Sentry has it above).
    _db_retry(job_id, "saving the failure", store.update, job_id,
              status="error", error=msg[:2000], **errors.job_error(code),
              refunded=refunded, input_path=None)
    _record_event("analysis_failed", job_id, code=code or "unknown",
                  infra=bool(infra), refunded=bool(refunded))
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
        self.params = extra   # the job's error_params
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
        progress(errors.stage_message("analyze.normalize",
                                      "Checking the video…"), 1)
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
                task_worker.limit_to_length(settings, seconds or 0.0)
        if seconds:
            # Billed or not: the analysis stops at the measured length.
            task_worker.limit_to_length(settings, seconds)
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
    refunded: bool | None = None
    if auth.auth_enabled():
        if _db_retry(job_id, "refunding", accounts.refund, job_id, exc.code):
            refunded = True
    _db_retry(job_id, "saving the refusal", store.update, job_id,
              status="error", error=exc.text[:2000],
              **errors.job_error(exc.code, **exc.params), refunded=refunded,
              progress=0.0, input_path=None)
    _record_event("analysis_refused", job_id, code=exc.code)
    drop_upload()
    shutil.rmtree(job_dir, ignore_errors=True)
    if source_key:
        # Retrying can't help: the upload goes now (media_gc if R2 fails).
        _discard_upload(None, source_key, where)
    if media_entries:
        _gc_later([e for e in media_entries if e != source_key],
                  store_=where)


def _render_failed(job_id: str, exc: Exception, gen: int | None = None,
                   started_at: float | None = None) -> None:
    """A render failed (or its result couldn't be saved): back to review
    instead of a dead 'error' — the user's edits and the source are
    still on disk, so they can open the editor and render again without
    re-uploading. Raises when that can't be written (the sweep settles
    the job later). `gen` / `started_at` (time.time() of the request)
    only go into the render_failed event."""
    tb = traceback.format_exc()
    print(f"[job {job_id}] RENDER FAILED: {exc}\n{tb}", flush=True)
    observability.capture(exc, job_id=job_id, phase="render")
    code = _render_error_code(exc)
    # message "render_failed": what clients before UX5 look for.
    _db_retry(job_id, "saving the failure", store.update, job_id,
              status="awaiting_review", progress=100.0,
              message="render_failed", error=str(exc)[:500],
              error_code=code, error_params={})
    _refund_render(job_id, gen)
    _record_event("render_failed", job_id, code=code, gen=gen,
                  wall_s=_since(started_at))


def _run_analyze(job_id: str) -> None:
    """Worker thread: wait in line for an analysis slot, then analyze.
    The wait isn't billed to the job's costs."""
    try:
        waiting = ("pending", "processing")
        if not _ANALYZE_SLOTS.acquire(
                job_id, on_wait=_queued_writer(job_id, waiting),
                on_start=_start_writer(job_id, waiting, errors.stage_message(
                    "analyze.normalize", "Starting…"))):
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
        progress(errors.stage_message("analyze.cuts", "Saving…"), 96 + i)
        try:
            size = media.put_file(path, key, content_type="video/mp4",
                                  store=where)
        except Exception as e:
            raise MediaTransferError(
                f"storing {key} failed: {type(e).__name__}: {e}") from e
        fields[field_name] = key
        fields["media_bytes"][key] = size

    def put(path: str, key: str, ctype: str) -> int:
        try:
            return media.put_file(path, key, content_type=ctype, store=where)
        except Exception as e:
            raise MediaTransferError(
                f"storing {key} failed: {type(e).__name__}: {e}") from e
    extra, sizes = pipeline.store_analysis_extras(res, job_id, put)
    fields.update(extra)
    fields["media_bytes"].update(sizes)
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
    # Under the floor mid-analysis: this job stops (its ffmpeg killed) as
    # server_storage_full instead of filling the volume for every job.
    guard = task_worker.DiskGuard(job_id, ws, _TMP_ROOT, _MIN_FREE_BYTES)
    work_started = time.time()
    try:
        job = _db_retry(job_id, "reading the job", store.get, job_id)
        source_key = job.source_ref() if job is not None else None
        if job is None or (job.input_path is None and not source_key):
            return
        where = media.store_of(job)
        # Start exactly once, and only while the job still waits to start.
        if not _db_retry(job_id, "starting", store.update_if, job_id,
                         ("pending", "processing"), status="processing",
                         **errors.stage_fields(errors.stage_message(
                             "analyze.normalize", "Starting…")),
                         progress=1.0, queue_position=None):
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
        if _accepts(analyze_only, "cancel_check"):
            extra["cancel_check"] = guard.cancel_check()
        try:
            guard.start()
            input_path = job.input_path
            if not input_path:
                progress(errors.stage_message("analyze.normalize",
                                              "Fetching upload…"), 1)
                local_copy = ws / ("source" + upl.upload_ext(source_key))
                try:
                    media.get_file(source_key, local_copy, store=where)
                except Exception as e:
                    raise MediaTransferError(
                        f"fetching the upload failed: "
                        f"{type(e).__name__}: {e}") from e
                input_path = str(local_copy)
            guard.check()
            settings = _length_gate(job, input_path, progress)
            res = analyze_only(
                input_path=input_path,
                output_dir=str(ws),
                settings=settings,
                progress_cb=guard.progress(progress),
                **extra,
            )
            guard.check()
            stored = _store_analysis(job_id, res, progress, where)
        except AnalysisRefused as e:
            guard.stop()
            progress.close()
            _analysis_refused(job_id, ws, e, _drop_upload, media_entries,
                              where, source_key)
            return
        except Exception as e:
            guard.stop()
            progress.close()
            # Whatever the killed step raised: the disk was full.
            _analysis_failed(job_id, ws, guard.error(e), _drop_upload,
                             media_entries, where)
            return
        guard.stop()
        progress.close()
        try:
            # Pause here: status "awaiting_review" tells the UI to show the
            # subtitle editor. Render starts when client POSTs /jobs/{id}/render.
            # Only while the job is still ours to finish ("processing"):
            # a job another process settled meanwhile (error
            # container_restart, its media GC'd) or deleted must not come
            # back with keys pointing at deleted objects.
            # The doc's style is settled against the job as stored now
            # (a style picked while this ran: settings.caption_style;
            # one picked after the commit goes into the doc itself,
            # PATCH /jobs/{id}).
            change = edit_doc.commit_change(dict(
                status="awaiting_review",
                **errors.stage("analyze.done"),
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
                # UX11: bonus clips only while the timeline is this one.
                analysis_segments_hash=exports.segments_hash(res["segments"]),
                **pipeline.analysis_fields(res),
                **stored,
            ), res, prefs=edit_doc.load_prefs(job.owner_id))
            # One read-check-write (store.modify): the style is resolved
            # and the doc written under the same lock, so a PATCH /jobs
            # caption_style can't land between the two and be lost.
            committed = _db_retry(
                job_id, "saving the analysis", store.modify,
                job_id, change) is not None
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
        _after_analysis(job_id)
        _record_event("analysis_done", job_id, work_s=_since(work_started),
                      duration_s=round(float(res.get("duration") or 0.0), 3),
                      test=bool((job.settings or {}).get("_cost_test")))
        _drop_upload()  # if the pipeline didn't already
        if source_key:
            # Committed: the upload object isn't needed any more.
            _discard_upload(None, source_key, where)
    finally:
        guard.stop()
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
    requested_at = time.time()  # the thread starts with POST /render
    try:
        if not _RENDER_SLOTS.acquire(
                job_id, on_wait=_queued_writer(job_id, ("processing",)),
                on_start=_start_writer(job_id, ("processing",),
                                       errors.stage_message(
                                           "render.prepare", "Rendering…"))):
            return
        try:
            with costs.tracking(job_id, "render"):
                _run_render_inner(job_id, edited_subtitles, disabled_cuts,
                                  requested_at=requested_at)
        finally:
            _RENDER_SLOTS.release(job_id)
    finally:
        _INFLIGHT.release(job_id)


# The post caption + hashtags (one LLM call: up to its timeout × (1 +
# retries), backend/llm.py) are written while the video renders instead
# of after it, so a slow LLM never holds a render slot. They only need
# the edited transcript.
_SOCIAL_POOL = ThreadPoolExecutor(
    max_workers=max(1, _env_int("CLEO_SOCIAL_WORKERS", 4)),
    thread_name_prefix="social")
# How long a finished render waits for its caption before saving
# without one (past the LLM client's own limit: 2 × 30 s).
_SOCIAL_WAIT_S = 75.0
_NO_SOCIAL: dict = {"caption": "", "hashtags": []}


def _social_caption(subtitles: list, language: str | None
                    ) -> tuple[dict, dict[str, float]]:
    """_SOCIAL_POOL worker: the post caption for the (possibly edited)
    transcript, and the LLM usage it recorded (the render thread adds it
    to the render's costs). Soft-fails to no caption (no API key, API
    error)."""
    usage: dict[str, float] = {}
    social: dict = dict(_NO_SOCIAL)
    with costs.collecting(usage):
        try:
            from backend import llm
            full = " ".join(
                (s.get("text") or "").strip()
                for s in subtitles
                if isinstance(s, dict) and (s.get("text") or "").strip())
            social = llm.generate_social_caption(full, language=language)
        except Exception as e:
            print(f"[social] caption skipped: {e}", flush=True)
    return social, usage


def _social_result(job_id: str, future) -> dict:
    """The caption of `future` (_social_caption), its usage merged into
    this thread's costs — or none if it isn't there in _SOCIAL_WAIT_S."""
    try:
        social, usage = future.result(timeout=_SOCIAL_WAIT_S)
    except Exception as e:
        print(f"[job {job_id}] social-caption skipped: "
              f"{type(e).__name__}: {e}", flush=True)
        return dict(_NO_SOCIAL)
    costs.merge(usage)
    return social if isinstance(social, dict) else dict(_NO_SOCIAL)


def _run_render_inner(
    job_id: str,
    edited_subtitles: list,
    disabled_cuts: list[int] | None = None,
    requested_at: float | None = None,
) -> None:
    """Worker: render + concat into final MP4. Its state writes ride out
    a short database outage (_db_retry); if they still fail the thread
    ends, and _sweep_orphaned_jobs sends the job back to review later.
    `requested_at` (time.time() of POST /render, else now) is where the
    render events measure the wait from."""
    requested_at = requested_at or time.time()
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
                  status="processing", **errors.stage_fields(
                      errors.stage_message("render.prepare", "Rendering…")),
                  progress=1.0, queue_position=None)
        gen = max(1, int(job.render_gen or 0))
        out_prefix = f"{media.job_prefix(job_id)}r{gen}/"
        where = media.store_of(job)
        work_started = time.time()
        _make_workspace(ws)
        try:
            if not job.has_mezz():
                raise FileNotFoundError("the render source is gone")
            # The post text, as before; a v2 export keeps one made from
            # the same transcript and cut (exports.keep_social).
            social_future = (None if exports.keep_social(job, edited_subtitles)
                             else _SOCIAL_POOL.submit(_social_caption,
                                                      edited_subtitles,
                                                      job.language))
            mezz_key = job.mezz_key or _backfill_mezz(job, progress, where)
            # UT4: pins the job's caption engine at its first render;
            # a v2 spec only with CLEO_CAPTION_ENGINE=v2.
            captions = captions_v2.prepare_render(store, job_id, job,
                                                  edited_subtitles)
            result = pipeline.render_to_keys(
                job_id=job_id, gen=gen, mezz_key=mezz_key,
                out_prefix=out_prefix, store=where,
                mezz_bytes=(job.media_bytes or {}).get(mezz_key),
                segments=job.segments,
                subtitles=edited_subtitles,
                settings=exports.settings_for_render(job, _output_seconds(job)),
                language=job.language,
                cut_ranges=job.cut_ranges,
                disabled_cuts=disabled_cuts or [],
                duration=job.duration,
                workspace=str(ws),
                progress_cb=progress,
                **({"captions": captions} if captions else {}),
            )
        except Exception as e:
            progress.close()
            # Partial outputs of this generation — not before a Modal
            # call that wasn't really stopped (_cancel_modal_call doesn't
            # kill its container) can't write there any more.
            _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
            _render_failed(job_id, e, gen, requested_at)
            return
        # Social caption / hashtags from the (possibly edited)
        # transcript, written meanwhile. Soft-fails to none.
        social = (_social_result(job_id, social_future)
                  if social_future is not None else None)
        progress.close()
        try:
            # Nothing else writes these fields while the job renders
            # (edits need awaiting_review): computed from a fresh read.
            cur = _db_retry(job_id, "reading the job", store.get, job_id)
            if cur is None:
                _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
                return
            done, superseded = _render_commit(cur, result, out_prefix, social,
                                              edited_subtitles)
            _db_retry(job_id, "saving the render", store.update, job_id,
                      **done)
        except Exception as e:
            _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
            _render_failed(job_id, e, gen, requested_at)
            return
        _record_event("render_done", job_id, gen=gen,
                      wall_s=_since(requested_at),
                      work_s=_since(work_started),
                      output_s=round(_output_seconds(cur), 3),
                      test=bool((cur.settings or {}).get("_cost_test")))
        # The previous render stays a day: someone may still stream it.
        _gc_later(superseded, _SUPERSEDED_KEEP_S, store_=where)
    finally:
        if progress is not None:
            progress.close()
        _drop_workspace(ws)
        _release_active(job_id)


def _render_commit(cur: Job, result: dict, out_prefix: str,
                   social: dict | None,
                   subtitles: list | None = None) -> tuple[dict, list[str]]:
    """The job fields of a finished render (pipeline.render_to_keys'
    result) and the prefixes of the render(s) it supersedes. `social`
    None keeps the job's post text (made at analysis, UX11)."""
    output_keys, sizes, hook_clips, thumb = _render_files(result)
    old = set((cur.output_keys or {}).values())
    if cur.thumb_key:
        old.add(cur.thumb_key)
    superseded = sorted({media.key_prefix_of(k) for k in old
                         if not k.startswith(out_prefix)})
    media_bytes = {k: v for k, v in (cur.media_bytes or {}).items()
                   if media.key_prefix_of(k) not in superseded}
    media_bytes.update(sizes)
    done = dict(
        status="done",
        **errors.stage_fields(errors.stage_message("render.finish", "Done")),
        progress=100.0,
        output_keys=output_keys,
        thumb_key=thumb["key"] if thumb else None,
        hook_clips=hook_clips,
        media_bytes=media_bytes,
        # UX11: a successful user export (the fair-use counter) and what
        # its SRT / VTT files are made of.
        renders_ok=int(cur.renders_ok or 0) + 1,
        export_captions=exports.export_captions(
            subtitles, cur, exports.doc_offset_ms(cur)),
    )
    if social is not None:
        done.update(social_caption=social.get("caption", ""),
                    social_hashtags=social.get("hashtags", []),
                    social_source=exports.social_digest(subtitles,
                                                        cur.segments))
    return done, superseded


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
    progress(errors.stage_message("render.prepare"), 2)
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


# ── WP4 task queue (CLEO_TASK_QUEUE=1, backend/taskq.py) ─────────────
# With the queue on, POST /jobs and POST /render insert a durable task
# in the job's transaction instead of starting a thread; the leader
# (backend/leader.py, in this process: CLEO_ROLE=all, phase P0)
# dispatches it to the `local` executor — backend/worker.py in a thread
# of this process, running the functions bound below — and its
# finalizer settles the outcome here (_QueueOps): the job's terminal
# state, refunds / true-ups, media GC and the job event. Off (the
# default), none of this runs and the WP1 path above is unchanged.

# The local executor runs the API process's own implementations (looked
# up per call, so they are the ones the WP1 path uses).
task_worker.bind(analyze_only=lambda: analyze_only,
                 probe_duration=lambda: _probe_duration,
                 tmp_root=lambda: _TMP_ROOT)

_LEADER: task_leader.Leader | None = None


def _tasks():
    from backend.jobs import task_store
    return task_store()


def _queue_soft_check(user: User | None) -> None:
    """Queue mode, before any bytes move (presign, multipart init, POST
    /jobs): the WP1 refusals from the database, without a lock — 429
    too_many_active_jobs, 503 server_busy. POST /jobs checks again,
    binding, in the enqueue transaction."""
    owner = user.id if (user is not None and not user.is_service) else None
    n_user, queued, active = _tasks().admission_counts(owner)
    limit = taskq.max_active_per_user()
    if owner and limit > 0 and n_user >= limit:
        raise ApiRefusal(429, "too_many_active_jobs")
    if queued + active + 1 - taskq.running_limit("ingest") > taskq.max_queue():
        raise _server_busy()


def _queue_disk_check(size: float | None, seconds: float | None = None,
                      resolution: Any = None, smartcam: bool = True) -> None:
    """Queue mode with the local ingest executor: could this upload's
    analysis (_disk_need + CLEO_MIN_FREE_GB) fit on this box at all? 507
    otherwise. Each analysis also waits for room before it is dispatched
    (_QueueOps.local_room). Nothing with Modal."""
    if taskq.executor("ingest") != "local":
        return
    need = _disk_need(size, seconds, resolution, smartcam)
    free = shutil.disk_usage(_TMP_ROOT).free
    if free < need + _MIN_FREE_BYTES:
        print(f"[jobs] refusing upload: {free / 1e9:.1f} GB free, "
              f"{need / 1e9:.1f} GB needed", flush=True)
        raise DiskRefusal(free, 0.0, need)


def _queue_position_now(task_id: int | None, kind: str) -> int | None:
    """The place in line of a task just enqueued (the leader's
    queue_positions only has it from its next tick): its rank among the
    queued tasks of its kind minus the free slots; None = it starts now."""
    if task_id is None:
        return None
    ts = _tasks()
    rank = ts.rank(task_id)
    if rank is None:
        return None
    free = max(0, taskq.running_limit(kind) - ts.active_count(kind))
    pos = rank - free
    return pos if pos > 0 else None


def _queue_admit(job_id: str, user: User | None, parsed: dict, plan: str,
                 seconds: float | None, size: float | None,
                 source_key: str | None) -> str:
    """POST /jobs after the charge: admission + the claim becoming the
    job (processing / queued) + its ingest task, in one transaction."""
    service = user is not None and user.is_service
    charged = seconds if seconds else parsed.get("_max_seconds")
    payload = {"v": taskq.WORKER_PROTOCOL, "job_id": job_id,
               "source_key": source_key, "charged_s": seconds,
               "max_seconds": parsed.get("_max_seconds"),
               "est_audio_s": taskq.est_audio_s(charged),
               "size": float(size or 0.0),
               # What _disk_need sized the admission by (local_room
               # dispatches by the same formula).
               "resolution": parsed.get("resolution"),
               "smartcam": bool(pipeline.smartcam_plan(parsed)[0])}
    fields = dict(settings=parsed, plan=plan, status="processing",
                  **errors.stage("queued"), progress=0.0, queue_position=None)
    return _tasks().admit_ingest(
        job_id, owner_id=user.id if user else None,
        count_user=bool(user is not None and not service),
        user_limit=taskq.max_active_per_user(),
        queue_cap=taskq.max_queue(),
        running_limit=taskq.running_limit("ingest"),
        payload=payload, plan=plan,
        sort_offset_s=taskq.priority_offset_s(plan, service),
        max_attempts=taskq.max_attempts(), job_fields=fields)


# The job fields of a render that just started (POST /render).
_RENDER_STARTED = errors.stage_fields(
    errors.stage_message("render.prepare", "Rendering…"))


def _queue_start_render(job_id: str, edited: list, disabled_cuts: list,
                        owner_id: str | None, plan: str | None,
                        before: dict | None = None,
                        v2: bool = False) -> int | None:
    """POST /render: the compare-and-set to processing and the render
    task, in one transaction. None: not in review (409). `before` gets
    the job as it was ("job")."""
    def _start(cur: Job) -> dict | None:
        if cur.status != "awaiting_review":
            return None
        if before is not None:
            before["job"] = copy.deepcopy(cur)
        return dict(status="processing", **_RENDER_STARTED, progress=1.0,
                    **errors.no_error(), queue_position=None,
                    render_gen=int(cur.render_gen or 0) + 1,
                    **_render_start_fields(cur, v2))

    def _payload(written: dict | None) -> dict:
        return {"v": taskq.WORKER_PROTOCOL, "job_id": job_id,
                "gen": int((written or {}).get("render_gen") or 1),
                "subtitles": edited, "disabled_cuts": disabled_cuts}
    try:
        task_id, written = _tasks().enqueue(
            job_id, "render", _payload, owner_id=owner_id, plan=plan,
            sort_offset_s=taskq.priority_offset_s(plan),
            max_attempts=taskq.max_attempts(), job_change=_start)
    except taskq.TaskActive:
        return None
    return task_id if written is not None else None


def _wall_s(t: taskq.Task) -> float | None:
    if not t.finished_at or not t.created_at:
        return None
    return round(max(0.0, t.finished_at - t.created_at), 3)


def _ledger_refunded(job_id: str) -> bool | None:
    if not auth.auth_enabled():
        return None
    row = accounts.get_usage(job_id)
    return True if row and row.get("refunded") else None


class _QueueOps:
    """backend/leader.py LeaderOps: the job side of the task queue."""

    def __init__(self, periodic: bool = True) -> None:
        self._periodic = periodic

    # ── take-over ────────────────────────────────────────────────────

    def on_leadership(self) -> None:
        """Replaces the WP1 boot scans (mark_stuck_as_error,
        _refund_interrupted, _clean_interrupted): jobs pending /
        processing without an active or unsettled task — killed WP1
        threads, a rollback, a restore — are re-enqueued while their
        upload exists (the analysis runs again), else failed and
        refunded like an interrupted job; renders go back to review.
        Claims of POST /jobs in flight are left to the stale-claim
        sweep. Idempotent; runs at every takeover."""
        ts = _tasks()
        moved = 0
        for job_id in ts.running_jobs_without_tasks():
            job = store.get(job_id)
            if job is None or _is_claim(job):
                continue
            if job.segments and job.has_mezz():
                if store.update_if(job.id, job.status,
                                   status="awaiting_review", progress=100.0,
                                   message="render_failed",
                                   error="container_restart",
                                   error_code="render_failed",
                                   queue_position=None):
                    _refund_render(job.id, job.render_gen)
                    moved += 1
                continue
            where = media.store_of(job)
            src = job.source_ref()
            has_input = bool(job.input_path and Path(job.input_path).exists())
            try:
                has_src = bool(src) and media.exists(src, store=where)
            except Exception:
                has_src = False
            if has_input or has_src:
                seconds = ((accounts.get_usage(job.id) or {}).get(
                    "seconds_billed") if auth.auth_enabled() else None)
                cap = (job.settings or {}).get("_max_seconds")
                try:
                    tid, _ = ts.enqueue(
                        job.id, "ingest",
                        {"v": taskq.WORKER_PROTOCOL, "job_id": job.id,
                         "source_key": src, "charged_s": seconds,
                         "max_seconds": cap,
                         "est_audio_s": taskq.est_audio_s(seconds or cap),
                         "size": 0.0, "requeued": "takeover"},
                        owner_id=job.owner_id, plan=job.plan,
                        sort_offset_s=taskq.priority_offset_s(job.plan),
                        max_attempts=taskq.max_attempts(),
                        job_expect=("pending", "processing"),
                        job_change=dict(status="processing",
                                        **errors.stage("queued"),
                                        progress=0.0, queue_position=None))
                except taskq.TaskActive:
                    continue
                if tid is not None:
                    moved += 1
                    print(f"[leader] job {job.id}: its analysis was "
                          "interrupted — queued again", flush=True)
                continue
            if not _refund(job.id, "container_restart"):
                continue
            if not store.update_if(
                    job.id, job.status, status="error",
                    error="container_restart",
                    **errors.job_error("processing_interrupted"),
                    progress=0.0, queue_position=None, input_path=None):
                continue
            try:
                _discard_upload(job.input_path, src, where)
            except Exception as e:
                print(f"[leader] dropping the upload of {job.id} failed: "
                      f"{e}", flush=True)
            shutil.rmtree(_WORK_ROOT / job.id, ignore_errors=True)
            _gc_later(_media_of(job), store_=where)
            moved += 1
        if moved:
            print(f"[leader] took over: {moved} job(s) without a task "
                  "re-queued or settled", flush=True)

    # ── finalizer ────────────────────────────────────────────────────

    def finalize_success(self, t: taskq.Task) -> tuple | None:
        r = t.result or {}
        ts = _tasks()
        if t.kind == "ingest":
            job = store.get(t.job_id)
            if job is not None:
                _true_up(job.id, float(r.get("duration") or 0.0))
                if job.input_path:
                    _remove_upload(job.input_path)
                    store.update(job.id, input_path=None,
                                 updated_at=job.updated_at)
                src = job.source_ref()
                if src:
                    # Committed: the upload object isn't needed any more.
                    _discard_upload(None, src, media.store_of(job))
            task_leader.note_provider_success(ts, "groq")
            if r.get("llm_ok"):
                task_leader.note_provider_success(ts, "anthropic")
            _after_analysis(t.job_id)
            return ("analysis_done", t.job_id, {
                "work_s": r.get("work_s"),
                "duration_s": round(float(r.get("duration") or 0.0), 3),
                "test": bool(r.get("test"))})
        if t.kind == "render":
            return ("render_done", t.job_id, {
                "gen": r.get("gen"), "wall_s": _wall_s(t),
                "work_s": r.get("work_s"), "output_s": r.get("output_s"),
                "test": bool(r.get("test"))})
        return None

    def finalize_terminal(self, t: taskq.Task) -> tuple | None:
        if t.state == "cancelled":
            return None
        if t.kind == "ingest":
            return self._ingest_ended(t)
        if t.kind == "render":
            return self._render_ended(t)
        return None

    def _ingest_ended(self, t: taskq.Task) -> tuple | None:
        r = t.result or {}
        job = store.get(t.job_id)
        if job is None:
            return None
        where = media.store_of(job)
        if t.error_code == taskq.JOB_CHANGED:
            # Settled elsewhere (the worker saw it): what an attempt
            # stored belongs to nobody if the job failed. (A job already
            # in `error` here otherwise is this finalizer's own earlier
            # pass: its steps are idempotent, the event is recorded once.)
            if job.status == "error" and media.valid_job_id(job.id):
                _gc_later([media.job_prefix(job.id)], store_=where)
            return None
        test = bool((job.settings or {}).get("_cost_test"))
        src = job.source_ref()
        refused = r.get("refused")
        if refused:
            text = str(r.get("text") or refused)
            params = r.get("params") if isinstance(r.get("params"), dict) else {}
            refunded = None
            if auth.auth_enabled():
                accounts.refund(job.id, refused)
                refunded = _ledger_refunded(job.id)
            store.update_if(job.id, ("pending", "processing"),
                            status="error", error=text[:2000],
                            **errors.job_error(refused, **params),
                            refunded=refunded, progress=0.0,
                            input_path=None)
            _remove_upload(job.input_path)
            if src:
                _discard_upload(None, src, where)
            _gc_later([e for e in _media_of(job) if e != src], store_=where)
            return ("analysis_refused", job.id, {"code": refused,
                                                 "test": test})
        if t.state == "dead" or not r:
            msg = "Processing was interrupted. Please upload the video again."
            err = f"{t.error_code or 'failed'}: {t.last_error or ''}"
            job_code, refund, infra = None, True, True
            print(f"[job {job.id}] analysis given up: {err[:300]}",
                  flush=True)
            # The raw text reaches only admins (job.error): Sentry too.
            observability.capture(RuntimeError(f"analysis given up: {err[:500]}"),
                                  job_id=job.id, phase="analyze")
        else:
            msg = str(r.get("message") or t.last_error or "failed")
            err = str(r.get("error") or msg)
            job_code = r.get("job_code")
            refund, infra = bool(r.get("refund")), bool(r.get("infra"))
        if not refund and r.get("processed_s"):
            # A content failure: what was really processed is charged.
            _true_up(job.id, float(r["processed_s"]))
        refunded = None
        if refund and auth.auth_enabled():
            if accounts.refund(job.id, job_code or msg):
                print(f"[job {job.id}] minutes refunded "
                      f"({(job_code or msg)[:60]})", flush=True)
            refunded = _ledger_refunded(job.id)
        # The client sees the code and its catalogue text; the raw text
        # stays in `error` (admins).
        # (A task given up keeps its last attempt's code, e.g. Groq down.)
        client_code = job_code or r.get("job_code") or (
            "processing_interrupted" if t.state == "dead" or not r else None)
        store.update_if(job.id, ("pending", "processing"), status="error",
                        error=err[:2000], **errors.job_error(client_code),
                        refunded=refunded, input_path=None)
        _remove_upload(job.input_path)
        _gc_later(_media_of(job), store_=where)
        return ("analysis_failed", job.id, {
            "code": job_code or ("unknown" if t.state != "dead"
                                 else t.error_code or "unknown"),
            "infra": infra, "refunded": bool(refunded), "test": test})

    def _render_ended(self, t: taskq.Task) -> tuple | None:
        r = t.result or {}
        job = store.get(t.job_id)
        gen = r.get("gen") or (t.payload or {}).get("gen")
        prefix = r.get("out_prefix") or (
            f"{media.job_prefix(t.job_id)}r{gen}/" if gen
            and media.valid_job_id(t.job_id) else None)
        where = r.get("where") or (media.store_of(job) if job else None)
        if prefix:
            # Past Modal's own timeout: a call that kept running can't
            # write there after the delete.
            _gc_later([prefix], _render_gc_delay_s(), store_=where)
        if job is None or t.error_code == taskq.JOB_CHANGED:
            return None
        if t.state == "dead" or not r.get("job_code"):
            code = "render_unavailable"
            error = (f"render_unavailable: {t.error_code or 'failed'}: "
                     f"{t.last_error or ''}")
            observability.capture(RuntimeError(f"render given up: {error[:500]}"),
                                  job_id=job.id, phase="render")
        else:
            code, error = r["job_code"], str(r.get("error") or t.last_error)
        if store.update_if(job.id, "processing", status="awaiting_review",
                           progress=100.0, message="render_failed",
                           error=error[:500], error_code=code,
                           error_params={}):
            _refund_render(job.id, gen)
        return ("render_failed", job.id, {
            "code": code, "gen": gen, "wall_s": _wall_s(t),
            "test": bool((job.settings or {}).get("_cost_test"))})

    # ── executor ─────────────────────────────────────────────────────

    def run_local(self, t: taskq.Task, stop: threading.Event) -> None:
        task_worker.run(t.kind, t.id, t.job_id, t.attempts,
                        (t.payload or {}).get("v"), stop=stop)

    def local_room(self, tasks: list[taskq.Task]) -> int:
        """How many of these analyses (in order) fit on this box's disk
        now: _disk_need (by its length when charged_s is known, else
        CLEO_DISK_FACTOR × the upload) + CLEO_MIN_FREE_GB each."""
        try:
            free = shutil.disk_usage(_TMP_ROOT).free
        except OSError:
            return len(tasks)
        n = 0
        for t in tasks:
            p = t.payload or {}
            need = _disk_need(float(p.get("size") or 0.0), p.get("charged_s"),
                              p.get("resolution"), p.get("smartcam", True))
            if free - need < _MIN_FREE_BYTES:
                break
            free -= need
            n += 1
        return n

    # ── maintenance ──────────────────────────────────────────────────

    def periodic(self) -> list[task_leader.Periodic]:
        if not self._periodic:
            return []
        return [
            task_leader.Periodic("retention", 3600.0, _hourly),
            task_leader.Periodic("media GC", _GC_TICK_S, run_media_gc),
            task_leader.Periodic("billing reconcile", billing._SYNC_EVERY_S,
                                 _reconcile_once, first_s=60.0),
            task_leader.Periodic("queue stats", 300.0, _queue_stats_log,
                                 first_s=300.0),
        ]


def _reconcile_once() -> None:
    if billing.enabled():
        n = billing.reconcile()
        if n:
            print(f"[billing] reconcile updated {n} subscription(s)",
                  flush=True)


def queue_stats() -> dict[str, Any]:
    """Counts per kind, the oldest waiting task, breakers (GET
    /admin/queue and the leader's 5-minute [queue] line)."""
    ts = _tasks()
    now = time.time()
    out: dict[str, Any] = {"enabled": taskq.enabled(), "kinds": {},
                           "breakers": {}}
    for kind in task_leader.KINDS:
        queued_tasks = ts.queued(kind)
        queued, active = ts.counts(kind)
        oldest = min((t.created_at for t in queued_tasks), default=None)
        out["kinds"][kind] = {
            "executor": taskq.executor(kind), "queued": queued,
            "running": active, "limit": taskq.running_limit(kind),
            "oldest_queued_s": round(now - oldest, 1) if oldest else None}
    for p in taskq.PROVIDERS:
        b = ts.breaker(p)
        out["breakers"][p] = {"state": b.state(now), "opens": b.opens,
                              "open_until": b.open_until, "reason": b.reason}
    out["leader"] = (_LEADER.id if _LEADER is not None and _LEADER.leading
                     else None)
    return out


def _queue_stats_log() -> None:
    s = queue_stats()
    parts = []
    for kind, k in s["kinds"].items():
        age = k["oldest_queued_s"]
        parts.append(f"{kind}: queued {k['queued']}"
                     + (f" (oldest {age:.0f} s)" if age else "")
                     + f", running {k['running']}/{k['limit']}")
    opened = [p for p, b in s["breakers"].items() if b["state"] != "closed"]
    print("[queue] " + "; ".join(parts)
          + (f"; breakers not closed: {', '.join(opened)}" if opened else ""),
          flush=True)


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
# parts kept until the lifecycle rule aborts it, 8 days later) — POST
# /jobs's admission doesn't see them. Per user; per client address with
# auth off. In-process (one uvicorn process). Default 60: a resume or a
# retry of a stopped upload continues its saved ticket (no init), so
# only new picks count — and testing resume / retry by hand must never
# run into it.
def _init_limit() -> int:
    return max(0, _env_int("CLEO_UPLOAD_INITS_PER_HOUR", 60))


_INIT_RATE = upl.RateLimit(_init_limit(), 3600.0)

# The ticket lifetime of new uploads (upl.resume_window_s), from the
# bucket's lifecycle rules: read on the first init, then every 6 h (10
# min after a failed read, meanwhile the 23 h of before). Per process.
_RESUME_EVERY_S = 6 * 3600.0
_RESUME_RETRY_S = 600.0
_resume_window: dict[str, float] = {}


def _upload_ttl_s(now: float | None = None) -> int:
    from backend import r2_setup, storage
    now = time.monotonic() if now is None else now
    if now < _resume_window.get("next", float("-inf")):
        return int(_resume_window["ttl"])
    try:
        rules = storage._client().get_bucket_lifecycle_configuration(
            Bucket=storage.bucket()).get("Rules") or []
        known = True
    except Exception as e:
        known = "NoSuchLifecycleConfiguration" in str(e)
        rules = []
    abort_days, expire_days = r2_setup.uploads_retention_days(rules)
    ttl = upl.resume_window_s(known, abort_days, expire_days)
    if ttl != _resume_window.get("ttl"):
        print(f"[upload] resumable for {ttl / 3600:.0f} h "
              + (f"(bucket: abort after {abort_days} d, expire after "
                 f"{expire_days} d)" if known
                 else "(the bucket's lifecycle rules can't be read)"),
              flush=True)
    _resume_window.update(
        ttl=ttl, next=now + (_RESUME_EVERY_S if known else _RESUME_RETRY_S))
    return ttl


def _check_init_rate(user: User | None, request: Request) -> str | None:
    """Count one multipart init of this caller (429 too_many_uploads past
    the limit). Returns the key it was counted under (None: no limit),
    for _INIT_RATE.refund when the init then fails."""
    limit = _init_limit()
    if limit <= 0:
        return None
    _INIT_RATE.limit = limit
    who = (f"u:{user.id}" if user is not None
           else f"ip:{request.client.host if request.client else ''}")
    if not _INIT_RATE.allow(who):
        raise ApiRefusal(429, "too_many_uploads",
                         headers={"Retry-After": "600"})
    return who


# ── Upload refusals, recorded ────────────────────────────────────────
# Every refusal of the upload routes (multipart init / sign / complete,
# presign, POST /jobs) is one upload_refused row in job_events (kept
# EVENTS_KEEP_DAYS; GET /admin/capacity shows the newest): the code, the
# upload's size and length, the disk numbers and what is in flight here
# — so a refusal on production can be explained afterwards without the
# logs. Identity only as a keyed hash ("who"), like no other user data.
# At most 120 rows a minute (a refusal loop can't flood the table).
_REFUSAL_EVENTS = upl.RateLimit(120, 60.0)
# Answers of the upload protocol's normal flow, not refusals.
_NOT_REFUSALS = frozenset({"use_single_put", "parts_missing"})


def _who(user: User | None) -> str:
    """A stable, non-reversible tag of the caller for upload_refused."""
    if user is None:
        return "anon"
    if user.is_service:
        return "service"
    try:
        secret = _ticket_secret()
    except Exception:
        secret = "cleo-upload-refusals"
    return hmac.new(secret.encode(), f"refusal:{user.id}".encode(),
                    hashlib.sha256).hexdigest()[:12]


def _gb(n: float | None) -> float | None:
    return None if n is None else round(float(n) / 1e9, 3)


def _record_refusal(where: str, exc: BaseException, user: User | None,
                    size: float | None = None,
                    seconds: float | None = None) -> None:
    """One upload_refused event for `exc` (an ApiRefusal / HTTPException
    an upload route answers with). Never raises."""
    try:
        status = int(getattr(exc, "status", None)
                     or getattr(exc, "status_code", 0) or 0)
        code, _ = errors.http_code(status, getattr(exc, "detail", None))
        if status < 400 or status == 401 or code in _NOT_REFUSALS:
            return
        if not _REFUSAL_EVENTS.allow("all"):
            return
        data: dict[str, Any] = {
            "where": where, "code": code, "status": status,
            "size_gb": _gb(size) if size else None,
            "seconds": round(float(seconds), 1) if seconds else None,
            "who": _who(user), **_INFLIGHT.counts()}
        if isinstance(exc, DiskRefusal):
            data.update(free_gb=_gb(exc.free), reserved_gb=_gb(exc.reserved),
                        need_gb=_gb(exc.need))
        else:
            try:
                data["free_gb"] = _gb(shutil.disk_usage(_TMP_ROOT).free)
            except OSError:
                pass
        _record_event("upload_refused", None, test=False, **data)
    except Exception as e:
        print(f"[events] upload_refused not recorded: {e}", flush=True)


@contextmanager
def _refusals(where: str, user: User | None, size: Any = None,
              seconds: Any = None):
    """Record the refusal a (sync) upload route raises, then re-raise."""
    try:
        yield
    except (ApiRefusal, HTTPException) as e:
        _record_refusal(where, e, user, _to_float(size or 0) or None,
                        _to_float(seconds or 0) or None)
        raise


@app.post("/uploads/multipart/init")
def multipart_init(payload: dict, request: Request,
                   user: User | None = Depends(current_user)):
    """Start a resumable upload: {filename, content_type, size, duration?,
    resolution?} → {ticket, storage_key, part_size, parts_total,
    expires_at, parts: [{part_number, url}] (the first up to 8)}. Refuses
    like /uploads/presign, in the same order: 402, 413, 429 / 503
    server_busy, 507, 503 without R2; then 429 too_many_uploads (+
    Retry-After) past CLEO_UPLOAD_INITS_PER_HOUR (an init that fails
    after it doesn't count); 409 use_single_put unless
    CLEO_UPLOAD_MODE=multipart. A resume never inits again (/parts with
    the saved ticket)."""
    with _refusals("init", user, payload.get("size"), payload.get("duration")):
        return _multipart_init(payload, request, user)


def _multipart_init(payload: dict, request: Request, user: User | None):
    from backend import storage
    _require_multipart()
    duration = _to_float(payload.get("duration") or 0)
    _paywall_soft_check(user, duration)
    size = _to_float(payload.get("size") or 0)
    if size <= 0 or _too_big(size):
        raise _file_too_large()
    if _too_long(duration):
        raise _video_too_long()
    if taskq.enabled():
        _queue_soft_check(user)
        _queue_disk_check(size, duration or None, payload.get("resolution"))
    else:
        _INFLIGHT.check(user)
        _INFLIGHT.reserve_disk(None, size, seconds=duration or None,
                               resolution=payload.get("resolution"))
    if not storage.r2_available():
        raise _no_direct_upload()
    counted = _check_init_rate(user, request)
    size = int(size)
    ps, n = upl.part_plan(size)
    key = (auth.upload_prefix(user) + uuid.uuid4().hex
           + upl.upload_ext(payload.get("filename")))
    ct = upl.upload_content_type(payload.get("content_type"))
    try:
        upload_id = _storage_call("CreateMultipartUpload",
                                  storage.mpu_create, key, ct)
    except BaseException:
        # Nothing was opened: the caller's next try isn't one more upload.
        if counted is not None:
            _INIT_RATE.refund(counted)
        raise
    exp = int(time.time() + _upload_ttl_s())
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
    with _refusals("sign", user):
        return _multipart_sign(payload, user)


def _multipart_sign(payload: dict, user: User | None):
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
    with _refusals("complete", user):
        return _multipart_complete(payload, user)


def _multipart_complete(payload: dict, user: User | None):
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
    with _refusals("presign", user, payload.get("size"),
                   payload.get("duration")):
        return _presign_upload(payload, user)


def _presign_upload(payload: dict, user: User | None):
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
    if taskq.enabled():
        _queue_soft_check(user)
        if size > 0:
            _queue_disk_check(size, duration or None, payload.get("resolution"))
    else:
        _INFLIGHT.check(user)
        if size > 0:
            _INFLIGHT.reserve_disk(None, size, seconds=duration or None,
                                   resolution=payload.get("resolution"))
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

    Refusals (see presign): 413 file_too_large / video_too_long, 400
    no_audio (the probe read the streams and none is audio — before any
    charge), 429 too_many_active_jobs, 503 server_busy + Retry-After,
    507 server_storage_full. The upload is thrown away only when retrying
    can't help (402, 400, 413). When the analysis has to wait for a
    slot the job comes back as status "processing", message "queued"
    with its queue_position.
    """
    # The upload's size / length as far as known, for upload_refused.
    ctx: dict[str, Any] = {"seconds": _to_float(duration or 0) or None}
    try:
        return await _create_job(file, settings, storage_key, filename,
                                 preset_id, preset_label, duration, user, ctx)
    except (ApiRefusal, HTTPException) as e:
        await run_in_threadpool(_record_refusal, "jobs", e, user,
                                ctx.get("size"), ctx.get("seconds"))
        raise


async def _create_job(file: UploadFile | None, settings: str,
                      storage_key: str | None, filename: str | None,
                      preset_id: str | None, preset_label: str | None,
                      duration: str | None, user: User | None,
                      ctx: dict[str, Any]) -> dict:
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
                                    preset_label, user, ctx=ctx)
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
                                    client_duration, ctx=ctx)
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
    ctx: dict[str, Any] | None = None,
) -> dict:
    """POST /jobs after the settings / key checks: admission, caps,
    duration, charge, job row, analysis thread. `ctx` gets the upload's
    size and length as they become known (for upload_refused).

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

    ctx = {} if ctx is None else ctx
    refusal: str | None = None
    input_path: str | None = None
    # Our own copy of a legacy body in the media store: dropped on any
    # refusal or failure (nobody can retry with it).
    own_key: str | None = None
    job_id = new_job_id()
    job = None
    # 429 / 503 before anything moves; the upload is kept for a retry.
    queue = taskq.enabled()
    token: str | None = None
    if queue:
        await run_in_threadpool(_queue_soft_check, user)
    else:
        token = _INFLIGHT.admit(user)
    # Nothing between admit and this try: its finally releases the token.
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
            ctx["size"] = size
            if _too_big(size):
                await run_in_threadpool(_discard_upload, None, storage_key)
                raise _file_too_large()
            seconds, has_audio, has_video = await _probe_upload(storage_key)
            if seconds is None and client_duration:
                seconds = client_duration
            if seconds:
                ctx["seconds"] = seconds
            # The analysis downloads + normalizes it in its workspace:
            # sized by its length when known (_disk_need), so after the
            # header probe; the upload stays for a retry on 507.
            disk_seconds = seconds
            disk = dict(seconds=seconds, resolution=parsed.get("resolution"),
                        smartcam=pipeline.smartcam_plan(parsed)[0])
            if queue:
                await run_in_threadpool(functools.partial(
                    _queue_disk_check, size, **disk))
            else:
                await run_in_threadpool(functools.partial(
                    _INFLIGHT.reserve_disk, token, size, None, **disk))
        else:
            size = _upload_size(file)
            ctx["size"] = size
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
            if queue:
                await run_in_threadpool(_queue_disk_check, size or 0)
            else:
                await run_in_threadpool(_INFLIGHT.reserve_disk, token,
                                        size or 0, input_path)
            await run_in_threadpool(_copy_upload, file, input_path)
            seconds = await run_in_threadpool(_probe_duration, input_path)
            disk_seconds = seconds  # measured (packet scan): the cut too
            has_audio, has_video = await run_in_threadpool(_probe_streams,
                                                           input_path)

        if _too_long(seconds):
            await run_in_threadpool(_discard_upload, input_path, storage_key)
            input_path = None
            raise _video_too_long()
        # Content the analysis can't use, refused before the claim and the
        # charge — 0 minutes, and the upload goes (a retry can't help):
        # an audio file (no_video), a video without a sound track
        # (nothing to transcribe: no_audio), a clip too short to cut.
        content_refusal: ApiRefusal | None = None
        if has_video is False:
            content_refusal = ApiRefusal(400, "no_video")
        elif has_audio is False:
            content_refusal = ApiRefusal(400, "no_audio")
        elif _too_short(seconds):
            content_refusal = ApiRefusal(
                400, "video_too_short", min_seconds=_plain(_min_seconds()))
        if content_refusal is not None:
            await run_in_threadpool(_discard_upload, input_path, storage_key)
            input_path = None
            raise content_refusal

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
                    task_worker.limit_to_length(parsed, seconds)
            if disk_seconds:
                # Billed or not: the disk was reserved for this length
                # (_disk_need), the uploader's claim — the analysis
                # (mezz, proxy, transcript) stops there.
                task_worker.limit_to_length(parsed, disk_seconds)
            # Never more than CLEO_MAX_MINUTES, billed or not: the length
            # this was accepted with may be the uploader's claim.
            _cap_settings(parsed)
            # Accepted: the claim becomes the job.
            if queue:
                # ... with its ingest task, after the binding admission
                # checks, in one transaction (the task queue).
                outcome = await run_in_threadpool(functools.partial(
                    _queue_admit, job_id, user, parsed, plan, seconds, size,
                    source_key))
                if outcome == "too_many_active_jobs":
                    refusal = outcome
                    raise ApiRefusal(429, outcome)
                if outcome == "server_busy":
                    refusal = outcome
                    raise _server_busy()
                if outcome != "ok":
                    raise RuntimeError(f"job {job_id} vanished while its "
                                       "upload was being accepted")
            elif not await run_in_threadpool(functools.partial(
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
                                    own_key, (refusal or "create_failed")
                                    if charged else None)
            input_path = own_key = None
            raise
        claimed.settings, claimed.plan = parsed, plan
        job = claimed
        if queue:
            # The leader dispatches it (woken by the enqueue); answer
            # with its place in line when it has to wait.
            task = await run_in_threadpool(_tasks().active_task, job.id,
                                           "ingest")
            pos = await run_in_threadpool(
                _queue_position_now, task.id if task else None, "ingest")
            job = await run_in_threadpool(store.get, job.id) or job
            out = job.to_dict()
            if pos is not None:
                out["queue_position"] = pos
            return {"job_id": job.id, **out}
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
                **errors.stage("queued"), queue_position=pos))
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
        if token is not None:
            _INFLIGHT.release(token)


# The duration probe (ffprobe over a presigned URL, header only) runs in
# a pool of its own, never in the default threadpool: a slow storage
# answer can't starve the API's other requests.
_PROBE_POOL = ThreadPoolExecutor(
    max_workers=max(1, _env_int("CLEO_PROBE_WORKERS", 4)),
    thread_name_prefix="probe")


def _audio_verdict(streams: Any) -> bool | None:
    """From ffprobe's stream list: True = there is a sound track, False =
    streams were read and none is audio (a screen recording without a
    mic, a video exported without sound), None = unknown (nothing could
    be read) — only a clear False refuses an upload (no_audio)."""
    if not isinstance(streams, list) or not streams:
        return None
    kinds = {s.get("codec_type") for s in streams if isinstance(s, dict)}
    return "audio" in kinds


def _video_verdict(streams: Any) -> bool | None:
    """From ffprobe's stream list: True = there is a picture, False =
    streams were read and none is video (an audio file; its cover art —
    an attached picture — doesn't count), None = unknown. Only a clear
    False refuses an upload (no_video)."""
    if not isinstance(streams, list) or not streams:
        return None
    for s in streams:
        if not isinstance(s, dict) or s.get("codec_type") != "video":
            continue
        disp = s.get("disposition") if isinstance(s.get("disposition"), dict) else {}
        if not disp.get("attached_pic"):
            return True
    return False


# One ffprobe run tells length, sound and picture.
_PROBE_ENTRIES = "stream=codec_type:stream_disposition=attached_pic"


def _probe_streams(path: str) -> tuple[bool | None, bool | None]:
    """(has a sound track, has a picture) of a local upload
    (_audio_verdict, _video_verdict)."""
    from src.ffmpeg_utils import get_ffprobe_path
    try:
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-show_entries",
             _PROBE_ENTRIES, "-of", "json", path],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    if r.returncode != 0:
        return None, None
    try:
        streams = json.loads(r.stdout or "{}").get("streams")
    except (ValueError, AttributeError):
        return None, None
    return _audio_verdict(streams), _video_verdict(streams)


def _probe_audio(path: str) -> bool | None:
    """Does a local upload have a sound track? (_audio_verdict)"""
    return _probe_streams(path)[0]


def _probe_remote(url: str) -> tuple[float | None, bool | None, bool | None]:
    """(length, has a sound track, has a picture) of a remote file from
    its container header, in one ffprobe run: a few ranged GETs (moov at
    the end of an MP4 included), no packet scan — that would read the
    whole object. The length is None if the header doesn't say (streamed
    WebM), the verdicts as _audio_verdict / _video_verdict; all None if
    nothing can be read within 20 s."""
    from src.ffmpeg_utils import get_ffprobe_path
    nothing = (None, None, None)
    try:
        r = subprocess.run(
            [get_ffprobe_path(), "-v", "error", "-rw_timeout", "15000000",
             "-show_entries", f"format=duration:{_PROBE_ENTRIES}",
             "-of", "json", url],
            capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return nothing
    if r.returncode != 0:
        return nothing
    try:
        data = json.loads(r.stdout or "{}")
    except ValueError:
        return nothing
    if not isinstance(data, dict):
        return nothing
    fmt = data.get("format") if isinstance(data.get("format"), dict) else {}
    dur = _to_float(str(fmt.get("duration") or 0))
    streams = data.get("streams")
    return ((dur if dur > 0 else None), _audio_verdict(streams),
            _video_verdict(streams))


async def _probe_upload(key: str
                        ) -> tuple[float | None, bool | None, bool | None]:
    """_probe_remote of an upload in R2 (over a presigned GET)."""
    try:
        url = media.presign_get(key)
    except Exception as e:
        print(f"[jobs] presign for the probe of {key} failed: {e}", flush=True)
        return None, None, None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_PROBE_POOL, _probe_remote, url)


def _is_admin(user: User | None) -> bool:
    """The caller may see a job's raw error text (Job.to_dict): the
    service user (X-Admin-Token, backend/auth.py)."""
    return user is not None and user.is_service


# Fields of GET /jobs rows (the Library's server-side list).
_LIST_FIELDS = (
    "id", "status", "message", "progress", "error", "error_code",
    "error_params", "refunded", "stage", "stage_params",
    "filename", "preset_id",
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


# GET /jobs?fields=summary (UX12): what a Projects tile shows — no
# outputs or hook clips (the tile's menu asks GET /jobs/{id} for those).
_SUMMARY_FIELDS = (
    "id", "status", "message", "progress", "error_code", "error_params",
    "refunded", "stage", "stage_params", "queue_position", "filename",
    "title", "preset_id", "preset_label", "created_at", "updated_at",
    "expires_at", "has_output", "duration",
)


@app.get("/jobs")
def list_jobs(request: Request, fields: str = "",
              user: User = Depends(require_user)):
    """The caller's projects, newest first — all of them: the Projects
    page shows this list as the projects of every device (404
    not_available while accounts are off — the frontend keeps its
    localStorage list then). Beta jobs show up once claimed (POST
    /me/claim, or any /jobs/{id} request).

    `?fields=summary` (UX12): the slim rows of the Projects tiles
    (_SUMMARY_FIELDS), with a weak ETag — send it back as If-None-Match
    and an unchanged list is an empty 304. Without it: the full rows
    (_LIST_FIELDS) as before."""
    rows = (store.list_all() if user.is_service else
            _owner_jobs(user.id))
    rows.sort(key=lambda j: j.created_at or j.updated_at, reverse=True)
    out = []
    admin = _is_admin(user)
    keys = _SUMMARY_FIELDS if fields == "summary" else _LIST_FIELDS
    for job in rows:
        d = job.to_dict(admin=admin)
        out.append({k: d.get(k) for k in keys})
    if fields != "summary":
        return out
    raw = json.dumps(out, separators=(",", ":")).encode()
    etag = f'W/"{hashlib.sha1(raw).hexdigest()}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match", ""), etag):
        return Response(status_code=304, headers=headers)
    return Response(content=raw, media_type="application/json",
                    headers=headers)


# GET /jobs/status: at most this many ids per call.
_STATUS_MAX_IDS = 50


def _as_dict(value: Any) -> dict:
    """A status row's object field (nested JSON text in some rows)."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return dict(value) if isinstance(value, dict) else {}


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
        code = row.get("error_code")
        params = _as_dict(row.get("error_params"))
        message = row["message"]
        if row["status"] == "error" and not _is_admin(user):
            message = errors.public_text(code, params)
        jobs.append({
            "id": job_id,
            "status": row["status"],
            "message": message,
            "progress": row["progress"],
            "queue_position": row["queue_position"],
            # The raw text only for admins (Job.to_dict).
            "error": (row["error"] if _is_admin(user)
                      else errors.public_error(row["error"], code, params)),
            "error_code": code,
            "error_params": params,
            "refunded": row.get("refunded"),
            "stage": row.get("stage"),
            "stage_params": _as_dict(row.get("stage_params")),
            "has_output": has_output,
            "updated_at": row["updated_at"] or None,
            "preview_version": row["preview_version"],
            # UX12: the Projects tile (name, length, lifetime).
            "title": row.get("title"),
            "duration": row.get("duration") or None,
            "created_at": row.get("created_at") or None,
            "expires_at": expiry_time(row.get("plan"), row["updated_at"]),
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
    queue_position, error (its code unless admin), error_code,
    error_params, refunded, stage, stage_params, has_output, updated_at,
    preview_version, title, duration, created_at, expires_at}],
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
    return _job_out(get_owned_job(job_id, user), user)


# ── Edit document (UT3) ──────────────────────────────────────────────
# job.doc (backend/doc.py) is built at analysis end for new jobs. GET it
# in review (editable) or later (read-only); PATCH it in review with the
# client's revision rule: base_rev must be the stored rev (409 stale_rev:
# another tab or device saved meanwhile), rev must be newer.


def _doc_refusal(e: edit_doc.DocError) -> ApiRefusal:
    return ApiRefusal(e.status, e.code, **e.extra)


def _no_doc(job: Job) -> ApiRefusal:
    if job.status in ("pending", "processing"):
        return ApiRefusal(409, "doc_not_ready")
    return ApiRefusal(404, "no_doc")


@app.get("/jobs/{job_id}/doc")
def get_doc(job_id: str, user: User | None = Depends(current_user)):
    """{doc, rev, read_only}. 409 doc_not_ready while the analysis runs,
    404 no_doc for a job analysed before the doc existed."""
    job = get_owned_job(job_id, user)
    if job.doc is None:
        raise _no_doc(job)
    doc = job.doc
    # UX10: a doc from before hid the words of every filler range; they
    # become cut: "filler" words (captioned once a clip plays them) — on
    # the first read, stored under the row lock while in review.
    words, changed = edit_doc.migrate_cut_words(list(doc.get("words") or []))
    if changed:
        doc = {**doc, "words": words}
        if job.status == "awaiting_review":
            def _migrate(cur: Job) -> dict | None:
                if cur.doc is None or cur.status != "awaiting_review":
                    return None
                ws, ch = edit_doc.migrate_cut_words(list(cur.doc.get("words") or []))
                return {"doc": {**cur.doc, "words": ws}} if ch else None
            store.modify(job_id, _migrate)
    return {"doc": doc, "rev": job.doc_rev,
            "read_only": job.status != "awaiting_review",
            **_doc_captions(job)}


def _doc_captions(job: Job) -> dict[str, Any]:
    """What the editor's caption layer and Style panel need (UT5):
    caption_engine — "v2" / "v1" (pinned or the server's mode) or
    "optin" (the browser's ?captions=v2 decides); render_style — the
    style an export draws right now (captions_v2.style_for: before the
    first editor save a v1 caption_preset still decides the look);
    presets_live — the presets the Style panel offers and PATCH accepts;
    recommended — the top three for this transcript (doc.recommended)."""
    doc = job.doc or {}
    lang = doc.get("language") or job.language
    aspect = (doc.get("format") or {}).get("aspect")
    try:
        wps = edit_doc.words_per_second(doc.get("words") or [], job.segments)
    except Exception:
        wps = None
    style = captions_v2.style_for(job)
    return {
        "caption_engine": captions_v2.editor_engine(job),
        "render_style": style,
        "presets_live": edit_doc.live_presets(),
        "recommended": [p for p in edit_doc.recommended(lang, aspect, wps, style["presetId"])
                        if p != "none"][:3],
    }


def _doc_state_refusal(job: Job) -> ApiRefusal | None:
    if job.doc is None:
        return _no_doc(job)
    if job.status != "awaiting_review":
        return ApiRefusal(409, "doc_read_only", job_status=job.status)
    return None


@app.patch("/jobs/{job_id}/doc")
async def patch_doc(job_id: str, request: Request,
                    user: User | None = Depends(current_user)):
    """{base_rev, rev, style?, format?, words?: {upsert: [Word], delete:
    [id]}} → {rev}. Small by design (the debounced autosave and the
    unload flush): bodies over 64 KB are refused (413 doc_patch_too_large).
    Validation (backend/doc.py apply_patch): ≤ 50 000 words, starts in
    order, a known live preset or v1 alias, overrides in range."""
    raw = await request.body()
    if len(raw) > edit_doc.MAX_PATCH_BYTES:
        raise ApiRefusal(413, "doc_patch_too_large",
                         max_bytes=edit_doc.MAX_PATCH_BYTES)
    try:
        payload = json.loads(raw or b"null")
    except (ValueError, UnicodeDecodeError):
        raise ApiRefusal(400, "invalid_json")
    return await run_in_threadpool(_patch_doc, job_id, payload, user)


def _patch_doc(job_id: str, payload: Any, user: User | None) -> dict:
    job = get_owned_job(job_id, user)
    refusal = _doc_state_refusal(job)
    if refusal is not None:
        raise refusal
    try:  # validation outside the row lock
        prep = edit_doc.prepare_patch(payload, edit_doc.live_presets())
    except edit_doc.DocError as e:
        raise _doc_refusal(e)
    outcome: dict[str, Any] = {}

    def change(cur: Job) -> dict | None:
        if _doc_state_refusal(cur) is not None:
            outcome["refusal"] = _doc_state_refusal(cur)
            return None
        try:
            doc, rev = edit_doc.apply_prepared(cur.doc, cur.doc_rev, prep,
                                               duration=cur.duration)
        except edit_doc.DocError as e:
            outcome["refusal"] = _doc_refusal(e)
            return None
        outcome["rev"] = rev
        return {"doc": doc, "doc_rev": rev}
    store.modify(job_id, change)
    if "refusal" in outcome:
        raise outcome["refusal"]
    if "rev" not in outcome:  # deleted meanwhile
        raise HTTPException(404, "job not found")
    return {"rev": outcome["rev"]}


# ── One span transcribed on demand (backlog #20, backend/span_transcribe.py)
_SPAN_RATE = upl.RateLimit(span_tx.RATE_PER_MIN, 60.0)
_SPAN_LOCKS: OrderedDict[str, threading.Lock] = OrderedDict()
_SPAN_LOCKS_GUARD = threading.Lock()


def _span_lock(job_id: str) -> threading.Lock:
    """One span transcription per job at a time (a second call while one
    runs is refused: 409 busy, Retry-After)."""
    with _SPAN_LOCKS_GUARD:
        lock = _SPAN_LOCKS.pop(job_id, None) or threading.Lock()
        _SPAN_LOCKS[job_id] = lock
        while len(_SPAN_LOCKS) > 256:
            _SPAN_LOCKS.popitem(last=False)
        return lock


def _span_answer(doc: dict, span: dict, rev: float, changed: bool) -> dict:
    return {"words": span_tx.words_in(doc, span["start"], span["end"]),
            "rev": rev, "changed": changed}


@app.post("/jobs/{job_id}/transcribe-span")
def transcribe_span(job_id: str, payload: Any = Body(...),
                    user: User | None = Depends(current_user)):
    """{start, end, base_rev, rev} → {words, rev, changed}: the words of
    one span of the recording (SOURCE seconds, ≤ 60 s) that the edit doc
    has none for, transcribed now and merged into the doc with the
    PATCH /jobs/{id}/doc revision rule (409 stale_rev). Same owner and
    state rules as the doc routes (in review only). Idempotent (module
    doc of backend/span_transcribe.py); at most span_tx.RATE_PER_MIN
    calls a minute (429 too_many_requests). Never charged: billing is
    off for it (no minutes, no credits)."""
    job = get_owned_job(job_id, user)
    refusal = _doc_state_refusal(job)
    if refusal is not None:
        raise refusal
    try:
        span = span_tx.parse(payload, job.duration)
    except span_tx.SpanError as e:
        raise ApiRefusal(e.status, e.code, **e.extra)
    if not _SPAN_RATE.allow(_uid(user) or f"job:{job_id}"):
        raise ApiRefusal(429, "too_many_requests", headers={"Retry-After": "60"})
    lock = _span_lock(job_id)
    # never wait for another span of this job: a request thread is held
    # for its ffmpeg + Groq time at most once (the editor retries later)
    if not lock.acquire(blocking=False):
        raise ApiRefusal(409, "busy", headers={"Retry-After": "5"})
    try:
        job = get_owned_job(job_id, user)
        refusal = _doc_state_refusal(job)
        if refusal is not None:
            raise refusal
        done = span_tx.covered(job.doc, span["start"], span["end"])
        if done is not False:
            # this very request committed before (its answer was lost)
            mine = (isinstance(done, list) and done[2] == span["base_rev"]
                    and done[3] == float(job.doc_rev or 0))
            return _span_answer(job.doc, span, float(job.doc_rev or 0), mine)
        key = job.proxy_key or job.mezz_key
        if not key:
            raise ApiRefusal(409, "media_expired")
        where = media.store_of(job)
        cached = _proxy_cache_dir() / f"{job_id}.mp4"
        if where == "local":
            source = str(media.local_path(key))
        elif job.proxy_key and cached.is_file():
            source = str(cached)
        else:
            if not storage.r2_available():
                raise ApiRefusal(503, "storage_unavailable",
                                 headers={"Retry-After": "60"})
            source = media.presign_get(key)
        language = ((job.settings or {}).get("spoken_language")
                    or (job.doc or {}).get("language") or None)
        try:
            raw, offset = span_tx.transcribe(source, span, language, job.duration)
        except span_tx.SpanError as e:
            raise ApiRefusal(e.status, e.code, **e.extra)
        outcome: dict[str, Any] = {}

        def change(cur: Job) -> dict | None:
            refused = _doc_state_refusal(cur)
            if refused is not None:
                outcome["refusal"] = refused
                return None
            words = span_tx.new_words(raw, offset, span["start"], span["end"], cur.doc)
            try:
                doc, rev = span_tx.commit(cur.doc, cur.doc_rev, span, words,
                                          cur.duration)
            except edit_doc.DocError as e:
                outcome["refusal"] = _doc_refusal(e)
                return None
            outcome["doc"], outcome["rev"] = doc, rev
            return {"doc": doc, "doc_rev": rev}
        store.modify(job_id, change)
        if "refusal" in outcome:
            raise outcome["refusal"]
        if "rev" not in outcome:  # deleted meanwhile
            raise HTTPException(404, "job not found")
    finally:
        lock.release()
    print(f"[span] {job_id}: {span['start']:.2f}-{span['end']:.2f}s "
          f"→ {len(span_tx.words_in(outcome['doc'], span['start'], span['end']))} "
          f"word(s)", flush=True)
    return _span_answer(outcome["doc"], span, outcome["rev"], True)


# A project name (PATCH /jobs/{id} {title}): at most this many characters.
_TITLE_MAX = 120


def _clean_title(value: Any) -> str | None:
    """A title as stored: trimmed, control characters dropped, at most
    _TITLE_MAX characters; "" or null = back to the file name (None)."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ApiRefusal(400, "invalid_title")
    # Line breaks and tabs are spaces; other control and format
    # characters go — except the joiners and the emoji variation selector
    # that scripts and emoji need (ZWNJ U+200C, ZWJ U+200D, VS16 U+FE0F).
    text = "".join(
        " " if c in "\n\r\t" else c for c in value
        if c.isprintable() or c in "\n\r\t " or c in _TITLE_KEEP)
    text = " ".join(text.split())[:_TITLE_MAX].strip()
    return text or None


# Format characters (not str.isprintable) a title keeps.
_TITLE_KEEP = frozenset("\u200c\u200d\ufe0f")


@app.patch("/jobs/{job_id}")
def patch_job(job_id: str, payload: dict,
              user: User | None = Depends(current_user)):
    """{title?, caption_style?} (at least one).

    title (UX12): the project's name — any status; "" or null resets it
    to the file name. caption_style: a preset id (or v1 alias) or
    {presetId, overrides}. Accepted while the job waits or is analysed
    (the doc build at analysis end reads it: settings.caption_style) and
    in review (for a doc no editor saved yet, the doc's style too).
    Returns the job."""
    job = get_owned_job(job_id, user)
    allowed = {"caption_style", "title"}
    if set(payload) - allowed or not set(payload) & allowed:
        raise ApiRefusal(400, "unknown_field",
                         field=sorted(set(payload) - allowed
                                      or {"caption_style"})[0])
    title = _clean_title(payload["title"]) if "title" in payload else None
    style = None
    if "caption_style" in payload:
        try:
            style = edit_doc.validate_style(payload["caption_style"])
        except edit_doc.DocError as e:
            raise _doc_refusal(e)
    editable = ("pending", "processing", "awaiting_review")
    if style is not None and job.status not in editable:
        raise ApiRefusal(409, "not_editable", job_status=job.status)
    refused: list[str] = []

    def change(cur: Job) -> dict | None:
        out: dict[str, Any] = {}
        if "title" in payload:
            out["title"] = title
            # A rename while the job runs (the statuses the orphan sweep,
            # _sweep_orphaned_jobs, checks) is housekeeping: updated_at
            # stays. In any other status it counts as activity and moves
            # the expiry later.
            if style is None and cur.status in RUNNING_STATUSES:
                out["updated_at"] = cur.updated_at
        if style is not None:
            if cur.status not in editable:
                refused.append(cur.status)
                return None
            out["settings"] = {**(cur.settings or {}), "caption_style": style}
            if (cur.status == "awaiting_review" and cur.doc is not None
                    and not cur.doc_rev):
                out["doc"] = {**cur.doc, "style": style}
        return out
    store.modify(job_id, change)
    if refused:
        raise ApiRefusal(409, "not_editable", job_status=refused[0])
    return get_owned_job(job_id, user).to_dict()


@app.post("/jobs/{job_id}/fonts/refresh")
def refresh_fonts(job_id: str, user: User | None = Depends(current_user)):
    """Re-subset the job's CJK caption font when the doc's text holds
    characters the current subset lacks (an edit added them; the client
    debounces). → {font_subsets} (as in GET /jobs/{id})."""
    job = get_owned_job(job_id, user)
    if job.doc is None:
        raise _no_doc(job)
    font_id = font_subset.font_for(job.doc.get("language"))
    text = font_subset.text_of(job.doc.get("words"))
    current = dict(job.font_subsets or {})
    if not font_id or font_subset.covers(current.get(font_id), text):
        return {"font_subsets": font_subset.public(current)}
    subsets = font_subset.refresh(store, job_id, job, text,
                                  _workspace(job_id, "fonts"))
    return {"font_subsets": font_subset.public(subsets)}


@app.get("/jobs/{job_id}/fonts/{name}")
def job_font(job_id: str, name: str, user: User | None = Depends(media_user)):
    """A file of the job's CJK caption font subset (woff2, ttf, metrics
    json) by the name font_subsets / the metrics name it."""
    job = get_owned_job(job_id, user)
    hit = font_subset.key_of(job.font_subsets, name)
    if hit is None:
        raise HTTPException(404, "font_not_found")
    return _media(job, hit[0], hit[1], "font_not_found",
                  cache="private, max-age=604800, immutable")


@app.get("/jobs/{job_id}/peaks")
def job_peaks(job_id: str, user: User | None = Depends(media_user)):
    """peaks.bin: the mezz audio's 100 Hz RMS envelope, one int8 per 10 ms
    (0 = −96 dBFS … 127 = full scale; `peaks` in GET /jobs/{id})."""
    job = get_owned_job(job_id, user)
    if not job.peaks_key:
        raise HTTPException(404, "peaks_not_ready")
    # The body itself, also for R2 jobs (UX10): the editor fetch()es it
    # from the web origin, and a fetch that follows the 307 to R2 is
    # refused by the bucket's CORS (Origin: null). 100 bytes a second:
    # PEAKS_MAX_BYTES covers far more than the longest upload.
    where = media.store_of(job)
    if where == "r2" and not storage.r2_available():
        raise ApiRefusal(503, "storage_unavailable", headers={"Retry-After": "60"})
    try:
        return media.small_response(job.peaks_key, media_type="application/octet-stream",
                                    max_bytes=PEAKS_MAX_BYTES, store=where,
                                    cache="private, max-age=604800, immutable")
    except FileNotFoundError:
        raise HTTPException(409, "peaks_not_ready")
    except ValueError:
        raise HTTPException(404, "peaks_not_ready")


# peaks.bin is 100 bytes per second of audio: 8 MB ≈ 22 hours.
PEAKS_MAX_BYTES = 8 * 1024 * 1024


@app.get("/jobs/{job_id}/poster")
def job_poster(job_id: str, user: User | None = Depends(media_user)):
    """poster.jpg: the frame at the start of the first kept clip, as the
    analysis cut it (`has_poster` in GET /jobs/{id}). The editor shows it
    until its video has a frame of its own (UT5); after the user changes
    the first clip it may be stale, which the editor knows."""
    job = get_owned_job(job_id, user)
    if not job.poster_key:
        raise HTTPException(404, "poster_not_ready")
    return _media(job, job.poster_key, "image/jpeg",
                  "poster_not_ready", cache="private, max-age=604800, immutable")


# ── Filmstrip (UX7b) ─────────────────────────────────────────────────
# The analysis makes it (pipeline.make_filmstrip, stored by
# store_analysis_extras). A job from before gets it on the first GET:
# made from its stored proxy (else mezz, via the proxy cache) in
# _FILMSTRIP_POOL, one at a time, best effort — 202 filmstrip_pending
# meanwhile, 404 filmstrip_unavailable when it can't be made (no stored
# source, or it failed here within the last _FILMSTRIP_RETRY_S).
_FILMSTRIP_POOL = ThreadPoolExecutor(max_workers=1,
                                     thread_name_prefix="filmstrip")
_FILMSTRIP_GUARD = threading.Lock()
_FILMSTRIP_BUSY: set[str] = set()
_FILMSTRIP_FAILED: dict[str, float] = {}
_FILMSTRIP_RETRY_S = 3600.0
# More waiting than this: answered pending without queueing (the
# client's next poll queues it).
_FILMSTRIP_MAX_QUEUE = 8


def _filmstrip_lazy(job_id: str) -> bool:
    """Make, store and commit the filmstrip of a job without one. True
    once the job has one. Raises on failure (the caller logs it). The
    commit is a compare-and-set: only while the job has none, its media
    is still in the store the sprite went to; a sprite the job didn't
    take is queued for deletion."""
    job = store.get(job_id)
    if job is None:
        return False
    if job.filmstrip_key:
        return True
    if not (job.proxy_key or job.mezz_key):
        raise FileNotFoundError(f"job {job_id} has no stored video")
    ws = _make_workspace(_workspace(job_id,
                                    f"filmstrip-{uuid.uuid4().hex[:8]}"))
    try:
        out = ws / pipeline.FILMSTRIP_NAME
        with _proxy_in_use(job_id):
            source = _cached_proxy(job)
            meta = pipeline.make_filmstrip(source, str(out),
                                           job.duration or None)
        if not meta:
            raise RuntimeError("the sprite could not be made")
        where = media.store_of(job)
        key = media.job_prefix(job_id) + pipeline.FILMSTRIP_NAME
        size = media.put_file(out, key, content_type="image/jpeg",
                              store=where)
    finally:
        _drop_workspace(ws)

    def _set(cur: Job) -> dict | None:
        if cur.filmstrip_key or media.store_of(cur) != where:
            return None
        return {"filmstrip_key": key, "filmstrip_meta": meta,
                "media_bytes": {**(cur.media_bytes or {}), key: size},
                # not a use of the project
                "updated_at": cur.updated_at}
    if store.modify(job_id, _set) is not None:
        return True
    cur = store.get(job_id)
    if cur is not None and cur.filmstrip_key == key \
            and media.store_of(cur) == where:
        return True     # another process stored the same key meanwhile
    _gc_later([key], store_=where)
    return False


def _filmstrip_run(job_id: str) -> None:
    try:
        if not _filmstrip_lazy(job_id):
            raise RuntimeError("not committed")
    except Exception as e:
        print(f"[filmstrip] {job_id}: lazy filmstrip failed: "
              f"{type(e).__name__}: {e}", flush=True)
        with _FILMSTRIP_GUARD:
            _FILMSTRIP_FAILED[job_id] = time.monotonic()
    finally:
        with _FILMSTRIP_GUARD:
            _FILMSTRIP_BUSY.discard(job_id)


def _filmstrip_start(job: Job) -> bool:
    """Queue the lazy filmstrip of `job` (at most once at a time). False
    when it can't be made (no stored video, failed recently)."""
    if not (job.proxy_key or job.mezz_key):
        return False
    with _FILMSTRIP_GUARD:
        failed = _FILMSTRIP_FAILED.get(job.id)
        if failed is not None:
            if time.monotonic() - failed < _FILMSTRIP_RETRY_S:
                return False
            _FILMSTRIP_FAILED.pop(job.id, None)
        if job.id in _FILMSTRIP_BUSY or \
                len(_FILMSTRIP_BUSY) >= _FILMSTRIP_MAX_QUEUE:
            return True
        _FILMSTRIP_BUSY.add(job.id)
    try:
        _FILMSTRIP_POOL.submit(_filmstrip_run, job.id)
    except Exception:
        with _FILMSTRIP_GUARD:
            _FILMSTRIP_BUSY.discard(job.id)
        raise
    return True


@app.get("/jobs/{job_id}/filmstrip")
def job_filmstrip(job_id: str, meta: int = 0,
                  user: User | None = Depends(media_user)):
    """The timeline's thumbnail sprite (JPEG, `filmstrip` in GET
    /jobs/{id}: n tiles of tileW x tileH px side by side, tile i the
    frame at i * interval s). `?meta=1`: that meta as JSON instead.
    A job without one (from before UX7b) gets it made now: 202
    filmstrip_pending (Retry-After) until it is there; 404
    filmstrip_unavailable when it can't be made."""
    job = get_owned_job(job_id, user)
    if job.filmstrip_key and job.filmstrip_meta:
        if meta:
            return JSONResponse(dict(job.filmstrip_meta),
                                headers={"Cache-Control": "private, no-cache"})
        return _media(job, job.filmstrip_key, "image/jpeg",
                      "filmstrip_unavailable",
                      cache="private, max-age=604800, immutable")
    if not _filmstrip_start(job):
        raise HTTPException(404, "filmstrip_unavailable")
    raise ApiRefusal(202, "filmstrip_pending", headers={"Retry-After": "3"})


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


@app.get("/me/prefs")
def get_my_prefs(user: User | None = Depends(current_user)):
    """The signed-in user's remembered upload defaults (backend/prefs.py;
    {} when none are saved). 404 with accounts off: the browser keeps
    them itself."""
    if user is None:
        raise HTTPException(404, "not_available")
    if user.is_service:
        return {}
    return user_prefs.get(user.id) or {}


@app.put("/me/prefs")
def put_my_prefs(payload: Any = Body(...),
                 user: User | None = Depends(current_user)):
    """Merge the given keys into the user's prefs (null removes one) and
    return them. 400 bad_prefs (with `field`) for an unknown key or a
    bad value."""
    if user is None:
        raise HTTPException(404, "not_available")
    if user.is_service:
        raise HTTPException(403, "forbidden")
    try:
        return user_prefs.put(user.id, payload)
    except user_prefs.BadPrefs as e:
        raise HTTPException(400, {"code": "bad_prefs", "field": e.field})


# POST /me/claim (UX12): ids per call, calls per minute and user.
_CLAIM_MAX_IDS = 200
_CLAIM_RATE = upl.RateLimit(10, 60.0)


def _id_like(job_id: str) -> bool:
    """Shaped like a job id (ASCII letters, digits, _ and -; ≤ 64)."""
    return 0 < len(job_id) <= 64 and all(
        c.isascii() and (c.isalnum() or c in "_-") for c in job_id)


@app.post("/me/claim")
def claim_jobs(payload: dict, user: User = Depends(require_user)):
    """{job_ids: [id, …]} (at most 200) → {claimed, owned_elsewhere,
    missing}: the projects this browser made before its user signed in
    (the anonymous beta kept them in localStorage) become the caller's.

    A job without an owner is claimed (store.claim, the same step every
    /jobs/{id} request of a signed-in user takes — the job id is the only
    key to an anonymous job); the caller's own jobs count as claimed; a
    job of another account is left alone and listed under
    owned_elsewhere; unknown ids under missing. The web drops the ids of
    the last two from its list. Idempotent; 10 calls a minute per user
    (429 too_many_requests). 404 not_available while accounts are off."""
    ids = payload.get("job_ids") if isinstance(payload, dict) else None
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise ApiRefusal(400, "invalid_payload")
    if len(ids) > _CLAIM_MAX_IDS:
        raise ApiRefusal(400, "too_many_ids", max=_CLAIM_MAX_IDS)
    if user.is_service:
        raise ApiRefusal(403, "forbidden")
    if not _CLAIM_RATE.allow(user.id):
        raise ApiRefusal(429, "too_many_requests",
                         headers={"Retry-After": "60"})
    claimed: list[str] = []
    elsewhere: list[str] = []
    missing: list[str] = []
    for job_id in dict.fromkeys(i.strip() for i in ids):
        owner = (store.claim(job_id, user.id)
                 if _id_like(job_id) else None)
        if owner is None:
            missing.append(job_id)
        elif owner == user.id:
            claimed.append(job_id)
        else:
            elsewhere.append(job_id)
    if claimed:
        print(f"[auth] {user.id} claimed {len(claimed)} job(s) "
              f"({len(elsewhere)} elsewhere, {len(missing)} missing)",
              flush=True)
    return {"claimed": claimed, "owned_elsewhere": elsewhere,
            "missing": missing}


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


def _require_admin(x_admin_token: str) -> None:
    """The /admin/* routes: CLEO_ADMIN_TOKEN sent as X-Admin-Token; 404
    while that env var is unset, 401 for a wrong token."""
    token = os.environ.get("CLEO_ADMIN_TOKEN", "")
    if not token:
        raise HTTPException(404, "not found")
    if not hmac.compare_digest(x_admin_token, token):
        raise HTTPException(401, "bad admin token")


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
    _require_admin(x_admin_token)
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


# ── Reliability metrics (the launch gates, PLAN_TECH §1.8) ────────────
# Analysis failures the video caused, not we: left out of the analysis
# success rate (they still show under by_code).
USER_CAUSED_CODES = frozenset({"no_speech", "no_audio", "no_video",
                               "video_too_short"})
# Launch gates over the window (UX18): analysis ≥ 97 %, render ≥ 98 %,
# p50 of render wall time / video length ≤ 1.
METRIC_GATES = {"analysis_success": 0.97, "render_success": 0.98,
                "render_p50_ratio": 1.0}
_METRIC_EVENTS = ("analysis_done", "analysis_failed", "render_done",
                  "render_failed")


def _percentile(values: list[float], pct: float) -> float | None:
    """Nearest-rank percentile (None for no values)."""
    if not values:
        return None
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, math.ceil(pct / 100 * len(ordered)) - 1))
    return ordered[k]


def _rate(ok: int, total: int) -> float | None:
    return round(ok / total, 4) if total else None


def metrics_summary(events: list[dict[str, Any]], *, days: float,
                    since: float, until: float) -> dict[str, Any]:
    """GET /admin/metrics from job_events rows ({kind, data, …})."""
    by_kind: dict[str, list[dict[str, Any]]] = {k: [] for k in _METRIC_EVENTS}
    for ev in events:
        if ev.get("kind") in by_kind:
            by_kind[ev["kind"]].append(ev.get("data") or {})

    def codes(rows: list[dict[str, Any]]) -> dict[str, int]:
        out: dict[str, int] = {}
        for d in rows:
            code = str(d.get("code") or "unknown")
            out[code] = out.get(code, 0) + 1
        return dict(sorted(out.items(), key=lambda kv: -kv[1]))

    a_ok = len(by_kind["analysis_done"])
    a_failed = by_kind["analysis_failed"]
    a_user = [d for d in a_failed if d.get("code") in USER_CAUSED_CODES]
    a_counted = len(a_failed) - len(a_user)
    r_ok = by_kind["render_done"]
    r_failed = by_kind["render_failed"]

    def num(d: dict[str, Any], key: str) -> float | None:
        v = d.get(key)
        return float(v) if isinstance(v, (int, float)) and v == v else None

    ratios, work_ratios, walls = [], [], []
    for d in r_ok:
        wall, work, out = num(d, "wall_s"), num(d, "work_s"), num(d, "output_s")
        if wall is not None:
            walls.append(wall)
        if out and out > 0:
            if wall is not None:
                ratios.append(wall / out)
            if work is not None:
                work_ratios.append(work / out)

    def rounded(v: float | None, n: int = 3) -> float | None:
        return round(v, n) if v is not None else None

    analysis_rate = _rate(a_ok, a_ok + a_counted)
    render_rate = _rate(len(r_ok), len(r_ok) + len(r_failed))
    p50_ratio = rounded(_percentile(ratios, 50))

    def gate(name: str, value: float | None, higher_is_better: bool) -> dict:
        target = METRIC_GATES[name]
        ok = None if value is None else (
            value >= target if higher_is_better else value <= target)
        return {"target": target, "value": value, "ok": ok}

    return {
        "days": days,
        "since": since,
        "until": until,
        "analysis": {
            "done": a_ok,
            "failed": a_counted,
            "user_caused": len(a_user),
            "success_rate": analysis_rate,
            "by_code": codes(a_failed),
        },
        "render": {
            "done": len(r_ok),
            "failed": len(r_failed),
            "success_rate": render_rate,
            "by_code": codes(r_failed),
            # Wall time from POST /render (queue included) per second of
            # rendered video; work = from the render slot on.
            "p50_ratio": p50_ratio,
            "p90_ratio": rounded(_percentile(ratios, 90)),
            "p50_work_ratio": rounded(_percentile(work_ratios, 50)),
            "p50_wall_s": rounded(_percentile(walls, 50), 1),
            "p90_wall_s": rounded(_percentile(walls, 90), 1),
            "samples": len(ratios),
        },
        # Lost-edit reports come with the feedback table (UX11/UX20).
        "lost_edit_reports": None,
        "gates": {
            "analysis_success": gate("analysis_success", analysis_rate, True),
            "render_success": gate("render_success", render_rate, True),
            "render_p50_ratio": gate("render_p50_ratio", p50_ratio, False),
        },
    }


@app.get("/admin/metrics")
def admin_metrics(days: float = 14, include_tests: bool = False,
                  x_admin_token: str = Header(default="")):
    """Reliability over the last `days` (default 14, at most
    EVENTS_KEEP_DAYS): analysis and render success rates, render wall
    time per video second (p50 / p90) and the launch gates. From the
    job_events log, so deleted jobs still count; cost-test jobs are left
    out unless include_tests. Admin only (see /admin/costs)."""
    _require_admin(x_admin_token)
    if not days == days or days <= 0:  # NaN / zero / negative
        raise HTTPException(400, "days must be positive")
    days = min(float(days), EVENTS_KEEP_DAYS)
    until = time.time()
    since = until - days * 86400
    events = store.events(since, kinds=_METRIC_EVENTS)
    if not include_tests:
        events = [e for e in events if not (e.get("data") or {}).get("test")]
    return metrics_summary(events, days=days, since=since, until=until)


@app.get("/admin/queue")
def admin_queue(x_admin_token: str = Header(default="")):
    """The task queue (WP4): per kind queued / running / limit and the
    age of the oldest waiting task, the provider breakers, this
    process's leadership. Admin only (see /admin/costs)."""
    _require_admin(x_admin_token)
    return queue_stats()


# The limits GET /admin/capacity shows (as in effect: the env value, else
# the default the code uses).
_CAPACITY_LIMITS: dict[str, Callable[[], Any]] = {
    "CLEO_DISK_FACTOR": _disk_factor,
    "CLEO_DISK_MEZZ_MBPS": _disk_mezz_mbps,
    "CLEO_DISK_PREVIEW_MBPS": _disk_preview_mbps,
    "CLEO_MIN_FREE_GB": lambda: _MIN_FREE_BYTES / 1e9,
    "CLEO_MAX_UPLOAD_GB": _max_upload_gb,
    "CLEO_MAX_MINUTES": _max_minutes,
    "CLEO_MAX_QUEUE": lambda: _env_int("CLEO_MAX_QUEUE", 20),
    "CLEO_MAX_ANALYZE": lambda: _ANALYZE_SLOTS.limit(),
    "CLEO_MAX_RENDER": lambda: _RENDER_SLOTS.limit(),
    "CLEO_MAX_ACTIVE_PER_USER": lambda: _env_int("CLEO_MAX_ACTIVE_PER_USER", 2),
    "CLEO_UPLOAD_INITS_PER_HOUR": _init_limit,
    "CLEO_UPLOAD_ENTRY_TTL_S": _upload_entry_ttl_s,
    "CLEO_PROXY_CACHE_GB": lambda: _env_float("CLEO_PROXY_CACHE_GB", 5),
    "CLEO_UPLOAD_MODE": _upload_mode,
    "CLEO_TASK_QUEUE": lambda: taskq.enabled(),
}
_REFUSAL_FIELDS = ("where", "code", "status", "size_gb", "seconds",
                   "free_gb", "reserved_gb", "need_gb", "n_upload",
                   "n_analyze", "n_render", "who")


def _disk_of(path: Path) -> dict[str, Any]:
    try:
        u = shutil.disk_usage(path)
    except OSError as e:
        return {"error": type(e).__name__}
    return {"total_gb": _gb(u.total), "used_gb": _gb(u.used),
            "free_gb": _gb(u.free)}


def capacity_report(now: float | None = None) -> dict[str, Any]:
    """GET /admin/capacity: the numbers behind upload refusals."""
    now = time.time() if now is None else now
    try:
        same = os.stat(_TMP_ROOT).st_dev == os.stat(_WORK_ROOT).st_dev
    except OSError:
        same = None
    free, others = _INFLIGHT.room()
    room = free - others - _MIN_FREE_BYTES
    # What fits right now, for a 10-minute video of these sizes (1080p).
    fits = [{"size_gb": s, "minutes": 10,
             "need_gb": _gb(_disk_need(s * 1e9, 600)),
             "fits": _disk_need(s * 1e9, 600) <= room}
            for s in (0.5, 1, 2, 3, 4)]
    # Counts per code over each whole window (grouped in the database),
    # and the 50 newest refusals (newest first).
    by_code = {label: store.event_counts(now - span, "upload_refused",
                                         "code")
               for label, span in (("24h", 86400), ("7d", 7 * 86400))}
    events = store.events(now - EVENTS_KEEP_DAYS * 86400,
                          kinds=["upload_refused"], limit=50, newest=True)
    recent = [{"at": e["at"], "age_s": round(now - e["at"]),
               **{k: (e.get("data") or {}).get(k) for k in _REFUSAL_FIELDS}}
              for e in events]
    return {
        "tmp_root": {"same_disk_as_work_root": same, **_disk_of(_TMP_ROOT)},
        "work_root": _disk_of(_WORK_ROOT),
        "reserved_gb": _gb(others),
        "room_gb": _gb(room),
        "proxy_cache_gb": _gb(_proxy_cache_bytes()),
        "fits_now": fits,
        "inflight": {**_INFLIGHT.counts(), "entries": _INFLIGHT.snapshot()},
        "init_rate": {"limit_per_hour": _init_limit(), **_INIT_RATE.stats()},
        "limits": {k: f() for k, f in _CAPACITY_LIMITS.items()},
        "refusals": {"by_code": by_code, "recent": recent},
    }


@app.get("/admin/capacity")
def admin_capacity(x_admin_token: str = Header(default="")):
    """Why uploads are refused: disk total / free of CLEO_TMP_ROOT (and
    the work root), what the jobs in flight reserve, what a 10-minute
    upload of 0.5–4 GB needs and whether it fits now, the _Inflight
    entries (kind, age, reservation, thread), the multipart-init rate
    state, the CLEO_* limits in effect and the newest 50 upload_refused
    events with counts per code. Admin only (see /admin/costs);
    .github/workflows/ops-inspect.yml prints it."""
    _require_admin(x_admin_token)
    return capacity_report()


@app.post("/admin/sentry-test")
def admin_sentry_test(x_admin_token: str = Header(default="")):
    """Send a test error to Sentry — the check that error reports arrive
    after SENTRY_DSN was set. {"sentry": false} while it is off."""
    _require_admin(x_admin_token)
    on = observability.enabled()
    if on:
        observability.capture(
            RuntimeError("CleoCuts test error (POST /admin/sentry-test)"),
            phase="sentry_test")
    return {"sentry": on, "release": observability.release()}


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str, user: User | None = Depends(current_user)):
    """Delete a project and all its files right away (user request)."""
    job = get_owned_job(job_id, user)
    # (With the task queue every job with a task in flight is
    # processing; a stale task of a settled job goes with the job — its
    # worker is fenced out.)
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
        # Its revision (the client's ms timestamp of that save, 0 = none):
        # the v2 editor compares it with the edit doc's rev to tell a
        # newer v1 edit from an older one (UX8, web state/reconcile.ts).
        "phrases_rev": job.edited_phrases_rev or 0,
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


def _exact_fps(fps: float) -> float:
    """The exact rate of a stored mezz_fps (rounded to 4 decimals):
    29.97 → 30000/1001 (also 23.976, 59.94, …), 30.0002 → 30. The twin of
    the web's timeline/mechanics.ts exactFps."""
    ntsc = round(fps * 1.001)
    if (ntsc in (24, 30, 48, 60, 120) and abs(fps * 1.001 - ntsc) < 0.002
            and abs(fps - ntsc) > 0.01):
        return ntsc * 1000 / 1001
    whole = round(fps)
    return float(whole) if abs(fps - whole) < 0.002 else fps


def _edit_edge(x: float, fps: float | None) -> float:
    """A clip edge as stored by /edit-segments: rounded to ms, except an
    edge exactly on a frame boundary k / fps of the job's mezz (the v2
    editor's released trim, UX10 review 13), which is kept as sent: only
    k / fps itself starts both the v1 burn (MoviePy) and the v2 render
    on frame k (tests/captions/test_frame_edges.py)."""
    if fps and fps > 0:
        f = _exact_fps(float(fps))
        k = round(x * f)
        if k > 0 and abs(x - k / f) < 1e-7:
            return k / f
    return round(x, 3)


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
# Job ids whose cached proxy an ffmpeg call is reading right now (count
# of readers, under _PROXY_CACHE_GUARD): never deleted from under it.
_PROXY_IN_USE: dict[str, int] = {}


@contextmanager
def _proxy_in_use(job_id: str):
    """Around _cached_proxy + the ffmpeg call reading it: the cached file
    stays (_proxy_cache_reclaim / _proxy_cache_trim skip it)."""
    with _PROXY_CACHE_GUARD:
        _PROXY_IN_USE[job_id] = _PROXY_IN_USE.get(job_id, 0) + 1
    try:
        yield
    finally:
        with _PROXY_CACHE_GUARD:
            n = _PROXY_IN_USE.get(job_id, 0) - 1
            if n > 0:
                _PROXY_IN_USE[job_id] = n
            else:
                _PROXY_IN_USE.pop(job_id, None)


def _proxy_busy(path: Path) -> bool:
    with _PROXY_CACHE_GUARD:
        return _PROXY_IN_USE.get(path.stem, 0) > 0


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
        if path == keep or _proxy_busy(path):
            continue
        path.unlink(missing_ok=True)
        total -= size


def _proxy_cache_files() -> list[tuple[float, int, Path]]:
    """(mtime, size, path) of the cached proxies, oldest first."""
    out = []
    try:
        paths = list(_proxy_cache_dir().glob("*.mp4"))
    except OSError:
        return []
    for p in paths:
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((st.st_mtime, st.st_size, p))
    return sorted(out, key=lambda e: e[0])


def _proxy_cache_bytes() -> int:
    return sum(size for _, size, _ in _proxy_cache_files())


def _proxy_reclaim_min_age_s() -> float:
    """A cached proxy used (fetched or read) more recently than this
    (CLEO_PROXY_RECLAIM_MIN_AGE_S, 10 min) is an editor session going
    on: never reclaimed for an upload."""
    return _env_float("CLEO_PROXY_RECLAIM_MIN_AGE_S", 600)


def _proxy_cache_reclaim(want: float, dry_run: bool = False) -> int:
    """An upload's disk reservation is `want` bytes short: delete cached
    proxies, oldest first, until that much is free — only when the cache
    holds enough to make it fit (otherwise nothing goes). Never one read
    right now (_proxy_in_use), used in the last
    _proxy_reclaim_min_age_s, or being fetched (its _proxy_cache_lock is
    taken for the delete). Returns the bytes freed; `dry_run` (a check
    without a reservation: presign / multipart init) deletes nothing
    and returns what could be freed."""
    if want <= 0:
        return 0
    cutoff = time.time() - _proxy_reclaim_min_age_s()
    files = [(m, size, p) for m, size, p in _proxy_cache_files()
             if m < cutoff and not _proxy_busy(p)
             and not _proxy_cache_lock(p.stem).locked()]
    reclaimable = sum(size for _, size, _ in files)
    if reclaimable < want:
        return 0
    if dry_run:
        return reclaimable
    freed = 0
    for _, size, path in files:
        if freed >= want:
            break
        lock = _proxy_cache_lock(path.stem)
        if not lock.acquire(blocking=False):
            continue   # being fetched / refreshed right now
        try:
            # Checked again under the lock: read or refreshed meanwhile.
            if _proxy_busy(path) or path.stat().st_mtime >= cutoff:
                continue
            path.unlink()
            freed += size
        except OSError:
            pass
        finally:
            lock.release()
    print(f"[jobs] proxy cache: {freed / 1e9:.2f} GB freed for an upload",
          flush=True)
    return freed


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
    ws = _make_workspace(_workspace(job_id,
                                    f"preview-{threading.get_ident()}"))
    try:
        out = ws / "preview.mp4"
        with _proxy_in_use(job_id):
            if source is None:
                source = _cached_proxy(job)
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
        cleaned.append((_edit_edge(ss, job.mezz_fps), _edit_edge(ee, job.mezz_fps)))
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
                # a scene command's cut (UX10 cut_kinds)
                "kind": "voice_cmd",
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


# ── UX11: exports after the first one (backend/exports.py) ──────────
# Re-edit (POST /reopen), fair use, the caps, the instant export of a
# speculative render, and what the Done view needs (post text, SRT /
# VTT, download names). Caption engine: the job keeps the engine its
# FIRST render pinned (UT4, review F11) through every re-edit and
# re-export — a project exported before UT4 (no pin, outputs present:
# captions_v2.exported_before) stays v1; one pinned to v2 renders v2
# again. The speculative render is a job's first render and pins it.


def _mark_stuck_and_refund() -> int:
    """WP1 boot: store.mark_stuck_as_error, and the fair-use charge of
    every export it sent back to review is refunded (by its ledger key,
    idempotent) — an interrupted export never counts."""
    renders = [(j.id, int(j.render_gen or 0))
               for j in store.list_by_status(*RUNNING_STATUSES)
               if j.segments and j.has_mezz()]
    stuck = store.mark_stuck_as_error()
    for job_id, gen in renders:
        _refund_render(job_id, gen)
    return stuck


def _render_basis_seconds(job: Job) -> float:
    """The length fair use takes its share of: what the upload was
    charged (its ledger row, after the true-up), else the analysed
    length. (Owner decision pending: source vs output length, PLAN 2.6.)"""
    if auth.auth_enabled():
        try:
            row = accounts.get_usage(job.id)
        except Exception:
            row = None
        if row and float(row.get("seconds_billed") or 0) > 0:
            return float(row["seconds_billed"])
    return float(math.ceil(max(0.0, float(job.duration or 0.0))))


def _export_fields(job: Job, user: User | None) -> dict[str, Any]:
    """The fair-use numbers of the next export for `user` — honest: with
    billing off (or for the service user) exports cost nothing and no
    counter is shown (free_renders_left None)."""
    billed = _bills(user)
    basis = _render_basis_seconds(job) if billed else float(
        math.ceil(max(0.0, float(job.duration or 0.0))))
    try:
        ready = exports.spec_ready(job, captions_v2.style_for(job))
    except Exception:
        ready = False
    return {
        "fair_use": {"billed": billed, "free_total": exports.free_renders(),
                     "pct": exports.fairuse_pct(), "basis_seconds": basis},
        "free_renders_left": (exports.free_renders_left(job.renders_ok)
                              if billed else None),
        "next_render_cost_seconds": (exports.next_render_cost(
            job.renders_ok, basis) if billed else 0),
        "spec_ready": bool(ready and job.status == "awaiting_review"),
        # The primary's frame ("9:16", "16:9" or "original").
        "output_aspect": _output_aspect(job),
        # The file name each download gets (Save / Share names the file).
        "download_names": {
            fmt: _download_name(job, fmt)
            for fmt in [d["format"] for d in job._downloads()]
            + [h.get("key") for h in job.hook_clips or []
               if isinstance(h, dict) and h.get("key")]},
    }


def _job_out(job: Job, user: User | None) -> dict[str, Any]:
    out = job.to_dict(admin=_is_admin(user))
    out.update(_export_fields(job, user))
    return out


def _running_renders_of(owner_id: str, exclude: str) -> int:
    """Exports of one account running or waiting now (jobs processing
    with a timeline: an analysis has none yet)."""
    return sum(1 for j in store.list_by_status("processing")
               if j.owner_id == owner_id and j.id != exclude and j.segments)


def _render_backlog() -> int:
    """Exports waiting for a render slot."""
    if taskq.enabled():
        return _tasks().counts("render")[0]
    return _RENDER_SLOTS.waiting_count()


def _render_caps(job: Job, user: User | None) -> None:
    """The abuse guards of POST /render (never a paywall): 429
    render_limit, 429 too_many_renders, 503 server_busy."""
    day = exports.max_renders_per_job_day()
    if day and len(exports.recent_renders(job.render_times)) >= day:
        raise ApiRefusal(429, "render_limit", limit=day)
    per_user = exports.max_renders_per_user()
    if (per_user and user is not None and not user.is_service
            and _running_renders_of(user.id, job.id) >= per_user):
        raise ApiRefusal(429, "too_many_renders", limit=per_user)
    queue_cap = exports.max_render_queue()
    if queue_cap and _render_backlog() >= queue_cap:
        raise _server_busy()


def _render_start_fields(cur: Job, v2: bool = False) -> dict[str, Any]:
    """What every user export writes when it starts, besides the status:
    which client exported (exports.is_v2), a v2 export's request time
    (daily cap) and a speculative render it doesn't take over marked
    stale."""
    out: dict[str, Any] = {"export_client": "v2" if v2 else None}
    if v2:
        out["render_times"] = [*exports.recent_renders(cur.render_times),
                               time.time()]
    spec = cur.spec if isinstance(cur.spec, dict) else None
    if spec and spec.get("status") in ("running", "done"):
        out["spec"] = {**spec, "status": "stale"}
    return out


def _drop_stale_spec(before: Job) -> None:
    """A finished speculative render nobody took: its files go (they
    were never served)."""
    spec = before.spec if isinstance(before.spec, dict) else None
    if spec and spec.get("status") == "done" and spec.get("gen"):
        _gc_later([f"{media.job_prefix(before.id)}r{int(spec['gen'])}/"],
                  store_=media.store_of(before))


def _charge_render(job_id: str, user: User | None, gen: int,
                   renders_ok_before: int) -> int:
    """Fair use (PLAN 2.6 B): after the free exports, record this one's
    share of the video's minutes under its own key — enforce=False, so
    it never blocks (over the quota it runs anyway; the account page
    shows the overage). Bookkeeping never fails an export. Returns the
    seconds recorded."""
    if not _bills(user) or exports.free_renders_left(renders_ok_before) > 0:
        return 0
    job = store.get(job_id)
    if job is None:
        return 0
    seconds = exports.render_cost_seconds(_render_basis_seconds(job))
    if seconds <= 0:
        return 0
    key = exports.usage_key(job_id, gen)
    try:
        if accounts.get_usage(key) is None:
            accounts.charge(key, user.id, seconds, email=user.email,
                            enforce=False)
            print(f"[job {job_id}] export r{gen}: {seconds}s of minutes "
                  "recorded (fair use)", flush=True)
    except Exception as e:  # never fail an export over bookkeeping
        print(f"[job {job_id}] fair-use charge failed: {e}", flush=True)
        return 0
    # The render may have failed before this charge landed (its refund
    # found no row then): refund now — whatever the order, a failed
    # export keeps no charge (refund is idempotent per key).
    cur = store.get(job_id)
    if (cur is not None and int(cur.render_gen or 0) == gen
            and cur.status != "processing"
            and not (cur.status == "done" and cur.output_keys)):
        _refund_render(job_id, gen)
        return 0
    return seconds


def _refund_render(job_id: str, gen: int | None) -> bool:
    """A failed export gives its fair-use minutes back (failed exports
    never count). Idempotent by its ledger key; nothing to do without a
    ledger row. True when settled (refunded, or nothing to refund). A
    refund that fails (the database) is recorded as a refund_pending job
    event; _retry_pending_refunds (boot, hourly) settles it later."""
    if not auth.auth_enabled():
        return True
    key = None
    try:
        if gen is None:
            cur = store.get(job_id)
            gen = int(cur.render_gen or 0) if cur else 0
        if not gen:
            return True
        key = exports.usage_key(job_id, gen)
        if accounts.refund(key, "render_failed"):
            print(f"[job {job_id}] export r{gen} failed: fair-use minutes "
                  "refunded", flush=True)
        return True
    except Exception as e:
        print(f"[job {job_id}] fair-use refund failed (retried later): {e}",
              flush=True)
        if key:
            _record_event("refund_pending", job_id, key=key, gen=gen)
        return False


def _retry_pending_refunds(since_days: float = 30.0) -> int:
    """Settle the refunds recorded as refund_pending: by ledger key,
    idempotent (an already refunded or missing row is done). Returns how
    many were refunded now."""
    if not auth.auth_enabled():
        return 0
    done = 0
    seen: set[str] = set()
    for ev in store.events(time.time() - since_days * 86400.0,
                           ["refund_pending"]):
        key = (ev.get("data") or {}).get("key")
        if not isinstance(key, str) or key in seen:
            continue
        seen.add(key)
        try:
            row = accounts.get_usage(key)
            if row is None or row.get("refunded"):
                continue
            if accounts.refund(key, "render_failed"):
                done += 1
                print(f"[fair-use] pending refund {key} settled", flush=True)
        except Exception as e:
            print(f"[fair-use] pending refund {key} still failing: {e}",
                  flush=True)
    return done


def _settle_stale_specs(older_than_s: float | None = None) -> int:
    """Speculative renders a restart cut off stay 'running': past the
    Modal timeout plus a margin (_render_gc_delay_s; or every one with
    older_than_s=0 — the WP1 boot, where no thread survived) their r{g}/
    is queued for deletion and the claim undone like a failure
    (_spec_failed: the pin, never the generation). Returns how many."""
    limit = _render_gc_delay_s() if older_than_s is None else older_than_s
    now = time.time()
    n = 0
    for job in store.list_by_status("awaiting_review", "done", "processing"):
        spec = job.spec if isinstance(job.spec, dict) else None
        if not spec or spec.get("status") != "running":
            continue
        age = now - float(spec.get("at") or 0)
        if age < limit:
            continue
        gen = int(spec.get("gen") or 0)
        if gen:
            # A Modal call may still write into r{gen}/ until its timeout.
            wait = max(0.0, _render_gc_delay_s() - age)
            _gc_later([f"{media.job_prefix(job.id)}r{gen}/"], wait,
                      store_=media.store_of(job))
        _spec_failed(job.id, gen)
        n += 1
    return n


def _exports_maintenance(boot: bool = False) -> None:
    """Boot and hourly: pending fair-use refunds, cut-off speculative
    renders. Never raises."""
    try:
        _retry_pending_refunds()
    except Exception as e:
        print(f"[fair-use] pending-refund retry failed: {e}", flush=True)
    try:
        # WP1 is one process: at its boot no speculative thread survived.
        n = _settle_stale_specs(0.0 if boot and not taskq.enabled() else None)
        if n:
            print(f"[spec] settled {n} speculative render(s) cut off by a "
                  "restart", flush=True)
    except Exception as e:
        print(f"[spec] stale speculative-render sweep failed: {e}", flush=True)


# ── speculative render: the instant export (review E1, PLAN 2.10) ───
# CLEO_SPECULATIVE_RENDER=1: a job whose first render will be v2 is
# rendered once, right after its analysis, as analysed — on its own
# small pool, never holding a user's render slot, dropped when exports
# are waiting (over half of CLEO_MAX_RENDER_QUEUE). It takes the job's
# next render generation (jobs/{id}/r{g}/, the layout render_r2 checks)
# and pins its caption engine (it IS the first render); the job stays in
# review. POST /render of the same state and captions then takes its
# files (instant, free, not counted). Any edit makes it stale; a stale
# or unused one is deleted when the next export starts.

_SPEC_POOL = ThreadPoolExecutor(
    max_workers=max(1, _env_int("CLEO_SPEC_WORKERS", 1)),
    thread_name_prefix="spec")


def _spec_busy() -> bool:
    cap = exports.max_render_queue()
    return bool(cap) and _render_backlog() * 2 > cap


def _spec_current(job: Job | None, gen: int) -> bool:
    spec = job.spec if job is not None and isinstance(job.spec, dict) else None
    return bool(spec and spec.get("gen") == gen
                and spec.get("status") == "running")


def _maybe_speculate(job_id: str) -> bool:
    """Start the speculative render of a job just analysed, if it is due
    one. True when started."""
    if not exports.speculative_enabled():
        return False
    job = store.get(job_id)
    if (job is None or job.status != "awaiting_review" or not job.mezz_key
            or job.spec is not None or job.output_keys or job.renders_ok):
        return False
    try:
        engine, _why = captions_v2.decide(job)
    except Exception:
        return False
    if engine != "v2" or _spec_busy():
        return False
    claimed: dict[str, Any] = {}

    def claim(cur: Job) -> dict | None:
        if (cur.status != "awaiting_review" or cur.spec is not None
                or cur.output_keys):
            return None
        gen = int(cur.render_gen or 0) + 1
        units = exports.analysis_units(cur)
        claimed.update(gen=gen, units=units)
        out: dict[str, Any] = {"render_gen": gen, "spec": {
            "gen": gen, "status": "running", "at": time.time(),
            "state": exports.state_fingerprint(cur, captions_v2.style_for(cur)),
            "units": exports.spec_unit_digests(cur, units),
            "pinned": cur.caption_engine is None}}
        if cur.caption_engine is None:
            out["caption_engine"] = "v2"
        return out
    if store.modify(job_id, claim) is None or not claimed:
        return False
    _SPEC_POOL.submit(_run_spec, job_id, claimed["gen"], claimed["units"])
    print(f"[job {job_id}] speculative render r{claimed['gen']} queued",
          flush=True)
    return True


def _render_files(result: dict) -> tuple[dict, dict, list, dict | None]:
    """(output_keys, sizes, hook_clips, thumb) of render_to_keys' result
    — what _render_commit stores."""
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
    return output_keys, sizes, hook_clips, thumb


def _run_spec(job_id: str, gen: int, units: list[dict]) -> None:
    """_SPEC_POOL worker: the speculative render (see above)."""
    out_prefix = f"{media.job_prefix(job_id)}r{gen}/"
    ws = _workspace(job_id, f"spec{gen}")
    where: str | None = None
    started = time.time()
    try:
        job = store.get(job_id)
        if not _spec_current(job, gen) or job.status != "awaiting_review":
            return
        if _spec_busy():
            raise RuntimeError("exports are waiting: dropped")
        where = media.store_of(job)
        _make_workspace(ws)
        with costs.tracking(job_id, "spec_render"):
            captions = captions_v2.prepare_render(store, job_id, job, units)
            if not captions:
                raise RuntimeError("not a v2 render")
            result = pipeline.render_to_keys(
                job_id=job_id, gen=gen, mezz_key=job.mezz_key,
                out_prefix=out_prefix, store=where,
                mezz_bytes=(job.media_bytes or {}).get(job.mezz_key),
                segments=job.segments, subtitles=units,
                settings=exports.render_settings(job, _output_seconds(job)),
                language=job.language, cut_ranges=job.cut_ranges,
                disabled_cuts=[], duration=job.duration,
                workspace=str(ws), captions=captions)
        output_keys, sizes, hook_clips, thumb = _render_files(result)

        def done(cur: Job) -> dict | None:
            if not _spec_current(cur, gen) or cur.status != "awaiting_review":
                return None
            return {"spec": {
                **cur.spec, "status": "done", "done_at": time.time(),
                "output_keys": output_keys, "media_bytes": sizes,
                "thumb_key": thumb["key"] if thumb else None,
                "hook_clips": hook_clips,
                "export_captions": exports.export_captions(
                    units, cur, exports.doc_offset_ms(cur))}}
        if store.modify(job_id, done) is None:
            _gc_later([out_prefix], store_=where)   # stale meanwhile
            return
        _record_event("spec_render_done", job_id, gen=gen,
                      wall_s=_since(started))
    except Exception as e:
        print(f"[job {job_id}] speculative render r{gen} failed: "
              f"{type(e).__name__}: {e}", flush=True)
        if where:
            _gc_later([out_prefix], _render_gc_delay_s(), store_=where)
        _spec_failed(job_id, gen)
        _record_event("spec_render_failed", job_id, gen=gen,
                      error=type(e).__name__)
    finally:
        _drop_workspace(ws)


def _spec_failed(job_id: str, gen: int) -> None:
    """Undo the engine pin of the claim while nothing else rendered: the
    job's first real render then decides its engine as if there had been
    no speculative one. The generation is never handed back (its prefix
    is queued for deletion)."""
    def change(cur: Job) -> dict | None:
        if not _spec_current(cur, gen):
            return None
        out: dict[str, Any] = {"spec": {**cur.spec, "status": "failed"}}
        # render_gen stays: r{gen}/ is queued for deletion, so the next
        # export must take a new generation (captions_v2.exported_before
        # doesn't count a speculative generation).
        untouched = (cur.status == "awaiting_review" and not cur.output_keys
                     and int(cur.render_gen or 0) == gen)
        if untouched and cur.spec.get("pinned"):
            out["caption_engine"] = None
            out["render_doc"] = None
        return out
    try:
        store.modify(job_id, change)
    except Exception as e:
        print(f"[job {job_id}] speculative render: saving the failure "
              f"failed: {e}", flush=True)


def _promote_spec(job_id: str, units_digest: str) -> bool:
    """POST /render of exactly what the finished speculative render
    shows: its files become the job's export — instant, free, not
    counted (renders_ok, fair use, the daily cap)."""
    info: dict[str, Any] = {}

    def change(cur: Job) -> dict | None:
        spec = cur.spec if isinstance(cur.spec, dict) else None
        if cur.status != "awaiting_review" or spec is None:
            return None
        if not exports.spec_ready(cur, captions_v2.style_for(cur)):
            info["miss"] = "the project changed since"
            return None
        accepted = spec.get("units")
        if units_digest not in (accepted if isinstance(accepted, list)
                                else [accepted]):
            info["miss"] = "other captions"
            return None
        keys = dict(spec["output_keys"])
        prefix = media.key_prefix_of(next(iter(keys.values())))
        old = set((cur.output_keys or {}).values())
        if cur.thumb_key:
            old.add(cur.thumb_key)
        superseded = sorted({media.key_prefix_of(k) for k in old
                             if not k.startswith(prefix)})
        media_bytes = {k: v for k, v in (cur.media_bytes or {}).items()
                       if media.key_prefix_of(k) not in superseded}
        media_bytes.update(spec.get("media_bytes") or {})
        info.update(superseded=superseded, gen=spec.get("gen"))
        return dict(
            status="done",
            **errors.stage_fields(errors.stage_message("render.finish", "Done")),
            progress=100.0, **errors.no_error(), queue_position=None,
            output_keys=keys, thumb_key=spec.get("thumb_key"),
            hook_clips=list(spec.get("hook_clips") or []),
            media_bytes=media_bytes,
            export_captions=spec.get("export_captions"),
            spec={**spec, "status": "promoted"})
    try:
        if store.modify(job_id, change) is None:
            if info.get("miss"):
                print(f"[job {job_id}] speculative render not taken: "
                      f"{info['miss']}", flush=True)
            return False
    except Exception as e:
        print(f"[job {job_id}] instant export failed: {e}", flush=True)
        return False
    job = store.get(job_id)
    if info.get("superseded"):
        _gc_later(info["superseded"], _SUPERSEDED_KEEP_S,
                  store_=media.store_of(job) if job else None)
    _record_event("render_instant", job_id, gen=info.get("gen"))
    return True


def _after_analysis(job_id: str) -> None:
    """A job just reached review (both paths): its speculative render.
    Never raises."""
    for step in (_maybe_speculate,):
        try:
            step(job_id)
        except Exception as e:
            print(f"[job {job_id}] {step.__name__} failed: {e}", flush=True)


@app.post("/jobs/{job_id}/render")
def post_render(job_id: str, payload: dict,
                user: User | None = Depends(current_user)):
    """Kick off the render with (possibly edited) subtitles. Exactly one
    of several concurrent calls (double click, second tab, retry) starts
    it; the others get 409. When all render slots are taken the job
    waits in line (message "queued", queue_position).

    UX11: a finished project is exported again after POST /reopen. The
    caps answer 429 render_limit / too_many_renders and 503 server_busy;
    the minutes were charged at upload, and after CLEO_FREE_RENDERS
    successful exports each one records its fair-use share (never
    blocking). A matching speculative render is taken at once: the job
    comes back done with "instant": true. The answer carries "gen" and
    "cost_seconds" (minutes recorded for this export)."""
    job = get_owned_job(job_id, user)
    if job.status != "awaiting_review":
        raise HTTPException(409, f"job not in review state (status={job.status})")
    # UX11 rules only for the v2 export sheet; without the marker the
    # export behaves exactly as before UX11.
    v2 = payload.get("client") == "v2"

    edited = payload.get("subtitles")
    if not isinstance(edited, list):
        raise HTTPException(400, "payload.subtitles must be a list")
    disabled_cuts = payload.get("disabled_cuts") or []
    if not isinstance(disabled_cuts, list):
        raise HTTPException(400, "payload.disabled_cuts must be a list")

    if (v2 and isinstance(job.spec, dict) and job.spec.get("status") == "done"
            and not disabled_cuts
            and _promote_spec(job_id, exports.units_hash(edited))):
        out = _job_out(store.get(job_id), user)
        out.update(instant=True, cost_seconds=0, gen=job.spec.get("gen"))
        return out

    if v2:
        _render_caps(job, user)
    # UT4 opt-in (CLEO_CAPTION_ENGINE unset or optin): this request's
    # "caption_engine": "v2" asks for the v2 captions at the job's first
    # render. Kept on the job before the render starts; ignored in the
    # other modes and once the job's engine is pinned.
    if captions_v2.engine_default() == "optin":
        requested = payload.get("caption_engine")
        store.modify(job_id, lambda cur: captions_v2.optin_fields(cur, requested)
                     if cur.status == "awaiting_review" else None)
    before: dict[str, Job] = {}

    if taskq.enabled():
        # The compare-and-set and the render task in one transaction
        # (the unique active-task index guards it too, across replicas).
        task_id = _queue_start_render(job_id, edited, disabled_cuts,
                                      job.owner_id, job.plan, before, v2)
        if task_id is None:
            cur = store.get(job_id)
            raise HTTPException(
                409, "job not in review state "
                     f"(status={cur.status if cur else None})")
        pos = _queue_position_now(task_id, "render")
        if pos is not None:
            t = _tasks().get(task_id)
            if t is not None and t.state == "queued":
                store.patch_status(job_id, "processing",
                                   **errors.stage("queued"))
        out = _render_started(job_id, user, before, v2)
        if pos is not None:
            out["queue_position"] = pos
        return out

    # Flip to processing right away (and clear a previous render error)
    # so a poll between this response and the worker start can't see
    # the old 'awaiting_review + error' state — as a compare-and-set, so
    # only one request gets to start the render. The same write takes
    # the render's generation (its outputs go under jobs/{id}/r{gen}/).
    def _start(cur: Job) -> dict | None:
        if cur.status != "awaiting_review":
            return None
        before["job"] = copy.deepcopy(cur)
        return dict(status="processing", **_RENDER_STARTED, progress=1.0,
                    **errors.no_error(), queue_position=None,
                    render_gen=int(cur.render_gen or 0) + 1,
                    **_render_start_fields(cur, v2))
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
            store.update_if(job_id, "processing", **errors.stage("queued"),
                            queue_position=pos)
        thread.start()
    except BaseException:
        _RENDER_SLOTS.cancel(job_id)
        raise
    _INFLIGHT.track(job_id, job.owner_id, "render", thread)
    return _render_started(job_id, user, before, v2)


def _render_started(job_id: str, user: User | None,
                    before: dict[str, Job], v2: bool = False) -> dict[str, Any]:
    """POST /render's answer once the export started: the job, its
    generation and the fair-use seconds it recorded."""
    prev = before.get("job")
    cur = store.get(job_id)
    gen = int(cur.render_gen or 0) if cur else 0
    cost = 0
    if prev is not None:
        _drop_stale_spec(prev)
        if v2:   # fair use: v2 exports only
            cost = _charge_render(job_id, user, gen, int(prev.renders_ok or 0))
    out = _job_out(store.get(job_id) or cur, user)
    out.update(gen=gen, cost_seconds=cost, instant=False)
    return out


@app.post("/jobs/{job_id}/reopen")
def reopen_job(job_id: str, user: User | None = Depends(current_user)):
    """Edit a finished project again (flows.md §3.10): done →
    awaiting_review as a compare-and-set. Its export (output_keys,
    thumbnail, bonus clips, post text, SRT / VTT) stays downloadable
    until the next export replaces it. The project's retention restarts
    (expires_at follows updated_at). Already in review: the job as it is.
    409 busy while it runs, 409 media_unavailable without its source,
    410 media_expired past its retention, 409 not_editable after a
    failed analysis."""
    job = get_owned_job(job_id, user)
    if job.status == "awaiting_review":
        return _job_out(job, user)
    if job.status in ("pending", "processing"):
        raise ApiRefusal(409, "busy", job_status=job.status)
    if job.status != "done":
        raise ApiRefusal(409, "not_editable", job_status=job.status)
    exp = job.expires_at()
    if exp is not None and exp < time.time():
        raise ApiRefusal(410, "media_expired")
    if not job.has_mezz() or not job.segments:
        raise ApiRefusal(409, "media_unavailable")
    refused: list[str] = []

    def change(cur: Job) -> dict | None:
        if cur.status != "done":
            refused.append(cur.status)
            return None
        return dict(status="awaiting_review",
                    **errors.stage_fields(errors.stage_message(
                        "analyze.done", "Ready for review")),
                    progress=100.0, **errors.no_error(), queue_position=None)
    store.modify(job_id, change)
    if refused and refused[0] != "awaiting_review":
        raise ApiRefusal(409, "busy", job_status=refused[0])
    _record_event("reopened", job_id, renders_ok=int(job.renders_ok or 0))
    return _job_out(store.get(job_id), user)


_SOCIAL_MAX_CHARS = 5000


@app.post("/jobs/{job_id}/social-caption")
def save_social_caption(job_id: str, payload: dict,
                        user: User | None = Depends(current_user)):
    """{text}: the post text as the user edited it (saved only; there is
    no regenerate, review G7). Empty text goes back to the generated one."""
    job = get_owned_job(job_id, user)
    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "payload.text must be a string")
    text = text.replace("\r\n", "\n").strip()[:_SOCIAL_MAX_CHARS]
    store.modify(job.id, lambda cur: {"social_caption_edited": text or None,
                                      "updated_at": cur.updated_at})
    return {"text": text}


def _caption_file(job_id: str, user: User | None, kind: str) -> Response:
    job = get_owned_job(job_id, user)
    if not job.export_captions:
        raise HTTPException(409, "requested format not ready")
    cues = exports.caption_cues(job.export_captions)
    body = exports.to_srt(cues) if kind == "srt" else exports.to_vtt(cues)
    name = exports.download_name(job.title or job.filename, "primary", None,
                                 job.created_at)[:-4] + f".{kind}"
    ctype = "application/x-subrip" if kind == "srt" else "text/vtt"
    return Response(content=body.encode("utf-8"),
                    media_type=f"{ctype}; charset=utf-8",
                    headers={"Content-Disposition":
                             f'attachment; filename="{name}"',
                             "Cache-Control": "private, no-cache"})


@app.get("/jobs/{job_id}/captions.srt")
def captions_srt(job_id: str, user: User | None = Depends(media_user)):
    """The latest export's captions as SubRip, in output time."""
    return _caption_file(job_id, user, "srt")


@app.get("/jobs/{job_id}/captions.vtt")
def captions_vtt(job_id: str, user: User | None = Depends(media_user)):
    """The latest export's captions as WebVTT, in output time."""
    return _caption_file(job_id, user, "vtt")


_FEEDBACK_KINDS = ("post_export",)


@app.post("/feedback", status_code=204)
def post_feedback(payload: dict, user: User | None = Depends(current_user)):
    """{kind, job_id?, answer?, text?}: the Done view's survey "Did you
    have to edit this video anywhere else?" (review A5) — one job event
    (kind feedback_{kind}), no content beyond the answer and ≤ 300
    characters of text."""
    kind = payload.get("kind")
    if kind not in _FEEDBACK_KINDS:
        raise ApiRefusal(400, "invalid_payload", field="kind")
    answer = payload.get("answer")
    if answer not in ("yes", "no", None):
        raise ApiRefusal(400, "invalid_payload", field="answer")
    text = payload.get("text")
    text = text.strip()[:300] if isinstance(text, str) else None
    job_id = payload.get("job_id")
    if job_id is not None:
        if not isinstance(job_id, str):
            raise ApiRefusal(400, "invalid_payload", field="job_id")
        get_owned_job(job_id, user)
    _record_event(f"feedback_{kind}", job_id, answer=answer, text=text or None,
                  user=user.id if user is not None else None)
    return Response(status_code=204)


@app.get("/jobs/{job_id}/download")
def download_job(job_id: str, format: str = "primary",
                 name: str | None = None,
                 user: User | None = Depends(media_user)):
    """A rendered format as an attachment (cleo_{id}_{format}.mp4). With
    name=v2 (the v2 Done view, UX11 review F9) named after the project:
    {slug}_cleocuts_{aspect}.mp4 — exports.download_name."""
    job = get_owned_job(job_id, user)
    safe = "".join(c if c.isalnum() or c in "_-" else "-"
                   for c in format.replace(":", "-"))
    v2_name = _download_name(job, format) if name == "v2" else None
    if job.output_keys:
        key = job.output_keys.get(format)
        if not key:
            raise HTTPException(409, "requested format not ready")
        return _media(job, key, "video/mp4", "requested format not ready",
                      download_name=v2_name or f"cleo_{job_id}_{safe}.mp4")
    path = job.outputs.get(format) or (
        job.output_path if format == "primary" else None
    )
    if not path or not Path(path).exists():
        raise HTTPException(409, "requested format not ready")
    safe = format.replace(":", "-")
    return FileResponse(
        path=path,
        media_type="video/mp4",
        filename=v2_name or f"cleo_{job_id}_{safe}.mp4",
    )


def _output_aspect(job: Job) -> str:
    fmt_doc = (job.doc or {}).get("format") if isinstance(job.doc, dict) else None
    return ((fmt_doc or {}).get("aspect") if isinstance(fmt_doc, dict)
            else None) or edit_doc.aspect_of(job.settings)


def _download_name(job: Job, fmt: str) -> str:
    return exports.download_name(job.title or job.filename, fmt, _output_aspect(job),
                                 job.created_at)


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
    derive the path without storing it on the Job.

    No thumbnail (an expired or unknown project, none rendered yet): the
    status with an EMPTY body (UX12) — an <img> that gets a JSON error
    body is blocked by the browser (ERR_BLOCKED_BY_ORB) and logged."""
    try:
        return _thumbnail(job_id, user)
    except HTTPException as e:
        if e.status_code in (404, 409):
            return Response(status_code=e.status_code,
                            headers={"Cache-Control": "no-store"})
        raise


def _thumbnail(job_id: str, user: User | None):
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
