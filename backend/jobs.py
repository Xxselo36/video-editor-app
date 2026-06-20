"""In-memory job store for the web backend.

Phase 2 is single-process, single-worker, no persistence. Phase 3 will
swap this for Redis + RQ without changing the API surface.
"""
from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
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


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, input_path: str, settings: dict[str, Any]) -> Job:
        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, input_path=input_path, settings=settings)
        with self._lock:
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for k, v in fields.items():
                setattr(job, k, v)


# Singleton — one store per process is fine for Phase 2
store = JobStore()
