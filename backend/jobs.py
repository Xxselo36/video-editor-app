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
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Literal

from backend import db, taskq

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


# The editor proxy's file name next to a legacy job's normalized file
# (backend.pipeline.PROXY_NAME).
LEGACY_PROXY_NAME = "proxy.mp4"

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
    # Machine-readable cause of `error` for the client ("no_speech",
    # "render_failed", "quota_exceeded", …; None = none known), and
    # whether the job's minutes were credited back for it (None: nothing
    # was charged or it isn't known). `error` keeps the raw text.
    error_code: str | None = None
    refunded: bool | None = None
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
    # ── Media keys (backend/media.py; R2 or the local media root) ──
    # Where the job's files live. Set once the object is stored; a key
    # never changes its content (a new version gets a new key). The
    # local path fields above (input_path, normalized_path, preview_path,
    # output_path, outputs, hook_clips[].path) are only read for jobs
    # from before the keys (not yet backfilled, backend/r2_backfill.py).
    # (The WP3-prep release carries these fields without using them: it
    # is the rollback target and must neither drop them nor treat a
    # keyed job as broken.)
    source_key: str | None = None      # upload / source object
    mezz_key: str | None = None        # jobs/{id}/mezz.mp4 (render source)
    proxy_key: str | None = None       # jobs/{id}/proxy.mp4 (editor)
    preview_key: str | None = None     # jobs/{id}/preview/v{n}.mp4
    # Render generation: POST /render bumps it; outputs of generation g
    # live under jobs/{id}/r{g}/.
    render_gen: int = 0
    # Format → key ("primary", "9:16", …, "hook_1", …). Same-size
    # formats point at the primary's key.
    output_keys: dict[str, str] = field(default_factory=dict)
    thumb_key: str | None = None
    # Key → size in bytes (storage accounting, GET /admin/costs).
    media_bytes: dict[str, int] = field(default_factory=dict)
    # Where the job's keys live ("r2" / "local"); None = not recorded.
    media_store: str | None = None
    # Steps the task queue's worker had to leave out (WP4, e.g.
    # "llm_skipped:cleanup" while Anthropic is down or its spend limit is
    # reached). None = none recorded — then it isn't stored at all, so a
    # job written without the queue looks exactly as before.
    processing_warnings: list[str] | None = None
    # ── UT3: the edit document and media analysis (new jobs only; a job
    # analysed before keeps None / defaults and opens as before) ──
    # EditDoc v2 (backend/doc.py): words, style, format, clips (null
    # until UX10). GET/PATCH /jobs/{id}/doc.
    doc: dict[str, Any] | None = None
    # Last accepted client revision of the doc (PATCH base_rev / rev).
    doc_rev: float = 0
    # Frame rate of the mezz, and whether it is constant (the web
    # normalize makes it so; review C8). UT4 snaps cuts to that grid.
    mezz_fps: float | None = None
    mezz_cfr: bool = False
    # loudnorm measurement of the mezz audio {I, TP, LRA, thresh, offset}.
    audio_loudness: dict[str, Any] | None = None
    # jobs/{id}/peaks.bin: 100 Hz int8 RMS envelope (audio_analysis.py).
    peaks_key: str | None = None
    # CJK caption font subsets {font: {family, rev, chars, missing, json,
    # woff2, ttf (keys)}} (backend/font_subset.py).
    font_subsets: dict[str, Any] = field(default_factory=dict)
    # Keys of the stored row this code doesn't know (a later release's
    # fields): kept as stored and written back on every write, so this
    # release can't drop them. Never part of the API.
    _extras: dict[str, Any] = field(default_factory=dict, repr=False,
                                    compare=False)

    def source_ref(self) -> str | None:
        """The upload object: source_key, or where jobs from before the
        media keys kept it (settings._r2_storage_key)."""
        return self.source_key or (self.settings or {}).get("_r2_storage_key")

    def has_mezz(self) -> bool:
        """Can this job still be edited / rendered: its render source is
        stored (mezz_key) or, for a legacy job, on the local disk."""
        return bool(self.mezz_key) or (
            bool(self.normalized_path) and Path(self.normalized_path).exists())

    def has_media_keys(self) -> bool:
        """Does this job keep (some of) its media under media keys
        (backend/media.py, in R2 or the local media root)? Such a job is
        intact even when its legacy local paths are missing (boot
        sweep). The WP3-prep release — the rollback target — answers 409
        media_unavailable for these jobs."""
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

    def _has_output(self) -> bool:
        if self.output_keys:
            return bool(self.output_keys.get("primary"))
        return self.output_path is not None and Path(self.output_path).exists()

    def _has_proxy(self) -> bool:
        """GET /jobs/{id}/proxy-video has something to play: the proxy
        object, or (legacy jobs) proxy.mp4 next to the normalized file.
        Always False unless CLEO_PROXY_VIDEO=1 (the route's lever)."""
        if os.environ.get("CLEO_PROXY_VIDEO", "").strip() != "1":
            return False
        if self.proxy_key:
            return True
        return bool(self.normalized_path) and (
            Path(self.normalized_path).with_name(LEGACY_PROXY_NAME).is_file())

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "plan": self.plan,
            "expires_at": self.expires_at(),
            "message": self.message,
            "progress": self.progress,
            "error": self.error,
            "error_code": self.error_code,
            "refunded": self.refunded,
            "has_output": self._has_output(),
            "has_proxy": self._has_proxy(),
            "outputs": list((self.output_keys or self.outputs).keys()),
            "social_caption": self.social_caption,
            "social_hashtags": self.social_hashtags,
            # Media keys and local paths are never exposed.
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
            # The edit document (UT3): fetched with GET /jobs/{id}/doc.
            "has_doc": self.doc is not None,
            "font_subsets": _public_fonts(self.font_subsets),
            "peaks": ({"rate": 100, "floor_db": -96} if self.peaks_key
                      else None),
            # Only once the task queue's worker recorded any (WP4).
            **({"processing_warnings": list(self.processing_warnings)}
               if self.processing_warnings is not None else {}),
        }


def _public_fonts(font_subsets: dict | None) -> dict:
    from backend import font_subset
    return font_subset.public(font_subsets)


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
# output_keys only so has_output can be told without touching the disk.
_STATUS_FIELDS = ("id", "status", "message", "progress", "queue_position",
                  "error", "error_code", "refunded", "output_path",
                  "updated_at", "preview_version", "owner_id", "output_keys")


# Durable queue of media prefixes / keys to delete (backend/main.py
# _media_gc): a `jobs/{id}/…` prefix (ends with "/") or a single key, in
# `store` ("local" / "r2"; "" = queued before stores were recorded:
# deleted in both). Only entries media.gc_entry_ok accepts get in.
_MEDIA_GC_DDL = (
    "CREATE TABLE IF NOT EXISTS media_gc ("
    "prefix TEXT NOT NULL, store TEXT NOT NULL DEFAULT '', "
    "not_before REAL NOT NULL, "
    "attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, "
    "created_at REAL NOT NULL, PRIMARY KEY (prefix, store))")

# Failed deletes wait before the next try: GC_BACKOFF_BASE_S × 2^(n-1),
# at most GC_BACKOFF_MAX_S (a stuck row must not block newer ones: rows
# are taken oldest not_before first).
GC_BACKOFF_BASE_S = 300.0
GC_BACKOFF_MAX_S = 6 * 3600.0


# Job lifecycle events (analysis / render outcomes, backend/main.py
# _record_event) for the reliability numbers of GET /admin/metrics. A
# log of their own, so the numbers survive the jobs' deletion; pruned
# after EVENTS_KEEP_DAYS. Not part of backups or the Postgres cutover
# (backend/pg.py TABLES): statistics only, rebuilt by new events.
_EVENTS_DDL = (
    "CREATE TABLE IF NOT EXISTS job_events ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, "
    "kind TEXT NOT NULL, job_id TEXT, data TEXT NOT NULL DEFAULT '{}')",
    "CREATE INDEX IF NOT EXISTS job_events_kind_at ON job_events(kind, at)",
)
EVENTS_KEEP_DAYS = 90.0

# WP4 task queue (backend/taskq.py): the same tables as Postgres
# (backend/pg.py _SCHEMA_V5), in this connection, so a job write and its
# task commit together. Times are Unix floats. Created whatever
# CLEO_TASK_QUEUE says (empty and unused while it is off). Not part of
# backups or the Postgres cutover (backend/pg.py TABLES): after a
# restore or a cutover the leader re-enqueues what was running.
_TASKS_DDL = (
    "CREATE TABLE IF NOT EXISTS tasks ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, "
    "kind TEXT NOT NULL CHECK (kind IN ('ingest', 'render', 'preview')), "
    "state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', "
    "'running', 'succeeded', 'failed', 'dead', 'cancelled')), "
    "owner_id TEXT, plan TEXT, payload TEXT NOT NULL DEFAULT '{}', "
    "sort_at REAL NOT NULL, run_after REAL NOT NULL, "
    "attempts INTEGER NOT NULL DEFAULT 0, "
    "max_attempts INTEGER NOT NULL DEFAULT 3, "
    "provider_waits INTEGER NOT NULL DEFAULT 0, first_wait_at REAL, "
    "executor TEXT, locked_by TEXT, locked_until REAL, heartbeat_at REAL, "
    "modal_call_id TEXT, started_at REAL, finished_at REAL, result TEXT, "
    "error_code TEXT, last_error TEXT, retryable INTEGER, finalized_at REAL, "
    "created_at REAL NOT NULL, updated_at REAL NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active ON tasks "
    "(job_id, kind) WHERE state IN ('queued', 'dispatching', 'running')",
    "CREATE INDEX IF NOT EXISTS tasks_queue ON tasks (kind, sort_at, id) "
    "WHERE state = 'queued'",
    "CREATE INDEX IF NOT EXISTS tasks_leases ON tasks (locked_until) "
    "WHERE state IN ('dispatching', 'running')",
    "CREATE INDEX IF NOT EXISTS tasks_unfinalized ON tasks (finished_at) "
    "WHERE finalized_at IS NULL AND state IN ('succeeded', 'failed', "
    "'dead', 'cancelled')",
    "CREATE INDEX IF NOT EXISTS tasks_started ON tasks (kind, started_at) "
    "WHERE started_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS tasks_job ON tasks (job_id)",
    "CREATE TABLE IF NOT EXISTS provider_state ("
    "provider TEXT PRIMARY KEY, open_until REAL, reason TEXT, "
    "failures INTEGER NOT NULL DEFAULT 0, window_start REAL, "
    "opens INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS queue_positions ("
    "job_id TEXT PRIMARY KEY, kind TEXT, pos INTEGER, hint TEXT, "
    "updated_at REAL)",
)


def event_row(at: float, kind: str, job_id: str | None,
              data: Any) -> dict[str, Any]:
    """An events() row: {at, kind, job_id, data} with data a dict."""
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            data = {}
    return {"at": float(at), "kind": kind, "job_id": job_id,
            "data": data if isinstance(data, dict) else {}}


def gc_backoff_s(attempts: int) -> float:
    return min(GC_BACKOFF_MAX_S,
               GC_BACKOFF_BASE_S * 2 ** max(0, int(attempts) - 1))


def gc_clean_entries(entries: Iterable[str]) -> list[str]:
    """The entries the media GC may take (media.gc_entry_ok); anything
    else is refused loudly and not queued."""
    from backend import media
    ok = []
    for e in entries:
        if not e:
            continue
        if media.gc_entry_ok(e):
            ok.append(e)
        else:
            print(f"[media] REFUSING to queue {e!r} for deletion: not a "
                  "GC-able media key or prefix", flush=True)
    return ok


def gc_store(store: str | None) -> str:
    return store if store in ("local", "r2") else ""


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
    # Stored only once set: rows written without the task queue keep
    # exactly the keys they had before WP4.
    if d.get("processing_warnings") is None:
        d.pop("processing_warnings", None)
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
        self._tasks: SqliteTaskStore | None = None
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
            self._gc_migrate()
            self._conn.execute(_MEDIA_GC_DDL)
            for ddl in _EVENTS_DDL:
                self._conn.execute(ddl)
            for ddl in _TASKS_DDL:
                self._conn.execute(ddl)
            self._conn.commit()

    @property
    def tasks(self) -> "SqliteTaskStore":
        """The task store of this database (same connection and lock)."""
        if self._tasks is None:
            self._tasks = SqliteTaskStore(self)
        return self._tasks

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
            job = self._deserialize(row["data"])
        except Exception:
            return None
        return self._with_position(job)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        if row is None:
            return None
        try:
            job = self._deserialize(row["data"])
        except Exception as e:
            print(f"[jobstore] deserialize failed for {job_id}: {e}",
                  flush=True)
            return None
        return self._with_position(job)

    def _positions(self, job_ids: list[str]) -> dict[str, int]:
        """queue_position of queued jobs, from the task queue's
        queue_positions table (the leader keeps it current; the job rows
        don't carry it with the queue on). {} while the queue is off."""
        if not job_ids or not taskq.enabled():
            return {}
        marks = ",".join("?" for _ in job_ids)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT job_id, pos FROM queue_positions WHERE job_id IN "
                f"({marks}) AND pos IS NOT NULL", list(job_ids)).fetchall()
        return {r["job_id"]: int(r["pos"]) for r in rows}

    def _with_position(self, job: Job) -> Job:
        pos = self._positions([job.id]).get(job.id)
        if pos is not None:
            job.queue_position = pos
        return job

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
            return self._apply(job_id, expect, change, commit=True)

    def _apply(self, job_id: str, expect: tuple[str, ...] | None,
               change: dict[str, Any] | Callable[[Job], Any],
               commit: bool) -> dict[str, Any] | None:
        """_write's read-check-write, the store lock held. commit=False:
        part of a larger transaction (the task store's), which commits
        or rolls back itself."""
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
        if not commit:
            self._conn.execute("UPDATE jobs SET data = ? WHERE id = ?",
                               (self._serialize(job), job_id))
            return fields_to_update
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

    def patch_status(self, job_id: str, expect: str | tuple[str, ...],
                     **fields_to_update: Any) -> bool:
        """A progress write (message / progress) while the job's status
        is `expect` — never after a terminal one. SQLite has one process
        and one lock, so this is update_if (Postgres merges the fields
        into the row instead of rewriting it)."""
        return self.update_if(job_id, expect, **fields_to_update)

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
        for job_id, pos in self._positions(list(out)).items():
            out[job_id]["queue_position"] = pos
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

    def delete(self, job_id: str, gc: Iterable[str] = (),
               not_before: float | None = None,
               gc_store: str | None = None) -> None:
        """Delete the job row; with `gc`, queue those media prefixes /
        keys (in `gc_store`, the job's) for deletion (media_gc) in the
        same transaction."""
        entries = gc_clean_entries(gc)
        with self._lock:
            try:
                self._conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
                self._conn.execute("DELETE FROM job_keys WHERE job_id = ?",
                                   (job_id,))
                # Its tasks go with it (Postgres: ON DELETE CASCADE): a
                # worker still running one is fenced out on its next
                # heartbeat and commits nothing.
                self._conn.execute("DELETE FROM tasks WHERE job_id = ?",
                                   (job_id,))
                self._conn.execute(
                    "DELETE FROM queue_positions WHERE job_id = ?", (job_id,))
                self._gc_insert(entries, time.time() if not_before is None
                                else not_before, gc_store)
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    def exists(self, job_id: str) -> bool:
        """Is there a row for `job_id` — readable or not (the orphan
        sweep: a row get() can't parse still owns its media)."""
        with self._lock:
            return self._conn.execute(
                "SELECT 1 FROM jobs WHERE id = ?", (job_id,)
            ).fetchone() is not None

    # ── media_gc: durable deletion queue (backend/main.py _media_gc) ──

    def _gc_migrate(self) -> None:
        """A media_gc from before stores were recorded (prefix alone as
        the key): rebuilt with store '' (= both)."""
        cols = [r["name"] for r in self._conn.execute(
            "PRAGMA table_info(media_gc)")]
        if cols and "store" not in cols:
            self._conn.execute("ALTER TABLE media_gc RENAME TO media_gc_v1")
            self._conn.execute(_MEDIA_GC_DDL)
            self._conn.execute(
                "INSERT INTO media_gc (prefix, store, not_before, attempts, "
                "last_error, created_at) SELECT prefix, '', not_before, "
                "attempts, last_error, created_at FROM media_gc_v1")
            self._conn.execute("DROP TABLE media_gc_v1")

    def _gc_insert(self, entries: list[str], not_before: float,
                   store: str | None = None) -> None:
        now = time.time()
        for entry in entries:
            self._conn.execute(
                "INSERT INTO media_gc (prefix, store, not_before, attempts, "
                "last_error, created_at) VALUES (?, ?, ?, 0, NULL, ?) "
                "ON CONFLICT(prefix, store) DO UPDATE SET "
                "not_before = min(media_gc.not_before, excluded.not_before)",
                (entry, gc_store(store), float(not_before), now))

    def gc_add(self, entries: Iterable[str],
               not_before: float | None = None,
               store: str | None = None) -> None:
        """Queue media prefixes / keys in `store` for deletion at
        `not_before` (default now). An entry already queued keeps the
        earlier time. Entries outside the GC whitelist are refused."""
        entries = gc_clean_entries(entries)
        if not entries:
            return
        with self._lock:
            try:
                self._gc_insert(entries, time.time() if not_before is None
                                else not_before, store)
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    _GC_COLS = "prefix, store, not_before, attempts, last_error, created_at"

    @staticmethod
    def _gc_row(r) -> dict[str, Any]:
        d = dict(r)
        d["store"] = d.get("store") or None
        return d

    def gc_due(self, now: float | None = None,
               limit: int = 200) -> list[dict[str, Any]]:
        """Entries whose time has come, oldest first."""
        now = time.time() if now is None else now
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {self._GC_COLS} "
                "FROM media_gc WHERE not_before <= ? ORDER BY not_before "
                "LIMIT ?", (float(now), int(limit))).fetchall()
        return [self._gc_row(r) for r in rows]

    def gc_all(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {self._GC_COLS} "
                "FROM media_gc ORDER BY not_before").fetchall()
        return [self._gc_row(r) for r in rows]

    def gc_done(self, prefix: str, store: str | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "DELETE FROM media_gc WHERE prefix = ? AND store = ?",
                (prefix, gc_store(store)))
            self._conn.commit()

    def gc_failed(self, prefix: str, error: str,
                  store: str | None = None,
                  now: float | None = None) -> int:
        """attempts + 1, the error, and the next try pushed back
        (gc_backoff_s); returns the new attempt count."""
        now = time.time() if now is None else now
        with self._lock:
            row = self._conn.execute(
                "SELECT attempts FROM media_gc WHERE prefix = ? AND store = ?",
                (prefix, gc_store(store))).fetchone()
            if row is None:
                return 0
            attempts = int(row["attempts"]) + 1
            self._conn.execute(
                "UPDATE media_gc SET attempts = ?, last_error = ?, "
                "not_before = ? WHERE prefix = ? AND store = ?",
                (attempts, error[:2000], now + gc_backoff_s(attempts),
                 prefix, gc_store(store)))
            self._conn.commit()
        return attempts

    def _truncate_gc_for_tests(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM media_gc")
            self._conn.commit()

    # ── job_events: the reliability log (GET /admin/metrics) ──

    def record_event(self, kind: str, job_id: str | None,
                     data: dict[str, Any] | None = None,
                     at: float | None = None) -> None:
        """Append one event (see _EVENTS_DDL)."""
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO job_events (at, kind, job_id, data) "
                    "VALUES (?, ?, ?, ?)",
                    (time.time() if at is None else float(at), kind, job_id,
                     json.dumps(data or {}, default=str)))
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    def events(self, since: float, kinds: Iterable[str] | None = None,
               limit: int = 200_000) -> list[dict[str, Any]]:
        """Events at or after `since` (of `kinds`), oldest first, as
        {at, kind, job_id, data}."""
        kinds = list(kinds or ())
        sql = "SELECT at, kind, job_id, data FROM job_events WHERE at >= ?"
        args: list[Any] = [float(since)]
        if kinds:
            sql += f" AND kind IN ({','.join('?' for _ in kinds)})"
            args += kinds
        sql += " ORDER BY at, id LIMIT ?"
        args.append(int(limit))
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [event_row(r["at"], r["kind"], r["job_id"], r["data"])
                for r in rows]

    def prune_events(self, before: float) -> int:
        """Delete events older than `before`; returns how many."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM job_events WHERE at < ?",
                                     (float(before),))
            self._conn.commit()
            return cur.rowcount

    def _truncate_events_for_tests(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM job_events")
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
        for job in rows:
            if job.status in RUNNING_STATUSES:
                self._with_position(job)
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
                                error_code="render_failed",
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


class _Rollback(Exception):
    """Internal: undo the task store transaction, answer normally."""


# The per-user limit counts jobs, not the claims of POST /jobs requests
# still being accepted (pending + settings._accepting): those are
# admitted one after the other (the store lock / the user's advisory
# lock) and stop being claims when admitted — counting them would let a
# burst of one account's uploads refuse each other, all of them.
_NOT_A_CLAIM_SQLITE = (
    "AND coalesce(json_extract(json_extract(data, '$.settings'), "
    "'$._accepting'), 0) IS NOT 1")


class SqliteTaskStore:
    """The WP4 task queue on SQLite (backend/taskq.py): the tasks,
    provider_state and queue_positions tables of the job DB, on the job
    store's connection and under its lock — so a job write and its task
    commit together, and the one process serializes every claim (the
    Postgres store, backend/pg_tasks.py, uses row locks and SKIP LOCKED
    instead). Same methods as PgTaskStore. Times are Unix floats."""

    def __init__(self, jobs_store: JobStore) -> None:
        self._s = jobs_store

    # ── plumbing ─────────────────────────────────────────────────────

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """One transaction on the job store's connection."""
        with self._s._lock:
            conn = self._s._conn
            try:
                yield conn
                conn.commit()
            except BaseException:
                conn.rollback()
                raise

    def _tasks(self, sql: str, args: Iterable[Any] = ()) -> list[taskq.Task]:
        with self._s._lock:
            rows = self._s._conn.execute(sql, list(args)).fetchall()
        return [taskq.task_from_row(dict(r)) for r in rows]

    def _one(self, sql: str, args: Iterable[Any] = ()) -> Any:
        with self._s._lock:
            row = self._s._conn.execute(sql, list(args)).fetchone()
        return row[0] if row is not None else None

    @staticmethod
    def _insert(conn: sqlite3.Connection, job_id: str, kind: str,
                payload: dict[str, Any], owner_id: str | None,
                plan: str | None, sort_offset_s: float, max_attempts: int,
                now: float) -> int:
        try:
            cur = conn.execute(
                "INSERT INTO tasks (job_id, kind, state, owner_id, plan, "
                "payload, sort_at, run_after, max_attempts, created_at, "
                "updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
                (job_id, kind, owner_id, plan, json.dumps(payload),
                 now + float(sort_offset_s), now, int(max_attempts), now,
                 now))
        except sqlite3.IntegrityError as e:
            raise taskq.TaskActive(f"job {job_id} has an active {kind} "
                                   "task") from e
        return int(cur.lastrowid)

    def notify(self, kind: str) -> None:
        """Wake the dispatcher (one process: in-process only)."""
        taskq.wake(kind)

    def schema_version(self) -> int:
        return taskq.REQUIRED_SCHEMA

    # ── enqueue (with the job write, in one transaction) ─────────────

    def enqueue(self, job_id: str, kind: str,
                payload: dict[str, Any] | Callable[[dict | None], dict], *,
                owner_id: str | None = None, plan: str | None = None,
                sort_offset_s: float = 0.0, max_attempts: int = 3,
                job_expect: str | tuple[str, ...] | None = None,
                job_change: dict[str, Any] | Callable[[Job], Any] | None = None
                ) -> tuple[int | None, dict[str, Any] | None]:
        """Insert a queued task. With job_change: only if that job write
        applies (update_if(job_expect) / modify), in the same
        transaction. `payload` may be a callable of the job fields
        written. Returns (task id, the job fields written) — (None,
        None) when the job write didn't apply. Raises taskq.TaskActive
        (nothing written) when the job already has an active task of
        this kind."""
        expect = ((job_expect,) if isinstance(job_expect, str)
                  else job_expect)
        now = time.time()
        with self._tx() as conn:
            written = None
            if job_change is not None:
                written = self._s._apply(job_id, expect, job_change,
                                         commit=False)
                if written is None:
                    return None, None
            if callable(payload):
                payload = payload(written)
            task_id = self._insert(conn, job_id, kind, payload, owner_id,
                                   plan, sort_offset_s, max_attempts, now)
        self.notify(kind)
        return task_id, written

    def admit_ingest(self, job_id: str, *, owner_id: str | None,
                     count_user: bool, user_limit: int, queue_cap: int,
                     running_limit: int, payload: dict[str, Any],
                     plan: str | None, sort_offset_s: float,
                     max_attempts: int, job_fields: dict[str, Any]) -> str:
        """POST /jobs, after the charge: the binding admission checks and
        the enqueue in one transaction — the owner's other running jobs
        (count_user; < user_limit, else "too_many_active_jobs"), the
        analyses waiting beyond the running ones (≤ queue_cap, else
        "server_busy"), then the claim row becomes the job (update_if
        pending → job_fields) and its ingest task is inserted. Returns
        "ok", one of those codes, or "gone" (the claim row vanished)."""
        now = time.time()
        with self._tx() as conn:
            if count_user and owner_id and user_limit > 0:
                n = conn.execute(
                    "SELECT count(*) FROM jobs WHERE id <> ? AND "
                    "json_extract(data, '$.owner_id') = ? AND "
                    "json_extract(data, '$.status') IN ('pending', "
                    "'processing') " + _NOT_A_CLAIM_SQLITE,
                    (job_id, owner_id)).fetchone()[0]
                if n >= user_limit:
                    return "too_many_active_jobs"
            queued, active = conn.execute(
                "SELECT count(*) FILTER (WHERE state = 'queued'), "
                "count(*) FILTER (WHERE state IN ('dispatching', 'running')) "
                "FROM tasks WHERE kind = 'ingest' AND state IN ('queued', "
                "'dispatching', 'running')").fetchone()
            if queued + active + 1 - running_limit > queue_cap:
                return "server_busy"
            if self._s._apply(job_id, ("pending",), job_fields,
                              commit=False) is None:
                return "gone"
            self._insert(conn, job_id, "ingest", payload, owner_id, plan,
                         sort_offset_s, max_attempts, now)
        self.notify("ingest")
        return "ok"

    def admission_counts(self, owner_id: str | None) -> tuple[int, int, int]:
        """(the owner's running jobs, queued ingest tasks, dispatched or
        running ingest tasks) — the soft checks of presign / multipart
        init and POST /jobs before any bytes move (no lock)."""
        with self._s._lock:
            user = 0
            if owner_id:
                user = self._s._conn.execute(
                    "SELECT count(*) FROM jobs WHERE "
                    "json_extract(data, '$.owner_id') = ? AND "
                    "json_extract(data, '$.status') IN ('pending', "
                    "'processing') " + _NOT_A_CLAIM_SQLITE,
                    (owner_id,)).fetchone()[0]
            queued, active = self._s._conn.execute(
                "SELECT count(*) FILTER (WHERE state = 'queued'), "
                "count(*) FILTER (WHERE state IN ('dispatching', 'running')) "
                "FROM tasks WHERE kind = 'ingest' AND state IN ('queued', "
                "'dispatching', 'running')").fetchone()
        return int(user), int(queued or 0), int(active or 0)

    # ── dispatcher ───────────────────────────────────────────────────

    def counts(self, kind: str) -> tuple[int, int]:
        """(queued, dispatched or running) tasks of `kind`."""
        with self._s._lock:
            queued, active = self._s._conn.execute(
                "SELECT count(*) FILTER (WHERE state = 'queued'), "
                "count(*) FILTER (WHERE state IN ('dispatching', 'running')) "
                "FROM tasks WHERE kind = ? AND state IN ('queued', "
                "'dispatching', 'running')", (kind,)).fetchone()
        return int(queued or 0), int(active or 0)

    def active_count(self, kind: str) -> int:
        return self.counts(kind)[1]

    def queued(self, kind: str | None = None, limit: int | None = None
               ) -> list[taskq.Task]:
        """Queued tasks in dispatch order (per kind: sort_at, id)."""
        sql = "SELECT * FROM tasks WHERE state = 'queued'"
        args: list[Any] = []
        if kind is not None:
            sql += " AND kind = ?"
            args.append(kind)
        sql += " ORDER BY kind, sort_at, id"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(int(limit))
        return self._tasks(sql, args)

    def claim_for_dispatch(self, kind: str, limit: int, leader_id: str,
                           lease_s: float, executor: str, *,
                           created_before: float | None = None
                           ) -> list[taskq.Task]:
        """Take up to `limit` queued tasks of `kind` that are due, in
        order: state dispatching, attempts + 1 (the fencing token), a
        start lease of lease_s; ingest tasks count against the Groq
        window from now (started_at)."""
        if limit <= 0:
            return []
        now = time.time()
        with self._tx() as conn:
            sql = ("SELECT id FROM tasks WHERE state = 'queued' AND "
                   "kind = ? AND run_after <= ?")
            args: list[Any] = [kind, now]
            if created_before is not None:
                sql += " AND created_at <= ?"
                args.append(created_before)
            sql += " ORDER BY sort_at, id LIMIT ?"
            args.append(int(limit))
            ids = [r[0] for r in conn.execute(sql, args).fetchall()]
            for task_id in ids:
                conn.execute(
                    "UPDATE tasks SET state = 'dispatching', "
                    "attempts = attempts + 1, locked_by = ?, "
                    "locked_until = ?, executor = ?, updated_at = ?, "
                    "started_at = CASE WHEN kind = 'ingest' THEN ? "
                    "ELSE started_at END WHERE id = ? AND state = 'queued'",
                    (leader_id, now + lease_s, executor, now, now, task_id))
            if not ids:
                return []
            marks = ",".join("?" for _ in ids)
            rows = conn.execute(
                f"SELECT * FROM tasks WHERE id IN ({marks}) "
                "ORDER BY sort_at, id", ids).fetchall()
        return [taskq.task_from_row(dict(r)) for r in rows]

    def mark_spawned(self, task_id: int, attempt: int, call_id: str) -> bool:
        with self._tx() as conn:
            return conn.execute(
                "UPDATE tasks SET modal_call_id = ?, updated_at = ? "
                "WHERE id = ? AND attempts = ?",
                (call_id, time.time(), task_id, attempt)).rowcount == 1

    def groq_window_s(self, since: float) -> float:
        """Estimated Groq audio-seconds of the ingest tasks started after
        `since` (the budget gate)."""
        value = self._one(
            "SELECT sum(CAST(json_extract(payload, '$.est_audio_s') AS REAL)) "
            "FROM tasks WHERE kind = 'ingest' AND started_at > ?", (since,))
        return float(value or 0.0)

    # ── worker (fenced by attempts) ──────────────────────────────────

    def worker_claim(self, task_id: int, attempt: int, call_id: str,
                     lease_s: float) -> taskq.Task | None:
        """running, leased to `call_id` — only while attempts == attempt
        (dispatching, or running: a rerun of the same attempt). None:
        fenced out."""
        now = time.time()
        with self._tx() as conn:
            cur = conn.execute(
                "UPDATE tasks SET state = 'running', "
                "modal_call_id = coalesce(modal_call_id, ?), locked_by = ?, "
                "locked_until = ?, heartbeat_at = ?, "
                "started_at = coalesce(started_at, ?), updated_at = ? "
                "WHERE id = ? AND attempts = ? AND state IN ('dispatching', "
                "'running')",
                (call_id, call_id, now + lease_s, now, now, now, task_id,
                 attempt))
            if cur.rowcount != 1:
                return None
            row = conn.execute("SELECT * FROM tasks WHERE id = ?",
                               (task_id,)).fetchone()
        return taskq.task_from_row(dict(row))

    def heartbeat(self, task_id: int, attempt: int, lease_s: float) -> bool:
        """Renew the lease; False = fenced out (requeued, re-claimed,
        its job deleted): stop, commit nothing."""
        now = time.time()
        with self._tx() as conn:
            return conn.execute(
                "UPDATE tasks SET locked_until = ?, heartbeat_at = ?, "
                "updated_at = ? WHERE id = ? AND attempts = ? AND "
                "state = 'running'",
                (now + lease_s, now, now, task_id, attempt)).rowcount == 1

    def commit_success(self, task_id: int, attempt: int,
                       result: dict[str, Any] | Callable[[], dict[str, Any]],
                       job_id: str, job_expect: str | tuple[str, ...] | None,
                       job_change: dict[str, Any] | Callable[[Job], Any]
                       ) -> str:
        """The attempt's result and the job's new state, in one
        transaction: the task succeeds only while this attempt still
        holds it, the job write only with it. `result` may be a callable
        (called after the job write); its "gc" entry ([entries,
        not_before, store]) is queued in media_gc in the same
        transaction (the render a new one supersedes). Returns "ok",
        "fenced" (nothing written) or "job_changed" (the job isn't in
        job_expect any more / gone: nothing written)."""
        expect = ((job_expect,) if isinstance(job_expect, str)
                  else job_expect)
        now = time.time()
        try:
            with self._tx() as conn:
                if conn.execute(
                        "UPDATE tasks SET state = 'succeeded', "
                        "finished_at = ?, locked_until = NULL, "
                        "error_code = NULL, retryable = NULL, "
                        "updated_at = ? WHERE id = ? AND attempts = ? AND "
                        "state = 'running'",
                        (now, now, task_id, attempt)).rowcount != 1:
                    return "fenced"
                if self._s._apply(job_id, expect, job_change,
                                  commit=False) is None:
                    raise _Rollback()
                value = dict((result() if callable(result) else result) or {})
                gc = value.pop("gc", None)
                if gc and gc[0]:
                    self._s._gc_insert(gc_clean_entries(gc[0]),
                                       float(gc[1]), gc[2])
                conn.execute("UPDATE tasks SET result = ? WHERE id = ?",
                             (json.dumps(value), task_id))
        except _Rollback:
            return "job_changed"
        taskq.wake_finalizer()
        return "ok"

    def report_failure(self, task_id: int, attempt: int, error_code: str,
                       message: str, retryable: bool,
                       result: dict[str, Any] | None = None) -> bool:
        """The attempt failed (the finalizer decides what happens next);
        only while it still holds the task. False: fenced out."""
        now = time.time()
        with self._tx() as conn:
            ok = conn.execute(
                "UPDATE tasks SET state = 'failed', finished_at = ?, "
                "error_code = ?, last_error = ?, retryable = ?, result = ?, "
                "locked_until = NULL, updated_at = ? WHERE id = ? AND "
                "attempts = ? AND state = 'running'",
                (now, error_code, (message or "")[:2000], int(bool(retryable)),
                 json.dumps(result or {}), now, task_id,
                 attempt)).rowcount == 1
        if ok:
            taskq.wake_finalizer()
        return ok

    # ── reaper / finalizer ───────────────────────────────────────────

    def expired(self, now: float | None = None) -> list[taskq.Task]:
        """Dispatched or running tasks whose lease ran out."""
        now = time.time() if now is None else now
        return self._tasks(
            "SELECT * FROM tasks WHERE state IN ('dispatching', 'running') "
            "AND locked_until < ? ORDER BY locked_until", (now,))

    def requeue(self, task_id: int, *, expect_states: tuple[str, ...],
                attempts: int, delay_s: float = 0.0, free: bool = False,
                provider_wait: bool = False, error_code: str | None = None,
                last_error: str | None = None,
                expired_before: float | None = None,
                dead: bool = False) -> str | None:
        """Take a task back (reaper: a lost lease; finalizer: a retryable
        failure). Only while it is still in `expect_states` with this
        `attempts` (and, with expired_before, its lease ran out before
        then). queued again after delay_s — or dead
        (attempts_exhausted) once a counted attempt was the last, or
        with dead=True (error_code / last_error as given). `free`: the
        attempt doesn't count (max_attempts + 1: a provider wait, a
        spawn that never ran, a shutdown); `provider_wait` also counts
        the wait. Never lowers attempts (the fencing token). Returns
        "queued", "dead" or None (changed meanwhile)."""
        now = time.time()
        with self._tx() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?",
                               (task_id,)).fetchone()
            if row is None:
                return None
            t = taskq.task_from_row(dict(row))
            if (t.state not in expect_states or t.attempts != attempts
                    or t.finalized_at is not None
                    or (expired_before is not None
                        and not (t.locked_until is not None
                                 and t.locked_until < expired_before))):
                return None
            code = error_code or t.error_code
            text = last_error if last_error is not None else t.last_error
            if dead or (not free and t.attempts >= t.max_attempts):
                conn.execute(
                    "UPDATE tasks SET state = 'dead', finished_at = ?, "
                    "locked_by = NULL, locked_until = NULL, "
                    "error_code = ?, last_error = ?, retryable = 0, "
                    "updated_at = ? WHERE id = ?",
                    (now, code if dead else taskq.ATTEMPTS_EXHAUSTED,
                     ((text or "") if dead else
                      (f"{code}: {text}" if code else (text or "")))[:2000],
                     now, task_id))
                new_state = "dead"
            else:
                conn.execute(
                    "UPDATE tasks SET state = 'queued', run_after = ?, "
                    "max_attempts = max_attempts + ?, "
                    "provider_waits = provider_waits + ?, "
                    "first_wait_at = CASE WHEN ? THEN coalesce("
                    "first_wait_at, ?) ELSE first_wait_at END, "
                    "locked_by = NULL, locked_until = NULL, "
                    "heartbeat_at = NULL, modal_call_id = NULL, "
                    "finished_at = NULL, result = NULL, error_code = ?, "
                    "last_error = ?, retryable = NULL, updated_at = ? "
                    "WHERE id = ?",
                    (now + max(0.0, delay_s), 1 if free else 0,
                     1 if provider_wait else 0, 1 if provider_wait else 0,
                     now, code, (text or "")[:2000] or None, now, task_id))
                new_state = "queued"
        if new_state == "queued":
            self.notify(t.kind)
        else:
            taskq.wake_finalizer()
        return new_state

    def expire_held(self, kind: str, older_than: float, error_code: str,
                    message: str) -> list[taskq.Task]:
        """Queued tasks of `kind` waiting since before `older_than`
        (their first provider wait, else their creation) → dead."""
        now = time.time()
        with self._tx() as conn:
            rows = conn.execute(
                "SELECT id FROM tasks WHERE state = 'queued' AND kind = ? "
                "AND coalesce(first_wait_at, created_at) < ?",
                (kind, older_than)).fetchall()
            ids = [r[0] for r in rows]
            for task_id in ids:
                conn.execute(
                    "UPDATE tasks SET state = 'dead', finished_at = ?, "
                    "error_code = ?, last_error = ?, retryable = 0, "
                    "updated_at = ? WHERE id = ? AND state = 'queued'",
                    (now, error_code, message[:2000], now, task_id))
            if not ids:
                return []
            marks = ",".join("?" for _ in ids)
            out = conn.execute(f"SELECT * FROM tasks WHERE id IN ({marks})",
                               ids).fetchall()
        taskq.wake_finalizer()
        return [taskq.task_from_row(dict(r)) for r in out]

    def unfinalized(self, limit: int = 50) -> list[taskq.Task]:
        """Terminal tasks the finalizer hasn't settled, oldest first."""
        return self._tasks(
            "SELECT * FROM tasks WHERE finalized_at IS NULL AND state IN "
            "('succeeded', 'failed', 'dead', 'cancelled') "
            "ORDER BY finished_at, id LIMIT ?", (int(limit),))

    def mark_finalized(self, task_id: int,
                       event: tuple[str, str | None, dict[str, Any]] | None
                       = None) -> bool:
        """Settled — with its job event (kind, job_id, data) in the same
        transaction, so the event is recorded exactly once. False: it
        was settled already (or isn't terminal)."""
        now = time.time()
        with self._tx() as conn:
            if conn.execute(
                    "UPDATE tasks SET finalized_at = ?, updated_at = ? "
                    "WHERE id = ? AND finalized_at IS NULL AND state IN "
                    "('succeeded', 'failed', 'dead', 'cancelled')",
                    (now, now, task_id)).rowcount != 1:
                return False
            if event is not None:
                kind, job_id, data = event
                conn.execute(
                    "INSERT INTO job_events (at, kind, job_id, data) "
                    "VALUES (?, ?, ?, ?)",
                    (now, kind, job_id, json.dumps(data or {}, default=str)))
        return True

    # ── queue positions ──────────────────────────────────────────────

    def write_positions(self, rows: list[tuple[str, str, int, str | None]]
                        ) -> None:
        """Replace queue_positions with (job_id, kind, pos, hint) rows."""
        now = time.time()
        with self._tx() as conn:
            conn.execute("DELETE FROM queue_positions")
            conn.executemany(
                "INSERT OR REPLACE INTO queue_positions (job_id, kind, pos, "
                "hint, updated_at) VALUES (?, ?, ?, ?, ?)",
                [(j, k, p, h, now) for j, k, p, h in rows])

    def position(self, job_id: str) -> tuple[int | None, str | None]:
        with self._s._lock:
            row = self._s._conn.execute(
                "SELECT pos, hint FROM queue_positions WHERE job_id = ?",
                (job_id,)).fetchone()
        return (int(row["pos"]), row["hint"]) if row else (None, None)

    def rank(self, task_id: int) -> int | None:
        """1-based place of a queued task among the queued tasks of its
        kind (dispatch order); None if it isn't queued."""
        with self._s._lock:
            row = self._s._conn.execute(
                "SELECT kind, sort_at FROM tasks WHERE id = ? AND "
                "state = 'queued'", (task_id,)).fetchone()
            if row is None:
                return None
            n = self._s._conn.execute(
                "SELECT count(*) FROM tasks WHERE state = 'queued' AND "
                "kind = ? AND (sort_at < ? OR (sort_at = ? AND id <= ?))",
                (row["kind"], row["sort_at"], row["sort_at"],
                 task_id)).fetchone()[0]
        return int(n)

    # ── lookups ──────────────────────────────────────────────────────

    def get(self, task_id: int) -> taskq.Task | None:
        rows = self._tasks("SELECT * FROM tasks WHERE id = ?", (task_id,))
        return rows[0] if rows else None

    def for_job(self, job_id: str) -> list[taskq.Task]:
        return self._tasks("SELECT * FROM tasks WHERE job_id = ? ORDER BY id",
                           (job_id,))

    def active_task(self, job_id: str, kind: str | None = None
                    ) -> taskq.Task | None:
        sql = ("SELECT * FROM tasks WHERE job_id = ? AND state IN "
               "('queued', 'dispatching', 'running')")
        args: list[Any] = [job_id]
        if kind is not None:
            sql += " AND kind = ?"
            args.append(kind)
        rows = self._tasks(sql + " ORDER BY id", args)
        return rows[0] if rows else None

    def job_ids(self, kind: str) -> list[str]:
        """The jobs that got a task of `kind`, in the order the tasks
        were created (one entry per task)."""
        with self._s._lock:
            rows = self._s._conn.execute(
                "SELECT job_id FROM tasks WHERE kind = ? ORDER BY id",
                (kind,)).fetchall()
        return [r[0] for r in rows]

    def unsettled_job_ids(self) -> set[str]:
        """Jobs with a task that is active or not finalized yet."""
        with self._s._lock:
            rows = self._s._conn.execute(
                "SELECT DISTINCT job_id FROM tasks WHERE state IN "
                "('queued', 'dispatching', 'running') OR finalized_at IS "
                "NULL").fetchall()
        return {r[0] for r in rows}

    def running_jobs_without_tasks(self) -> list[str]:
        """Jobs pending / processing with no active and no unfinalized
        task: left behind by the WP1 path, a rollback or a restore (the
        leader's migration re-enqueues or settles them)."""
        with self._s._lock:
            rows = self._s._conn.execute(
                "SELECT id FROM jobs WHERE json_extract(data, '$.status') "
                "IN ('pending', 'processing') AND NOT EXISTS (SELECT 1 FROM "
                "tasks t WHERE t.job_id = jobs.id AND (t.state IN "
                "('queued', 'dispatching', 'running') OR "
                "t.finalized_at IS NULL))").fetchall()
        return [r[0] for r in rows]

    # ── provider breakers ────────────────────────────────────────────

    def breaker(self, provider: str) -> taskq.Breaker:
        with self._s._lock:
            row = self._s._conn.execute(
                "SELECT * FROM provider_state WHERE provider = ?",
                (provider,)).fetchone()
        return taskq.breaker_from_row(provider, dict(row) if row else None)

    def update_breaker(self, provider: str,
                       fn: Callable[[taskq.Breaker], taskq.Breaker | None]
                       ) -> taskq.Breaker:
        """Read-modify-write one provider_state row atomically."""
        with self._tx() as conn:
            row = conn.execute(
                "SELECT * FROM provider_state WHERE provider = ?",
                (provider,)).fetchone()
            cur = taskq.breaker_from_row(provider, dict(row) if row else None)
            new = fn(cur)
            if new is None:
                return cur
            conn.execute(
                "INSERT INTO provider_state (provider, open_until, reason, "
                "failures, window_start, opens, updated_at) VALUES "
                "(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET "
                "open_until = excluded.open_until, reason = excluded.reason, "
                "failures = excluded.failures, "
                "window_start = excluded.window_start, "
                "opens = excluded.opens, updated_at = excluded.updated_at",
                (provider, new.open_until, new.reason, new.failures,
                 new.window_start, new.opens, new.updated_at or time.time()))
        return new

    def _truncate_for_tests(self) -> None:
        with self._tx() as conn:
            for table in ("tasks", "provider_state", "queue_positions"):
                conn.execute(f"DELETE FROM {table}")


def task_store() -> Any:
    """The task store of the active database (SqliteTaskStore, or
    backend.pg_tasks.PgTaskStore with Postgres) — the job store's own,
    so it follows whatever store is active."""
    return _open_store().tasks


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
