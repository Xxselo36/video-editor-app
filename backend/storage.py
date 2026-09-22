"""Cloudflare R2 direct upload — presigned URLs so the browser can
push large video files (multi-GB ProRes) straight to storage without
routing through Railway's edge (which caps at ~32-100MB body size).

R2 is S3-compatible so we use boto3 with a custom endpoint. Config
via env vars:

    R2_ACCOUNT_ID           = <Cloudflare account ID>
    R2_ACCESS_KEY_ID        = <R2 API access key>
    R2_SECRET_ACCESS_KEY    = <R2 API secret>
    R2_BUCKET               = <bucket name, e.g. 'cleocuts-uploads'>
    R2_PUBLIC_URL           = optional; base URL for public reads

All functions soft-fail with a clear error message if config missing —
so the /jobs endpoint can fall back to direct upload for small files
during local dev before R2 is provisioned.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any


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


def _r2_client():
    """Build a boto3 S3 client pointed at R2. Raises if unconfigured."""
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError(
            "R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
            "R2_SECRET_ACCESS_KEY, R2_BUCKET env vars."
        )
    try:
        import boto3
    except ImportError as e:
        raise RuntimeError(
            "boto3 not installed — add to requirements.txt"
        ) from e

    endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def presign_upload(
    filename: str,
    expires_in: int = 3600,
    content_type: str = "video/mp4",
) -> dict[str, Any]:
    """Generate a presigned PUT URL for direct browser upload to R2.

    Args:
        filename: original filename (used to derive the extension).
        expires_in: URL validity in seconds (default 1h — long enough
            for multi-GB uploads on slow connections).
        content_type: expected Content-Type header on the upload.

    Returns:
        {
            "storage_key": "<unique R2 object key>",
            "upload_url":  "<presigned PUT URL>",
            "expires_in":  <seconds>,
            "method":      "PUT",
            "headers":     {"Content-Type": <content_type>},
        }

    The client PUTs the file body to upload_url with the given headers,
    then hands storage_key back to /jobs to start processing.
    """
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError("R2 not configured")

    ext = Path(filename).suffix.lower() or ".mp4"
    # Namespace uploads under `uploads/<uuid><ext>` so we can bulk-list
    # / bulk-clean without touching other keys later.
    storage_key = f"uploads/{uuid.uuid4().hex}{ext}"

    client = _r2_client()
    url = client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": cfg["R2_BUCKET"],
            "Key": storage_key,
            "ContentType": content_type,
        },
        ExpiresIn=expires_in,
    )

    return {
        "storage_key": storage_key,
        "upload_url": url,
        "expires_in": expires_in,
        "method": "PUT",
        "headers": {"Content-Type": content_type},
    }


def multipart_init(
    filename: str,
    content_type: str = "video/mp4",
) -> dict[str, Any]:
    """Start a new S3 Multipart Upload on R2.

    Returns:
        {"upload_id": "...", "storage_key": "uploads/<uuid>.mp4"}
    """
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError("R2 not configured")
    ext = Path(filename).suffix.lower() or ".mp4"
    storage_key = f"uploads/{uuid.uuid4().hex}{ext}"
    client = _r2_client()
    resp = client.create_multipart_upload(
        Bucket=cfg["R2_BUCKET"],
        Key=storage_key,
        ContentType=content_type,
    )
    return {
        "upload_id": resp["UploadId"],
        "storage_key": storage_key,
    }


def multipart_sign_parts(
    storage_key: str,
    upload_id: str,
    part_numbers: list[int],
    expires_in: int = 21600,  # 6 hours — enough for slow mobile
) -> list[dict[str, Any]]:
    """Presign a batch of part upload URLs. Batching lets the client
    fetch all URLs up front and stream through them, avoiding a round
    trip per chunk.
    """
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError("R2 not configured")
    client = _r2_client()
    out: list[dict[str, Any]] = []
    for n in part_numbers:
        url = client.generate_presigned_url(
            "upload_part",
            Params={
                "Bucket": cfg["R2_BUCKET"],
                "Key": storage_key,
                "UploadId": upload_id,
                "PartNumber": int(n),
            },
            ExpiresIn=expires_in,
        )
        out.append({"part_number": int(n), "upload_url": url})
    return out


def multipart_complete(
    storage_key: str,
    upload_id: str,
    parts: list[dict[str, Any]],
) -> None:
    """Finalise the multipart upload. `parts` must be an ordered list
    of {"part_number": int, "etag": str} — R2 stitches them into the
    final object.
    """
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError("R2 not configured")
    client = _r2_client()
    ordered = sorted(parts, key=lambda p: int(p["part_number"]))
    client.complete_multipart_upload(
        Bucket=cfg["R2_BUCKET"],
        Key=storage_key,
        UploadId=upload_id,
        MultipartUpload={
            "Parts": [
                {"PartNumber": int(p["part_number"]),
                 "ETag": str(p["etag"])}
                for p in ordered
            ],
        },
    )


def multipart_abort(storage_key: str, upload_id: str) -> None:
    """Cancel a multipart upload (called on user cancel or error)."""
    cfg = _r2_config()
    if cfg is None:
        return
    try:
        client = _r2_client()
        client.abort_multipart_upload(
            Bucket=cfg["R2_BUCKET"],
            Key=storage_key,
            UploadId=upload_id,
        )
    except Exception as e:
        print(f"[storage] multipart abort failed: {e}", flush=True)


def download_from_r2(storage_key: str, dest_path: str) -> None:
    """Fetch an R2 object into a local file (used by the worker
    thread before analyze).
    """
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError("R2 not configured")
    client = _r2_client()
    client.download_file(cfg["R2_BUCKET"], storage_key, dest_path)


def delete_from_r2(storage_key: str) -> None:
    """Remove an R2 object once the job is done. Silent on failure —
    orphan cleanup is a nice-to-have, not a hard requirement.
    """
    cfg = _r2_config()
    if cfg is None:
        return
    try:
        client = _r2_client()
        client.delete_object(Bucket=cfg["R2_BUCKET"], Key=storage_key)
    except Exception as e:
        print(f"[storage] r2 delete failed for {storage_key}: {e}",
              flush=True)
