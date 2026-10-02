"""UX12: POST /me/claim (anonymous beta projects → the signed-in
account), GET /jobs?fields=summary, PATCH /jobs/{id} {title}, the
Projects fields of the status rows and the empty-body thumbnail 404."""
from __future__ import annotations

import time

import backend.main as M
from backend.jobs import store


def _job(owner=None, **fields):
    job = store.create("/nonexistent/in.mp4", {"caption_preset": "clean"},
                       owner_id=owner)
    if fields:
        store.update(job.id, **fields)
    return store.get(job.id)


def _claim(client, headers, ids):
    return client.post("/me/claim", headers=headers, json={"job_ids": ids})


# ── POST /me/claim ───────────────────────────────────────────────────


def test_unowned_jobs_are_claimed(client, auth_on, bearer):
    a = _job(owner=None)
    b = _job(owner=None)
    store.update(a.id, updated_at=1000.0)
    r = _claim(client, bearer("user_a"), [a.id, b.id, a.id])
    assert r.status_code == 200
    assert r.json() == {"claimed": [a.id, b.id], "owned_elsewhere": [],
                        "missing": []}
    assert store.get(a.id).owner_id == "user_a"
    assert store.get(b.id).owner_id == "user_a"
    # Claiming doesn't touch the retention clock.
    assert store.get(a.id).updated_at == 1000.0
    # Now in the account's list.
    rows = client.get("/jobs?fields=summary", headers=bearer("user_a")).json()
    assert {r["id"] for r in rows} == {a.id, b.id}


def test_owned_elsewhere_and_missing_are_untouched(client, auth_on, bearer):
    mine = _job(owner="user_a")
    theirs = _job(owner="user_b")
    r = _claim(client, bearer("user_a"),
               [mine.id, theirs.id, "000000000000", "../etc/passwd"])
    assert r.status_code == 200
    assert r.json() == {"claimed": [mine.id], "owned_elsewhere": [theirs.id],
                        "missing": ["000000000000", "../etc/passwd"]}
    assert store.get(theirs.id).owner_id == "user_b"
    # Idempotent: the same answer again.
    again = _claim(client, bearer("user_a"), [mine.id, theirs.id])
    assert again.json()["claimed"] == [mine.id]
    assert again.json()["owned_elsewhere"] == [theirs.id]


def test_claim_rate_limit_and_size(client, auth_on, bearer):
    job = _job(owner=None)
    big = _claim(client, bearer("user_c"), ["x"] * (M._CLAIM_MAX_IDS + 1))
    assert big.status_code == 400
    assert big.json()["code"] == "too_many_ids"
    for _ in range(10):
        assert _claim(client, bearer("user_c"), [job.id]).status_code == 200
    r = _claim(client, bearer("user_c"), [job.id])
    assert r.status_code == 429
    assert r.json()["code"] == "too_many_requests"
    assert r.headers["Retry-After"] == "60"
    # Per user: someone else still gets through (and finds it taken).
    other = _claim(client, bearer("user_d"), [job.id])
    assert other.status_code == 200
    assert other.json()["owned_elsewhere"] == [job.id]


def test_claim_needs_a_user_and_a_body(client, auth_on, bearer):
    assert client.post("/me/claim", json={"job_ids": []}).status_code == 401
    bad = client.post("/me/claim", headers=bearer("user_e"),
                      json={"job_ids": "abc"})
    assert bad.status_code == 400
    assert bad.json()["code"] == "invalid_payload"


def test_claim_is_404_with_accounts_off(client):
    job = _job(owner=None)
    r = client.post("/me/claim", json={"job_ids": [job.id]})
    assert r.status_code == 404
    assert store.get(job.id).owner_id is None


# ── GET /jobs?fields=summary ─────────────────────────────────────────


def test_summary_list_is_slim_with_an_etag(client, auth_on, bearer):
    job = _job(owner="user_a", filename="talk.mp4", duration=61.5,
               title="My talk", social_caption="x" * 50)
    r = client.get("/jobs?fields=summary", headers=bearer("user_a"))
    assert r.status_code == 200
    row = r.json()[0]
    assert set(row) == set(M._SUMMARY_FIELDS)
    assert row["id"] == job.id
    assert row["title"] == "My talk"
    assert row["duration"] == 61.5
    assert row["expires_at"] > time.time()
    etag = r.headers["ETag"]
    same = client.get("/jobs?fields=summary",
                      headers={**bearer("user_a"), "If-None-Match": etag})
    assert same.status_code == 304
    assert same.content == b""
    store.update(job.id, progress=50.0)
    changed = client.get("/jobs?fields=summary",
                         headers={**bearer("user_a"), "If-None-Match": etag})
    assert changed.status_code == 200
    # The full list is unchanged.
    full = client.get("/jobs", headers=bearer("user_a")).json()[0]
    assert "outputs" in full and "hook_clips" in full


# ── PATCH /jobs/{id} {title} ─────────────────────────────────────────


def test_rename_any_status(client):
    job = _job(status="done", filename="clip.mp4")
    r = client.patch(f"/jobs/{job.id}", json={"title": "  Folge\n 12 \u0007 "})
    assert r.status_code == 200
    assert r.json()["title"] == "Folge 12"
    assert store.get(job.id).title == "Folge 12"
    long = client.patch(f"/jobs/{job.id}", json={"title": "a" * 500})
    assert long.json()["title"] == "a" * 120
    reset = client.patch(f"/jobs/{job.id}", json={"title": ""})
    assert reset.json()["title"] is None
    bad = client.patch(f"/jobs/{job.id}", json={"title": 5})
    assert bad.status_code == 400
    assert bad.json()["code"] == "invalid_title"
    unknown = client.patch(f"/jobs/{job.id}", json={"name": "x"})
    assert unknown.status_code == 400
    assert client.patch(f"/jobs/{job.id}", json={}).status_code == 400


def test_title_keeps_joiners_and_spaces_line_breaks(client):
    job = _job(status="done")
    # ZWJ emoji sequence, a ZWNJ word (Persian), tabs and line breaks.
    family = "\U0001F468\u200d\U0001F469\u200d\U0001F467"
    heart = "\u2764\ufe0f"
    zwnj = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"
    r = client.patch(f"/jobs/{job.id}",
                     json={"title": f"{family}\tVlog\nTeil\r\n2 {heart} {zwnj}\u200b"})
    assert r.status_code == 200
    assert r.json()["title"] == f"{family} Vlog Teil 2 {heart} {zwnj}"


def test_rename_keeps_updated_at_only_while_running(client):
    # Running (what the orphan sweep checks): housekeeping, clock stays.
    for status in M.RUNNING_STATUSES:
        job = _job(status=status)
        store.update(job.id, updated_at=1000.0)
        assert client.patch(f"/jobs/{job.id}", json={"title": "x"}).status_code == 200
        got = store.get(job.id)
        assert (got.title, got.updated_at) == ("x", 1000.0), status
    # Anything else (review, done, ...) expires: a rename is activity.
    for status in ("awaiting_review", "done", "error"):
        job = _job(status=status)
        store.update(job.id, updated_at=1000.0)
        assert client.patch(f"/jobs/{job.id}", json={"title": "y"}).status_code == 200
        assert store.get(job.id).updated_at > 1000.0, status


def test_rename_is_owner_only(client, auth_on, bearer):
    job = _job(owner="user_a")
    r = client.patch(f"/jobs/{job.id}", headers=bearer("user_b"),
                     json={"title": "mine now"})
    assert r.status_code == 404
    assert store.get(job.id).title is None


# ── status rows, thumbnail ───────────────────────────────────────────


def test_status_rows_carry_the_tile_fields(client):
    job = _job(filename="a.mp4", duration=12.0, title="T")
    body = client.get(f"/jobs/status?ids={job.id}").json()
    row = body["jobs"][0]
    assert row["title"] == "T"
    assert row["duration"] == 12.0
    assert row["created_at"] == store.get(job.id).created_at
    assert row["expires_at"] == store.get(job.id).expires_at()


def test_thumbnail_without_one_has_an_empty_body(client):
    r = client.get("/jobs/000000000000/thumbnail")
    assert r.status_code == 404
    assert r.content == b""
    job = _job(status="processing")
    r = client.get(f"/jobs/{job.id}/thumbnail")
    assert r.status_code == 409
    assert r.content == b""
