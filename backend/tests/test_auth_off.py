"""With CLERK_ISSUER unset everything must work exactly as before
accounts existed: anonymous, the job id is the key, no accounts DB."""
from __future__ import annotations

from pathlib import Path

import pytest

import backend.main as M
from backend import accounts
from backend.jobs import DEFAULT_PLAN, store


@pytest.fixture
def no_accounts_db():
    accounts._reset_for_tests()
    yield
    assert accounts._conn is None, "auth off must not touch the accounts DB"


def test_legacy_create_signature_still_works():
    # scratchpad/bt/serve.py and older callers pass (input_path, settings).
    job = store.create("/x.mp4", {"caption_preset": "clipper"})
    got = store.get(job.id)
    assert got.owner_id is None and got.plan == DEFAULT_PLAN
    assert got.created_at > 0 and got.settings == {"caption_preset": "clipper"}


@pytest.mark.sqlite_only
def test_old_rows_load():
    # A row written before the new Job fields existed.
    import json
    with store._lock:
        store._conn.execute(
            "INSERT INTO jobs (id, data) VALUES (?, ?)",
            ("oldjob", json.dumps({"id": "oldjob", "status": "done",
                                   "settings": "{}", "updated_at": 5.0})))
        store._conn.commit()
    job = store.get("oldjob")
    assert job.owner_id is None and job.filename is None
    assert job.created_at == 0.0
    assert job.to_dict()["created_at"] is None


def test_anonymous_flow(client, no_accounts_db, clean_state):
    r = client.post("/jobs", data={
        "settings": '{"style": "tight", "_cost_test": true, '
                    '"_r2_storage_key": "uploads/someone-elses.mp4"}',
        "filename": "Clip.MOV", "preset_id": "p1", "preset_label": "Vlog"},
        files={"file": ("Clip.MOV", b"data", "video/quicktime")})
    assert r.status_code == 200, r.text
    body = r.json()
    job_id = body["job_id"]
    assert clean_state == [job_id]
    assert body["status"] == "pending" and body["filename"] == "Clip.MOV"
    job = store.get(job_id)
    assert job.owner_id is None and job.plan == DEFAULT_PLAN
    if M.media.is_r2():
        # The body went to the media store; nothing stays on this box.
        assert job.input_path is None
        assert job.source_key == f"jobs/{job_id}/source.mov"
        assert M.media.size(job.source_key) == 4
    else:
        assert job.input_path.endswith(".MOV")
    # _cost_test kept (cost_test.py runs without auth), forged key gone.
    assert job.settings == {"style": "tight", "_cost_test": True}
    assert (job.preset_id, job.preset_label) == ("p1", "Vlog")

    assert client.get(f"/jobs/{job_id}").status_code == 200
    assert client.get(f"/jobs/{job_id}/subtitles").status_code == 409
    assert client.get(f"/jobs/{job_id}/preview-video").status_code == 409
    assert client.get(f"/jobs/{job_id}/watch").status_code == 409
    assert client.get(f"/jobs/{job_id}/thumbnail").status_code == 409
    assert client.delete(f"/jobs/{job_id}").status_code == 409  # pending
    store.update(job_id, status="done")
    assert client.delete(f"/jobs/{job_id}").status_code == 200
    assert client.get(f"/jobs/{job_id}").status_code == 404


def test_media_without_token(client, no_accounts_db):
    out = Path(M._WORK_ROOT) / "anon"
    out.mkdir(parents=True, exist_ok=True)
    (out / "cleo_output.mp4").write_bytes(b"mp4")
    (out / "cleo_thumbnail.jpg").write_bytes(b"jpg")
    job = store.create("/x.mp4", {})
    store.update(job.id, status="done", output_path=str(out / "cleo_output.mp4"),
                 outputs={"primary": str(out / "cleo_output.mp4")})
    r = client.get(f"/jobs/{job.id}/thumbnail")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=86400"
    assert client.get(f"/jobs/{job.id}/watch").status_code == 200
    assert client.get(f"/jobs/{job.id}/download").status_code == 200


def test_new_routes_when_off(client, no_accounts_db):
    assert client.get("/me").json() == {"auth_enabled": False}
    r = client.get("/jobs")
    assert r.status_code == 404 and r.json() == {"detail": "not_available"}
    assert client.post("/billing/checkout",
                       json={"plan": "pro"}).status_code == 404
    assert client.get("/billing/portal").status_code == 404
    assert client.post("/billing/webhook", content=b"{}").status_code == 404
    assert client.get("/health").json() == {"status": "ok"}


def test_invalid_settings(client, no_accounts_db):
    for bad in ("not json", "[1, 2]"):
        r = client.post("/jobs", data={"settings": bad},
                        files={"file": ("a.mp4", b"x", "video/mp4")})
        assert r.status_code == 400


def test_storage_key_outside_uploads_is_refused(client, no_accounts_db):
    r = client.post("/jobs", data={"settings": "{}",
                                   "storage_key": "secrets/backup.tar"})
    assert r.status_code == 403


def test_presign_still_503_without_r2(client, no_accounts_db, no_r2):
    assert client.post("/uploads/presign", json={}).status_code == 503


def test_analysis_hooks_are_noops(no_accounts_db, monkeypatch):
    job = store.create("/nonexistent.mp4", {})
    monkeypatch.setattr(M, "analyze_only", lambda **kw: (_ for _ in ()).throw(
        OSError("No space left on device")))
    M._run_analyze_inner(job.id)
    assert store.get(job.id).message == "server_storage_full"
    M._refund_interrupted()
