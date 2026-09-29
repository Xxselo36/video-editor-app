"""R2 bucket setup helper (DEPLOY.md, "Media storage (R2)").

    python -m backend.r2_setup --print-config [--origins https://a,https://b]
        The CORS and lifecycle JSON the bucket needs (apply them in the
        Cloudflare dashboard or with an admin token:
        aws s3api put-bucket-cors / put-bucket-lifecycle-configuration
        --endpoint-url https://<account>.r2.cloudflarestorage.com).

    python -m backend.r2_setup --check [--origin https://cleocuts.com]
        With the API token of the deployment (R2_* env vars): HeadBucket,
        put / get / Range get / delete of a probe object, a 2-part
        multipart upload through size-signed presigned part URLs (plain
        HTTP PUTs, like the browser) plus a wrong-length PUT that must be
        refused, a day-aligned presigned GET (today's and yesterday's
        00:00Z signature, Range → 206), and with --origin the CORS
        preflight for a part PUT. Exit status 0 when everything passed.

The probe objects live under uploads/_r2check/ (the uploads lifecycle
rule removes them should a delete fail).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from unittest import mock

_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from backend import storage  # noqa: E402

DEFAULT_ORIGINS = ["https://cleocuts.com", "https://www.cleocuts.com"]


def cors_config(origins: list[str]) -> dict:
    return {"CORSRules": [{
        "AllowedOrigins": origins,
        "AllowedMethods": ["GET", "HEAD", "PUT"],
        "AllowedHeaders": ["content-type", "range"],
        "ExposeHeaders": ["ETag", "Content-Length", "Content-Range",
                          "Accept-Ranges"],
        "MaxAgeSeconds": 7200}]}


def lifecycle_config() -> dict:
    return {"Rules": [
        {"ID": "uploads-expire-2d", "Status": "Enabled",
         "Filter": {"Prefix": "uploads/"}, "Expiration": {"Days": 2}},
        {"ID": "uploads-abort-mpu-1d", "Status": "Enabled",
         "Filter": {"Prefix": "uploads/"},
         "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}},
        {"ID": "jobs-abort-mpu-2d", "Status": "Enabled",
         "Filter": {"Prefix": "jobs/"},
         "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 2}}]}


def _http(method: str, url: str, data: bytes | None = None,
          headers: dict | None = None) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


class Checks:
    def __init__(self) -> None:
        self.failed = 0

    def __call__(self, name: str, ok: bool, detail: str = "") -> bool:
        print(f"{'PASS' if ok else 'FAIL'}  {name}"
              + (f"  ({detail})" if detail else ""), flush=True)
        if not ok:
            self.failed += 1
        return ok


def check(origin: str | None = None) -> int:
    if not storage.r2_available():
        print("R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
              "R2_SECRET_ACCESS_KEY, R2_BUCKET)", flush=True)
        return 2
    ok = Checks()
    client = storage._client()
    bucket = storage.bucket()
    print(f"bucket {bucket} at {storage.endpoint_url()}", flush=True)
    try:
        client.head_bucket(Bucket=bucket)
        ok("HeadBucket", True)
    except Exception as e:
        ok("HeadBucket", False, str(e))
        return 1
    base = f"uploads/_r2check/{uuid.uuid4().hex}"

    # put / get / range / delete
    key = base + ".bin"
    body = os.urandom(4096)
    fd, name = tempfile.mkstemp(prefix="r2check-")
    os.close(fd)
    tmp = Path(name)
    try:
        tmp.write_bytes(body)
        size = storage.put_file(str(tmp), key, content_type="video/mp4")
        ok("put_file", size == len(body))
        ok("head", storage.head(key) == len(body))
        storage.get_file(key, str(tmp) + ".back")
        ok("get_file", Path(str(tmp) + ".back").read_bytes() == body)
        url = storage.presign_get(key)
        st, hd, data = _http("GET", url, headers={"Range": "bytes=0-1"})
        ok("presigned GET, Range bytes=0-1 → 206",
           st == 206 and data == body[:2], f"HTTP {st}")
        ok("presigned GET is day-aligned (X-Amz-Date=…T000000Z)",
           "T000000Z" in url and "X-Amz-Expires=172800" in url)
        today = dt.datetime.now(dt.timezone.utc).replace(
            tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
        with mock.patch("botocore.auth.get_current_datetime",
                        return_value=today - dt.timedelta(days=1)):
            old = storage.presign_get(key)
        st, _, _ = _http("GET", old, headers={"Range": "bytes=0-1"})
        ok("yesterday's 00:00Z presign (48 h expiry) still serves → 206",
           st == 206, f"HTTP {st}")
        att = storage.presign_get(key, filename="cleo_check.mp4",
                                  attachment=True)
        st, hd, _ = _http("GET", att, headers={"Range": "bytes=0-0"})
        ok("download disposition",
           "attachment" in hd.get("content-disposition", ""),
           hd.get("content-disposition", ""))
        storage.delete(key)
        ok("delete", storage.head(key) is None)
    except Exception as e:
        ok("objects", False, f"{type(e).__name__}: {e}")
    finally:
        tmp.unlink(missing_ok=True)
        Path(str(tmp) + ".back").unlink(missing_ok=True)

    # multipart with size-signed parts
    key = base + ".mp4"
    part = 5 * 1024 * 1024
    sizes = [part, 1234]
    upload_id = None
    try:
        upload_id = storage.mpu_create(key, "video/mp4")
        u1 = storage.mpu_sign(key, upload_id, 1, sizes[0], 600)
        ok("part URL signs content-length",
           "content-length" in u1.lower().split("x-amz-signedheaders=")[1]
           .split("&")[0])
        st, _, _ = _http("PUT", u1, data=os.urandom(sizes[0] - 1))
        ok("wrong-length part PUT is refused", st in (400, 403),
           f"HTTP {st}")
        st, hd, _ = _http("PUT", u1, data=os.urandom(sizes[0]))
        ok("part 1 PUT", st == 200 and bool(hd.get("etag")), f"HTTP {st}")
        u2 = storage.mpu_sign(key, upload_id, 2, sizes[1], 600)
        st, _, _ = _http("PUT", u2, data=os.urandom(sizes[1]))
        ok("part 2 PUT", st == 200, f"HTTP {st}")
        parts = storage.mpu_list_parts(key, upload_id)
        ok("ListParts", [(p["part_number"], p["size"]) for p in parts]
           == [(1, sizes[0]), (2, sizes[1])])
        storage.mpu_complete(key, upload_id, parts)
        upload_id = None
        ok("complete → HeadObject size", storage.head(key) == sum(sizes))
        storage.delete(key)
    except Exception as e:
        ok("multipart", False, f"{type(e).__name__}: {e}")
    finally:
        if upload_id:
            try:
                storage.mpu_abort(key, upload_id)
            except Exception:
                pass

    if origin:
        st, hd, _ = _http("OPTIONS", f"{storage.endpoint_url()}/{bucket}/{key}",
                          headers={"Origin": origin,
                                   "Access-Control-Request-Method": "PUT"})
        allowed = hd.get("access-control-allow-origin") in (origin, "*")
        ok(f"CORS preflight from {origin}", st in (200, 204) and allowed,
           f"HTTP {st}, allow-origin={hd.get('access-control-allow-origin')}")
    print(f"{'all checks passed' if not ok.failed else f'{ok.failed} FAILED'}",
          flush=True)
    return 1 if ok.failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.r2_setup")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--origin", default=None,
                    help="also check the CORS preflight from this origin")
    ap.add_argument("--print-config", action="store_true")
    ap.add_argument("--origins", default=",".join(DEFAULT_ORIGINS),
                    help="comma-separated AllowedOrigins for --print-config")
    args = ap.parse_args(argv)
    if args.print_config:
        origins = [o.strip() for o in args.origins.split(",") if o.strip()]
        print("# CORS (dashboard → bucket → Settings → CORS policy, or "
              "aws s3api put-bucket-cors --cors-configuration file://cors.json)")
        print(json.dumps(cors_config(origins), indent=2))
        print("# Lifecycle (aws s3api put-bucket-lifecycle-configuration "
              "--lifecycle-configuration file://lifecycle.json)")
        print(json.dumps(lifecycle_config(), indent=2))
        if not args.check:
            return 0
    if args.check:
        return check(args.origin)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
