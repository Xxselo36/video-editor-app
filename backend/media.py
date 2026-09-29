"""Job media, backend-neutral: the only API the rest of the backend uses
to store and serve a job's files.

Two backends, chosen per process from the environment:

    R2 configured (backend/storage.py), CLEO_MEDIA_BACKEND unset → "r2"
    CLEO_MEDIA_BACKEND=local                                  → "local"
    no R2_* env vars                                          → "local"
    CLEO_MEDIA_BACKEND=r2 without R2 config                   → refuse to
                                                                start
                                                                (ConfigError)

Both use the same keys (layout in DEPLOY.md, "Media storage (R2)"):

    uploads/{user}/{uuid32}{ext}   browser upload target
    jobs/{id}/source{ext}          a source that didn't come via uploads/
    jobs/{id}/mezz.mp4             render source (normalized / SmartCam)
    jobs/{id}/proxy.mp4            <=720p editor proxy, same timeline
    jobs/{id}/preview/v{n}.mp4     server-built cut preview, version n
    jobs/{id}/r{g}/…               render generation g (primary.mp4,
                                   {fmt}.mp4, hook_{k}.mp4, thumb.jpg)

Keys are immutable: a key a committed job points to is never
overwritten; a new version always gets a new key.

"local" keeps the files under CLEO_MEDIA_ROOT/<key> (default
<work root>/media) and serves them with FileResponse (Range works).
"r2" answers media requests with a 307 to a presigned GET.

stdlib only at import (backend.storage imports boto3 lazily; fastapi is
imported inside media_response), so backend.pipeline and the Modal
image can import it.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from backend import storage


class ConfigError(RuntimeError):
    """CLEO_MEDIA_BACKEND doesn't make sense: don't start."""


# Cache headers of objects under jobs/ (R2 metadata; the local backend
# answers with its own headers, see media_response).
IMMUTABLE = storage.IMMUTABLE
# How long a browser may reuse a 307 to R2: far below the >= 24 h the
# presigned target stays valid.
REDIRECT_CACHE = "private, max-age=3600"

_JOB_ID = re.compile(r"^[0-9a-f]{12}$")


def backend() -> str:
    """'r2' or 'local' (see module doc). Raises ConfigError for
    CLEO_MEDIA_BACKEND=r2 without R2 config or an unknown value."""
    choice = os.environ.get("CLEO_MEDIA_BACKEND", "").strip().lower()
    if choice in ("", "auto"):
        return "r2" if storage.r2_available() else "local"
    if choice == "local":
        return "local"
    if choice == "r2":
        if not storage.r2_available():
            raise ConfigError(
                "CLEO_MEDIA_BACKEND=r2 but R2 is not configured — set "
                "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and "
                "R2_BUCKET, or remove CLEO_MEDIA_BACKEND")
        return "r2"
    raise ConfigError(f"CLEO_MEDIA_BACKEND={choice!r}: use 'r2' or 'local' "
                      "(or leave it unset)")


def is_r2() -> bool:
    return backend() == "r2"


def _where(key: str) -> str:
    """Browser uploads (uploads/…) are in R2 whenever R2 is configured —
    the upload API needs it, also with CLEO_MEDIA_BACKEND=local; every
    other key is in the media backend."""
    if key.startswith("uploads/") and storage.r2_available():
        return "r2"
    return backend()


def check_key(key: Any) -> str:
    """A key both backends accept, or ValueError: no '..', no leading
    '/', no backslash, no NUL."""
    if (not isinstance(key, str) or not key or ".." in key
            or key.startswith("/") or "\\" in key or "\x00" in key
            or len(key) > 1024):
        raise ValueError(f"bad media key: {key!r}")
    return key


def valid_job_id(job_id: Any) -> bool:
    return isinstance(job_id, str) and bool(_JOB_ID.match(job_id))


def job_prefix(job_id: str) -> str:
    """`jobs/{id}/` — the id must look like backend.jobs.new_job_id()."""
    if not valid_job_id(job_id):
        raise ValueError(f"bad job id for a media prefix: {job_id!r}")
    return f"jobs/{job_id}/"


def key_prefix_of(key: str) -> str:
    """`jobs/{id}/r{g}/` of `jobs/{id}/r{g}/primary.mp4` (the folder)."""
    return key.rsplit("/", 1)[0] + "/" if "/" in key else key


# ── local backend ────────────────────────────────────────────────────


def work_root() -> Path:
    """Job work root of the web backend (backend.main._WORK_ROOT):
    CLEO_WORK_ROOT, else the /data volume, else the temp dir."""
    env = os.environ.get("CLEO_WORK_ROOT")
    if env:
        return Path(env)
    data = Path("/data")
    if data.is_dir() and os.access(data, os.W_OK):
        return data / "cleo_jobs"
    return Path(tempfile.gettempdir()) / "cleo_jobs"


def local_root() -> Path:
    env = os.environ.get("CLEO_MEDIA_ROOT", "").strip()
    return Path(env) if env else work_root() / "media"


def local_path(key: str) -> Path:
    return local_root() / check_key(key)


def _link_or_copy(src: str | Path, dest: Path) -> None:
    """dest := src, atomically (temp name + rename). A hard link when
    both are on one filesystem (nothing ever writes into a stored file,
    and the other name is a workspace copy about to be deleted), else a
    copy."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        try:
            os.link(src, tmp)
        except OSError:
            shutil.copyfile(src, tmp)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


# ── API ──────────────────────────────────────────────────────────────


def put_file(path: str | Path, key: str, *, content_type: str,
             cache_control: str = IMMUTABLE) -> int:
    """Store a local file under `key`. Returns its size. Raises."""
    check_key(key)
    if backend() == "r2":
        return storage.put_file(str(path), key, content_type=content_type,
                                cache_control=cache_control)
    size = os.path.getsize(path)
    _link_or_copy(path, local_path(key))
    return size


def get_file(key: str, path: str | Path) -> None:
    """Fetch `key` into a local file. Raises (FileNotFoundError locally)."""
    check_key(key)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    if _where(key) == "r2":
        storage.get_file(key, str(path))
        return
    src = local_path(key)
    if not src.is_file():
        raise FileNotFoundError(f"media object {key} not found")
    _link_or_copy(src, Path(path))


def size(key: str) -> int | None:
    """Size of `key`; None when it doesn't exist. Raises on errors."""
    check_key(key)
    if _where(key) == "r2":
        return storage.head(key)
    try:
        return local_path(key).stat().st_size
    except FileNotFoundError:
        return None


def exists(key: str | None) -> bool:
    try:
        return bool(key) and size(key) is not None
    except ValueError:
        return False


def delete(key: str) -> None:
    check_key(key)
    if _where(key) == "r2":
        storage.delete(key)
        return
    local_path(key).unlink(missing_ok=True)


def delete_prefix(prefix: str) -> int:
    """Delete everything under a `jobs/{id}/…` or `uploads/…/` prefix.
    Returns how many objects. Raises."""
    check_key(prefix)
    if not prefix.endswith("/"):
        raise ValueError(f"not a prefix: {prefix!r}")
    if _where(prefix) == "r2":
        return storage.delete_prefix(prefix)
    root = local_path(prefix)
    if not root.exists():
        return 0
    n = sum(1 for p in root.rglob("*") if p.is_file())
    shutil.rmtree(root)
    return n


def delete_any(entry: str) -> int:
    """A media_gc entry: a prefix (ends with '/') or a single key."""
    if entry.endswith("/"):
        return delete_prefix(entry)
    delete(entry)
    return 1


def presign_get(key: str, *, filename: str | None = None,
                attachment: bool = False,
                content_type: str | None = None) -> str:
    """R2 only: the presigned GET the media routes redirect to."""
    check_key(key)
    return storage.presign_get(key, filename=filename, attachment=attachment,
                               content_type=content_type)


def media_response(key: str, *, media_type: str,
                   download_name: str | None = None,
                   cache: str | None = None):
    """What a media route answers for `key`: r2 → 307 to a presigned GET
    (Cache-Control: private, max-age=3600); local → FileResponse (Range,
    `cache` as its Cache-Control, an attachment when `download_name`).
    Raises FileNotFoundError when a local object is missing."""
    from fastapi.responses import FileResponse, RedirectResponse
    check_key(key)
    if _where(key) == "r2":
        url = presign_get(key, filename=download_name,
                          attachment=bool(download_name),
                          content_type=media_type)
        return RedirectResponse(url, status_code=307,
                                headers={"Cache-Control": REDIRECT_CACHE})
    path = local_path(key)
    if not path.is_file():
        raise FileNotFoundError(f"media object {key} not found")
    headers = {"Accept-Ranges": "bytes"}
    if cache:
        headers["Cache-Control"] = cache
    return FileResponse(path=str(path), media_type=media_type,
                        filename=download_name, headers=headers)


def delete_user(user_id: str) -> int:
    """Account deletion (for later use): the user's upload prefix plus the
    media of each of their jobs. Returns how many objects went. The job
    rows themselves are the caller's business."""
    from backend import auth
    from backend.jobs import store
    removed = delete_prefix(auth.upload_prefix(auth.User(id=user_id)))
    for job in store.list_by_owner(user_id):
        if valid_job_id(job.id):
            removed += delete_prefix(job_prefix(job.id))
        if job.source_key:
            try:
                delete(job.source_key)
                removed += 1
            except ValueError:
                pass
    return removed


def list_job_prefixes(skip=None):
    """(job id, newest object time as a Unix float) of every jobs/{id}/
    prefix — the orphan sweep. Ids for which skip(id) is true aren't
    looked into."""
    if backend() == "r2":
        for job_id, newest in storage.list_job_prefixes(skip):
            yield job_id, newest.timestamp()
        return
    root = local_root() / "jobs"
    if not root.is_dir():
        return
    for d in root.iterdir():
        if not d.is_dir() or (skip is not None and skip(d.name)):
            continue
        newest = None
        for f in d.rglob("*"):
            try:
                if f.is_file():
                    m = f.stat().st_mtime
                    newest = m if newest is None or m > newest else newest
            except OSError:
                pass
        if newest is not None:
            yield d.name, newest
