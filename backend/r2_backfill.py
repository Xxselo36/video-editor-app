"""Backfill: move job media into R2, so the volume can go —

  * legacy jobs (from before WP3: local files on the work volume, job
    path fields) get their files uploaded under the WP3 keys;
  * keyed-local jobs (media_store "local": created while
    CLEO_MEDIA_BACKEND was unset / local) get their keys copied from the
    local media root to R2 — same keys.

Both end with media_store "r2". Needs R2 configured; it doesn't depend
on CLEO_MEDIA_BACKEND (that only decides where NEW jobs go).

    python -m backend.r2_backfill [--dry-run] [--delete-local]
                                  [--limit N] [--max-mbps 40] [--job ID]

Per job, newest updated_at first, skipping pending / processing jobs:
  0. keyed-local: every key of the job        → the same key in R2
  1. source:  a local upload (input_path)      → jobs/{id}/source{ext}
  2. mezz:    normalized_path                  → jobs/{id}/mezz.mp4
  3. proxy:   proxy.mp4 next to it, or made now → jobs/{id}/proxy.mp4
              (pipeline._make_proxy, CLEO_BACKFILL_MAKE_PROXY=1, the
              default: ~27 CPU-s per video minute, once, one at a time)
  4. preview: preview_path                     → jobs/{id}/preview/v{n}.mp4
  5. outputs: outputs / output_path            → jobs/{id}/r1/… (render_gen
              1); hard-linked formats (same st_dev, st_ino) are uploaded
              once and share one key
  6. thumbnail and hook clips                  → jobs/{id}/r1/thumb.jpg,
                                                  hook_{k}.mp4
  7. commit: HEAD every key, compare with the local size, then one
     compare-and-set (store.modify): only if the job still has the
     status, store and keys it had when the run started — else nothing
     is written (the next run retries) and the copies are queued for
     GC. A moved keyed-local job's local copy goes to the media GC a
     day later (a player may still stream it).

Idempotent and resumable: what is already in R2 is skipped. One line per
job, then a summary (jobs, bytes, estimated Railway egress at $0.05/GB).

--delete-local (a separate run, >= 7 days later): for legacy jobs whose
keys all verify by HEAD (size as recorded in media_bytes), delete the
local files and clear the local path fields.

The retention loop runs it in small batches when CLEO_BACKFILL=1
(backend/main.py _backfill_tick; one runner per process).
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from backend import media  # noqa: E402
from backend.jobs import RUNNING_STATUSES, Job, store  # noqa: E402

EGRESS_USD_PER_GB = 0.05
_RUN = threading.Lock()   # one runner per process


def _file(path: str | None) -> Path | None:
    if not path:
        return None
    p = Path(path)
    return p if p.is_file() else None


def _proxy_file(job: Job) -> Path | None:
    if not job.normalized_path:
        return None
    return _file(str(Path(job.normalized_path).with_name("proxy.mp4")))


def _thumb_file(job: Job) -> Path | None:
    if not job.output_path:
        return None
    return _file(str(Path(job.output_path).parent / "cleo_thumbnail.jpg"))


def _output_files(job: Job) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for fmt, path in (job.outputs or {}).items():
        f = _file(path)
        if f is not None:
            files[fmt] = f
    if "primary" not in files and _file(job.output_path):
        files["primary"] = Path(job.output_path)
    return files


def plan(job: Job, make_proxy: bool = True) -> list[dict[str, Any]]:
    """What a job still needs uploaded: [{field, key, path, ctype}]
    (field: the job field, or "output:<fmt>" / "thumb" / "hook:<k>")."""
    prefix = media.job_prefix(job.id)
    items: list[dict[str, Any]] = []
    src = _file(job.input_path)
    if src is not None and not job.source_key:
        from backend.uploads import upload_ext
        items.append({"field": "source_key", "path": src,
                      "key": f"{prefix}source{upload_ext(src.name)}",
                      "ctype": "application/octet-stream"})
    mezz = _file(job.normalized_path)
    if mezz is not None and not job.mezz_key:
        items.append({"field": "mezz_key", "path": mezz,
                      "key": prefix + "mezz.mp4", "ctype": "video/mp4"})
    if not job.proxy_key and mezz is not None:
        proxy = _proxy_file(job)
        if proxy is not None or make_proxy:
            items.append({"field": "proxy_key", "path": proxy,
                          "make_from": mezz, "key": prefix + "proxy.mp4",
                          "ctype": "video/mp4"})
    preview = _file(job.preview_path)
    if preview is not None and not job.preview_key:
        n = max(1, int(job.preview_version or 1))
        items.append({"field": "preview_key", "path": preview,
                      "key": f"{prefix}preview/v{n}.mp4",
                      "ctype": "video/mp4"})
    if not job.output_keys:
        outs = _output_files(job)
        if "primary" in outs:
            r1 = prefix + "r1/"
            for fmt, path in outs.items():
                items.append({"field": f"output:{fmt}", "path": path,
                              "key": _output_key(r1, fmt),
                              "ctype": "video/mp4"})
            thumb = _thumb_file(job)
            if thumb is not None and not job.thumb_key:
                items.append({"field": "thumb", "path": thumb,
                              "key": r1 + "thumb.jpg",
                              "ctype": "image/jpeg"})
            for i, clip in enumerate(job.hook_clips or []):
                path = _file(clip.get("path"))
                name = str(clip.get("key") or f"hook_{i + 1}")
                if path is not None:
                    items.append({"field": f"hook:{name}", "path": path,
                                  "key": _output_key(r1, name),
                                  "ctype": "video/mp4"})
    return items


def _output_key(prefix: str, fmt: str) -> str:
    if fmt == "primary":
        return prefix + "primary.mp4"
    return prefix + fmt.replace(":", "x") + ".mp4"


def _dedupe(items: list[dict[str, Any]]) -> None:
    """Hard-linked (same inode) or identical output files share the key
    of the first one (the primary comes first): stored once."""
    seen: dict[tuple, str] = {}
    for it in sorted(items, key=lambda i: i["field"] != "output:primary"):
        if not it["field"].startswith(("output:", "hook:")) or it["path"] is None:
            continue
        st = os.stat(it["path"])
        ident = (st.st_dev, st.st_ino)
        if ident in seen:
            it["key"] = seen[ident]
            it["alias"] = True
        else:
            seen[ident] = it["key"]


class _Throttle:
    """Keeps the average upload rate at or below max_mbps (MB/s × 8)."""

    def __init__(self, max_mbps: float) -> None:
        self.bps = max(0.1, float(max_mbps)) * 1e6 / 8
        self.t0 = time.monotonic()
        self.sent = 0

    def add(self, nbytes: int) -> None:
        self.sent += nbytes
        ahead = self.sent / self.bps - (time.monotonic() - self.t0)
        if ahead > 0:
            time.sleep(ahead)


_KEY_FIELDS = ("source_key", "mezz_key", "proxy_key", "preview_key",
               "thumb_key")


def _keys_of(job: Job) -> tuple:
    """The job's keys (compare-and-set of the commit)."""
    return (tuple(getattr(job, f) for f in _KEY_FIELDS),
            tuple((job.output_keys or {}).items()),
            job.preview_version)


def move_plan(job: Job) -> list[dict[str, Any]]:
    """A keyed-local job's keys (media_store "local"): each one to copy
    from the local media root to the same key in R2. Browser uploads
    (uploads/…) are in R2 already."""
    if media.store_of(job) != "local" or not media._job_keys(job):
        return []
    items = []
    for key in dict.fromkeys(media._job_keys(job)):
        path = media.local_path(key)
        items.append({"field": "move", "key": key,
                      "path": path if path.is_file() else None,
                      "ctype": ("image/jpeg" if key.endswith(".jpg")
                                else "video/mp4")})
    return items


def backfill_job(job: Job, *, dry_run: bool = False,
                 throttle: _Throttle | None = None,
                 make_proxy: bool = True) -> dict[str, Any]:
    """Upload, verify and commit one job's local media to R2. Returns
    {"job", "status": "done" | "dry-run" | "skipped" | "nothing" |
    "failed", "bytes", "detail"}."""
    from backend import storage
    out = {"job": job.id, "status": "nothing", "bytes": 0, "detail": ""}
    if job.status in RUNNING_STATUSES:
        out.update(status="skipped", detail=job.status)
        return out
    if not media.valid_job_id(job.id):
        out.update(status="skipped", detail="id")
        return out
    if not storage.r2_available():
        out.update(status="skipped", detail="R2 not configured")
        return out
    moving = move_plan(job)
    if any(it["path"] is None for it in moving):
        missing = [it["key"] for it in moving if it["path"] is None]
        out.update(status="failed", detail=f"local copy missing: {missing}")
        return out
    items = moving + plan(job, make_proxy=make_proxy)
    if not items:
        return out
    _dedupe(items)
    if dry_run:
        out.update(status="dry-run", bytes=sum(
            it["path"].stat().st_size for it in items
            if it["path"] is not None and not it.get("alias")),
            detail=", ".join(sorted({it["key"].rsplit("/", 1)[-1]
                                     for it in items})))
        return out
    tmp_proxy: Path | None = None
    try:
        sizes: dict[str, int] = {}
        for it in items:
            if it["path"] is None:   # proxy to make now
                from backend import pipeline
                tmp_proxy = Path(it["make_from"]).with_name(
                    f"proxy.backfill.{os.getpid()}.mp4")
                if not pipeline._make_proxy(str(it["make_from"]),
                                            str(tmp_proxy)):
                    it["skip"] = True
                    continue
                it["path"] = tmp_proxy
            if it.get("alias"):
                continue
            size = media.put_file(it["path"], it["key"],
                                  content_type=it["ctype"], store="r2")
            sizes[it["key"]] = size
            out["bytes"] += size
            if throttle is not None:
                throttle.add(size)
        items = [it for it in items if not it.get("skip")]
        for it in items:     # verify: HEAD every key against the file
            want = it["path"].stat().st_size
            got = media.size(it["key"], store="r2")
            if got != want:
                raise RuntimeError(f"{it['key']}: stored {got} B, "
                                   f"local {want} B")
        fields = _commit_fields(job, [it for it in items
                                      if it["field"] != "move"], sizes)
        before = (job.status, job.media_store, _keys_of(job))

        def _cas(cur: Job) -> dict | None:
            if (cur.status, cur.media_store, _keys_of(cur)) != before:
                return None
            # Merged into what is stored now; updated_at stays (the
            # backfill isn't a use of the project).
            return {**fields, "media_store": "r2",
                    "media_bytes": {**(cur.media_bytes or {}),
                                    **fields["media_bytes"]},
                    "updated_at": cur.updated_at}
        if store.modify(job.id, _cas) is None:
            # Not committed. The R2 copies stay: the next run uploads
            # the same keys again and commits them (a deleted job's are
            # found by the orphan sweep).
            out.update(status="skipped", detail="job changed meanwhile")
            return out
        if moving:
            # The local copy: a player may still stream it for a while.
            store.gc_add([media.job_prefix(job.id)],
                         time.time() + 24 * 3600, store="local")
        out.update(status="done", detail=", ".join(
            sorted({it["key"].rsplit("/", 1)[-1] for it in items})))
        return out
    except Exception as e:
        out.update(status="failed", detail=f"{type(e).__name__}: {e}")
        return out
    finally:
        if tmp_proxy is not None:
            tmp_proxy.unlink(missing_ok=True)


def _commit_fields(job: Job, items: list[dict[str, Any]],
                   sizes: dict[str, int]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    media_bytes = {k: v for k, v in sizes.items()}
    output_keys: dict[str, str] = {}
    for it in items:
        field, key = it["field"], it["key"]
        media_bytes[key] = sizes.get(key, media_bytes.get(key, 0))
        if field.startswith("output:"):
            output_keys[field.split(":", 1)[1]] = key
        elif field.startswith("hook:"):
            output_keys[field.split(":", 1)[1]] = key
        elif field == "thumb":
            fields["thumb_key"] = key
        else:
            fields[field] = key
    if output_keys:
        # primary first: the order of the download buttons.
        fields["output_keys"] = {"primary": output_keys.pop("primary"),
                                 **output_keys}
        fields["render_gen"] = max(1, int(job.render_gen or 0))
    fields["media_bytes"] = media_bytes
    return fields


def _local_files(job: Job) -> list[Path]:
    files = [_file(job.input_path), _file(job.normalized_path),
             _proxy_file(job), _file(job.preview_path), _thumb_file(job)]
    files += list(_output_files(job).values())
    files += [_file(c.get("path")) for c in job.hook_clips or []]
    return [f for f in files if f is not None]


def delete_local(job: Job, *, dry_run: bool = False,
                 work_root: Path | None = None) -> dict[str, Any]:
    """Remove a backfilled job's local files once every key verifies by
    HEAD (size as recorded in media_bytes)."""
    out = {"job": job.id, "status": "nothing", "bytes": 0, "detail": ""}
    files = _local_files(job)
    job_dir = (work_root or media.work_root()) / job.id
    if not files and not job_dir.exists():
        return out
    if job.status in RUNNING_STATUSES:
        out.update(status="skipped", detail=job.status)
        return out
    keys = [k for k in [job.mezz_key, job.proxy_key, job.preview_key,
                        job.thumb_key, *(job.output_keys or {}).values()]
            if k]
    if not job.mezz_key or not keys or media.store_of(job) != "r2":
        out.update(status="skipped", detail="not backfilled")
        return out
    for key in dict.fromkeys(keys):
        want = (job.media_bytes or {}).get(key)
        got = media.size(key, store="r2")
        if got is None or (want is not None and got != want):
            out.update(status="skipped", detail=f"{key} does not verify")
            return out
    out["bytes"] = sum(f.stat().st_size for f in files)
    if dry_run:
        out.update(status="dry-run", detail=f"{len(files)} file(s)")
        return out
    for f in files:
        f.unlink(missing_ok=True)
    shutil.rmtree(job_dir, ignore_errors=True)
    hooks = [{k: v for k, v in c.items() if k != "path"}
             for c in job.hook_clips or []]
    store.update(job.id, input_path=None, normalized_path=None,
                 preview_path=None, output_path=None, outputs={},
                 hook_clips=hooks, updated_at=job.updated_at)
    out.update(status="done", detail=f"{len(files)} file(s)")
    return out


def _candidates(job_id: str | None) -> list[Job]:
    if job_id:
        job = store.get(job_id)
        return [job] if job is not None else []
    jobs = store.list_all()
    jobs.sort(key=lambda j: j.updated_at or 0, reverse=True)
    return jobs


def run(*, dry_run: bool = False, delete_local_files: bool = False,
        limit: int | None = None, max_mbps: float = 40.0,
        job_id: str | None = None, echo=None) -> dict[str, Any] | None:
    """One pass. Returns the summary, or None when another pass of this
    process is running."""
    from backend import storage
    if not storage.r2_available():
        return {"jobs": 0, "bytes": 0, "failed": 0, "skipped": 0,
                "error": "R2 not configured"}
    if not _RUN.acquire(blocking=False):
        return None
    echo = echo or (lambda line: print(line, flush=True))
    try:
        make_proxy = os.environ.get("CLEO_BACKFILL_MAKE_PROXY",
                                    "1").strip() != "0"
        throttle = _Throttle(max_mbps)
        summary = {"jobs": 0, "bytes": 0, "failed": 0, "skipped": 0}
        for job in _candidates(job_id):
            if limit is not None and summary["jobs"] >= limit:
                break
            if delete_local_files:
                res = delete_local(job, dry_run=dry_run)
            else:
                res = backfill_job(job, dry_run=dry_run, throttle=throttle,
                                   make_proxy=make_proxy)
            if res["status"] == "nothing":
                continue
            echo(f"[backfill] {res['job']} {res['status']} "
                 f"{res['bytes'] / 1e6:.1f} MB {res['detail']}")
            if res["status"] in ("done", "dry-run"):
                summary["jobs"] += 1
                summary["bytes"] += res["bytes"]
            elif res["status"] == "failed":
                summary["failed"] += 1
            else:
                summary["skipped"] += 1
        if not delete_local_files:
            summary["egress_usd_est"] = round(
                summary["bytes"] / 1e9 * EGRESS_USD_PER_GB, 4)
        summary["local_only_left"] = sum(
            1 for j in store.list_all()
            if j.status not in RUNNING_STATUSES
            and (move_plan(j) or plan(j, make_proxy=False)))
        return summary
    finally:
        _RUN.release()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.r2_backfill",
                                 description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--delete-local", action="store_true",
                    help="remove local files of jobs whose keys verify")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--max-mbps", type=float, default=40.0)
    ap.add_argument("--job", default=None)
    args = ap.parse_args(argv)
    from backend import storage
    if not storage.r2_available():
        print("[backfill] R2 is not configured (R2_* env vars) — nothing "
              "to move to", flush=True)
        return 2
    print(f"[backfill] target: R2 bucket {storage.bucket()}"
          + (" (dry run)" if args.dry_run else ""), flush=True)
    summary = run(dry_run=args.dry_run, delete_local_files=args.delete_local,
                  limit=args.limit, max_mbps=args.max_mbps, job_id=args.job)
    print(f"[backfill] summary: {summary}", flush=True)
    return 1 if summary and summary.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
