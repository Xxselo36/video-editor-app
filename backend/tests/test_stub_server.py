"""The e2e stub backend (stub_server.py) starts and serves its seeds.

The stub wraps backend internals (the analysis worker's analyze_only,
pipeline.render_to_keys, the preview rebuild, the proxy route), so a
backend change can break it without any change under web/ — whose CI
runs the browser suites against it. This runs it for real, as those
suites do: a subprocess on a free port, anonymous mode, local media.
Needs ffmpeg (the grid clip); not espeak-ng.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

import stub_media

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
WEBM_MAGIC = b"\x1a\x45\xdf\xa3"


class Api:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, body: bytes | dict | None = None,
             headers: dict | None = None, timeout: float = 120):
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        hdrs = {"Content-Type": "application/json"} if isinstance(body, dict) else {}
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={**hdrs, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def json(self, method: str, path: str, body: bytes | dict | None = None, **kw):
        status, _, raw = self.call(method, path, body, **kw)
        assert status == 200, f"{method} {path}: {status} {raw[:400]!r}"
        return json.loads(raw)

    def wait_status(self, job_id: str, want: str, timeout: float = 90) -> dict:
        end = time.monotonic() + timeout
        job: dict = {}
        while time.monotonic() < end:
            job = self.json("GET", f"/jobs/{job_id}")
            if job["status"] == want:
                return job
            assert job["status"] != "error", job
            time.sleep(0.25)
        raise AssertionError(f"job {job_id} never reached {want}: {job}")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def stub(tmp_path_factory):
    try:
        stub_media.ffmpeg()
    except RuntimeError as e:
        pytest.skip(str(e))
    tmp = tmp_path_factory.mktemp("stub")
    port = _free_port()
    # The test run's own settings (DB, R2, test mode) are not the stub's.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CLEO_", "R2_", "MOTO_", "DATABASE_URL", "STUB_"))}
    env.update({"STUB_ANALYSIS_SECONDS": "0.3", "TMPDIR": str(tmp),
                "STUB_MEDIA_DIR": os.environ.get("STUB_MEDIA_DIR") or str(tmp / "media")})
    log = open(tmp / "stub.log", "w+")
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "stub_server.py"), "--port", str(port),
         "--web-origin", "http://localhost:3999"],
        cwd=str(REPO), env=env, stdout=log, stderr=subprocess.STDOUT)
    api = Api(f"http://127.0.0.1:{port}")
    try:
        end = time.monotonic() + 240
        while True:
            if proc.poll() is not None:
                log.seek(0)
                pytest.fail(f"stub exited ({proc.returncode}):\n{log.read()[-4000:]}")
            try:
                if api.call("GET", "/health", timeout=2)[0] == 200:
                    break
            except OSError:
                pass
            if time.monotonic() > end:
                log.seek(0)
                pytest.fail(f"stub did not answer /health:\n{log.read()[-4000:]}")
            time.sleep(0.3)
        yield api
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        log.close()


def test_info(stub):
    info = stub.json("GET", "/_test/info")
    assert info["auth_test"] is False and info["r2"] is False
    assert "review" in info["seeds"] and "done" in info["seeds"]


def test_review_seed_edit_and_render(stub):
    job = stub.json("POST", "/_test/seed/review", {"filename": "smoke.mp4"})
    j = stub.json("GET", f"/jobs/{job['id']}")
    assert j["status"] == "awaiting_review"
    assert j["preview_segments"] == [[0, 6], [7, 14], [15, 22], [23, 30]]  # the grid clip
    assert j["has_proxy"] is False                       # proxy "off" (default)
    assert stub.call("GET", f"/jobs/{job['id']}/proxy-video")[0] == 404
    status, headers, body = stub.call("GET", f"/jobs/{job['id']}/preview-video")
    assert status == 200 and body[:4] == WEBM_MAGIC      # VP8 for Playwright's Chromium

    saved = stub.json("POST", f"/jobs/{job['id']}/edit-segments",
                      {"segments": [{"start": 0, "end": 6}, {"start": 15, "end": 22}]})
    assert saved["preview_ok"] is True
    inner = stub.json("GET", f"/_test/job/{job['id']}")
    assert [[s["start"], s["end"]] for s in inner["edit_segments"]] == [[0, 6], [15, 22]]
    assert inner["preview_version"] >= 2

    subs = stub.json("GET", f"/jobs/{job['id']}/subtitles")["subtitles"]
    stub.json("POST", f"/jobs/{job['id']}/render", {"subtitles": subs, "disabled_cuts": []})
    done = stub.wait_status(job["id"], "done")
    assert "primary" in done["outputs"]
    status, headers, body = stub.call("GET", f"/jobs/{job['id']}/download")
    assert status == 200 and body[:4] == WEBM_MAGIC
    assert headers["content-disposition"].startswith("attachment;")


def test_done_seed_and_proxy_modes(stub):
    done = stub.json("POST", "/_test/seed/done", {"clip": "grid"})
    assert stub.json("GET", f"/jobs/{done['id']}")["status"] == "done"
    status, headers, body = stub.call("GET", f"/jobs/{done['id']}/thumbnail")
    assert status == 200 and headers["content-type"] == "image/jpeg"

    on = stub.json("POST", "/_test/seed/review", {"proxy": "on"})
    assert stub.json("GET", f"/jobs/{on['id']}")["has_proxy"] is True
    status, _, body = stub.call("GET", f"/jobs/{on['id']}/proxy-video")
    assert status == 200 and body[:4] == WEBM_MAGIC

    probe = stub.json("POST", "/_test/seed/review", {"proxy": "probe"})
    assert "has_proxy" not in stub.json("GET", f"/jobs/{probe['id']}")


def test_upload_runs_the_fake_analysis(stub):
    name = f"smoke-{uuid.uuid4().hex[:6]}.mp4"
    stub.json("POST", "/_test/config", {"by_filename": {name: {"clip": "grid"}}})
    _, _, clip = stub.call("GET", "/_test/media/grid.mp4")
    boundary = uuid.uuid4().hex
    parts = [
        (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
         "Content-Type: video/mp4\r\n\r\n").encode() + clip + b"\r\n",
        (f'--{boundary}\r\nContent-Disposition: form-data; name="settings"\r\n\r\n'
         '{"caption_preset": "clipper"}\r\n').encode(),
        f"--{boundary}--\r\n".encode(),
    ]
    job = stub.json("POST", "/jobs", b"".join(parts),
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    review = stub.wait_status(job["id"], "awaiting_review")
    assert review["filename"] == name
    assert len(review["preview_segments"]) == 4          # the grid clip's analysis
    assert stub.json("GET", f"/_test/job/{job['id']}")["stub"]["clip"] == "grid"
    # new jobs carry the edit document (UT3)
    assert review["has_doc"] is True
    assert stub.json("GET", f"/jobs/{job['id']}/doc")["doc"]["words"][0]["text"] == "Satz"


def test_doc_get_and_patch(stub):
    job = stub.json("POST", "/_test/seed/review", {})
    got = stub.json("GET", f"/jobs/{job['id']}/doc")
    doc = got["doc"]
    assert (got["rev"], got["read_only"], doc["v"], doc["clips"]) == (0, False, 2, None)
    assert doc["style"] == {"presetId": "power", "overrides": {}}
    assert [w["text"] for w in doc["words"][:3]] == ["Satz", "1", "hier."]
    w = dict(doc["words"][0], text="Szene")
    assert stub.json("PATCH", f"/jobs/{job['id']}/doc", {
        "base_rev": 0, "rev": 7, "words": {"upsert": [w]},
        "style": {"presetId": "clipper", "overrides": {"y": 0.6}}}) == {"rev": 7}
    status, _, raw = stub.call("PATCH", f"/jobs/{job['id']}/doc",
                               {"base_rev": 0, "rev": 8, "format": {"aspect": "16:9"}})
    assert status == 409 and json.loads(raw) == {"detail": "stale_rev", "rev": 7}
    again = stub.json("GET", f"/jobs/{job['id']}/doc")
    assert again["rev"] == 7 and again["doc"]["words"][0]["text"] == "Szene"
    old = stub.json("POST", "/_test/seed/review", {"doc": False})
    assert stub.call("GET", f"/jobs/{old['id']}/doc")[0] == 404
    assert stub.json("GET", f"/jobs/{old['id']}")["has_doc"] is False
