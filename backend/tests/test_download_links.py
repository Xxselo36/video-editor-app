"""PR2 live test, D1 and D2: GET /jobs/{id}/download is never stored,
its 307 to R2 neither (a browser reused the first export's redirect for
an hour, so Herunterladen after a second Fertigstellen saved the first
export), while the players' and images' redirects keep their hour; the
web's v= (the export's generation) and other unknown parameters are
ignored. ?as=url says where the file is instead, for the page's fetch()
(the iPhone's "Video sichern": a fetch() that follows the 307 into the
bucket is redirect-tainted, which the bucket's CORS rules refuse): the
presigned R2 GET itself, or with local media this route's own URL. The
Projects tiles' rows carry the generation (renders_ok) for their menu's
download link."""
from __future__ import annotations

from urllib.parse import parse_qs, unquote, urlsplit

import backend.main as M
from backend import auth, media, storage
from backend.jobs import store
from conftest import R2_ENDPOINT

NOT_READY = {"detail": "requested format not ready"}


def _r2_job(r2, owner="user_a"):
    """A job after its second export, its media in R2 (moto)."""
    job = store.create(None, {}, owner_id=owner)
    p = f"jobs/{job.id}/"
    keys = {"primary": p + "r2/primary.mp4", "1:1": p + "r2/1x1.mp4",
            "hook_1": p + "r2/hook_1.mp4"}
    others = {"proxy": p + "proxy.mp4", "preview": p + "preview/v1.mp4",
              "thumb": p + "r2/thumb.jpg"}
    for key in (*keys.values(), *others.values()):
        r2.put_object(Bucket=storage.bucket(), Key=key, Body=key.encode())
    store.update(job.id, status="done", title="Mein Take", renders_ok=2,
                 render_gen=2, proxy_key=others["proxy"],
                 preview_key=others["preview"], preview_version=1,
                 output_keys=keys, thumb_key=others["thumb"])
    return store.get(job.id), keys


def _local_job(tmp_path, owner=None, body=b"export 2"):
    """A job after its second export, its media on the local disk."""
    job = store.create(None, {}, owner_id=owner)
    key = f"jobs/{job.id}/r2/primary.mp4"
    src = tmp_path / f"{job.id}.mp4"
    src.write_bytes(body)
    media.put_file(src, key, content_type="video/mp4")
    store.update(job.id, status="done", title="Mein Take", renders_ok=2,
                 render_gen=2, output_keys={"primary": key})
    return store.get(job.id)


def _legacy_job(owner=None):
    """A job from before the media keys: its export a local file."""
    job = store.create(None, {}, owner_id=owner)
    out = M._WORK_ROOT / "legacy-download" / job.id
    out.mkdir(parents=True, exist_ok=True)
    (out / "cleo_output.mp4").write_bytes(b"legacy export")
    store.update(job.id, status="done", output_path=str(out / "cleo_output.mp4"),
                 outputs={"primary": str(out / "cleo_output.mp4")})
    return store.get(job.id)


def _get(client, job_id, route="download", headers=None, **params):
    return client.get(f"/jobs/{job_id}/{route}", params=params,
                      headers=headers or {}, follow_redirects=False)


# ── no-store (D1) ────────────────────────────────────────────────────


def test_the_download_redirect_is_never_stored(client, r2, auth_on,
                                               monkeypatch):
    monkeypatch.setenv("CLEO_PROXY_VIDEO", "1")
    job, keys = _r2_job(r2)
    t = auth.media_token("user_a")
    for params in ({}, {"format": "1:1"}, {"format": "hook_1"},
                   {"name": "v2"}, {"name": "v2", "v": 2}):
        r = _get(client, job.id, t=t, **params)
        assert r.status_code == 307, (params, r.text)
        assert r.headers["cache-control"] == "no-store", params
    # The generation is ignored: the same presigned GET as without it.
    plain = _get(client, job.id, name="v2", t=t).headers["location"]
    assert _get(client, job.id, name="v2", v=2, t=t).headers["location"] == plain
    assert unquote(urlsplit(plain).path) == f"/{storage.bucket()}/{keys['primary']}"
    # The players' and the images' redirects keep their hour.
    for route, params in (("watch", {}), ("watch", {"v": 2}),
                          ("preview-video", {"v": 1}), ("proxy-video", {}),
                          ("thumbnail", {"v": 2})):
        r = _get(client, job.id, route, t=t, **params)
        assert r.status_code == 307, (route, r.text)
        assert r.headers["cache-control"] == media.REDIRECT_CACHE, route
    assert media.REDIRECT_CACHE == "private, max-age=3600"
    # The next export behind the same link: its own file at once.
    third = f"jobs/{job.id}/r3/primary.mp4"
    r2.put_object(Bucket=storage.bucket(), Key=third, Body=b"export 3")
    store.update(job.id, renders_ok=3, render_gen=3,
                 output_keys={"primary": third})
    loc = _get(client, job.id, name="v2", t=t).headers["location"]
    assert unquote(urlsplit(loc).path) == f"/{storage.bucket()}/{third}"


def test_a_local_download_is_never_stored(client, no_r2, tmp_path):
    job = _local_job(tmp_path)
    r = _get(client, job.id, name="v2", v=2)
    assert (r.status_code, r.content) == (200, b"export 2")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["content-disposition"].startswith("attachment;")
    # The player's file keeps its headers (no-store is for downloads).
    w = _get(client, job.id, "watch", v=2)
    assert (w.status_code, w.content) == (200, b"export 2")
    assert "no-store" not in w.headers.get("cache-control", "")
    # A job from before the media keys: the same.
    old = _legacy_job()
    r = _get(client, old.id, v=0)
    assert (r.status_code, r.content) == (200, b"legacy export")
    assert r.headers["cache-control"] == "no-store"
    assert f'filename="cleo_{old.id}_primary.mp4"' in r.headers["content-disposition"]


# ── ?as=url (D2) ─────────────────────────────────────────────────────


def test_as_url_on_r2_is_the_presigned_get_without_a_redirect(
        client, r2, auth_on, bearer):
    job, keys = _r2_job(r2)
    t = auth.media_token("user_a")
    q = {"format": "primary", "name": "v2", "v": 2}
    r = _get(client, job.id, **q, **{"as": "url"}, t=t)
    assert r.status_code == 200, r.text
    assert "location" not in r.headers
    assert r.headers["cache-control"] == "no-store"
    name = M._download_name(store.get(job.id), "primary")
    body = r.json()
    assert set(body) == {"url", "name"} and body["name"] == name
    u = urlsplit(body["url"])
    query = parse_qs(u.query)
    assert f"{u.scheme}://{u.netloc}" == R2_ENDPOINT
    assert unquote(u.path) == f"/{storage.bucket()}/{keys['primary']}"
    assert query["response-content-type"] == ["video/mp4"]
    assert query["response-content-disposition"] == [
        f'attachment; filename="{name}"']
    # The very GET the download's 307 goes to.
    assert body["url"] == _get(client, job.id, **q, t=t).headers["location"]
    # Signed in by the header too; another format its own file.
    h = _get(client, job.id, **q, **{"as": "url"}, headers=bearer("user_a"))
    assert (h.status_code, h.json()) == (200, body)
    sq = _get(client, job.id, format="1:1", **{"as": "url"}, t=t).json()
    assert unquote(urlsplit(sq["url"]).path).endswith(keys["1:1"])
    assert sq["name"] == f"cleo_{job.id}_1-1.mp4"
    # The owner check of /download: someone else's job is 404, no token 401.
    other = auth.media_token("user_b")
    assert _get(client, job.id, **{"as": "url"}, t=other).status_code == 404
    assert _get(client, job.id, **{"as": "url"}).status_code == 401
    # A format that isn't rendered, and a job before its export: 409.
    r = _get(client, job.id, format="4:5", **{"as": "url"}, t=t)
    assert (r.status_code, r.json()["detail"]) == (409, NOT_READY["detail"])
    fresh = store.create(None, {}, owner_id="user_a")
    store.update(fresh.id, status="awaiting_review",
                 mezz_key=f"jobs/{fresh.id}/mezz.mp4")
    for params in ({"as": "url"}, {}):
        r = _get(client, fresh.id, **params, t=t)
        assert (r.status_code, r.json()["detail"]) == (409, NOT_READY["detail"])


def test_as_url_locally_is_this_route_fetched_like_any_api_call(
        client, no_r2, auth_on, bearer, tmp_path):
    job = _local_job(tmp_path, owner="user_a")
    t = auth.media_token("user_a")
    r = _get(client, job.id, format="primary", name="v2", v=2,
             **{"as": "url"}, t=t)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    name = M._download_name(store.get(job.id), "primary")
    # Relative to the API, without `as` and the media token.
    want = f"/jobs/{job.id}/download?format=primary&name=v2&v=2"
    assert r.json() == {"url": want, "name": name}
    # The page fetches it with its API auth (the header): the file.
    f = client.get(want, headers=bearer("user_a"))
    assert (f.status_code, f.content) == (200, b"export 2")
    assert f.headers["cache-control"] == "no-store"
    assert f'filename="{name}"' in f.headers["content-disposition"]
    # Signed in by the header: the same answer; someone else's job 404;
    # without a token or a header 401.
    h = _get(client, job.id, format="primary", name="v2", v=2,
             **{"as": "url"}, headers=bearer("user_a"))
    assert (h.status_code, h.json()) == (200, r.json())
    assert _get(client, job.id, **{"as": "url"},
                t=auth.media_token("user_b")).status_code == 404
    assert _get(client, job.id, **{"as": "url"}).status_code == 401
    # A local file that is gone: 409, as /download says.
    media.local_path(job.output_keys["primary"]).unlink()
    for params in ({"as": "url"}, {}):
        r = _get(client, job.id, **params, t=t)
        assert (r.status_code, r.json()["detail"]) == (409, NOT_READY["detail"])


def test_as_url_for_an_anonymous_visitor(client, no_r2, tmp_path):
    # Accounts off (the beta): the job id is all it takes, also here.
    job = _local_job(tmp_path)
    r = _get(client, job.id, format="primary", name="v2", v=2, **{"as": "url"})
    assert r.status_code == 200
    assert r.json()["url"] == f"/jobs/{job.id}/download?format=primary&name=v2&v=2"
    assert client.get(r.json()["url"]).content == b"export 2"
    # A job from before the media keys: the same route serves its file.
    old = _legacy_job()
    r = _get(client, old.id, **{"as": "url"})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert r.json() == {"url": f"/jobs/{old.id}/download",
                        "name": f"cleo_{old.id}_primary.mp4"}
    assert client.get(r.json()["url"]).content == b"legacy export"
    r = _get(client, old.id, format="9:16", **{"as": "url"})
    assert r.status_code == 409


def test_as_url_of_an_r2_job_without_r2_config_is_503(client, no_r2):
    job = store.create(None, {})
    store.update(job.id, status="done", media_store="r2",
                 output_keys={"primary": f"jobs/{job.id}/r1/primary.mp4"})
    for params in ({"as": "url"}, {}):
        r = _get(client, job.id, **params)
        assert (r.status_code, r.json()["detail"]) == (503, "storage_unavailable")


# ── the tiles' generation (D1, Projects ⋯ → Herunterladen) ────────────


def test_the_tiles_rows_carry_the_export_generation(client, auth_on, bearer):
    job = store.create(None, {}, owner_id="user_a")
    store.update(job.id, status="done", renders_ok=3)
    fresh = store.create(None, {}, owner_id="user_a")
    rows = client.get("/jobs/status", params={"ids": f"{job.id},{fresh.id}"},
                      headers=bearer("user_a")).json()["jobs"]
    assert {r["id"]: r["renders_ok"] for r in rows} == {job.id: 3, fresh.id: 0}
    tiles = client.get("/jobs?fields=summary", headers=bearer("user_a")).json()
    assert {r["id"]: r["renders_ok"] for r in tiles} == {job.id: 3, fresh.id: 0}
