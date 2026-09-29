"""WP3-prep: this release is the rollback target of WP3 (media in R2).

It must (on SQLite and on Postgres — every test here runs on both, each
on a store of its own):
- round-trip the WP3 Job fields (media keys, render_gen, output_keys in
  their order, media_bytes, media_store);
- keep keys of a stored row it doesn't know (a later release's fields)
  on every write — update, update_if, modify, claim, the boot sweep;
- treat a job with media keys as intact although its local files are
  missing (boot sweep, orphaned-job sweep).

The prep release also answered 409 media_unavailable for keyed jobs and
kept them out of its sweeps; this release serves and deletes their
media itself (tests in test_wp3_*.py), so those prep-only tests are not
here any more.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

import backend.main as M
from backend import jobs

KEYS = dict(
    source_key="uploads/u/0123456789abcdef0123456789abcdef.mp4",
    mezz_key="jobs/{id}/mezz.mp4",
    proxy_key="jobs/{id}/proxy.mp4",
    preview_key="jobs/{id}/preview/v2.mp4",
    render_gen=3,
    # Not sorted: "primary" first is the order of the download buttons.
    output_keys={"primary": "jobs/{id}/r3/out.mp4",
                 "9:16": "jobs/{id}/r3/out_9x16.mp4",
                 "1:1": "jobs/{id}/r3/out.mp4",
                 "hook_1": "jobs/{id}/r3/hook_1.mp4"},
    thumb_key="jobs/{id}/r3/thumb.jpg",
    media_bytes={"jobs/{id}/mezz.mp4": 123456789,
                 "jobs/{id}/proxy.mp4": 2345},
    media_store="r2",
)

# What a later release may have stored that this code doesn't know.
EXTRAS = {
    "future_scalar": 7,
    "future_text": "x",
    "future_obj": {"a": 1, "b": [1, 2]},
    # A structured field stored as nested JSON text (key order kept).
    "future_nested": json.dumps({"zeta": 1, "alpha": 2}),
    "future_none": None,
}


def _keys(job_id: str) -> dict:
    def fill(v):
        if isinstance(v, str):
            return v.replace("{id}", job_id)
        if isinstance(v, dict):
            return {fill(k): fill(x) for k, x in v.items()}
        return v
    return {k: fill(v) for k, v in KEYS.items()}


# ── one store per backend ────────────────────────────────────────────


class _Sqlite:
    name = "sqlite"

    def __init__(self, st):
        self.st = st

    def raw(self, job_id):
        with self.st._lock:
            row = self.st._conn.execute(
                "SELECT data FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return json.loads(row["data"])

    def merge_raw(self, job_id, extra):
        d = self.raw(job_id)
        d.update(extra)
        with self.st._lock:
            self.st._conn.execute("UPDATE jobs SET data = ? WHERE id = ?",
                                  (json.dumps(d), job_id))
            self.st._conn.commit()



class _Pg:
    name = "postgres"

    def __init__(self, st, database):
        self.st = st
        self.db = database

    def raw(self, job_id):
        with self.db.connection() as conn:
            text = conn.execute("SELECT data FROM jobs WHERE id = %s",
                                (job_id,)).fetchone()[0]
        return text if isinstance(text, dict) else json.loads(text)

    def merge_raw(self, job_id, extra):
        with self.db.connection() as conn:
            conn.execute("UPDATE jobs SET data = data || %s::jsonb "
                         "WHERE id = %s", (json.dumps(extra), job_id))



@pytest.fixture(params=["sqlite", "postgres"])
def bk(request, monkeypatch, tmp_path):
    """A fresh job store of each kind, installed as backend.jobs.store
    (so backend.main uses it too)."""
    if request.param == "sqlite":
        monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "jobs.db"))
        b = _Sqlite(jobs.JobStore())
        yield_close = None
    else:
        from conftest import pg_server_or_skip
        pg = pytest.importorskip("backend.pg")
        database = pg.Database(pg_server_or_skip().fresh(), max_size=4)
        database.apply_schema()
        b = _Pg(pg.PgJobStore(database), database)
        yield_close = database.close
    monkeypatch.setattr(jobs, "_store_impl", b.st)
    yield b
    if yield_close:
        yield_close()


def _keyed(b, status="awaiting_review", **fields):
    """A WP3 job: media keys, no local files, a later release's extra
    keys in its row."""
    job = b.st.create(None, {"caption_preset": "clipper"})
    b.st.update(job.id, status=status, segments=[(0.0, 5.0)],
                **_keys(job.id), **fields)
    b.merge_raw(job.id, EXTRAS)
    return b.st.get(job.id)


def _assert_extras_kept(b, job_id):
    raw = b.raw(job_id)
    for k, v in EXTRAS.items():
        assert k in raw, k
        assert raw[k] == v, (k, raw[k])


# ── fields ───────────────────────────────────────────────────────────


def test_defaults():
    job = jobs.Job(id="abc")
    assert (job.source_key, job.mezz_key, job.proxy_key, job.preview_key,
            job.thumb_key, job.media_store) == (None,) * 6
    assert job.render_gen == 0
    assert job.output_keys == {} and job.media_bytes == {}
    assert not job.has_media_keys() and not job.has_mezz()
    assert "_extras" not in job.to_dict()


def test_new_fields_round_trip(bk):
    b = bk
    job = b.st.create("/in.mp4", {})
    keys = _keys(job.id)
    b.st.update(job.id, **keys)
    got = b.st.get(job.id)
    for k, v in keys.items():
        assert getattr(got, k) == v, k
    assert list(got.output_keys) == ["primary", "9:16", "1:1", "hook_1"]
    assert got._extras == {}
    # Another write keeps them (and the order).
    b.st.update(job.id, message="x")
    again = b.st.get(job.id)
    assert list(again.output_keys) == list(keys["output_keys"])
    assert again.media_bytes == keys["media_bytes"]
    if b.name == "postgres":
        # output_keys is nested JSON text inside jsonb (jsonb would sort
        # the keys), like the WP3 release stores it.
        assert isinstance(b.raw(job.id)["output_keys"], str)


def test_old_rows_get_defaults(bk):
    """A row written before this release (no new keys) loads with the
    defaults and gains them on the next write."""
    b = bk
    job = b.st.create("/in.mp4", {})
    raw = b.raw(job.id)
    for k in KEYS:
        raw.pop(k, None)
    raw.pop("_extras", None)
    if b.name == "sqlite":
        with b.st._lock:
            b.st._conn.execute("UPDATE jobs SET data = ? WHERE id = ?",
                               (json.dumps(raw), job.id))
            b.st._conn.commit()
    else:
        with b.db.connection() as conn:
            conn.execute("UPDATE jobs SET data = %s::jsonb WHERE id = %s",
                         (json.dumps(raw), job.id))
    got = b.st.get(job.id)
    assert got.mezz_key is None and got.output_keys == {}
    assert got.render_gen == 0 and got._extras == {}
    b.st.update(job.id, message="y")
    assert b.raw(job.id)["render_gen"] == 0


# ── unknown keys pass through ────────────────────────────────────────


def test_unknown_keys_survive_every_write(bk):
    b = bk
    job = _keyed(b)
    assert job._extras == EXTRAS
    # Never exposed.
    assert not set(EXTRAS) & set(job.to_dict())
    assert "_extras" not in b.raw(job.id)

    b.st.update(job.id, message="a")
    _assert_extras_kept(b, job.id)
    assert b.st.update_if(job.id, "awaiting_review", progress=50.0)
    _assert_extras_kept(b, job.id)
    b.st.modify(job.id, lambda j: {"preview_version": j.preview_version + 1})
    _assert_extras_kept(b, job.id)
    assert b.st.claim(job.id, "user_z") == "user_z"
    _assert_extras_kept(b, job.id)
    got = b.st.get(job.id)
    assert got.owner_id == "user_z" and got.preview_version == 1
    for k, v in _keys(job.id).items():
        assert getattr(got, k) == v, k
    # The nested JSON text is kept byte for byte (its key order).
    assert b.raw(job.id)["future_nested"] == '{"zeta": 1, "alpha": 2}'
    # "_extras" in a stored row is never taken for a field.
    b.merge_raw(job.id, {"_extras": {"x": 1}})
    assert b.st.get(job.id)._extras == EXTRAS
    b.st.update(job.id, message="b")
    assert "_extras" not in b.raw(job.id)
    _assert_extras_kept(b, job.id)


def test_unknown_keys_survive_the_boot_sweep(bk):
    b = bk
    running = _keyed(b, status="processing", message="Rendering…")
    review = _keyed(b)
    b.st.mark_stuck_as_error()
    for job in (running, review):
        _assert_extras_kept(b, job.id)
        cur = b.st.get(job.id)
        assert cur.mezz_key == _keys(job.id)["mezz_key"]
        assert list(cur.output_keys) == list(KEYS["output_keys"])


def test_extras_through_the_cutover_serializers():
    """SQLite blob → Job → Postgres text (pg_cutover's path) keeps the
    unknown keys."""
    pg = pytest.importorskip("backend.pg")
    blob = {"id": "abcdefabcdef", "status": "done", **EXTRAS,
            "output_keys": {"primary": "k1", "9:16": "k2"}}
    job = jobs.job_from_dict(blob)
    back = pg.load_job(pg.dump_job(job))
    assert back._extras == EXTRAS
    assert list(back.output_keys) == ["primary", "9:16"]
    stored = json.loads(pg.dump_job(back))
    for k, v in EXTRAS.items():
        assert stored[k] == v


# ── sweeps keep keyed jobs ───────────────────────────────────────────


def test_boot_sweep_keeps_keyed_jobs(bk, tmp_path):
    b = bk
    review = _keyed(b)                                   # mezz + outputs
    only_outputs = b.st.create(None, {})
    b.st.update(only_outputs.id, status="awaiting_review",
                output_keys={"primary": f"jobs/{only_outputs.id}/r1/o.mp4"})
    only_hook = b.st.create(None, {})
    b.st.update(only_hook.id, status="awaiting_review", hook_clips=[
        {"object_key": f"jobs/{only_hook.id}/r1/hook_1.mp4", "score": 1}])
    rendering = _keyed(b, status="processing", message="Rendering…")
    analysing = b.st.create(None, {})
    b.st.update(analysing.id, status="processing",
                source_key="uploads/u/x.mp4")
    legacy_gone = b.st.create(None, {})
    b.st.update(legacy_gone.id, status="awaiting_review",
                normalized_path=str(tmp_path / "gone.mp4"))

    assert b.st.mark_stuck_as_error() == 3
    for job in (review, only_outputs, only_hook):
        cur = b.st.get(job.id)
        assert (cur.status, cur.error) == ("awaiting_review", None), job.id
    cur = b.st.get(rendering.id)
    assert (cur.status, cur.message, cur.error) == (
        "awaiting_review", "render_failed", "container_restart")
    cur = b.st.get(analysing.id)
    assert (cur.status, cur.error) == ("error", "container_restart")
    assert b.st.get(legacy_gone.id).error == "files_expired"
    assert b.st.mark_stuck_as_error() == 0


def test_orphan_sweep_uses_mezz_key(bk, monkeypatch):
    b = bk
    render = _keyed(b, status="processing", message="Rendering…")
    analysis = b.st.create(None, {})
    b.st.update(analysis.id, status="processing",
                source_key="uploads/u/a.mp4")
    work = M._WORK_ROOT / analysis.id
    work.mkdir(parents=True, exist_ok=True)
    later = time.time() + M._ORPHAN_STALE_S + 60
    assert M._sweep_orphaned_jobs(now=later) == 2
    cur = b.st.get(render.id)
    assert (cur.status, cur.message) == ("awaiting_review", "render_failed")
    cur = b.st.get(analysis.id)
    assert (cur.status, cur.error) == ("error", "container_restart")
    # This release frees an interrupted analysis's work folder and
    # queues its media for GC (the prep release left both alone).
    assert not work.exists()
    _assert_extras_kept(b, render.id)


# ── routes ───────────────────────────────────────────────────────────


def test_routes_unchanged_for_legacy_jobs(bk, client, tmp_path):
    b = bk
    out = tmp_path / "out.mp4"
    out.write_bytes(b"\x00" * 16)
    job = b.st.create(None, {})
    b.st.update(job.id, status="done", output_path=str(out),
                outputs={"primary": str(out)})
    assert client.get(f"/jobs/{job.id}/watch").status_code == 200
    gone = b.st.create(None, {})
    b.st.update(gone.id, status="done",
                output_path=str(tmp_path / "missing.mp4"))
    r = client.get(f"/jobs/{gone.id}/watch")
    assert (r.status_code, r.json()["detail"]) == (
        409, "requested format not ready")
    assert client.delete(f"/jobs/{gone.id}").status_code == 200
    assert b.st.get(gone.id) is None
    assert Path(out).exists()
