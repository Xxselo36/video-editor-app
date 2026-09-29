"""Cloudflare R2 (S3 API): job media, browser uploads and the Postgres
backups (backend/pg_backup.py).

Config via env vars (all four required, else R2 is "not configured"):

    R2_ACCOUNT_ID           = <Cloudflare account ID>
    R2_ACCESS_KEY_ID        = <R2 API token access key>
    R2_SECRET_ACCESS_KEY    = <R2 API token secret>
    R2_BUCKET               = <bucket, e.g. 'cleocuts-media'>
    R2_ENDPOINT_URL         = optional; default https://<account>.r2.cloudflarestorage.com
                              (tests and a local S3 stand-in only)

The rest of the backend uses backend/media.py for job media; this module
is the R2 half of it. Every function raises on errors (callers decide),
except the few soft helpers marked as such.

Clients: one cached boto3 client per process (created under a lock; a
client per call cost ~9 ms), plus a second one used only for presigned
GETs. That one signs with "cleo-day": X-Amz-Date is 00:00:00Z of the
current UTC day and the expiry 48 h, so a GET URL is byte-identical for
the whole day on every replica (browser caches hit) and still valid
>= 24 h at any moment. It relies on botocore internals
(AUTH_TYPE_MAPS, S3SigV4QueryAuth), which is why boto3/botocore are
pinned to one minor version in requirements.txt; a unit test compares
it with botocore's own presign at a patched clock.

boto3 is imported lazily (only when R2 is used); botocore's auth module
at import to register the signer — without boto3 installed (desktop
app) importing this module still works.
"""
from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Iterator

IMMUTABLE = "private, max-age=31536000, immutable"
# Presigned GET lifetime: counted from X-Amz-Date (today 00:00Z), so a
# URL handed out at 23:59 is still good for 24 h.
PRESIGN_GET_EXPIRES = 172800
# CLEO_MEDIA_PRESIGN=standard: counted from now.
PRESIGN_GET_STANDARD_EXPIRES = 86400
_MIB = 1024 * 1024

try:  # registered once per process, at import (see module doc)
    import botocore.auth as _ba
except ImportError:  # no boto3 here: R2 can't be used anyway
    _ba = None
else:
    class DayAlignedQueryAuth(_ba.S3SigV4QueryAuth):
        """S3 SigV4 query signing with X-Amz-Date = 00:00:00Z today."""

        def add_auth(self, request):
            day = _ba.get_current_datetime().replace(
                hour=0, minute=0, second=0, microsecond=0)
            request.context["timestamp"] = day.strftime(_ba.SIGV4_TIMESTAMP)
            self._modify_request_before_signing(request)
            cr = self.canonical_request(request)
            self._inject_signature_to_request(
                request, self.signature(self.string_to_sign(request, cr),
                                        request))

    _ba.AUTH_TYPE_MAPS.setdefault("cleo-day", _ba.S3SigV4Auth)
    _ba.AUTH_TYPE_MAPS.setdefault("cleo-day-query", DayAlignedQueryAuth)


def _r2_config() -> dict[str, str] | None:
    """Return R2 config dict, or None if not configured."""
    keys = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    values: dict[str, str] = {}
    for k in keys:
        v = os.environ.get(k, "").strip()
        if not v:
            return None
        values[k] = v
    return values


def r2_available() -> bool:
    """Cheap check: is R2 configured on this deployment?"""
    return _r2_config() is not None


def endpoint_url(cfg: dict[str, str] | None = None) -> str:
    cfg = cfg or _r2_config() or {}
    override = os.environ.get("R2_ENDPOINT_URL", "").strip()
    if override:
        return override.rstrip("/")
    return f"https://{cfg.get('R2_ACCOUNT_ID', '')}.r2.cloudflarestorage.com"


def bucket() -> str:
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError("R2 not configured")
    return cfg["R2_BUCKET"]


_clients: dict[tuple, Any] = {}
_clients_lock = threading.Lock()


def _client(kind: str = "api"):
    """The cached client ("api": everything; "get": presigned GETs with
    the day-aligned signer; "get-std": presigned GETs with the standard
    signer, CLEO_MEDIA_PRESIGN=standard). Raises if unconfigured. Keyed
    by the config, so changed credentials get a new client."""
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError(
            "R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
            "R2_SECRET_ACCESS_KEY, R2_BUCKET env vars.")
    ep = endpoint_url(cfg)
    key = (kind, ep, cfg["R2_ACCESS_KEY_ID"], cfg["R2_SECRET_ACCESS_KEY"])
    client = _clients.get(key)
    if client is not None:
        return client
    with _clients_lock:
        client = _clients.get(key)
        if client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as e:
                raise RuntimeError("boto3 not installed") from e
            conf = Config(
                signature_version="cleo-day" if kind == "get" else "s3v4",
                s3={"addressing_style": "path"},
                # Only the checksums S3 requires: botocore >= 1.36 adds
                # CRC32 trailers / ChecksumCRC32 to every PUT and part by
                # default ("when_supported"), which the R2 multipart
                # path (>= 64 MiB: every mezz and output) doesn't need.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                retries={"mode": "standard", "max_attempts": 5},
                connect_timeout=5, read_timeout=60,
                max_pool_connections=32)
            # A session of its own: the default session isn't thread safe.
            client = boto3.session.Session().client(
                "s3", endpoint_url=ep,
                aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
                region_name="auto", config=conf)
            _clients[key] = client
        return client


def _r2_client():
    """Back-compat name: the cached API client."""
    return _client("api")


def _code(exc: BaseException) -> str:
    resp = getattr(exc, "response", None) or {}
    return str((resp.get("Error") or {}).get("Code") or "")


def _status(exc: BaseException) -> int | None:
    resp = getattr(exc, "response", None) or {}
    return (resp.get("ResponseMetadata") or {}).get("HTTPStatusCode")


def is_not_found(exc: BaseException) -> bool:
    return _code(exc) in ("404", "NoSuchKey", "NotFound") or _status(exc) == 404


def is_no_such_upload(exc: BaseException) -> bool:
    return _code(exc) == "NoSuchUpload"


# ── objects ──────────────────────────────────────────────────────────


def _transfer_config(**kw):
    from boto3.s3.transfer import TransferConfig
    return TransferConfig(**kw)


def presign_get(key: str, *, filename: str | None = None,
                attachment: bool = False,
                content_type: str | None = None) -> str:
    """Presigned GET, identical for the whole UTC day (see module doc),
    valid >= 24 h. Range requests work. `attachment` (+ `filename`, ASCII)
    makes the browser download it."""
    params: dict[str, Any] = {"Bucket": bucket(), "Key": key}
    if attachment or filename:
        disp = "attachment" if attachment else "inline"
        if filename:
            safe = "".join(c for c in filename
                           if 32 <= ord(c) < 127 and c not in '"\\')
            disp += f'; filename="{safe}"'
        params["ResponseContentDisposition"] = disp
    if content_type:
        params["ResponseContentType"] = content_type
    if presign_mode() == "standard":
        # The lever: X-Amz-Date = now (no day alignment, a new URL per
        # request), valid PRESIGN_GET_STANDARD_EXPIRES.
        return _client("get-std").generate_presigned_url(
            "get_object", Params=params,
            ExpiresIn=PRESIGN_GET_STANDARD_EXPIRES)
    return _client("get").generate_presigned_url(
        "get_object", Params=params, ExpiresIn=PRESIGN_GET_EXPIRES)


def presign_mode() -> str:
    """CLEO_MEDIA_PRESIGN: "day" (default: day-aligned, see module doc)
    or "standard" (botocore's own presign — the lever if R2 ever
    refuses the backdated X-Amz-Date)."""
    v = os.environ.get("CLEO_MEDIA_PRESIGN", "").strip().lower()
    return "standard" if v == "standard" else "day"


def put_file(path: str, key: str, *, content_type: str,
             cache_control: str = IMMUTABLE) -> int:
    """Upload a local file (multipart above 64 MiB). Returns its size."""
    size = os.path.getsize(path)
    _client().upload_file(
        str(path), bucket(), key,
        ExtraArgs={"ContentType": content_type,
                   "CacheControl": cache_control},
        Config=_transfer_config(multipart_threshold=64 * _MIB,
                                multipart_chunksize=64 * _MIB,
                                max_concurrency=8))
    return size


def get_file(key: str, path: str) -> None:
    """Download an object into a local file (ranged, 16 in parallel)."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    _client().download_file(
        bucket(), key, str(path),
        Config=_transfer_config(multipart_chunksize=64 * _MIB,
                                max_concurrency=16))


def head(key: str) -> int | None:
    """Size of an object; None only when it doesn't exist (404)."""
    try:
        return int(_client().head_object(Bucket=bucket(),
                                         Key=key)["ContentLength"])
    except Exception as e:
        if is_not_found(e):
            return None
        raise


def delete(key: str) -> None:
    _client().delete_object(Bucket=bucket(), Key=key)


def get_text(key: str) -> str | None:
    """A small text object (e.g. jobs/.owner); None when missing."""
    try:
        body = _client().get_object(Bucket=bucket(), Key=key)["Body"]
    except Exception as e:
        if is_not_found(e):
            return None
        raise
    return body.read().decode("utf-8", "replace").strip() or None


def put_text(key: str, text: str) -> None:
    _client().put_object(Bucket=bucket(), Key=key,
                         Body=text.encode("utf-8"),
                         ContentType="text/plain")


def delete_prefix(prefix: str) -> int:
    """Delete every object under `prefix` (ListObjectsV2 pages, then
    DeleteObjects in batches of <= 1000). Returns how many; raises if
    any key reports an error."""
    if not prefix or prefix.startswith("/") or ".." in prefix:
        raise ValueError(f"refusing to delete prefix {prefix!r}")
    client = _client()
    name = bucket()
    deleted = 0
    batch: list[dict[str, str]] = []

    def flush() -> None:
        nonlocal deleted
        if not batch:
            return
        resp = client.delete_objects(
            Bucket=name, Delete={"Objects": list(batch), "Quiet": True})
        errors = resp.get("Errors") or []
        if errors:
            e = errors[0]
            raise RuntimeError(
                f"DeleteObjects: {len(errors)} key(s) failed, e.g. "
                f"{e.get('Key')}: {e.get('Code')} {e.get('Message')}")
        deleted += len(batch)
        batch.clear()

    for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=name, Prefix=prefix):
        for obj in page.get("Contents") or []:
            batch.append({"Key": obj["Key"]})
            if len(batch) >= 1000:
                flush()
    flush()
    return deleted


def list_job_prefixes(skip: Callable[[str], bool] | None = None
                      ) -> Iterator[tuple[str, Any]]:
    """(job id, newest LastModified) of every `jobs/<id>/` prefix, for
    the orphan sweep. Ids for which skip(id) is true aren't listed
    further (known jobs: no need to read their objects)."""
    client = _client()
    name = bucket()
    for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=name, Prefix="jobs/", Delimiter="/"):
        for cp in page.get("CommonPrefixes") or []:
            prefix = cp["Prefix"]
            job_id = prefix[len("jobs/"):].rstrip("/")
            if skip is not None and skip(job_id):
                continue
            newest = None
            for sub in client.get_paginator("list_objects_v2").paginate(
                    Bucket=name, Prefix=prefix):
                for obj in sub.get("Contents") or []:
                    lm = obj.get("LastModified")
                    if lm is not None and (newest is None or lm > newest):
                        newest = lm
            if newest is not None:
                yield job_id, newest


# ── browser uploads: multipart with presigned, size-signed parts ─────


def mpu_create(key: str, content_type: str) -> str:
    """Start a multipart upload; returns its UploadId."""
    return _client().create_multipart_upload(
        Bucket=bucket(), Key=key, ContentType=content_type)["UploadId"]


def mpu_sign(key: str, upload_id: str, n: int, size: int,
             expires_in: int = 21600) -> str:
    """Presigned UploadPart URL for part `n`. ContentLength goes into the
    signature (content-length in X-Amz-SignedHeaders): R2 must refuse a
    body of any other length."""
    return _client().generate_presigned_url(
        "upload_part",
        Params={"Bucket": bucket(), "Key": key, "UploadId": upload_id,
                "PartNumber": int(n), "ContentLength": int(size)},
        ExpiresIn=max(1, int(expires_in)))


def mpu_list_parts(key: str, upload_id: str) -> list[dict[str, Any]]:
    """Every uploaded part (all pages): [{part_number, size, etag}]."""
    client = _client()
    out: list[dict[str, Any]] = []
    marker = 0
    while True:
        kw: dict[str, Any] = {"Bucket": bucket(), "Key": key,
                              "UploadId": upload_id, "MaxParts": 1000}
        if marker:
            kw["PartNumberMarker"] = marker
        page = client.list_parts(**kw)
        for p in page.get("Parts") or []:
            out.append({"part_number": int(p["PartNumber"]),
                        "size": int(p["Size"]), "etag": p["ETag"]})
        nxt = int(page.get("NextPartNumberMarker") or 0)
        if not page.get("IsTruncated") or nxt <= marker:
            return out
        marker = nxt


def mpu_complete(key: str, upload_id: str,
                 parts: list[dict[str, Any]]) -> None:
    ordered = sorted(parts, key=lambda p: int(p["part_number"]))
    _client().complete_multipart_upload(
        Bucket=bucket(), Key=key, UploadId=upload_id,
        MultipartUpload={"Parts": [
            {"PartNumber": int(p["part_number"]), "ETag": str(p["etag"])}
            for p in ordered]})


def mpu_abort(key: str, upload_id: str) -> None:
    _client().abort_multipart_upload(Bucket=bucket(), Key=key,
                                     UploadId=upload_id)


# ── single-PUT upload (POST /uploads/presign) ────────────────────────


def presign_upload(
    filename: str,
    expires_in: int = 3600,
    content_type: str = "video/mp4",
    prefix: str = "uploads/",
) -> dict[str, Any]:
    """Presigned PUT URL for one direct browser upload (<= 5 GiB).

    Returns {"storage_key", "upload_url", "expires_in", "method",
    "headers": {"Content-Type": content_type}}. The client PUTs the file
    body to upload_url with those headers, then hands storage_key to
    POST /jobs. Keys are `uploads/[<user>/]<uuid><ext>`.
    """
    ext = Path(filename).suffix.lower() or ".mp4"
    storage_key = f"{prefix}{uuid.uuid4().hex}{ext}"
    url = _client().generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket(), "Key": storage_key,
                "ContentType": content_type},
        ExpiresIn=expires_in,
    )
    return {
        "storage_key": storage_key,
        "upload_url": url,
        "expires_in": expires_in,
        "method": "PUT",
        "headers": {"Content-Type": content_type},
    }


# ── Database backups (backend/pg_backup.py) ──────────────────────────
# R2_BACKUP_BUCKET (optional, recommended): a bucket of its own for the
# dumps (same account and credentials). The Modal render token
# (secret "cleocuts-r2") then can't be given access to them: create it
# with an R2 API token scoped to the media bucket only. Unset → the
# media bucket (backups/pg/…).


def backup_bucket() -> str:
    return os.environ.get("R2_BACKUP_BUCKET", "").strip() or bucket()


def backup_put(path: str, key: str) -> None:
    """Put a dump into the backup bucket (multipart for big files)."""
    _client().upload_file(path, backup_bucket(), key)


def backup_get(key: str, dest_path: str) -> None:
    Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
    _client().download_file(backup_bucket(), key, str(dest_path))


def backup_list(prefix: str) -> list[dict[str, Any]]:
    return list_r2(prefix, bucket_name=backup_bucket())


def backup_delete(key: str) -> None:
    """Soft: a failure is only logged."""
    try:
        _client().delete_object(Bucket=backup_bucket(), Key=key)
    except Exception as e:
        print(f"[storage] backup delete failed for {key}: {e}", flush=True)


def delete_from_r2(storage_key: str) -> None:
    """Soft delete: remove an object, only logging a failure."""
    if not r2_available():
        return
    try:
        delete(storage_key)
    except Exception as e:
        print(f"[storage] r2 delete failed for {storage_key}: {e}",
              flush=True)


def upload_to_r2(path: str, storage_key: str) -> None:
    """Put a local file into R2 (multipart for big files). Raises."""
    _client().upload_file(path, bucket(), storage_key)


def download_from_r2(storage_key: str, dest_path: str) -> None:
    """Fetch an object into a local file. Raises."""
    get_file(storage_key, dest_path)


def list_r2(prefix: str, bucket_name: str | None = None
            ) -> list[dict[str, Any]]:
    """Objects under `prefix`: [{"key", "size", "last_modified"}]. Raises."""
    client = _client()
    out: list[dict[str, Any]] = []
    for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=bucket_name or bucket(), Prefix=prefix):
        for obj in page.get("Contents") or []:
            out.append({"key": obj["Key"], "size": obj.get("Size"),
                        "last_modified": obj.get("LastModified")})
    return out
