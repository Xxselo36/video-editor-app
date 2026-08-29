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
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Literal

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
    social_caption: str = ""
    social_hashtags: list[str] = field(default_factory=list)
    hook_clips: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
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
        }


def _db_path() -> str:
    return os.environ.get("CLEO_JOB_DB", "/tmp/cleo_jobs.db")


# Fields that hold structured (list/dict) data — JSON-encode on write,
# JSON-decode on read.
_JSON_FIELDS = {
    "settings", "subtitles", "segments", "cut_ranges",
    "audio_warnings", "audio_levels", "outputs",
    "social_hashtags", "hook_clips",
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
        job = Job(id=job_id, input_path=input_path, settings=settings)
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
            self._conn.execute(
                "UPDATE jobs SET data = ? WHERE id = ?",
                (self._serialize(job), job_id),
            )
            self._conn.commit()


# Singleton — one store per process
store = JobStore()
