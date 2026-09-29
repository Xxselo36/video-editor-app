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
        00:00Z signature, Range → 206), a 70 MiB put / get round trip
        (the multipart path every mezz and render output takes), the
        lifecycle rules for uploads/ (--skip-lifecycle when the token
        may not read them — then check them in the dashboard), and with
        --origin the CORS preflight for a part PUT. Exit status 0 when
        everything passed.

    python -m backend.r2_setup --apply [--origins https://a,https://b]
        With an R2 token that has "Admin Read & Write" (R2_* env vars):
        sets the bucket's CORS and lifecycle configuration to exactly
        what --print-config prints (PutBucketCors,
        PutBucketLifecycleConfiguration; other rules are replaced).
        Idempotent: a configuration already in place is left alone.
        Prints only rule IDs and counts (the GitHub workflow "R2 setup"
        runs it in a public log). Combine with --check to verify.

    python -m backend.r2_setup --roundtrip
        put / head / get / delete of one small object with the current
        credentials and nothing bucket-level — what render_r2 does with
        the Modal token ("Object Read & Write" on the media bucket).

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
import time
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


# The big round trip: above storage.put_file's 64 MiB multipart
# threshold (CreateMultipartUpload + UploadPart + Complete, like every
# mezz and render output).
BIG_BYTES = 70 * 1024 * 1024
# --check's CORS preflight: tries, seconds between them.
CORS_TRIES = 4
CORS_RETRY_S = 10.0


def _error(e: BaseException) -> str:
    """An S3 error for the log: type, code and message, with endpoint,
    bucket, account and key ID blanked out (boto3's transfer errors name
    the bucket), plus what to do about a refused token."""
    inner = e
    for _ in range(5):          # S3UploadFailedError → its ClientError
        if storage._code(inner) or inner.__context__ is None:
            break
        inner = inner.__context__
    text = f"{type(e).__name__}: {inner}"
    cfg = storage._r2_config() or {}
    for value, label in ((storage.endpoint_url(cfg) if cfg else "",
                          "<endpoint>"),
                         (cfg.get("R2_BUCKET"), "<bucket>"),
                         (cfg.get("R2_ACCOUNT_ID"), "<account>"),
                         (cfg.get("R2_ACCESS_KEY_ID"), "<key>"),
                         (cfg.get("R2_SECRET_ACCESS_KEY"), "<secret>")):
        if value:
            text = text.replace(value, label)
    code = storage._code(inner)
    if code in ("AccessDenied", "Unauthorized", "403", "InvalidAccessKeyId",
                "SignatureDoesNotMatch") or storage._status(inner) in (401,
                                                                       403):
        text += (" — the token was refused: check the access key pair, "
                 "its permission and its buckets")
    elif code == "NoSuchBucket":
        text += " — no bucket of that name in this account (R2_BUCKET?)"
    return text


def _rule_prefix(r: dict) -> str:
    f = r.get("Filter") or {}
    return (f.get("Prefix") if "Prefix" in f
            else (f.get("And") or {}).get("Prefix", r.get("Prefix", ""))) or ""


def lifecycle_problems(rules: list[dict]) -> list[str]:
    """What the bucket's lifecycle rules lack for uploads/ (abandoned or
    refused browser uploads must expire; the orphan sweep skips them)."""
    live = [r for r in rules if r.get("Status") == "Enabled"
            and "uploads/".startswith(_rule_prefix(r))]
    problems = []
    days = [int((r.get("Expiration") or {}).get("Days") or 0) for r in live]
    if not any(0 < d <= 7 for d in days):
        problems.append("no enabled rule expires uploads/ within 7 days")
    mpu = [int((r.get("AbortIncompleteMultipartUpload") or {})
               .get("DaysAfterInitiation") or 0) for r in live]
    if not any(0 < d <= 7 for d in mpu):
        problems.append("no enabled rule aborts incomplete multipart "
                        "uploads under uploads/")
    return problems


def check(origin: str | None = None, lifecycle: bool = True) -> int:
    if not storage.r2_available():
        return _not_configured()
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
        if storage.presign_mode() == "day":
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

    # 70 MiB round trip: the multipart path of put_file / get_file
    key = base + ".big"
    fd, name = tempfile.mkstemp(prefix="r2check-big-")
    os.close(fd)
    big = Path(name)
    try:
        import hashlib
        h = hashlib.sha256()
        with big.open("wb") as f:
            left = BIG_BYTES
            while left:
                chunk = os.urandom(min(left, 4 * 1024 * 1024))
                h.update(chunk)
                f.write(chunk)
                left -= len(chunk)
        size = storage.put_file(str(big), key, content_type="video/mp4")
        ok("70 MiB put_file (multipart)", size == BIG_BYTES
           and storage.head(key) == BIG_BYTES)
        storage.get_file(key, str(big) + ".back")
        h2 = hashlib.sha256()
        with open(str(big) + ".back", "rb") as f:
            for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
                h2.update(chunk)
        ok("70 MiB get_file, same bytes", h.digest() == h2.digest())
        storage.delete(key)
    except Exception as e:
        ok("70 MiB round trip", False, f"{type(e).__name__}: {e}")
        try:
            storage.delete(key)
        except Exception:
            pass
    finally:
        big.unlink(missing_ok=True)
        Path(str(big) + ".back").unlink(missing_ok=True)

    if lifecycle:
        try:
            rules = client.get_bucket_lifecycle_configuration(
                Bucket=bucket).get("Rules") or []
        except Exception as e:
            if "NoSuchLifecycleConfiguration" in str(e):
                rules = []
            else:
                rules = None
                ok("lifecycle rules for uploads/", False,
                   f"can't read them ({type(e).__name__}: {e}) — check "
                   "them in the Cloudflare dashboard (bucket → Settings → "
                   "Object lifecycle rules, --print-config shows them) "
                   "and rerun with --skip-lifecycle")
        if rules is not None:
            problems = lifecycle_problems(rules)
            ok("lifecycle rules for uploads/", not problems,
               "; ".join(problems) + (" — apply --print-config's lifecycle"
                                      if problems else ""))

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
        # Rules just set (--apply) may take a moment to be served: a
        # failing preflight is retried for about half a minute.
        for attempt in range(CORS_TRIES):
            st, hd, _ = _http("OPTIONS",
                              f"{storage.endpoint_url()}/{bucket}/{key}",
                              headers={"Origin": origin,
                                       "Access-Control-Request-Method": "PUT"})
            allowed = hd.get("access-control-allow-origin") in (origin, "*")
            if (st in (200, 204) and allowed) or attempt == CORS_TRIES - 1:
                break
            time.sleep(CORS_RETRY_S)
        ok(f"CORS preflight from {origin}", st in (200, 204) and allowed,
           f"HTTP {st}, allow-origin={hd.get('access-control-allow-origin')}")
    print(f"{'all checks passed' if not ok.failed else f'{ok.failed} FAILED'}",
          flush=True)
    return 1 if ok.failed else 0


def _not_configured() -> int:
    print("R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
          "R2_SECRET_ACCESS_KEY, R2_BUCKET)", flush=True)
    return 2


def _cors_key(rules: list[dict]) -> list:
    """CORS rules as comparable values: any order, methods and headers in
    any case, extra fields (an ID) ignored."""
    def one(r: dict) -> tuple:
        def low(k: str) -> tuple:
            return tuple(sorted({str(v).lower() for v in r.get(k) or []}))
        return (tuple(sorted(set(r.get("AllowedOrigins") or []))),
                low("AllowedMethods"), low("AllowedHeaders"),
                low("ExposeHeaders"), int(r.get("MaxAgeSeconds") or 0))
    return sorted(one(r) for r in rules)


def _lifecycle_key(rules: list[dict]) -> list:
    """Lifecycle rules as comparable values (any order; the prefix in
    Filter, Filter.And or the legacy Prefix field)."""
    def one(r: dict) -> tuple:
        rest = {k: v for k, v in r.items()
                if k not in ("ID", "Status", "Filter", "Prefix")
                and v not in (None, {}, [])}
        return (r.get("ID") or "", r.get("Status") or "", _rule_prefix(r),
                json.dumps(rest, sort_keys=True, default=str))
    return sorted(one(r) for r in rules)


def apply(origins: list[str]) -> int:
    """Set the bucket's CORS and lifecycle configuration to exactly
    cors_config(origins) / lifecycle_config() (needs an R2 token with
    Admin Read & Write). A configuration already in place is not
    written again. Prints only rule IDs and counts."""
    if not storage.r2_available():
        return _not_configured()
    ok = Checks()
    client = storage._client()
    bucket = storage.bucket()

    def current(get, field: str, missing: str) -> list[dict] | None:
        """The bucket's rules; [] when it has none, None when they can't
        be read (then they are written without comparing)."""
        try:
            return get(Bucket=bucket).get(field) or []
        except Exception as e:
            if storage._code(e) == missing or missing in str(e):
                return []
            print(f"      (can't read the current rules: {_error(e)})",
                  flush=True)
            return None

    cors = cors_config(origins)
    n_cors = len(cors["CORSRules"])
    what = f"{n_cors} rule, {len(origins)} origin(s)"
    have = current(client.get_bucket_cors, "CORSRules",
                   "NoSuchCORSConfiguration")
    if have is not None and _cors_key(have) == _cors_key(cors["CORSRules"]):
        ok("CORS", True, f"unchanged: {what}")
    else:
        try:
            client.put_bucket_cors(Bucket=bucket, CORSConfiguration=cors)
            was = "?" if have is None else len(have)
            ok("CORS", True, f"set: {what}; had {was} rule(s)")
        except Exception as e:
            ok("CORS", False, _error(e))

    life = lifecycle_config()
    ids = [r["ID"] for r in life["Rules"]]
    what = f"{len(ids)} rules: {', '.join(ids)}"
    have = current(client.get_bucket_lifecycle_configuration, "Rules",
                   "NoSuchLifecycleConfiguration")
    if have is not None and _lifecycle_key(have) == _lifecycle_key(
            life["Rules"]):
        ok("lifecycle", True, f"unchanged: {what}")
    else:
        try:
            client.put_bucket_lifecycle_configuration(
                Bucket=bucket, LifecycleConfiguration=life)
            gone = sorted({str(r.get("ID") or "(no ID)") for r in have or []}
                          - set(ids))
            ok("lifecycle", True, f"set: {what}"
               + (f"; replaced: {', '.join(gone)}" if gone else ""))
        except Exception as e:
            ok("lifecycle", False, _error(e))
    print("applied" if not ok.failed else f"{ok.failed} FAILED", flush=True)
    return 1 if ok.failed else 0


def roundtrip() -> int:
    """put_file / head / get_file / delete of one small object under
    uploads/_r2check/ with the current credentials — no bucket-level
    call (an "Object Read & Write" token needs none)."""
    if not storage.r2_available():
        return _not_configured()
    ok = Checks()
    key = f"uploads/_r2check/{uuid.uuid4().hex}.rt"
    body = os.urandom(64 * 1024)
    with tempfile.TemporaryDirectory(prefix="r2rt-") as d:
        src, back = Path(d) / "src", Path(d) / "back"
        src.write_bytes(body)
        try:
            ok("put_file", storage.put_file(
                str(src), key, content_type="application/octet-stream")
                == len(body))
            ok("head", storage.head(key) == len(body))
            storage.get_file(key, str(back))
            ok("get_file, same bytes", back.read_bytes() == body)
            storage.delete(key)
            ok("delete", storage.head(key) is None)
        except Exception as e:
            ok("round trip", False, _error(e))
            try:
                storage.delete(key)
            except Exception:
                pass
    print("round trip passed" if not ok.failed else f"{ok.failed} FAILED",
          flush=True)
    return 1 if ok.failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.r2_setup")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--origin", default=None,
                    help="also check the CORS preflight from this origin")
    ap.add_argument("--skip-lifecycle", action="store_true",
                    help="don't read the bucket's lifecycle rules (a token "
                         "without that right; check them in the dashboard)")
    ap.add_argument("--print-config", action="store_true")
    ap.add_argument("--apply", action="store_true",
                    help="set the bucket's CORS and lifecycle to what "
                         "--print-config prints (Admin Read & Write token)")
    ap.add_argument("--roundtrip", action="store_true",
                    help="put / get / delete of one small object only")
    ap.add_argument("--origins", default=",".join(DEFAULT_ORIGINS),
                    help="comma-separated AllowedOrigins for --print-config "
                         "and --apply")
    args = ap.parse_args(argv)
    origins = [o.strip() for o in args.origins.split(",") if o.strip()]
    if args.print_config:
        print("# CORS (dashboard → bucket → Settings → CORS policy, or "
              "aws s3api put-bucket-cors --cors-configuration file://cors.json)")
        print(json.dumps(cors_config(origins), indent=2))
        print("# Lifecycle (aws s3api put-bucket-lifecycle-configuration "
              "--lifecycle-configuration file://lifecycle.json)")
        print(json.dumps(lifecycle_config(), indent=2))
        if not (args.apply or args.check or args.roundtrip):
            return 0
    if not (args.apply or args.check or args.roundtrip):
        ap.print_help()
        return 2
    if args.apply:
        rc = apply(origins)
        if rc:
            return rc
    rc = 0
    if args.check:
        rc = check(args.origin, lifecycle=not args.skip_lifecycle)
    if args.roundtrip:
        rc = roundtrip() or rc
    return rc


if __name__ == "__main__":
    sys.exit(main())
