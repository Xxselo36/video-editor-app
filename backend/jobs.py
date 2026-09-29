"""Job store for the web backend.

Persists across container restarts so a Railway deploy doesn't nuke
in-flight jobs (which was killing users mid-render). Same API surface
as the old in-memory version — callers use store.create / .get / .update.

`store` is the store of the active database (backend/db.py): this
module's SQLite JobStore, or — with DATABASE_URL set — backend.pg's
PgJobStore (same methods, Postgres as the source of truth). This module
stays stdlib-only; psycopg is imported only when Postgres is active.

SQLite file lives at CLEO_JOB_DB (default /data/cleo_jobs.db). On
Railway that's a mounted persistent volume; locally it defaults to /tmp.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Callable, Literal

from backend import db

# Subscription plans and how long an idle project is kept (days after
# the last change). No free tier. Override per plan with e.g.
# CLEO_RETENTION_DAYS_PRO=45; CLEO_RETENTION_DAYS=0 disables deletion.
# A job gets its owner's plan at upload (backend/main.py); without an
# active subscription, or with billing off, it gets CLEO_DEFAULT_PLAN.
PLAN_RETENTION_DAYS: dict[str, float] = {
    plan: float(os.environ.get(f"CLEO_RETENTION_DAYS_{plan.upper()}", days))
    for plan, days in (("starter", 14), ("pro", 30), ("studio", 90))
}
DEFAULT_PLAN = os.environ.get("CLEO_DEFAULT_PLAN", "starter")


def retention_days(plan: str | None) -> float:
    """Retention for a plan; 0 means never delete."""
    if os.environ.get("CLEO_RETENTION_DAYS", "").strip() == "0":
        return 0.0
    return PLAN_RETENTION_DAYS.get(plan or DEFAULT_PLAN,
                                   PLAN_RETENTION_DAYS["starter"])


JobStatus = Literal[
    "pending", "processing", "awaiting_review", "done", "error", "cancelled",
]


@dataclass
class Job:
    id: str
    status: JobStatus = "pending"
    message: str = "Queued…"
    progress: float = 0.0
    input_path: str | None = None
    normalized_path: str | None = None
    preview_path: str | None = None
    output_path: str | None = None
    outputs: dict[str, str] = field(default_factory=dict)
    error: str | None = None
    settings: dict[str, Any] = field(default_factory=dict)
    # Set after analyze; consumed by render. Each subtitle is
    # {start, end, text, original_start, original_end}.
    subtitles: list[dict[str, Any]] = field(default_factory=list)
    segments: list[tuple[float, float]] = field(default_factory=list)
    cut_ranges: list[dict[str, Any]] = field(default_factory=list)
    duration: float = 0.0
    language: str | None = None
    audio_warnings: list[str] = field(default_factory=list)
    audio_levels: dict[str, Any] = field(default_factory=dict)
    scene_events: list[dict[str, Any]] = field(default_factory=list)
    social_caption: str = ""
    social_hashtags: list[str] = field(default_factory=list)
    hook_clips: list[dict[str, Any]] = field(default_factory=list)
    # Segment list the CURRENT preview.mp4 was built from, and a counter
    # bumped on every successful rebuild. The editor maps the playhead
    # through preview_segments and cache-busts the preview URL with
    # preview_version, so after leaving and re-entering a job it shows
    # the preview that is really on disk.
    preview_segments: list[list[float]] = field(default_factory=list)
    preview_version: int = 0
    # Transcript phrases as last edited in review (text fixes, deleted
    # lines). None until the user edits — an empty list means every line
    # was deleted. GET /subtitles returns them so edits survive leaving
    # the job.
    edited_phrases: list[dict[str, Any]] | None = None
    # Client revision of edited_phrases; older saves are ignored.
    edited_phrases_rev: float = 0
    # Unix time of the last change (create/update). Drives automatic
    # deletion after CLEO_RETENTION_DAYS of inactivity. 0 = legacy job.
    updated_at: float = 0.0
    # Subscription plan of the owner; decides the retention period.
    plan: str = DEFAULT_PLAN
    # Accumulated processing cost (raw units + usd_*), see backend/costs.py.
    costs: dict[str, float] = field(default_factory=dict)
    # Account that uploaded the job (Clerk user id, see backend/auth.py).
    # None = beta job from before accounts; the first signed-in user who
    # opens it claims it.
    owner_id: str | None = None
    # What the Library shows for server-listed jobs (GET /jobs): original
    # file name and the preset picked at upload.
    filename: str | None = None
    preset_id: str | None = None
    preset_label: str | None = None
    # Unix time of the upload. 0 = legacy job.
    created_at: float = 0.0
    # 1-based place in line while the job waits for a free analysis or
    # render slot (status "processing", message "queued"); None otherwise.
    # Written by the waiting worker thread (backend/main.py) whenever the
    # line moves.
    queue_position: int | None = None
    # ── Media keys (WP3: R2 / media store) ──
    # This release only carries them: it can't read or write that
    # media, but it must neither lose these fields when it writes a row
    # nor treat a keyed job as broken because its local paths are gone
    # (it is the rollback target of the release that fills them).
    source_key: str | None = None      # upload / source object
    mezz_key: str | None = None        # jobs/{id}/mezz.mp4 (render source)
    proxy_key: str | None = None       # jobs/{id}/proxy.mp4 (editor)
    preview_key: str | None = None     # jobs/{id}/preview/v{n}.mp4
    # Render generation: outputs of generation g live under jobs/{id}/r{g}/.
    render_gen: int = 0
    # Format → key ("primary", "9:16", …, "hook_1", …); order = buttons.
    output_keys: dict[str, str] = field(default_factory=dict)
    thumb_key: str | None = None
    # Key → size in bytes (storage accounting).
    media_bytes: dict[str, int] = field(default_factory=dict)
    # Where the job's keys live ("r2" / "local"); None = not recorded.
    media_store: str | None = None
    # Keys of the stored row this code doesn't know (a later release's
    # fields): kept as stored and written back on every write, so this
    # release can't drop them. Never part of the API.
    _extras: dict[str, Any] = field(default_factory=dict, repr=False,
                                    compare=False)

    def has_mezz(self) -> bool:
        """Can this job still be edited / rendered: its render source is
        stored (mezz_key) or, for a legacy job, on the local disk."""
        return bool(self.mezz_key) or (
            bool(self.normalized_path) and Path(self.normalized_path).exists())

    def has_media_keys(self) -> bool:
        """Does this job keep (some of) its media in the media store
        (R2), written by a later release? Such a job is intact even when
        its local paths are missing; this release can't serve, edit or
        delete that media (routes answer 409 media_unavailable)."""
        return bool(
            self.source_key or self.mezz_key or self.proxy_key
            or self.preview_key or self.output_keys or self.thumb_key
            or self.media_store
            or any(isinstance(c, dict) and c.get("object_key")
                   for c in self.hook_clips or ()))

    def expires_at(self) -> float | None:
        """Unix time when the project gets deleted, None = never."""
        days = retention_days(self.plan)
        if days <= 0 or not self.updated_at:
            return None
        return self.updated_at + days * 86400

    def edit_segments(self) -> list[dict[str, Any]]:
        """job.segments zipped with their per-segment effects.

        This is the user's saved timeline (after /edit-segments), which
        the editor must be seeded from — cut_ranges only describe the
        automatic cuts from analysis.
        """
        effects = (self.settings or {}).get("segment_effects") or []
        if len(effects) != len(self.segments):
            effects = [{} for _ in self.segments]
        out = []
        for (s, e), eff in zip(self.segments, effects):
            out.append({
                "start": float(s),
                "end": float(e),
                "speed": eff.get("speed", 1.0),
                "fadeIn": eff.get("fadeIn", 0.0),
                "fadeOut": eff.get("fadeOut", 0.0),
                "volume": eff.get("volume", 1.0),
            })
        return out

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "plan": self.plan,
            "expires_at": self.expires_at(),
            "message": self.message,
            "progress": self.progress,
            "error": self.error,
            "has_output": self.output_path is not None and Path(self.output_path).exists(),
            "outputs": list(self.outputs.keys()),
            "social_caption": self.social_caption,
            "social_hashtags": self.social_hashtags,
            "hook_clips": [
                {k: v for k, v in c.items() if k not in ("path", "object_key")}
                for c in self.hook_clips
            ],
            "audio_warnings": self.audio_warnings,
            "audio_levels": self.audio_levels,
            "duration": self.duration,
            "cut_ranges": self.cut_ranges,
            "scene_events": self.scene_events,
            "edit_segments": self.edit_segments(),
            # Jobs from before preview_segments existed: their preview
            # was last rebuilt from job.segments, so that's the best guess.
            "preview_segments": [
                [float(s), float(e)]
                for s, e in (self.preview_segments or self.segments)
            ],
            "preview_version": self.preview_version,
            "caption_preset": (self.settings or {}).get("caption_preset"),
            "filename": self.filename,
            "preset_id": self.preset_id,
            "preset_label": self.preset_label,
            "created_at": self.created_at or None,
            "updated_at": self.updated_at or None,
            "queue_position": self.queue_position,
        }


def _db_path() -> str:
    env = os.environ.get("CLEO_JOB_DB")
    if env:
        return env
    # Persistent volume (e.g. Railway mounted at /data) so jobs survive
    # redeploys; /tmp is wiped on every restart.
    if os.path.isdir("/data") and os.access("/data", os.W_OK):
        return "/data/cleo_jobs.db"
    return "/tmp/cleo_jobs.db"


def tune_connection(conn: sqlite3.Connection) -> None:
    """WAL + busy_timeout for both connections to the DB file (jobs here,
    accounts in backend/accounts.py): readers no longer wait for a
    writer, and a writer waits for the other connection's transaction
    instead of failing with "database is locked"."""
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
        if str(mode).lower() != "wal":
            print(f"[jobstore] WAL not available (journal_mode={mode})",
                  flush=True)
    except sqlite3.DatabaseError as e:
        print(f"[jobstore] could not enable WAL: {e}", flush=True)


# Scalar fields of GET /jobs/status rows (JobStore.status_many).
_STATUS_FIELDS = ("id", "status", "message", "progress", "queue_position",
                  "error", "output_path", "updated_at", "preview_version",
                  "owner_id")


# Fields that hold structured (list/dict) data — JSON-encode on write,
# JSON-decode on read.
_JSON_FIELDS = {
    "settings", "subtitles", "segments", "cut_ranges",
    "audio_warnings", "audio_levels", "outputs",
    "social_hashtags", "hook_clips", "scene_events",
}

# Statuses of jobs a worker thread is (or was) busy with.
RUNNING_STATUSES = ("pending", "processing")


class DuplicateKey(Exception):
    """create(idempotency_key=k): another job already holds k (a second
    POST /jobs for the same upload, e.g. in another process). `job_id`
    is that job's id."""

    def __init__(self, job_id: str | None) -> None:
        super().__init__(f"idempotency key already used by job {job_id}")
        self.job_id = job_id


_EXTRAS = "_extras"


def job_from_dict(d: dict[str, Any]) -> Job:
    """Job from a stored JSON object. Structured fields may be nested
    JSON strings (the SQLite blob format) or plain JSON values (Postgres);
    unknown keys are kept, as stored, in job._extras (job_to_dict writes
    them back)."""
    d = dict(d)
    for k in _JSON_FIELDS:
        if k in d and isinstance(d[k], str):
            try:
                d[k] = json.loads(d[k])
            except (json.JSONDecodeError, TypeError):
                pass
    # Reconstruct segments as tuples (JSON gives lists)
    if isinstance(d.get("segments"), list):
        d["segments"] = [tuple(s) for s in d["segments"]]
    known = {f.name for f in fields(Job)} - {_EXTRAS}
    extras = {k: v for k, v in d.items() if k not in known and k != _EXTRAS}
    d = {k: v for k, v in d.items() if k in known}
    return Job(**d, _extras=extras)


def job_to_dict(job: Job) -> dict[str, Any]:
    """The stored JSON object of a job (before the stores' own encoding
    of structured fields): its fields plus the unknown keys it was read
    with (job._extras), unchanged — a later release's fields survive
    this code rewriting the row."""
    d = asdict(job)
    extras = d.pop(_EXTRAS, None) or {}
    for k, v in extras.items():
        d.setdefault(k, v)
    return d


def _list_key(job: Job) -> tuple[bool, float, str]:
    """Sort key of list_by_owner, newest first when reversed: by
    created_at, legacy jobs (created_at 0) last, ties by id."""
    return (bool(job.created_at), float(job.created_at or 0), job.id)


class JobStore:
    """SQLite-backed job store. Thread-safe via a single connection lock.
    Writes are synchronous so the current job survives a hard crash /
    OOM kill mid-render. One process only: the read-modify-write in
    update() is guarded by a process-local lock (Postgres, backend/pg.py,
    is safe across processes).

    `job_keys` maps an upload's storage key to its job, so a retried
    POST /jobs returns the job instead of creating (and charging) a
    second one.
    """
    # list_by_owner reads the whole table on every call, so a caller
    # wanting all of an account's jobs asks once, not page by page.
    PAGES_BY_INDEX = False

    def __init__(self) -> None:
        self._lock = threading.Lock()
        db_path = _db_path()
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False,
                                     timeout=30)
        self._conn.row_factory = sqlite3.Row
        tune_connection(self._conn)
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
            )
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS job_keys "
                "(key TEXT PRIMARY KEY, job_id TEXT NOT NULL)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS job_keys_job ON job_keys(job_id)"
            )
            self._conn.commit()

    def _serialize(self, job: Job) -> str:
        d = job_to_dict(job)
        for k in _JSON_FIELDS:
            if k in d and not isinstance(d[k], str):
                d[k] = json.dumps(d[k])
        return json.dumps(d)

    def _deserialize(self, row_data: str) -> Job:
        return job_from_dict(json.loads(row_data))

    def create(
        self,
        input_path: str,
        settings: dict[str, Any],
        job_id: str | None = None,
        idempotency_key: str | None = None,
        **extra: Any,
    ) -> Job:
        """Insert a new pending job. `job_id` lets the caller pick the id
        up front (the usage ledger is keyed by it before the job exists);
        `idempotency_key` (the upload's storage key) makes find_by_key
        return this job — raises DuplicateKey if another job holds it;
        `extra` sets further Job fields (owner_id, plan, filename, ...)."""
        job_id = job_id or new_job_id()
        now = time.time()
        job = Job(id=job_id, input_path=input_path, settings=settings,
                  updated_at=now, created_at=now, **extra)
        with self._lock:
            if idempotency_key:
                row = self._conn.execute(
                    "SELECT k.job_id FROM job_keys k JOIN jobs j "
                    "ON j.id = k.job_id WHERE k.key = ?", (idempotency_key,)
                ).fetchone()
                if row is not None:
                    raise DuplicateKey(row["job_id"])
            try:
                self._conn.execute(
                    "INSERT INTO jobs (id, data) VALUES (?, ?)",
                    (job_id, self._serialize(job)),
                )
                if idempotency_key:
                    self._conn.execute(
                        "INSERT OR REPLACE INTO job_keys (key, job_id) "
                        "VALUES (?, ?)", (idempotency_key, job_id),
                    )
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise
        return job

    def find_by_key(self, key: str) -> Job | None:
        """The job created from upload `key` (see create), if it still
        exists."""
        with self._lock:
            row = self._conn.execute(
                "SELECT j.data FROM job_keys k JOIN jobs j ON j.id = k.job_id "
                "WHERE k.key = ?", (key,)
            ).fetchone()
        if row is None:
            return None
        try:
            return self._deserialize(row["data"])
        except Exception:
            return None

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None:
            return None
        try:
            return self._deserialize(row["data"])
        except Exception as e:
            print(f"[jobstore] deserialize failed for {job_id}: {e}",
                  flush=True)
            return None

    def update(self, job_id: str, **fields_to_update: Any) -> None:
        self._write(job_id, None, fields_to_update)

    def update_if(self, job_id: str, expect_status: str | tuple[str, ...],
                  **fields_to_update: Any) -> bool:
        """Compare-and-set: apply the update only while the job's status
        is `expect_status` (one status or a tuple of them). Returns
        whether it was applied. Check and write happen under the store
        lock, so of two concurrent callers expecting the same status and
        moving it on, exactly one wins (POST /render, analysis start),
        and a late progress tick can't overwrite a finished job."""
        if isinstance(expect_status, str):
            expect_status = (expect_status,)
        return self._write(job_id, tuple(expect_status),
                           fields_to_update) is not None

    def modify(self, job_id: str,
               fn: Callable[[Job], dict[str, Any] | None]
               ) -> dict[str, Any] | None:
        """Read-check-write in one step: fn(job) gets the stored job and
        returns the fields to change — computed from it, e.g. a counter
        + 1 or a merged settings dict — or None to leave the job alone
        (e.g. an older revision). Returns what was written; None if fn
        declined or the job doesn't exist. Nothing can change the job
        between the read and the write: here the store lock, on Postgres
        the row lock (SELECT … FOR UPDATE), which holds across processes
        — so call sites need no lock of their own. fn runs under that
        lock: keep it quick and don't call the store from it."""
        return self._write(job_id, None, fn)

    def _write(self, job_id: str, expect: tuple[str, ...] | None,
               change: dict[str, Any] | Callable[[Job], Any]
               ) -> dict[str, Any] | None:
        """update / update_if / modify: the fields written, or None."""
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return None
            try:
                job = self._deserialize(row["data"])
            except Exception:
                return None
            if expect is not None and job.status not in expect:
                return None
            fields_to_update = change(job) if callable(change) else change
            if fields_to_update is None:
                return None
            for k, v in fields_to_update.items():
                setattr(job, k, v)
            if "updated_at" not in fields_to_update:
                job.updated_at = time.time()
            try:
                self._conn.execute(
                    "UPDATE jobs SET data = ? WHERE id = ?",
                    (self._serialize(job), job_id),
                )
                self._conn.commit()
            except BaseException:
                # e.g. disk full: don't leave the shared connection in an
                # open transaction that the next write would join.
                self._conn.rollback()
                raise
            return fields_to_update

    def status_many(self, job_ids: list[str]) -> dict[str, dict[str, Any]]:
        """Scalar status fields (_STATUS_FIELDS) of several jobs in one
        query, keyed by id; missing ids are left out. The big structured
        fields stay unparsed, so this is much cheaper than get()."""
        ids = list(dict.fromkeys(i for i in job_ids if i))
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT id, data FROM jobs WHERE id IN ({marks})", ids
            ).fetchall()
        defaults = {f.name: f.default for f in fields(Job)
                    if f.name in _STATUS_FIELDS}
        out: dict[str, dict[str, Any]] = {}
        for r in rows:
            try:
                d = json.loads(r["data"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(d, dict):
                continue
            out[r["id"]] = {k: d.get(k, defaults.get(k)) for k in _STATUS_FIELDS}
            out[r["id"]]["id"] = r["id"]
        return out

    def ping(self) -> None:
        """Trivial query for the readiness check (GET /ready)."""
        with self._lock:
            self._conn.execute("SELECT 1").fetchone()

    def claim(self, job_id: str, owner_id: str) -> str | None:
        """Give an unowned (beta) job to `owner_id`, atomically, without
        touching updated_at. Returns the job's owner afterwards — the
        caller's id, or whoever claimed it first — or None if the job
        doesn't exist."""
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return None
            try:
                job = self._deserialize(row["data"])
            except Exception:
                return None
            if job.owner_id is None:
                job.owner_id = owner_id
                self._conn.execute(
                    "UPDATE jobs SET data = ? WHERE id = ?",
                    (self._serialize(job), job_id),
                )
                self._conn.commit()
            return job.owner_id

    def delete(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
            self._conn.execute("DELETE FROM job_keys WHERE job_id = ?",
                               (job_id,))
            self._conn.commit()

    def list_all(self) -> list[Job]:
        """Return every job in the store (unfiltered)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT data FROM jobs"
            ).fetchall()
        jobs: list[Job] = []
        for r in rows:
            try:
                jobs.append(self._deserialize(r["data"]))
            except Exception:
                continue
        return jobs

    def list_by_owner(self, owner_id: str, limit: int | None = None,
                      before: tuple[float, str] | None = None,
                      summary: bool = False) -> list[Job]:
        """Jobs of one account (GET /jobs). With `limit` / `before` (the
        (created_at, id) of the last job of the previous page): newest
        first by created_at (legacy jobs without one last), keyset-paged.
        `summary` lets a store leave out the big editor fields (Postgres
        does; SQLite returns whole jobs anyway)."""
        rows = [j for j in self.list_all() if j.owner_id == owner_id]
        if limit is None and before is None:
            return rows
        rows.sort(key=_list_key, reverse=True)
        if before is not None:
            cursor = (bool(before[0]), float(before[0] or 0), before[1])
            rows = [j for j in rows if _list_key(j) < cursor]
        return rows[:limit] if limit is not None else rows

    def list_by_status(self, *statuses: str,
                       error: str | None = None) -> list[Job]:
        """Jobs in one of `statuses` (and with job.error == `error`, if
        given) — the boot scans."""
        return [j for j in self.list_all() if j.status in statuses
                and (error is None or j.error == error)]

    def retention_candidates(self, before: float | None) -> list[Job]:
        """Jobs the retention sweep has to look at: not running, and idle
        since before `before` (None: none by age) or without updated_at
        (legacy, to be stamped). The sweep checks each job's own
        expires_at()."""
        return [j for j in self.list_all()
                if j.status not in RUNNING_STATUSES
                and (not j.updated_at
                     or (before is not None and j.updated_at < before))]

    def input_paths(self) -> set[str]:
        """input_path of every job that still has one (uploads in use)."""
        return {j.input_path for j in self.list_all() if j.input_path}

    def mark_stuck_as_error(
        self,
        message: str = "Processing was interrupted. "
                       "Please upload the video again.",
    ) -> int:
        """Mark jobs that were mid-processing during shutdown as failed.

        Called on container startup. Any job whose in-memory worker
        thread died with the previous process (status='processing' or
        'pending') is unrecoverable — surface the error so the user
        can retry instead of watching an infinite spinner.

        Returns the number of jobs that got marked.
        """
        marked = 0
        for job in self.list_all():
            src_ok = job.has_mezz()
            if job.status in ("processing", "pending"):
                if src_ok and job.segments:
                    # Died while RENDERING (or waiting for a render
                    # slot): analysis + edits are intact, send it back
                    # to review so the user can re-render.
                    self.update(job.id, status="awaiting_review", progress=100.0,
                                message="render_failed", error="container_restart",
                                queue_position=None)
                else:
                    self.update(job.id, status="error", message=message,
                                error="container_restart", progress=0.0,
                                queue_position=None)
                marked += 1
            elif (job.status == "awaiting_review" and not src_ok
                  and not job.has_media_keys()):
                # Files are gone (old /tmp storage) — can't be edited.
                # (A job with media keys keeps its files in the media
                # store: intact, even though this release can't open it.)
                self.update(job.id, status="error", error="files_expired",
                            message="This project's files have expired. "
                                    "Please upload the video again.")
                marked += 1
        return marked


def new_job_id() -> str:
    return uuid.uuid4().hex[:12]


# The store of the active database, opened on first use (_open_store).
_store_impl: Any = None
_store_lock = threading.Lock()


def _open_store() -> Any:
    impl = _store_impl
    if impl is not None:
        return impl
    backend = db.active()  # may run the Postgres cutover (backend/db.py)
    return _set_store(backend)


def _set_store(backend: str) -> Any:
    global _store_impl
    with _store_lock:
        if _store_impl is None:
            if backend == "postgres":
                from backend import pg
                _store_impl = pg.job_store()
            else:
                _store_impl = JobStore()
        return _store_impl


class _ActiveStore:
    """`store`: forwards to the job store of the active database — the
    SQLite JobStore above, or backend.pg.PgJobStore. Opened on first
    use. Attribute writes go to that store too, so monkeypatching
    store.<method> works as it did on the plain JobStore."""
    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        return getattr(_open_store(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(_open_store(), name, value)

    def __delattr__(self, name: str) -> None:
        delattr(_open_store(), name)

    def __repr__(self) -> str:
        return f"<backend.jobs.store → {_store_impl!r}>"


# Singleton — one store per process
store = _ActiveStore()
