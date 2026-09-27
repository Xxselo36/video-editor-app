"""SQLite-backed job store for the web backend.

Persists across container restarts so a Railway deploy doesn't nuke
in-flight jobs (which was killing users mid-render). Same API surface
as the old in-memory version — callers use store.create / .get / .update.

DB file lives at CLEO_JOB_DB (default /data/cleo_jobs.db). On Railway
that's a mounted persistent volume; locally it defaults to /tmp.
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
from typing import Any, Literal

# Subscription plans and how long an idle project is kept (days after
# the last change). No free tier. Override per plan with e.g.
# CLEO_RETENTION_DAYS_PRO=45; CLEO_RETENTION_DAYS=0 disables deletion.
# Until accounts/billing exist every job gets CLEO_DEFAULT_PLAN.
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
                {k: v for k, v in c.items() if k != "path"}
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


# Fields that hold structured (list/dict) data — JSON-encode on write,
# JSON-decode on read.
_JSON_FIELDS = {
    "settings", "subtitles", "segments", "cut_ranges",
    "audio_warnings", "audio_levels", "outputs",
    "social_hashtags", "hook_clips", "scene_events",
}


class JobStore:
    """SQLite-backed job store. Thread-safe via a single connection lock.
    Writes are synchronous so the current job survives a hard crash /
    OOM kill mid-render.
    """
    def __init__(self) -> None:
        self._lock = threading.Lock()
        db_path = _db_path()
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
            )
            self._conn.commit()

    def _serialize(self, job: Job) -> str:
        d = asdict(job)
        for k in _JSON_FIELDS:
            if k in d and not isinstance(d[k], str):
                d[k] = json.dumps(d[k])
        return json.dumps(d)

    def _deserialize(self, row_data: str) -> Job:
        d = json.loads(row_data)
        for k in _JSON_FIELDS:
            if k in d and isinstance(d[k], str):
                try:
                    d[k] = json.loads(d[k])
                except (json.JSONDecodeError, TypeError):
                    pass
        # Reconstruct segments as tuples (JSON gives lists)
        if isinstance(d.get("segments"), list):
            d["segments"] = [tuple(s) for s in d["segments"]]
        # Filter to known Job fields (schema-tolerant reads)
        known = {f.name for f in fields(Job)}
        d = {k: v for k, v in d.items() if k in known}
        return Job(**d)

    def create(self, input_path: str, settings: dict[str, Any]) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, input_path=input_path, settings=settings,
                  updated_at=time.time())
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (id, data) VALUES (?, ?)",
                (job_id, self._serialize(job)),
            )
            self._conn.commit()
        return job

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
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return
            try:
                job = self._deserialize(row["data"])
            except Exception:
                return
            for k, v in fields_to_update.items():
                setattr(job, k, v)
            if "updated_at" not in fields_to_update:
                job.updated_at = time.time()
            self._conn.execute(
                "UPDATE jobs SET data = ? WHERE id = ?",
                (self._serialize(job), job_id),
            )
            self._conn.commit()

    def delete(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
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
            src_ok = bool(job.normalized_path) and Path(job.normalized_path).exists()
            if job.status in ("processing", "pending"):
                if src_ok and job.segments:
                    # Died while RENDERING: analysis + edits are intact,
                    # send it back to review so the user can re-render.
                    self.update(job.id, status="awaiting_review", progress=100.0,
                                message="render_failed", error="container_restart")
                else:
                    self.update(job.id, status="error", message=message,
                                error="container_restart", progress=0.0)
                marked += 1
            elif job.status == "awaiting_review" and not src_ok:
                # Files are gone (old /tmp storage) — can't be edited.
                self.update(job.id, status="error", error="files_expired",
                            message="This project's files have expired. "
                                    "Please upload the video again.")
                marked += 1
        return marked


# Singleton — one store per process
store = JobStore()
