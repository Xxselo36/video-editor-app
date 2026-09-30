"""Job media, backend-neutral: the only API the rest of the backend uses
to store and serve a job's files.

Two stores. Every job records where its media lives (Job.media_store,
"r2" | "local", set when its first keys are written); every read,
write and delete of a job's media goes to THAT store, whatever the
process setting says now. The process setting only decides where the
media of NEW jobs goes:

    CLEO_MEDIA_BACKEND unset / "local"                     → "local"
    CLEO_MEDIA_BACKEND=r2 (R2 configured, backend/storage)  → "r2"
    CLEO_MEDIA_BACKEND=r2 without R2 config                 → refuse to
                                                              start
                                                              (ConfigError)

So switching CLEO_MEDIA_BACKEND in either direction never strands a
job: old jobs keep being served from where they are (R2 must stay
configured while any job has media_store="r2"); r2_backfill can move
keyed-local jobs to R2.

Browser uploads (uploads/…) are in R2 whenever R2 is configured — the
upload API needs it — whatever the job's store.

Both stores use the same keys (layout in DEPLOY.md, "Media storage"):

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


STORES = ("local", "r2")


def backend() -> str:
    """Where the media of NEW jobs goes: 'local' (default) or 'r2' (only
    with CLEO_MEDIA_BACKEND=r2). Raises ConfigError for
    CLEO_MEDIA_BACKEND=r2 without R2 config or an unknown value."""
    choice = os.environ.get("CLEO_MEDIA_BACKEND", "").strip().lower()
    if choice in ("", "local"):
        return "local"
    if choice == "r2":
        if not storage.r2_available():
            raise ConfigError(
                "CLEO_MEDIA_BACKEND=r2 but R2 is not configured — set "
                "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and "
                "R2_BUCKET, or remove CLEO_MEDIA_BACKEND")
        return "r2"
    raise ConfigError(f"CLEO_MEDIA_BACKEND={choice!r}: use 'r2' or 'local' "
                      "(or leave it unset = local)")


def is_r2() -> bool:
    """Do NEW jobs keep their media in R2?"""
    return backend() == "r2"


def _job_keys(job: Any) -> list[str]:
    keys = [getattr(job, k, None) for k in (
        "source_key", "mezz_key", "proxy_key", "preview_key", "thumb_key")]
    keys += list((getattr(job, "output_keys", None) or {}).values())
    keys.append(getattr(job, "peaks_key", None))
    for sub in (getattr(job, "font_subsets", None) or {}).values():
        if isinstance(sub, dict):
            keys += [sub.get(k) for k in ("woff2", "ttf", "json")]
    return [k for k in keys if isinstance(k, str) and k
            and not k.startswith("uploads/")]


def store_of(job: Any) -> str:
    """The store a job's media lives in: Job.media_store; for a job
    without one — no keys yet (legacy or not analysed), or keys written
    before the store was recorded — where its keys are found (a local
    file wins, else R2 when configured), else where new media goes."""
    s = getattr(job, "media_store", None)
    if s in STORES:
        return s
    keys = _job_keys(job)
    if keys:
        for k in keys:
            try:
                if local_path(k).is_file():
                    return "local"
            except ValueError:
                continue
        if storage.r2_available():
            return "r2"
        return "local"
    return backend()


def _where(key: str, store: str | None) -> str:
    """The store `key` is in: browser uploads (uploads/…) are in R2
    whenever R2 is configured (the upload API needs it); every other key
    is in `store` (the job's, media.store_of). None: the process
    default (new media)."""
    if key.startswith("uploads/") and storage.r2_available():
        return "r2"
    if store is None:
        return backend()
    if store not in STORES:
        raise ValueError(f"unknown media store {store!r}")
    return store


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
# `store`: the job's store (store_of(job)); None = the process default
# (only right for media of a job that has no store yet — the caller then
# records media_store=backend() with the keys).


def put_file(path: str | Path, key: str, *, content_type: str,
             cache_control: str = IMMUTABLE, store: str | None = None) -> int:
    """Store a local file under `key`. Returns its size. Raises."""
    check_key(key)
    if _where(key, store) == "r2":
        return storage.put_file(str(path), key, content_type=content_type,
                                cache_control=cache_control)
    size = os.path.getsize(path)
    _link_or_copy(path, local_path(key))
    return size


def get_file(key: str, path: str | Path, *, store: str | None = None) -> None:
    """Fetch `key` into a local file. Raises (FileNotFoundError locally)."""
    check_key(key)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    if _where(key, store) == "r2":
        storage.get_file(key, str(path))
        return
    src = local_path(key)
    if not src.is_file():
        raise FileNotFoundError(f"media object {key} not found")
    _link_or_copy(src, Path(path))


def size(key: str, *, store: str | None = None) -> int | None:
    """Size of `key`; None when it doesn't exist. Raises on errors."""
    check_key(key)
    if _where(key, store) == "r2":
        return storage.head(key)
    try:
        return local_path(key).stat().st_size
    except FileNotFoundError:
        return None


def exists(key: str | None, *, store: str | None = None) -> bool:
    try:
        return bool(key) and size(key, store=store) is not None
    except ValueError:
        return False


def delete(key: str, *, store: str | None = None) -> None:
    check_key(key)
    if _where(key, store) == "r2":
        storage.delete(key)
        return
    local_path(key).unlink(missing_ok=True)


def delete_prefix(prefix: str, *, store: str | None = None) -> int:
    """Delete everything under a GC-able prefix (gc_entry_ok). Returns
    how many objects. Raises."""
    check_key(prefix)
    if not prefix.endswith("/"):
        raise ValueError(f"not a prefix: {prefix!r}")
    if not gc_entry_ok(prefix):
        raise ValueError(f"refusing to delete prefix {prefix!r}")
    if _where(prefix, store) == "r2":
        return storage.delete_prefix(prefix)
    root = local_path(prefix)
    if not root.exists():
        return 0
    n = sum(1 for p in root.rglob("*") if p.is_file())
    shutil.rmtree(root)
    return n


# What the media GC may delete — nothing else, whatever a row says
# (one bad row must not wipe jobs/, uploads/ or backups/):
#   jobs/<id>/                 a whole job
#   jobs/<id>/r<g>/            one render generation
#   jobs/<id>/preview/v<n>.mp4 one preview version
#   jobs/<id>/source.<ext>     a body upload
#   jobs/<id>/fonts/<font>.<rev>.<ext>   a replaced CJK font subset
#   uploads/[<user>/]<uuid32>.<ext>   a browser upload
_GC_JOB = re.compile(
    r"^jobs/[0-9a-f]{12}/((r[0-9]+/)|preview/v[0-9]+\.mp4|source\.[a-z0-9]+"
    r"|fonts/[a-z0-9-]+\.[0-9a-f]{8}\.(woff2|ttf|json))?$")
_GC_UPLOAD = re.compile(
    r"^uploads/([A-Za-z0-9_-]+/)?[0-9a-f]{32}\.[a-z0-9]+$")


def gc_entry_ok(entry: Any) -> bool:
    """Is `entry` something the media GC may delete (see above)?"""
    return isinstance(entry, str) and bool(
        _GC_JOB.match(entry) or _GC_UPLOAD.match(entry))


def gc_stores(store: str | None) -> list[str]:
    """The stores a media_gc row is deleted in: its own; a row without
    one (queued before stores were recorded) in both — local, and R2
    when configured. An "r2" row is deleted in R2 whenever R2 is
    configured (whatever CLEO_MEDIA_BACKEND says); without R2 config it
    fails and stays queued."""
    if store in STORES:
        return [store]
    return ["local"] + (["r2"] if storage.r2_available() else [])


def delete_any(entry: str, store: str | None = None) -> int:
    """A media_gc entry: a prefix (ends with '/') or a single key, in
    the row's store (gc_stores). Raises ValueError for an entry outside
    the GC whitelist (gc_entry_ok), RuntimeError for an "r2" row
    without R2 config."""
    if not gc_entry_ok(entry):
        raise ValueError(f"refusing to delete {entry!r}: not a GC-able "
                         "media key or prefix")
    if entry.startswith("uploads/"):
        # Browser uploads are in R2 whenever it is configured (_where),
        # whatever the row says.
        stores = ["r2"] if storage.r2_available() else ["local"]
    else:
        stores = gc_stores(store)
    n = 0
    for where in stores:
        if where == "r2" and not storage.r2_available():
            raise RuntimeError("R2 is not configured — can't delete R2 "
                               f"media {entry}")
        if entry.endswith("/"):
            n += delete_prefix(entry, store=where)
        else:
            delete(entry, store=where)
            n += 1
    return n


def presign_get(key: str, *, filename: str | None = None,
                attachment: bool = False,
                content_type: str | None = None) -> str:
    """R2 only: the presigned GET the media routes redirect to."""
    check_key(key)
    return storage.presign_get(key, filename=filename, attachment=attachment,
                               content_type=content_type)


def media_response(key: str, *, media_type: str,
                   download_name: str | None = None,
                   cache: str | None = None, store: str | None = None):
    """What a media route answers for `key` in `store`: r2 → 307 to a
    presigned GET (Cache-Control: private, max-age=3600); local →
    FileResponse (Range, `cache` as its Cache-Control, an attachment
    when `download_name`). Raises FileNotFoundError when a local object
    is missing."""
    from fastapi.responses import FileResponse, RedirectResponse
    check_key(key)
    if _where(key, store) == "r2":
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


# Account deletion: backend.main.delete_user_media (each job the way
# DELETE /jobs/{id} removes it, through the media GC).


def list_job_prefixes(store: str, skip=None):
    """(job id, newest object time as a Unix float) of every jobs/{id}/
    prefix in `store` — the orphan sweep. Ids for which skip(id) is
    true aren't looked into."""
    if store == "r2":
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


# ── bucket owner marker (the orphan sweep) ───────────────────────────
# jobs/.owner holds the id of the database that owns the store's jobs/
# (meta media_owner_id). The orphan sweep deletes nothing unless they
# match: another deployment sharing the bucket (staging, a dev box with
# the prod .env) must never treat our jobs as its orphans. A clone or
# restore of our database has our id too — main._media_owner refuses
# those (the id is bound to the database's physical identity).
OWNER_KEY = "jobs/.owner"


def read_owner(store: str) -> str | None:
    if store == "r2":
        return storage.get_text(OWNER_KEY)
    try:
        return local_path(OWNER_KEY).read_text().strip() or None
    except FileNotFoundError:
        return None


def write_owner(store: str, owner: str) -> None:
    if store == "r2":
        storage.put_text(OWNER_KEY, owner)
        return
    p = local_path(OWNER_KEY)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(owner)
