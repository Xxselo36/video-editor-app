"""WP3 over real HTTP against a moto S3 server (ThreadedMotoServer),
like the browser and ffprobe see R2: parts PUT through presigned,
size-signed URLs (a retried part replaces the first try), complete,
POST /jobs probing the duration with ffprobe over a presigned GET (moov
at the end of the MP4; a streamed WebM without one → the client's
duration), and the 307 targets of the media routes served with Range.
Skipped without ffmpeg / ffprobe. (moto doesn't check signatures: that
R2 refuses a part of the wrong length is part of the staging smoke
test, python -m backend.r2_setup --check.)"""
from __future__ import annotations

import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

import backend.main as M
from backend import accounts, auth, storage
from backend.jobs import store
from conftest import R2_ENV, add_sub, analysis_result

pytestmark = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="needs ffmpeg + ffprobe")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def moto_server():
    from moto.server import ThreadedMotoServer
    port = _free_port()
    srv = ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)
    srv.start()
    yield f"http://127.0.0.1:{port}"
    srv.stop()


@pytest.fixture
def r2_http(moto_server, monkeypatch):
    import boto3
    for k, v in R2_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("R2_ENDPOINT_URL", moto_server)
    monkeypatch.setenv("CLEO_DISK_FACTOR", "0")
    # Every WP3 lever on (all opt-in).
    monkeypatch.setenv("CLEO_MEDIA_BACKEND", "r2")
    monkeypatch.setenv("CLEO_UPLOAD_MODE", "multipart")
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    s3 = boto3.session.Session().client(
        "s3", endpoint_url=moto_server, region_name="us-east-1",
        aws_access_key_id="AK", aws_secret_access_key="SK")
    try:
        s3.create_bucket(Bucket=R2_ENV["R2_BUCKET"])
    except s3.exceptions.BucketAlreadyOwnedByYou:
        pass
    return s3


def _http(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=headers or {})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def _video(path: Path, seconds: int, webm_stream: bool = False) -> Path:
    ff = shutil.which("ffmpeg")
    src = ["-f", "lavfi", "-i", f"testsrc=size=64x64:rate=10:duration={seconds}",
           "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
           "-shortest"]
    if webm_stream:
        # Written to a pipe like MediaRecorder: no duration in the header.
        with open(path, "wb") as out:
            subprocess.run([ff, "-v", "error", *src, "-c:v", "libvpx",
                            "-c:a", "libopus", "-f", "webm", "pipe:1"],
                           stdout=out, check=True)
    else:
        # Plain MP4 (moov at the end), ~25 MB of noise: two 16 MiB parts.
        subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i",
                        f"color=c=gray:s=480x270:r=30:d={seconds}",
                        "-f", "lavfi", "-i",
                        f"sine=frequency=440:duration={seconds}",
                        "-vf", "noise=alls=100:allf=t", "-c:v", "mjpeg",
                        "-q:v", "2", "-c:a", "aac", "-shortest", str(path)],
                       check=True)
    return path


def _upload(client, headers, data: bytes, name: str, retry_part=None):
    """The browser's multipart upload: init, a PUT per part (plain HTTP,
    no custom headers besides the content type moto needs), complete."""
    r = client.post("/uploads/multipart/init", headers=headers,
                    json={"filename": name, "content_type": "video/mp4",
                          "size": len(data)})
    assert r.status_code == 200, r.text
    body = r.json()
    ps = body["part_size"]
    for p in body["parts"]:
        n = p["part_number"]
        chunk = data[(n - 1) * ps:n * ps]
        if retry_part == n:   # a first try that got cut off, then again
            st, _, _ = _http("PUT", p["url"], data=chunk[:len(chunk) // 2],
                             headers={"Content-Type": "application/octet-stream"})
        st, hd, _ = _http("PUT", p["url"], data=chunk,
                          headers={"Content-Type": "application/octet-stream"})
        assert st == 200 and hd.get("etag"), (n, st)
    r = client.post("/uploads/multipart/parts", headers=headers,
                    json={"ticket": body["ticket"]})
    assert [p["size"] for p in r.json()["parts"]] == [
        min(ps, len(data) - i * ps) for i in range(body["parts_total"])]
    r = client.post("/uploads/multipart/complete", headers=headers,
                    json={"ticket": body["ticket"]})
    assert r.status_code == 200, r.text
    assert r.json() == {"storage_key": body["storage_key"], "size": len(data)}
    return body["storage_key"]


def test_upload_probe_and_charge_over_http(client, r2_http, enforce, bearer,
                                           tmp_path, clean_state):
    add_sub(plan="pro", period_start=time.time() - 60)
    h = bearer()
    data = _video(tmp_path / "moov_end.mp4", 7).read_bytes()
    assert 16 * 2**20 < len(data) < 32 * 2**20
    key = _upload(client, h, data, "clip.mp4", retry_part=2)
    assert storage.head(key) == len(data)
    t0 = time.monotonic()
    r = client.post("/jobs", headers=h,
                    data={"settings": "{}", "storage_key": key,
                          "duration": "99"})
    assert r.status_code == 200, r.text
    assert time.monotonic() - t0 < 5
    job = store.get(r.json()["job_id"])
    # ffprobe read the header over the presigned URL: 7 s, not the 99 s
    # the client claimed.
    assert accounts.get_usage(job.id)["seconds_billed"] == 7
    assert job.source_key == key


def test_streamed_webm_falls_back_to_the_client_duration(
        client, r2_http, enforce, bearer, tmp_path):
    add_sub(plan="pro", period_start=time.time() - 60)
    h = bearer()
    data = _video(tmp_path / "rec.webm", 3, webm_stream=True).read_bytes()
    url_probe = []
    real = M._probe_remote

    def probe(url):
        seconds, has_audio = real(url)
        url_probe.append(seconds)
        assert has_audio is True     # the header lists the sound track
        return seconds, has_audio
    mp = pytest.MonkeyPatch()
    mp.setattr(M, "_probe_remote", probe)
    try:
        key = _upload(client, h, data, "rec.webm")
        r = client.post("/jobs", headers=h, data={
            "settings": "{}", "storage_key": key, "duration": "3.2"})
        assert r.status_code == 200, r.text
        assert url_probe == [None]            # no duration in the header
        assert accounts.get_usage(r.json()["job_id"])["seconds_billed"] == 4
        # No duration from the browser either (MediaRecorder reports
        # Infinity): accepted, measured and charged by the worker — the
        # real packet scan of the real object.
        key2 = _upload(client, h, data, "rec2.webm")
        r = client.post("/jobs", headers=h, data={"settings": "{}",
                                                   "storage_key": key2})
        assert r.status_code == 200, r.text
        job_id = r.json()["job_id"]
        assert accounts.get_usage(job_id) is None
        seen = {}

        def analyze(input_path, output_dir, settings, **kw):
            seen["settings"] = settings
            return analysis_result(output_dir, 3.0)
        mp.setattr(M, "analyze_only", analyze)
        M._run_analyze_inner(job_id)
        got = store.get(job_id)
        assert got.status == "awaiting_review", got.error
        billed = accounts.get_usage(job_id)["seconds_billed"]
        assert billed in (3, 4)
        assert seen["settings"] == {
            "_max_seconds": billed + accounts.TRUE_UP_TOLERANCE_S}
        assert got.settings == seen["settings"] and got.plan == "pro"
        assert storage.head(key2) is None     # consumed
    finally:
        mp.undo()


def test_307_targets_serve_ranges_and_the_download_name(client, r2_http,
                                                        auth_on, tmp_path):
    job = store.create(None, {}, owner_id="user_a")
    p = f"jobs/{job.id}/"
    body = bytes(range(256)) * 40
    src = tmp_path / "p.mp4"
    src.write_bytes(body)
    for key in ("proxy.mp4", "r1/primary.mp4"):
        storage.put_file(str(src), p + key, content_type="video/mp4")
    store.update(job.id, status="done", proxy_key=p + "proxy.mp4",
                 output_keys={"primary": p + "r1/primary.mp4"})
    token = auth.media_token("user_a")
    r = client.get(f"/jobs/{job.id}/proxy-video", params={"t": token},
                   follow_redirects=False)
    assert r.status_code == 307
    st, hd, data = _http("GET", r.headers["location"],
                         headers={"Range": "bytes=0-1"})
    assert (st, data) == (206, body[:2])
    st, hd, data = _http("GET", r.headers["location"],
                         headers={"Range": "bytes=100-"})
    assert st == 206 and data == body[100:]
    r = client.get(f"/jobs/{job.id}/download", params={"t": token},
                   follow_redirects=False)
    st, hd, _ = _http("GET", r.headers["location"],
                      headers={"Range": "bytes=0-0"})
    assert st == 206
    assert hd["content-disposition"] == \
        f'attachment; filename="cleo_{job.id}_primary.mp4"'
