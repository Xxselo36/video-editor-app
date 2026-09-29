"""WP3: backend/storage.py (R2 client, day-aligned presigned GETs,
delete by prefix), backend/media.py (backend choice, key rules, the local
backend) and the import rule (no boto3 / psycopg in the modules the
desktop app and Modal load). R2 is moto, in-process."""
from __future__ import annotations

import datetime as dt
import os
import subprocess
import sys
import threading
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import pytest

import backend.main as M
from backend import media, storage
from conftest import R2_ENDPOINT, R2_ENV, REPO

JOB = "0123456789ab"


# ── the client ───────────────────────────────────────────────────────


def test_one_cached_client_per_process(r2, monkeypatch):
    api = storage._client()
    assert storage._client() is api
    got: set[int] = set()

    def grab():
        for _ in range(50):
            got.add(id(storage._client()))
    threads = [threading.Thread(target=grab) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert got == {id(api)}
    cfg = api.meta.config
    assert cfg.signature_version == "s3v4"
    assert cfg.s3["addressing_style"] == "path"
    # retries={"max_attempts": 5}: botocore counts the first try too.
    assert cfg.retries == {"mode": "standard", "total_max_attempts": 6}
    assert (cfg.connect_timeout, cfg.read_timeout,
            cfg.max_pool_connections) == (5, 60, 32)
    assert api.meta.endpoint_url == R2_ENDPOINT
    # The presign-only client signs day-aligned; the API one keeps s3v4.
    get = storage._client("get")
    assert get is storage._client("get") and get is not api
    assert get.meta.config.signature_version == "cleo-day"
    # 8 threads share one client for real calls too.
    r2.put_object(Bucket=storage.bucket(), Key="jobs/x/a.mp4", Body=b"abc")
    sizes = []
    threads = [threading.Thread(
        target=lambda: sizes.append(storage.head("jobs/x/a.mp4")))
        for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sizes == [3] * 8
    # New credentials → a new client.
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "AKIAOTHER")
    assert storage._client() is not api


def _midnight(delta_days: int = 0) -> dt.datetime:
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    return now.replace(hour=0, minute=0, second=0, microsecond=0) \
        + dt.timedelta(days=delta_days)


def test_day_aligned_presign_equals_botocore_at_midnight(r2):
    import boto3
    from botocore.config import Config
    key = f"jobs/{JOB}/r2/primary.mp4"
    url = storage.presign_get(key, filename=f"cleo_{JOB}_primary.mp4",
                              attachment=True, content_type="video/mp4")
    ref_client = boto3.session.Session().client(
        "s3", endpoint_url=R2_ENDPOINT, region_name="auto",
        aws_access_key_id=R2_ENV["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=R2_ENV["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4",
                      s3={"addressing_style": "path"}))
    day = _midnight()
    with mock.patch("botocore.auth.get_current_datetime", return_value=day):
        ref = ref_client.generate_presigned_url("get_object", Params={
            "Bucket": storage.bucket(), "Key": key,
            "ResponseContentDisposition":
                f'attachment; filename="cleo_{JOB}_primary.mp4"',
            "ResponseContentType": "video/mp4"}, ExpiresIn=172800)
    assert url == ref
    q = parse_qs(urlsplit(url).query)
    assert q["X-Amz-Date"] == [day.strftime("%Y%m%dT000000Z")]
    assert q["X-Amz-Expires"] == ["172800"]
    assert q["response-content-disposition"] == [
        f'attachment; filename="cleo_{JOB}_primary.mp4"']
    assert urlsplit(url).netloc == urlsplit(R2_ENDPOINT).netloc
    # The same URL all day …
    late = day + dt.timedelta(hours=23, minutes=59, seconds=59)
    with mock.patch("botocore.auth.get_current_datetime", return_value=late):
        assert storage.presign_get(
            key, filename=f"cleo_{JOB}_primary.mp4", attachment=True,
            content_type="video/mp4") == url
    # … a new one the next day.
    with mock.patch("botocore.auth.get_current_datetime",
                    return_value=day + dt.timedelta(days=1, hours=1)):
        nxt = storage.presign_get(key, filename=f"cleo_{JOB}_primary.mp4",
                                  attachment=True, content_type="video/mp4")
    assert nxt != url
    assert parse_qs(urlsplit(nxt).query)["X-Amz-Date"] == [
        _midnight(1).strftime("%Y%m%dT000000Z")]


def test_header_signed_calls_keep_the_real_clock(r2):
    """Only the presign client is day-aligned: a normal call signs with
    the current time (a midnight signature would be refused as skewed)."""
    seen = {}

    def before_send(request, **_):
        seen["date"] = request.headers.get("X-Amz-Date")
    api = storage._client()
    api.meta.events.register("before-send.s3.HeadObject", before_send)
    try:
        storage.head("jobs/nothing/here.mp4")
    finally:
        api.meta.events.unregister("before-send.s3.HeadObject", before_send)
    raw = seen["date"]
    signed = dt.datetime.strptime(
        raw.decode() if isinstance(raw, bytes) else raw, "%Y%m%dT%H%M%SZ")
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    assert abs((now - signed).total_seconds()) < 300


def test_put_get_head_and_metadata(r2, tmp_path):
    src = tmp_path / "a.mp4"
    src.write_bytes(b"x" * 1000)
    key = f"jobs/{JOB}/mezz.mp4"
    assert storage.put_file(str(src), key, content_type="video/mp4") == 1000
    head = r2.head_object(Bucket=storage.bucket(), Key=key)
    assert head["ContentType"] == "video/mp4"
    assert head["CacheControl"] == "private, max-age=31536000, immutable"
    assert storage.head(key) == 1000
    assert storage.head(key + ".missing") is None
    storage.get_file(key, str(tmp_path / "back" / "b.mp4"))
    assert (tmp_path / "back" / "b.mp4").read_bytes() == b"x" * 1000
    storage.delete(key)
    assert storage.head(key) is None


def test_head_raises_on_errors_other_than_404(r2, monkeypatch):
    from botocore.exceptions import ClientError
    err = ClientError({"Error": {"Code": "AccessDenied"},
                       "ResponseMetadata": {"HTTPStatusCode": 403}},
                      "HeadObject")
    monkeypatch.setattr(storage._client(), "head_object",
                        mock.Mock(side_effect=err))
    with pytest.raises(ClientError):
        storage.head("jobs/x/y.mp4")


def test_delete_prefix_over_1000_keys(r2, monkeypatch):
    b = storage.bucket()
    for i in range(1105):
        r2.put_object(Bucket=b, Key=f"jobs/{JOB}/r1/hook_{i}.mp4", Body=b"")
    r2.put_object(Bucket=b, Key="jobs/0123456789ac/mezz.mp4", Body=b"n")
    api = storage._client()
    real = api.delete_objects
    batches = []

    def delete_objects(**kw):
        batches.append(len(kw["Delete"]["Objects"]))
        assert kw["Delete"]["Quiet"] is True
        return real(**kw)
    monkeypatch.setattr(api, "delete_objects", delete_objects)
    assert storage.delete_prefix(f"jobs/{JOB}/") == 1105
    assert batches == [1000, 105]
    left = [o["Key"] for o in r2.list_objects_v2(Bucket=b).get("Contents")]
    assert left == ["jobs/0123456789ac/mezz.mp4"]
    for bad in ("", "/jobs/x/", "jobs/../x/"):
        with pytest.raises(ValueError):
            storage.delete_prefix(bad)


def test_delete_prefix_raises_on_key_errors(r2, monkeypatch):
    r2.put_object(Bucket=storage.bucket(), Key=f"jobs/{JOB}/a", Body=b"")
    monkeypatch.setattr(storage._client(), "delete_objects", lambda **kw: {
        "Errors": [{"Key": f"jobs/{JOB}/a", "Code": "InternalError",
                    "Message": "try again"}]})
    with pytest.raises(RuntimeError, match="InternalError"):
        storage.delete_prefix(f"jobs/{JOB}/")


def test_list_job_prefixes(r2):
    b = storage.bucket()
    for key in ("jobs/aaaaaaaaaaaa/mezz.mp4", "jobs/aaaaaaaaaaaa/r1/p.mp4",
                "jobs/bbbbbbbbbbbb/proxy.mp4", "uploads/u/x.mp4"):
        r2.put_object(Bucket=b, Key=key, Body=b"")
    got = dict(storage.list_job_prefixes())
    assert set(got) == {"aaaaaaaaaaaa", "bbbbbbbbbbbb"}
    assert all(isinstance(v, dt.datetime) for v in got.values())
    assert [j for j, _ in storage.list_job_prefixes(
        skip=lambda j: j == "aaaaaaaaaaaa")] == ["bbbbbbbbbbbb"]


# ── media.py ─────────────────────────────────────────────────────────


def test_key_and_job_id_validation():
    for bad in ("", "/jobs/x", "jobs/../x", "jobs\\x", "a\x00b", None, 5,
                "x" * 1025):
        with pytest.raises(ValueError):
            media.check_key(bad)
    assert media.check_key(f"jobs/{JOB}/mezz.mp4")
    assert media.job_prefix(JOB) == f"jobs/{JOB}/"
    for bad in ("0123456789a", "0123456789abc", "0123456789AB", "../x",
                "", None, "0123456789a/"):
        with pytest.raises(ValueError):
            media.job_prefix(bad)
    with pytest.raises(ValueError):
        media.put_file(__file__, "../escape", content_type="video/mp4")
    with pytest.raises(ValueError):
        media.delete_prefix("jobs/x")      # not a prefix


def test_backend_choice(monkeypatch, no_r2):
    monkeypatch.delenv("CLEO_MEDIA_BACKEND", raising=False)
    assert media.backend() == "local"
    for k, v in R2_ENV.items():
        monkeypatch.setenv(k, v)
    assert media.backend() == "r2"
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "local")
    assert media.backend() == "local"
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    assert media.backend() == "r2"
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "s3")
    with pytest.raises(media.ConfigError):
        media.backend()
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    monkeypatch.delenv("R2_BUCKET")
    with pytest.raises(media.ConfigError, match="R2 is not configured"):
        media.backend()


def test_r2_backend_without_config_refuses_to_start(monkeypatch, no_r2):
    from fastapi.testclient import TestClient
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    with pytest.raises(media.ConfigError):
        with TestClient(M.app):
            pass


def test_local_backend(monkeypatch, no_r2, tmp_path):
    monkeypatch.setenv("CLEO_MEDIA_ROOT", str(tmp_path / "media"))
    src = tmp_path / "w" / "mezz.mp4"
    src.parent.mkdir()
    src.write_bytes(b"m" * 10)
    key = f"jobs/{JOB}/mezz.mp4"
    assert media.put_file(src, key, content_type="video/mp4") == 10
    assert (tmp_path / "media" / key).read_bytes() == b"m" * 10
    src.unlink()                          # the workspace goes: still there
    assert media.size(key) == 10 and media.exists(key)
    media.get_file(key, tmp_path / "copy.mp4")
    assert (tmp_path / "copy.mp4").read_bytes() == b"m" * 10
    with pytest.raises(FileNotFoundError):
        media.get_file(key + "x", tmp_path / "nope.mp4")
    media.put_file(tmp_path / "copy.mp4", f"jobs/{JOB}/r1/primary.mp4",
                   content_type="video/mp4")
    assert media.delete_prefix(f"jobs/{JOB}/") == 2
    assert media.size(key) is None and not media.exists(key)
    assert media.delete_prefix(f"jobs/{JOB}/") == 0
    media.delete(key)                    # idempotent


def test_uploads_live_in_r2_even_with_local_media(r2, monkeypatch):
    """CLEO_MEDIA_BACKEND=local (rollback) with R2 configured: browser
    uploads still went to R2 — their keys are read and deleted there."""
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "local")
    r2.put_object(Bucket=storage.bucket(), Key="uploads/u/v.mp4", Body=b"v1")
    assert media.size("uploads/u/v.mp4") == 2
    media.delete("uploads/u/v.mp4")
    assert storage.head("uploads/u/v.mp4") is None


# ── import rule ──────────────────────────────────────────────────────


def test_modules_import_without_boto3_and_psycopg():
    """backend.jobs / costs / llm / whisper_groq / pipeline (desktop app,
    Modal image) and media / storage import with boto3, botocore and
    psycopg unavailable, and load none of them."""
    code = r"""
import sys
BLOCKED = ("boto3", "botocore", "s3transfer", "psycopg", "psycopg_pool", "moto")
class Block:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in BLOCKED:
            raise ImportError("blocked: " + name)
        return None
sys.meta_path.insert(0, Block())
import backend.jobs, backend.costs, backend.llm, backend.whisper_groq
import backend.pipeline, backend.media, backend.storage, backend.uploads
loaded = sorted(m for m in sys.modules if m.split(".")[0] in BLOCKED)
assert not loaded, loaded
assert not backend.storage.r2_available()
print("ok")
"""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("R2_", "DATABASE_URL", "CLEO_DB"))}
    r = subprocess.run([sys.executable, "-c", code], cwd=str(REPO), env=env,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and r.stdout.strip().endswith("ok"), r.stderr
