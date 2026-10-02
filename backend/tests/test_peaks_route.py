"""GET /jobs/{id}/peaks (UX10 review finding 1/12): the editor fetch()es
peaks.bin from the web origin. The media routes answer R2 jobs with a 307
to a presigned URL, and a cross-origin fetch that follows it is
redirect-tainted (Origin: null), which the bucket's CORS refuses: the
editor never got peaks for R2 jobs. peaks.bin is small, so the API sends
the body itself, from either store, never a redirect.
"""
from __future__ import annotations

import pytest

import backend.main as M
from backend import auth, storage
from backend.jobs import store

BLOB = bytes(range(128)) * 3


def _job_with_peaks(r2=None):
    job = store.create(None, {}, owner_id="user_a")
    key = f"jobs/{job.id}/peaks.bin"
    if r2 is not None:
        r2.put_object(Bucket=storage.bucket(), Key=key, Body=BLOB)
        r2.put_object(Bucket=storage.bucket(), Key=f"jobs/{job.id}/proxy.mp4", Body=b"p" * 10)
    else:
        from backend import media
        path = media.local_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(BLOB)
    store.update(job.id, status="awaiting_review", peaks_key=key,
                 proxy_key=f"jobs/{job.id}/proxy.mp4",
                 media_store="r2" if r2 is not None else "local")
    return store.get(job.id)


def test_r2_peaks_are_the_body_not_a_redirect(client, r2, auth_on, monkeypatch):
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job = _job_with_peaks(r2)
    assert job.media_store == "r2"
    token = auth.media_token("user_a")
    # the other media routes redirect to R2 (the path the fetch failed on)
    r = client.get(f"/jobs/{job.id}/proxy-video", params={"t": token}, follow_redirects=False)
    assert r.status_code == 307
    # peaks: the bytes from the API's own origin, which the web app may read
    r = client.get(f"/jobs/{job.id}/peaks", params={"t": token}, follow_redirects=False,
                   headers={"Origin": "http://localhost:3000"})
    assert r.status_code == 200, r.text
    assert "location" not in r.headers
    assert r.content == BLOB
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["cache-control"] == "private, max-age=604800, immutable"


def test_local_peaks_unchanged(client, no_r2):
    job = _job_with_peaks()
    r = client.get(f"/jobs/{job.id}/peaks", follow_redirects=False)
    assert r.status_code == 200 and r.content == BLOB


def test_peaks_missing_or_oversized(client, r2, auth_on, monkeypatch):
    token = auth.media_token("user_a")
    job = _job_with_peaks(r2)
    monkeypatch.setattr(M, "PEAKS_MAX_BYTES", 100)
    r = client.get(f"/jobs/{job.id}/peaks", params={"t": token}, follow_redirects=False)
    assert r.status_code == 404
    monkeypatch.setattr(M, "PEAKS_MAX_BYTES", 8 * 1024 * 1024)
    r2.delete_object(Bucket=storage.bucket(), Key=job.peaks_key)
    r = client.get(f"/jobs/{job.id}/peaks", params={"t": token}, follow_redirects=False)
    assert r.status_code == 409


@pytest.mark.parametrize("origin", ["http://localhost:3000"])
def test_api_cors_lets_the_web_app_read_it(client, no_r2, origin):
    job = _job_with_peaks()
    r = client.get(f"/jobs/{job.id}/peaks", headers={"Origin": origin})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") in (origin, "*")
