"""Postgres job store + accounts adapter (backend/pg.py), on databases of
their own — these run in both suite modes (CLEO_TEST_DB unset or
postgres) and are skipped without pgserver.

Covers: round trips (Job JSON incl. NaN / NUL, timestamps float ↔
timestamptz), hot columns, the indexed queries, and cross-process
safety: concurrent update() on one job from separate connections and
from separate processes, concurrent quota charges (threads and
processes), idempotent create.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.main as M
from backend import accounts, jobs
from conftest import REPO

pg = pytest.importorskip("backend.pg")


@pytest.fixture
def pgdb(pg_server):
    """A fresh, migrated database: (url, pg.Database)."""
    url = pg_server.fresh()
    database = pg.Database(url, max_size=8)
    database.apply_schema()
    yield url, database
    database.close()


@pytest.fixture
def pg_side(pgdb, monkeypatch):
    """backend.jobs.store and the accounts DB on a fresh Postgres database
    for this test (whatever CLEO_TEST_DB says)."""
    url, database = pgdb
    monkeypatch.setattr(jobs, "_store_impl", pg.PgJobStore(database))
    monkeypatch.setattr(accounts, "_conn", pg.AccountsDB(database))
    return url, database


def _sql(database, query, args=()):
    with database.connection() as conn:
        return conn.execute(query, args).fetchall()


# ── round trips ──────────────────────────────────────────────────────


def test_job_round_trip_and_hot_columns(pgdb):
    _, database = pgdb
    st = pg.PgJobStore(database)
    job = st.create("/in.mp4", {"caption_preset": "clipper", "n": [1, 2]},
                    idempotency_key="uploads/u/a.mp4", owner_id="user_a",
                    plan="pro", filename="clip\x00.mp4")
    st.update(job.id, status="awaiting_review", segments=[(0.0, 1.5)],
              audio_levels={"peak": float("-inf"), "mean": float("nan"),
                            "ok": -3.25},
              subtitles=[{"text": "hé ☃ \U0001F600", "start": 0.1}],
              duration=12.345678901234)
    got = st.get(job.id)
    assert got.segments == [(0.0, 1.5)]
    assert got.audio_levels["peak"] == float("-inf")
    assert math.isnan(got.audio_levels["mean"])
    assert got.audio_levels["ok"] == -3.25
    assert got.subtitles[0]["text"] == "hé ☃ \U0001F600"
    assert got.duration == 12.345678901234
    assert got.filename == "clip.mp4"            # NUL dropped (jsonb)
    assert got.settings == {"caption_preset": "clipper", "n": [1, 2]}
    assert got.created_at == job.created_at      # exact float, from JSON
    assert got.updated_at > job.updated_at
    row = _sql(database, "SELECT owner_id, status, plan, "
               "extract(epoch FROM created_at)::float8, idempotency_key, "
               "data->>'status' FROM jobs")[0]
    assert row[:3] == ("user_a", "awaiting_review", "pro")
    assert abs(row[3] - job.created_at) < 1e-6
    assert row[4] == "uploads/u/a.mp4" and row[5] == "awaiting_review"
    # Structured fields are nested JSON strings, as in the SQLite blob
    # (jsonb would reorder their keys).
    assert _sql(database, "SELECT jsonb_typeof(data->'settings') "
                "FROM jobs")[0][0] == "string"
    assert st.find_by_key("uploads/u/a.mp4").id == job.id
    assert st.status_many([job.id, "nope"])[job.id]["status"] == \
        "awaiting_review"


def test_legacy_blob_shape_loads(pgdb):
    """data written like the SQLite blob (nested JSON strings, fields
    missing) still loads — what the cutover copies from old rows."""
    _, database = pgdb
    with database.connection() as conn:
        conn.execute(
            "INSERT INTO jobs (id, status, data) VALUES (%s, %s, %s)",
            ("oldjob", "done", '{"id": "oldjob", "status": "done", '
             '"settings": "{\\"a\\": 1}", "segments": "[[0, 2]]", '
             '"updated_at": 5.0}'))
    job = pg.PgJobStore(database).get("oldjob")
    assert job.settings == {"a": 1} and job.segments == [(0, 2)]
    assert job.owner_id is None and job.created_at == 0.0


def test_accounts_timestamps_round_trip(pg_side):
    now = 1_790_000_000.123456
    user = accounts.ensure_user("user_a", "a@example.com")
    assert isinstance(user["created_at"], float)
    sub = {"id": "s1", "user_id": "user_a", "variant_id": "1", "plan": "pro",
           "status": "active", "test_mode": 0, "customer_id": 42,
           "renews_at": accounts.parse_ts("2026-10-01T10:00:00.250000Z"),
           "ends_at": None, "portal_url": None, "update_payment_url": None,
           "raw_json": '{"x": 1}', "created_at": now - 86400,
           "ls_updated_at": now - 86400}
    assert accounts.upsert_subscription(sub)
    accounts.set_period_start("s1", now - 3600)
    got = accounts.get_subscription("s1")
    assert got["renews_at"] == accounts.parse_ts("2026-10-01T10:00:00.25Z")
    assert got["ends_at"] is None
    assert got["period_start"] == pytest.approx(now - 3600, abs=1e-6)
    assert got["created_at"] == pytest.approx(now - 86400, abs=1e-6)
    assert got["test_mode"] is False and got["customer_id"] == "42"
    # An older event can't roll it back; period start never moves back.
    assert not accounts.upsert_subscription({**sub, "status": "expired",
                                             "ls_updated_at": now - 90000})
    accounts.set_period_start("s1", now - 7200)
    assert accounts.get_subscription("s1")["period_start"] == \
        pytest.approx(now - 3600, abs=1e-6)
    accounts.charge("j1", "user_a", 59.2, enforce=False, now=now)
    usage = accounts.get_usage("j1")
    assert usage["seconds_billed"] == 60.0
    assert usage["created_at"] == pytest.approx(now, abs=1e-6)
    assert usage["refunded"] is False
    assert accounts.used_seconds("user_a", now - 1) == 60.0
    assert accounts.used_seconds("user_a", now + 1) == 0.0
    assert accounts.refund("j1", "test") and not accounts.refund("j1")
    assert accounts.used_seconds("user_a", now - 1) == 0.0
    assert accounts.apply_event("evt-1", lambda conn: None)
    assert not accounts.apply_event("evt-1", lambda conn: None)
    assert accounts.event_seen("evt-1")
    accounts.note_checkout("user_a", now=now)
    assert accounts.last_checkout_at("user_a") == now
    secret = accounts.media_secret()
    assert accounts.media_secret() == secret and len(secret) == 64
    assert accounts.users_by_email("A@EXAMPLE.com")[0]["id"] == "user_a"


def test_pool_session_settings(pgdb):
    """The Postgres counterpart of test_both_connections_use_wal: every
    pooled connection has the statement timeout, UTC, no server-side
    prepared statements (pooler-safe) and explicit transactions."""
    _, database = pgdb
    assert database.pool.min_size == 1
    with database.connection() as conn:
        assert conn.execute("SHOW statement_timeout").fetchone()[0] == "15s"
        assert conn.execute("SHOW TimeZone").fetchone()[0] == "UTC"
        assert conn.prepare_threshold is None and not conn.autocommit
    assert pg.pool_max() == 10


def test_portable_sql():
    assert pg.portable_sql("SELECT * FROM t WHERE a = ? AND b LIKE 'x%?'"
                           " AND c = ?") == \
        "SELECT * FROM t WHERE a = %s AND b LIKE 'x%%?' AND c = %s"


# ── queries ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("backend", ["sqlite", "postgres"])
def test_list_by_owner_keyset_and_scans(backend, pgdb, tmp_path,
                                        monkeypatch):
    if backend == "sqlite":
        monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "side.db"))
        st = jobs.JobStore()
    else:
        st = pg.PgJobStore(pgdb[1])
    base = 1_790_000_000.0
    ids = []
    for i in range(7):
        job = st.create(f"/in{i}.mp4", {}, owner_id="user_a")
        st.update(job.id, created_at=base + (i // 2), updated_at=base,
                  subtitles=[{"text": "x" * 50}], status="done")
        ids.append(job.id)
    legacy = st.create(None, {}, owner_id="user_a")
    st.update(legacy.id, created_at=0.0, updated_at=0.0, status="done")
    other = st.create(None, {}, owner_id="user_b")
    st.update(other.id, status="done")
    expected = [j.id for j in sorted(
        (st.get(i) for i in ids), key=lambda j: (j.created_at, j.id),
        reverse=True)] + [legacy.id]
    pages, before = [], None
    while True:
        page = st.list_by_owner("user_a", limit=3, before=before,
                                summary=True)
        if not page:
            break
        pages.append([j.id for j in page])
        before = (page[-1].created_at, page[-1].id)
    assert sum(pages, []) == expected
    assert [len(p) for p in pages] == [3, 3, 2]
    full = st.list_by_owner("user_a")
    assert sorted(j.id for j in full) == sorted(expected)
    if backend == "postgres":
        # summary rows skip the editor's big fields
        assert st.list_by_owner("user_a", limit=1,
                                summary=True)[0].subtitles == []
    # retention candidates: not running, idle before the cutoff or legacy
    st.update(ids[0], status="processing")
    cand = {j.id for j in st.retention_candidates(base + 1)}
    assert legacy.id in cand and ids[0] not in cand
    assert set(ids[1:]) <= cand
    assert {j.id for j in st.retention_candidates(None)} >= {legacy.id}
    assert not ({j.id for j in st.retention_candidates(None)} & set(ids))
    st.update(ids[1], status="error", error="container_restart")
    st.update(ids[2], status="error", error="other")
    assert [j.id for j in st.list_by_status("error",
                                            error="container_restart")] \
        == [ids[1]]
    assert {j.id for j in st.list_by_status("processing", "error")} == \
        set(ids[:3])
    assert "/in3.mp4" in st.input_paths() and None not in st.input_paths()


@pytest.mark.parametrize("backend", ["sqlite", "postgres"])
def test_create_with_used_key_raises_duplicate(backend, pgdb, tmp_path,
                                               monkeypatch):
    if backend == "sqlite":
        monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "side.db"))
        st = jobs.JobStore()
    else:
        st = pg.PgJobStore(pgdb[1])
    first = st.create("/a.mp4", {}, idempotency_key="uploads/k.mp4")
    with pytest.raises(jobs.DuplicateKey) as e:
        st.create("/b.mp4", {}, idempotency_key="uploads/k.mp4")
    assert e.value.job_id == first.id
    assert len(st.list_all()) == 1
    st.delete(first.id)             # deleting the job frees the key
    again = st.create("/c.mp4", {}, idempotency_key="uploads/k.mp4")
    assert st.find_by_key("uploads/k.mp4").id == again.id


def test_mark_stuck_and_claim(pgdb, tmp_path):
    st = pg.PgJobStore(pgdb[1])
    src = tmp_path / "normalized.mp4"
    src.write_bytes(b"n")
    a = st.create("/a.mp4", {})
    st.update(a.id, status="processing")
    b = st.create("/b.mp4", {})
    st.update(b.id, status="processing", normalized_path=str(src),
              segments=[(0.0, 1.0)])
    c = st.create("/c.mp4", {})
    st.update(c.id, status="awaiting_review",
              normalized_path=str(tmp_path / "gone.mp4"))
    d = st.create("/d.mp4", {})
    st.update(d.id, status="awaiting_review", normalized_path=str(src))
    assert st.mark_stuck_as_error() == 3
    assert (st.get(a.id).status, st.get(a.id).error) == \
        ("error", "container_restart")
    assert st.get(b.id).message == "render_failed"
    assert st.get(c.id).error == "files_expired"
    assert st.get(d.id).status == "awaiting_review"
    assert st.mark_stuck_as_error() == 0
    before = st.get(a.id).updated_at
    results = []
    threads = [threading.Thread(target=lambda u=u: results.append(
        st.claim(a.id, u))) for u in ("user_x", "user_y", "user_z")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(results)) == 1          # one winner, seen by all
    assert st.get(a.id).owner_id == results[0]
    assert st.get(a.id).updated_at == before
    assert st.claim("missing", "user_x") is None


# ── cross-process safety ─────────────────────────────────────────────


def test_concurrent_updates_on_separate_connections_lose_nothing(pgdb):
    """Two threads, each with its own pooled connection, write different
    fields of one job 150 times: the row lock of update() keeps both."""
    _, database = pgdb
    st = pg.PgJobStore(database)
    job = st.create("/in.mp4", {})
    n = 150

    def worker(field):
        for i in range(1, n + 1):
            st.update(job.id, **{field: i})
    threads = [threading.Thread(target=worker, args=(f,))
               for f in ("preview_version", "queue_position")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    got = st.get(job.id)
    assert (got.preview_version, got.queue_position) == (n, n)


def test_update_if_is_compare_and_set_across_connections(pgdb):
    _, database = pgdb
    st = pg.PgJobStore(database)
    job = st.create("/in.mp4", {})
    st.update(job.id, status="awaiting_review")
    barrier = threading.Barrier(6)
    wins = []

    def render():
        barrier.wait()
        if st.update_if(job.id, "awaiting_review", status="processing"):
            wins.append(1)
    threads = [threading.Thread(target=render) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(wins) == 1


def _run_procs(scripts: list[str], env: dict[str, str],
               timeout: float = 120) -> list[str]:
    full = {**os.environ, **env, "PYTHONPATH": str(REPO)}
    procs = [subprocess.Popen([sys.executable, "-c", s], env=full,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, cwd=str(REPO)) for s in scripts]
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=timeout)
        assert p.returncode == 0, err[-3000:]
        outs.append(out)
    return outs


def _proc_env(url: str, tmp_path: Path) -> dict[str, str]:
    return {"DATABASE_URL": url, "CLEO_JOB_DB": str(tmp_path / "none.db"),
            "CLEO_DB_BACKEND": ""}


def test_two_processes_updating_one_job_lose_nothing(pgdb, tmp_path):
    """The audit's lost-update repro (2 processes × different fields of
    one job): with Postgres both end at n."""
    url, database = pgdb
    job = pg.PgJobStore(database).create("/in.mp4", {})
    n = 200
    script = textwrap.dedent("""
        import sys
        from backend.jobs import store
        job_id, field, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
        for i in range(1, n + 1):
            store.update(job_id, **{field: i})
    """)
    env = _proc_env(url, tmp_path)
    full = {**os.environ, **env, "PYTHONPATH": str(REPO)}
    procs = [subprocess.Popen([sys.executable, "-c", script, job.id, field,
                               str(n)], env=full, cwd=str(REPO),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True)
             for field in ("preview_version", "queue_position")]
    for p in procs:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err[-3000:]
        assert "backend: postgres" in out
    got = pg.PgJobStore(database).get(job.id)
    assert (got.preview_version, got.queue_position) == (n, n)


def test_concurrent_charges_never_exceed_quota(pg_side, monkeypatch):
    """Threads on separate connections: the advisory lock (not a process
    lock — there is none on Postgres) makes check + insert atomic."""
    monkeypatch.setenv("CLEO_COMP_USERS", "user_q")
    monkeypatch.setitem(accounts.PLAN_MINUTES, "studio", 10)  # 600 s
    barrier = threading.Barrier(8)
    ok, refused = [], []

    def worker(w):
        barrier.wait()
        for i in range(3):
            try:
                accounts.charge(f"job-{w}-{i}", "user_q", 60)
                ok.append(1)
            except accounts.QuotaExceeded:
                refused.append(1)
    threads = [threading.Thread(target=worker, args=(w,)) for w in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(ok) == 10 and len(refused) == 14
    ent = accounts.entitlement("user_q")
    start = accounts.period_for(ent)[0]
    assert accounts.used_seconds("user_q", start) == 600


def test_charges_from_several_processes_never_exceed_quota(pgdb, tmp_path):
    url, _ = pgdb
    script = textwrap.dedent("""
        import os
        from backend import accounts
        ok = 0
        for i in range(5):
            try:
                accounts.charge(f"job-{os.getpid()}-{i}", "user_q", 60)
                ok += 1
            except accounts.QuotaExceeded:
                pass
        print("OK", ok)
    """)
    env = {**_proc_env(url, tmp_path), "CLEO_COMP_USERS": "user_q",
           "CLEO_PLAN_MINUTES_STUDIO": "10"}
    outs = _run_procs([script] * 4, env)
    total = sum(int(o.split("OK ")[1].split()[0]) for o in outs)
    assert total == 10
    database = pg.Database(url, max_size=1)
    try:
        billed = _sql(database, "SELECT sum(seconds_billed), count(*) "
                      "FROM usage WHERE user_id = 'user_q'")[0]
    finally:
        database.close()
    assert billed == (600.0, 10)


# ── POST /jobs across processes ──────────────────────────────────────


@pytest.fixture
def fake_r2(monkeypatch, r2):
    """R2 (moto) with 1000-byte uploads (HEAD faked); the header probe
    of POST /jobs records its calls and waits at state["barrier"]."""
    state = {"probes": [], "deleted": [], "barrier": None}
    real_delete = M.media.delete

    def delete(key, **kw):
        state["deleted"].append(key)
        real_delete(key, **kw)

    def probe(url):
        state["probes"].append(url)
        if state["barrier"] is not None:
            state["barrier"].wait(timeout=10)
        return 60.0, None
    monkeypatch.setattr(M.media, "size", lambda key, **kw: 1000)
    monkeypatch.setattr(M.media, "delete", delete)
    monkeypatch.setattr(M, "_probe_remote", probe)
    monkeypatch.setattr(M, "_probe_duration", lambda p: 60.0)
    return state


class _NoGuard(dict):
    """_CREATING_KEYS as seen by two different processes: no in-process
    serialization of the same storage key."""

    def get(self, key, default=None):
        return None

    def __setitem__(self, key, value):
        pass

    def pop(self, key, default=None):
        return default


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_concurrent_post_jobs_same_key_make_one_job(
        backend, request, client, enforce, bearer, fake_r2, clean_state,
        monkeypatch):
    """Two POST /jobs for one upload that pass the in-process guard at
    the same time (as in two processes): one job, one analysis, one
    charge (the loser runs into the winner's claim before charging),
    both answers name the same job and the R2 object is not deleted."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from conftest import add_sub
    from backend.jobs import store
    add_sub(plan="pro", period_start=time.time() - 60)
    monkeypatch.setattr(M, "_CREATING_KEYS", _NoGuard())
    fake_r2["barrier"] = threading.Barrier(2)
    form = {"settings": "{}", "storage_key": "uploads/user_a/v.mp4"}
    answers = []

    def post():
        answers.append(client.post("/jobs", headers=bearer(), data=form))
    threads = [threading.Thread(target=post) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.status_code for r in answers] == [200, 200], \
        [r.text for r in answers]
    assert answers[0].json()["job_id"] == answers[1].json()["job_id"]
    assert len(store.list_all()) == 1
    assert len(fake_r2["probes"]) == 2
    assert fake_r2["deleted"] == []
    assert clean_state == [answers[0].json()["job_id"]]  # one analysis
    ent = accounts.entitlement("user_a")
    assert accounts.used_seconds("user_a", accounts.period_for(ent)[0]) == 60
    # Nothing is downloaded by POST /jobs any more (the worker fetches).
    assert list((M._WORK_ROOT / "uploads").glob("*")) == []


def test_ready_and_list_on_postgres(pg_side, client, auth_on, bearer,
                                   monkeypatch):
    from backend.jobs import store
    assert client.get("/ready").json() == {"status": "ready"}
    for i in range(3):
        job = store.create(f"/in{i}.mp4", {"caption_preset": "clean"},
                           owner_id="user_a", filename=f"v{i}.mp4")
        store.update(job.id, subtitles=[{"text": "x"}], status="done",
                     created_at=1_790_000_000.0 + i)
    monkeypatch.setattr(M, "_LIST_LIMIT", 2)     # read in pages of 2
    rows = client.get("/jobs", headers=bearer()).json()
    assert [r["filename"] for r in rows] == ["v2.mp4", "v1.mp4", "v0.mp4"]
    assert rows[0]["status"] == "done" and "subtitles" not in rows[0]


@pytest.mark.parametrize("pages", [3, 5])
@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_list_returns_every_project(backend, pages, request, client,
                                    auth_on, bearer, monkeypatch):
    """GET /jobs is the Library's list of every device: older finished
    projects must not drop out behind newer failed uploads (it used to
    stop at the 200 newest, any status). Read in keyset pages — also
    across the legacy jobs without created_at, and when the last page
    is exactly full."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from backend.jobs import store
    base = 1_790_000_000.0
    done = []
    for i in range(9):                      # older finished projects
        job = store.create(f"/d{i}.mp4", {}, owner_id="user_a",
                           filename=f"done{i}.mp4")
        store.update(job.id, status="done", created_at=base + (i // 2))
        done.append(job.id)
    failed = []
    for i in range(4):                      # newer failed uploads
        job = store.create(f"/e{i}.mp4", {}, owner_id="user_a")
        store.update(job.id, status="error", created_at=base + 100 + i)
        failed.append(job.id)
    legacy = []
    for i in range(2):                      # before created_at existed
        job = store.create(None, {}, owner_id="user_a")
        store.update(job.id, status="done", created_at=0.0)
        legacy.append(job.id)
    store.create(None, {}, owner_id="user_b")
    monkeypatch.setattr(M, "_LIST_LIMIT", pages)  # 15 rows: 3 × 5 exactly
    rows = client.get("/jobs", headers=bearer()).json()
    assert len(rows) == 15
    assert {r["id"] for r in rows} == set(done + failed + legacy)


def test_list_on_sqlite_scans_the_table_once(client, auth_on, bearer,
                                            monkeypatch, tmp_path):
    """On SQLite every list_by_owner call parses the whole table: GET
    /jobs asks once instead of once per page (a 5,000-job account took
    minutes on the single worker after a failed cutover / rollback)."""
    monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "list.db"))
    st = jobs.JobStore()
    monkeypatch.setattr(jobs, "_store_impl", st)
    try:
        for i in range(5):
            job = st.create(None, {}, owner_id="user_a",
                            filename=f"v{i}.mp4")
            st.update(job.id, created_at=1_790_000_000.0 + i)
        st.create(None, {}, owner_id="user_b")
        scans = []
        real = st.list_all

        def list_all():
            scans.append(1)
            return real()
        monkeypatch.setattr(st, "list_all", list_all)
        monkeypatch.setattr(M, "_LIST_LIMIT", 2)
        rows = client.get("/jobs", headers=bearer()).json()
        assert [r["filename"] for r in rows] == \
            [f"v{i}.mp4" for i in range(4, -1, -1)]
        assert len(scans) == 1
    finally:
        st._conn.close()


@pytest.mark.parametrize("slow_charge", [0.0, 0.3])
@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_same_key_when_the_quota_covers_one_charge(
        backend, slow_charge, request, client, enforce, bearer, fake_r2,
        clean_state, monkeypatch):
    """Two POST /jobs for one upload as in two processes, with minutes
    for one charge only: the second request runs into the first one's
    claim (the job row goes in before the charge) and answers with that
    job — not 402 quota_exceeded plus a deleted R2 object for an upload
    that was accepted and charged."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from conftest import add_sub
    from backend.jobs import store
    add_sub(plan="starter", period_start=time.time() - 60)
    monkeypatch.setitem(accounts.PLAN_MINUTES, "starter", 1.5)  # 90 s
    monkeypatch.setattr(M, "_CREATING_KEYS", _NoGuard())
    fake_r2["barrier"] = threading.Barrier(2)
    if slow_charge:  # the winner is still charging when the loser looks
        real = accounts.charge

        def charge(*a, **kw):
            time.sleep(slow_charge)
            return real(*a, **kw)
        monkeypatch.setattr(accounts, "charge", charge)
    form = {"settings": "{}", "storage_key": "uploads/user_a/v.mp4"}
    answers = []

    def post():
        answers.append(client.post("/jobs", headers=bearer(), data=form))
    threads = [threading.Thread(target=post) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.status_code for r in answers] == [200, 200], \
        [r.text for r in answers]
    job_id = answers[0].json()["job_id"]
    assert answers[1].json()["job_id"] == job_id
    assert fake_r2["deleted"] == []
    assert clean_state == [job_id]
    job = store.get(job_id)
    assert len(store.list_all()) == 1 and not M._is_claim(job)
    assert job.plan == "starter" and "_accepting" not in job.settings
    assert job.settings["_max_seconds"] == 60 + accounts.TRUE_UP_TOLERANCE_S
    ent = accounts.entitlement("user_a")
    assert accounts.used_seconds("user_a", accounts.period_for(ent)[0]) == 60
    assert list((M._WORK_ROOT / "uploads").glob("*")) == []


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_same_key_refused_for_both_when_no_minutes_left(
        backend, request, client, enforce, bearer, fake_r2, clean_state,
        monkeypatch):
    """The first request is refused and drops its claim; the waiting one
    claims the key itself and is refused too — nothing left behind."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from conftest import add_sub
    from backend.jobs import store
    add_sub(plan="starter", period_start=time.time() - 60)
    monkeypatch.setitem(accounts.PLAN_MINUTES, "starter", 0.5)  # 30 s
    monkeypatch.setattr(M, "_CREATING_KEYS", _NoGuard())
    fake_r2["barrier"] = threading.Barrier(2)
    form = {"settings": "{}", "storage_key": "uploads/user_a/v.mp4"}
    answers = []

    def post():
        answers.append(client.post("/jobs", headers=bearer(), data=form))
    threads = [threading.Thread(target=post) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.status_code for r in answers] == [402, 402]
    assert all(r.json()["detail"]["code"] == "quota_exceeded"
               for r in answers)
    assert store.list_all() == [] and clean_state == []
    assert accounts._read("SELECT * FROM usage") == []
    assert set(fake_r2["deleted"]) == {"uploads/user_a/v.mp4"}
    assert list((M._WORK_ROOT / "uploads").glob("*")) == []


def _on_event_loop() -> bool:
    import asyncio
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_accept_failure_refunds_in_a_worker_thread(
        backend, request, enforce, bearer, fake_r2, clean_state,
        monkeypatch):
    """The job row can't be finished after the charge: the refund (a DB
    transaction) runs in the threadpool, not on the event loop, and the
    claim is dropped; the R2 object stays for a retry."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from conftest import add_sub
    from backend.jobs import _open_store, store
    add_sub(plan="pro", period_start=time.time() - 60)
    calls = []
    real_refund = accounts.refund

    def refund(job_id, note=""):
        calls.append((note, _on_event_loop()))
        return real_refund(job_id, note)
    monkeypatch.setattr(accounts, "refund", refund)

    def update_if(*a, **kw):
        raise RuntimeError("database gone")
    monkeypatch.setattr(_open_store(), "update_if", update_if)
    client = TestClient(M.app, raise_server_exceptions=False)
    r = client.post("/jobs", headers=bearer(),
                    data={"settings": "{}",
                          "storage_key": "uploads/user_a/v.mp4"})
    assert r.status_code == 500
    assert calls == [("create_failed", False)]
    assert store.list_all() == [] and clean_state == []
    rows = accounts._read("SELECT * FROM usage")
    assert len(rows) == 1 and rows[0]["refunded"]
    assert rows[0]["note"] == "create_failed"
    assert fake_r2["deleted"] == []
    assert list((M._WORK_ROOT / "uploads").glob("*")) == []


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_failed_refund_leaves_a_claim_the_sweep_settles(
        backend, request, enforce, bearer, fake_r2, clean_state,
        monkeypatch):
    """Refund impossible too (database down): the claim stays; once it
    is stale, the retention loop's sweep refunds the minutes, fails the
    job like an interrupted one and frees the upload."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from conftest import add_sub
    from backend.jobs import _open_store, store
    add_sub(plan="pro", period_start=time.time() - 60)
    real_refund = accounts.refund
    down = {"on": True}

    def refund(job_id, note=""):
        if down["on"]:
            raise RuntimeError("database gone")
        return real_refund(job_id, note)
    monkeypatch.setattr(accounts, "refund", refund)
    real_update_if = _open_store().update_if

    def update_if(job_id, expect, **kw):
        if "settings" in kw and "plan" in kw:  # the accept step
            raise RuntimeError("database gone")
        return real_update_if(job_id, expect, **kw)
    monkeypatch.setattr(_open_store(), "update_if", update_if)
    client = TestClient(M.app, raise_server_exceptions=False)
    r = client.post("/jobs", headers=bearer(),
                    data={"settings": "{}",
                          "storage_key": "uploads/user_a/v.mp4"})
    assert r.status_code == 500
    [claim] = store.list_all()
    assert M._is_claim(claim)
    assert not accounts._read("SELECT * FROM usage")[0]["refunded"]
    assert M._sweep_stale_claims() == 0            # not stale yet
    down["on"] = False
    later = time.time() + M._CLAIM_STALE_S + 1
    assert M._sweep_stale_claims(now=later) == 1
    job = store.get(claim.id)
    assert (job.status, job.error) == ("error", "container_restart")
    assert "_accepting" not in job.settings and job.input_path is None
    row = accounts._read("SELECT * FROM usage")[0]
    assert row["refunded"] and row["note"] == "container_restart"
    assert fake_r2["deleted"] == ["uploads/user_a/v.mp4"]
    assert M._sweep_stale_claims(now=later) == 0   # settled once


# ── read-modify-write under the row lock (store.modify) ──────────────


def test_modify_from_two_processes_loses_nothing(pgdb, tmp_path):
    """store.modify runs the caller's check under the row lock: counter
    + 1 from two processes, and a newest-revision-wins check with odd /
    even revisions interleaved — no increment and no newer save lost."""
    url, database = pgdb
    job = pg.PgJobStore(database).create("/in.mp4", {})
    n = 150
    script = textwrap.dedent("""
        import sys, time
        from backend.jobs import store
        job_id, offset, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
        for i in range(n):
            store.modify(job_id, lambda j: {
                "preview_version": j.preview_version + 1})
            rev = 2 * i + offset

            def save(j, rev=rev):
                time.sleep(0.001)  # widen the window between check and write
                if rev < j.edited_phrases_rev:
                    return None
                return {"edited_phrases_rev": rev,
                        "edited_phrases": [{"text": str(rev)}]}
            store.modify(job_id, save)
    """)
    full = {**os.environ, **_proc_env(url, tmp_path),
            "PYTHONPATH": str(REPO)}
    procs = [subprocess.Popen([sys.executable, "-c", script, job.id,
                               str(offset), str(n)], env=full, cwd=str(REPO),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True)
             for offset in (1, 2)]
    for p in procs:
        _, err = p.communicate(timeout=120)
        assert p.returncode == 0, err[-3000:]
    got = pg.PgJobStore(database).get(job.id)
    assert got.preview_version == 2 * n
    assert got.edited_phrases_rev == 2 * n
    assert got.edited_phrases == [{"text": str(2 * n)}]


_PHRASES_SCRIPT = textwrap.dedent("""
    import sys, time
    from fastapi.testclient import TestClient
    import backend.main as M
    from backend.jobs import store
    job_id, rev, start, hold = (sys.argv[1], float(sys.argv[2]),
                                float(sys.argv[3]), float(sys.argv[4]))
    real = store.modify

    def slow(jid, fn):
        def held(job):
            out = fn(job)
            time.sleep(hold)  # keep the row locked a while
            return out
        return real(jid, held)
    store.modify = slow
    client = TestClient(M.app)
    store.get(job_id)  # database open before the race starts
    while time.time() < start:
        time.sleep(0.001)
    r = client.post(f"/jobs/{job_id}/phrases",
                    json={"phrases": [{"text": f"rev {rev}"}], "rev": rev})
    print("ANSWER", r.status_code, r.json())
""")


@pytest.mark.parametrize("first", [1.0, 2.0])
def test_phrases_saves_from_two_processes_keep_the_newest(pgdb, tmp_path,
                                                          first):
    """POST /phrases in two processes (the review's repro): whichever
    save gets the row first, revision 2 is what stays — the revision
    check runs under the row lock, not a process-local lock."""
    url, database = pgdb
    st = pg.PgJobStore(database)
    job = st.create("/in.mp4", {})
    st.update(job.id, status="awaiting_review")
    second = 3.0 - first
    start = time.time() + 8
    env = {**os.environ, **_proc_env(url, tmp_path), "PYTHONPATH": str(REPO),
           "CLEO_WORK_ROOT": str(tmp_path / "work")}
    procs = [subprocess.Popen([sys.executable, "-c", _PHRASES_SCRIPT, job.id,
                               str(rev), str(at), str(hold)],
                              env=env, cwd=str(REPO), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
             for rev, at, hold in ((first, start, 0.6),
                                   (second, start + 0.2, 0.0))]
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err[-3000:]
        outs.append(out)
    assert all("ANSWER 200" in o for o in outs), outs
    got = st.get(job.id)
    assert got.edited_phrases_rev == 2.0
    assert got.edited_phrases[0]["text"] == "rev 2.0"
    if first == 2.0:  # the older save arrived second: told it's stale
        assert "'stale': True" in outs[1]


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_preview_rebuilds_never_lose_a_version(backend, request, monkeypatch):
    """preview_version + 1 is computed on the stored value (store.modify):
    rebuilds running at the same time (threads here, processes in
    production) bump it once each."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    import backend.pipeline as pipeline
    from backend.jobs import store
    monkeypatch.setattr(pipeline, "_ffmpeg_cuts_preview",
                        lambda src, segs, out: Path(out).write_bytes(b"p"))
    job = store.create("/in.mp4", {})
    store.update(job.id, status="awaiting_review", preview_version=3)
    barrier = threading.Barrier(4)

    def rebuild():
        barrier.wait()
        for _ in range(25):
            M._rebuild_preview(job.id, "/src.mp4", [(0.0, 1.0)])
    threads = [threading.Thread(target=rebuild) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    got = store.get(job.id)
    assert got.preview_version == 3 + 100
    assert got.preview_segments == [[0.0, 1.0]]


# ── what jsonb / Postgres text would change or refuse ────────────────


@pytest.mark.parametrize("backend", ["sqlite", "postgres"])
def test_ids_with_nul_are_unknown(backend, pgdb, tmp_path, monkeypatch):
    """A NUL (%00 in a URL / ?ids=) can't be sent to Postgres at all
    (psycopg DataError → 500); such an id is simply not found — like on
    SQLite — and not cleaned: "a\x00b" is not job "ab"."""
    if backend == "sqlite":
        monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "side.db"))
        st = jobs.JobStore()
    else:
        st = pg.PgJobStore(pgdb[1])
    st.create("/in.mp4", {}, job_id="ab")
    bad = "a\x00b"
    assert st.get(bad) is None
    assert st.update(bad, status="error") is None
    assert st.update_if(bad, "pending", status="error") is False
    assert st.modify(bad, lambda job: {"status": "error"}) is None
    assert st.claim(bad, "user_x") is None
    st.delete(bad)
    assert set(st.status_many([bad, "ab", "zz"])) == {"ab"}
    got = st.get("ab")
    assert (got.status, got.owner_id) == ("pending", None)
    if backend == "postgres":           # a lone surrogate: the same
        assert st.get("a\udcffb") is None
        assert st.status_many(["a\udcffb"]) == {}


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_nul_in_a_job_id_is_not_found(backend, request, client):
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from backend.jobs import store
    store.create("/in.mp4", {}, job_id="abcdef")
    assert client.get("/jobs/abc%00def").status_code == 404
    r = client.get("/jobs/status?ids=a%00b,abcdef,zzz")
    assert r.status_code == 200
    assert r.json()["missing"] == ["a\x00b", "zzz"]
    assert [j["id"] for j in r.json()["jobs"]] == ["abcdef"]
    for sub in ("download", "watch", "thumbnail", "subtitles"):
        assert client.get(f"/jobs/abc%00def/{sub}").status_code == 404, sub
    assert client.delete("/jobs/abc%00def").status_code == 404
    assert store.get("abcdef") is not None


def test_outputs_keep_their_order(pgdb):
    """jsonb sorts object keys ('primary' would come last): the structured
    fields are stored as nested JSON strings, like the SQLite blob, so the
    download buttons keep the pipeline's order — in get(), the summary
    list and to_dict() — and so do settings, costs and the rest."""
    _, database = pgdb
    st = pg.PgJobStore(database)
    settings = {"zz_last": 1, "output_formats": ["16:9", "9:16"], "a": 2}
    job = st.create("/in.mp4", settings, owner_id="user_a")
    outs = {"primary": "/o/p.mp4", "16:9": "/o/w.mp4", "9:16": "/o/v.mp4",
            "hook_1": "/o/h1.mp4", "hook_2": "/o/h2.mp4",
            "hook_10": "/o/h10.mp4"}
    costs = {"whisper": 0.5, "llm": 0.25, "bytes": 2e16}
    st.update(job.id, outputs=outs, status="done", costs=costs,
              edited_phrases=[{"text": "x", "b": 1, "a": 2}],
              audio_levels={"peak": -1.0, "mean": -20.0})
    got = st.get(job.id)
    assert list(got.outputs) == list(outs)
    assert got.to_dict()["outputs"] == list(outs)
    assert list(got.settings) == list(settings)
    assert list(got.costs) == list(costs)
    assert isinstance(got.costs["bytes"], float)
    assert list(got.edited_phrases[0]) == ["text", "b", "a"]
    assert list(got.audio_levels) == ["peak", "mean"]
    [row] = st.list_by_owner("user_a", limit=10, summary=True)
    assert row.to_dict()["outputs"] == list(outs)
    # Stored like the SQLite blob: the nested text is json.dumps' own.
    [(text,)] = _sql(database, "SELECT data->>'outputs' FROM jobs")
    assert text == json.dumps(outs)
    # Rows written with the structured fields as real JSON still load.
    with database.connection() as conn:
        conn.execute("UPDATE jobs SET data = jsonb_set(jsonb_set(data, "
                     "'{outputs}', %s::jsonb), '{costs}', %s::jsonb)",
                     (json.dumps(outs), json.dumps({"n": 1})))
    legacy = st.get(job.id)
    assert legacy.outputs == outs and legacy.costs == {"n": 1}


def test_big_floats_stay_floats(pgdb):
    _, database = pgdb
    st = pg.PgJobStore(database)
    job = st.create("/in.mp4", {})
    st.update(job.id, costs={"bytes": 2e16, "usd": 0.1 + 0.2, "n": 3},
              duration=1e20, progress=-1.5e300)
    got = st.get(job.id)
    assert got.costs == {"bytes": 2e16, "usd": 0.1 + 0.2, "n": 3}
    assert isinstance(got.costs["bytes"], float)
    assert isinstance(got.costs["n"], int)
    assert got.duration == 1e20 and isinstance(got.duration, float)
    assert got.progress == -1.5e300
    assert st.status_many([job.id])[job.id]["progress"] == -1.5e300


def test_lone_surrogates_and_nul_are_stored_cleaned(pg_side):
    """What SQLite stores but Postgres refuses (a half emoji from a JSON
    request, surrogateescape'd bytes, NUL): cleaned instead of failing
    the write — in job data, job text columns and accounts parameters."""
    _, database = pg_side
    st = pg.PgJobStore(database)
    half = json.loads('"caf\\ud83d"')
    job = st.create("/in.mp4", {"style": half, half: 1},
                    idempotency_key="uploads/u/\udcff.mp4",
                    owner_id="user_\x00a", filename="a\udcffb\x00.mp4")
    st.update(job.id, edited_phrases=[{"text": "hi \udcff"}],
              subtitles=[{"text": "ok \U0001F600 😀"}])
    got = st.get(job.id)
    assert got.settings == {"style": "caf�", "caf�": 1}
    assert got.filename == "a�b.mp4"
    assert got.edited_phrases == [{"text": "hi �"}]
    assert got.subtitles == [{"text": "ok \U0001F600 \U0001F600"}]
    assert got.owner_id == "user_a"
    assert st.find_by_key("uploads/u/\udcff.mp4").id == job.id
    row = _sql(database, "SELECT owner_id, idempotency_key FROM jobs")[0]
    assert row == ("user_a", "uploads/u/�.mp4")
    # accounts: raw_json with a NUL (billing._sub_row), a refund note
    # with ffmpeg's surrogateescape'd bytes
    sub = {"id": "s1", "user_id": "u", "variant_id": "1", "plan": "pro",
           "status": "active", "test_mode": False, "customer_id": "1",
           "renews_at": None, "ends_at": None, "portal_url": None,
           "update_payment_url": None,
           "raw_json": accounts.dump_json({"user_name": "Bob\x00 \udcff"}),
           "created_at": time.time(), "ls_updated_at": time.time()}
    assert accounts.upsert_subscription(sub)
    assert json.loads(accounts.get_subscription("s1")["raw_json"]) == \
        {"user_name": "Bob �"}
    accounts.charge("j1", "u", 10, enforce=False)
    assert accounts.refund("j1", "ffmpeg: bad byte \udcff\x00")
    assert accounts.get_usage("j1")["note"] == "ffmpeg: bad byte �"


@pytest.mark.parametrize("backend", ["active", "postgres"])
def test_phrases_with_a_lone_surrogate_are_saved(backend, request, client):
    """The review's request: a raw JSON body with half an emoji — 200 on
    both databases (Postgres stores U+FFFD in its place)."""
    if backend == "postgres":
        request.getfixturevalue("pg_side")
    from backend.jobs import store
    job = store.create("/in.mp4", {})
    store.update(job.id, status="awaiting_review")
    r = client.post(f"/jobs/{job.id}/phrases",
                    content=b'{"phrases":[{"text":"caf\\udcff"}],"rev":1}',
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 200 and r.json()["count"] == 1
    text = store.get(job.id).edited_phrases[0]["text"]
    assert text in ("caf\udcff", "caf�")
    assert text == ("caf�" if jobs._store_impl.__class__.__name__
                    == "PgJobStore" else "caf\udcff")
