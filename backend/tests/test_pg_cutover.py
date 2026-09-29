"""Backend selection (backend/db.py) and the automatic SQLite → Postgres
cutover (backend/pg_cutover.py): copy + verify + marker, idempotency,
failure → stay on SQLite, the safety stops, two processes booting at
once, and the import rule (no psycopg outside Postgres mode). Runs in
both suite modes; every test brings its own databases.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import textwrap
import time
from dataclasses import asdict
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.main as M
from backend import accounts, db, jobs
from conftest import REPO, add_sub

pg = pytest.importorskip("backend.pg")
from backend import pg_cutover  # noqa: E402

UNREACHABLE = "postgresql://nobody:x@127.0.0.1:9/nothing"


@pytest.fixture
def isolated(monkeypatch):
    """Run db.startup() from scratch in this test: the process-wide choice,
    the Postgres pool, the job store and the accounts connection are
    swapped out and restored afterwards (pools opened here are closed)."""
    saved_pg = pg._database
    monkeypatch.setattr(db, "_active", None)
    monkeypatch.setattr(pg, "_database", None)
    monkeypatch.setattr(jobs, "_store_impl", None)
    monkeypatch.setattr(accounts, "_conn", None)
    monkeypatch.setattr(db, "_fallback", None)
    monkeypatch.setattr(pg, "CONNECT_TIMEOUT_S", 1)
    monkeypatch.setenv("CLEO_DB_BOOT_WAIT_S", "0")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("CLEO_DB_BACKEND", raising=False)
    yield
    if pg._database is not None and pg._database is not saved_pg:
        pg._database.close()
    impl = jobs._store_impl
    if isinstance(impl, jobs.JobStore):
        impl._conn.close()
    if accounts._conn is not None and accounts._is_sqlite(accounts._conn):
        accounts._conn.close()


def build_sqlite(path: Path, monkeypatch, corrupt: bool = False) -> dict:
    """A SQLite DB written by the real SQLite code paths: jobs with keys,
    a legacy row, users, subscriptions, usage (with a refund), billing
    events, meta secrets. Returns the expected row counts."""
    monkeypatch.setenv("CLEO_JOB_DB", str(path))
    st = jobs.JobStore()
    conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30,
                           isolation_level=None)
    conn.row_factory = sqlite3.Row
    jobs.tune_connection(conn)
    conn.executescript(accounts._SCHEMA)
    with monkeypatch.context() as m:
        m.setattr(accounts, "_conn", conn)
        accounts.ensure_user("user_a", "a@example.com")
        accounts.ensure_user("user_b")
        add_sub("sub_1", plan="pro", period_start=time.time() - 3600)
        add_sub("sub_2", user_id="user_b", plan="starter", status="expired",
                test_mode=1, ends_at=None)
        secret = accounts.media_secret()
        accounts.note_checkout("user_a")
        accounts.charge("j1", "user_a", 61.5, enforce=False)
        accounts.charge("j2", "user_a", 30, enforce=False)
        accounts.refund("j2", "container_restart")
        accounts.charge("j3", "user_b", 10, enforce=False)
        accounts.true_up("j3", 20.0)
        accounts.apply_event("evt-1", lambda c: None)
    conn.close()
    j1 = st.create("/in1.mp4", {"caption_preset": "clipper"}, job_id="j1",
                   idempotency_key="uploads/user_a/v1.mp4", owner_id="user_a",
                   plan="pro", filename="v1.mp4")
    st.update(j1.id, status="awaiting_review", segments=[(0.0, 1.5)],
              subtitles=[{"text": "hé", "start": 0.1, "end": 1.0}],
              audio_levels={"peak": float("-inf")}, duration=12.5)
    st.create("/in2.mp4", {}, job_id="j2", owner_id="user_a",
              idempotency_key="uploads/user_a/v2.mp4")
    st.update("j2", status="error", error="container_restart")
    st.create(None, {}, job_id="j3", owner_id="user_b")
    with st._lock:
        st._conn.execute("INSERT INTO jobs (id, data) VALUES (?, ?)",
                         ("oldjob", json.dumps({"id": "oldjob",
                                                "status": "done",
                                                "settings": "{}",
                                                "updated_at": 5.0})))
        # A key whose job is gone (invisible in SQLite): not copied.
        st._conn.execute("INSERT INTO job_keys (key, job_id) VALUES (?, ?)",
                         ("uploads/gone.mp4", "deleted-job"))
        if corrupt:
            st._conn.execute("INSERT INTO jobs (id, data) VALUES (?, ?)",
                             ("badjob", "{not json"))
        st._conn.commit()
    st._conn.close()
    return {"secret": secret, "counts": {
        "meta": 2, "users": 2, "subscriptions": 2, "usage": 3,
        "billing_events": 1, "jobs": 4 + corrupt, "job_keys": 2}}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sqlite_rows(path: Path, table: str) -> list[dict]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]
    finally:
        conn.close()


# ── the copy ─────────────────────────────────────────────────────────


def test_cutover_copies_verifies_and_marks(pg_server, tmp_path, monkeypatch):
    path = tmp_path / "cleo_jobs.db"
    built = build_sqlite(path, monkeypatch)
    before = _sha(path)
    url = pg_server.fresh()
    database = pg.Database(url, max_size=4)
    try:
        database.apply_schema()
        result = pg_cutover.migrate_if_needed(database, str(path))
        assert result.status == "migrated"
        assert result.counts == built["counts"]
        marker = json.loads(result.marker)
        assert marker["counts"] == built["counts"]
        assert marker["sqlite_path"] == str(path)
        assert _sha(path) == before              # SQLite left untouched

        # jobs: every field, via the store APIs of both sides
        monkeypatch.setenv("CLEO_JOB_DB", str(path))
        old = jobs.JobStore()
        new = pg.PgJobStore(database)
        try:
            src_jobs = {j.id: j for j in old.list_all()}
        finally:
            old._conn.close()
        assert set(src_jobs) == {"j1", "j2", "j3", "oldjob"}
        for job_id, job in src_jobs.items():
            assert asdict(new.get(job_id)) == asdict(job), job_id
        assert new.find_by_key("uploads/user_a/v1.mp4").id == "j1"
        assert new.find_by_key("uploads/gone.mp4") is None
        assert new.get("j1").audio_levels["peak"] == float("-inf")
        assert [j.id for j in new.list_by_owner("user_a", limit=10)] == \
            ["j2", "j1"]
        assert [j.id for j in new.list_by_status(
            "error", error="container_restart")] == ["j2"]

        # accounts: row by row, timestamps as floats again
        adb = pg.AccountsDB(database)
        for table in ("meta", "users", "subscriptions", "usage",
                      "billing_events"):
            key = pg.PRIMARY_KEYS[table]
            src = {r[key]: r for r in _sqlite_rows(path, table)}
            dst = {r[key]: r for r in adb.read(f"SELECT * FROM {table}")}
            dst.pop(pg_cutover.MARKER_KEY, None)
            assert set(src) == set(dst), table
            for k, row in src.items():
                for col, value in row.items():
                    got = dst[k][col]
                    if col in pg.TIME_COLUMNS and value is not None:
                        assert got == pytest.approx(value, abs=1e-6), \
                            (table, k, col)
                    elif col in pg.BOOL_COLUMNS and value is not None:
                        assert got is bool(value), (table, k, col)
                    elif col == "raw_json":
                        assert json.loads(got) == json.loads(value)
                    else:
                        assert got == value, (table, k, col)
        assert adb.read("SELECT test_mode FROM subscriptions WHERE id = ?",
                        ("sub_2",))[0]["test_mode"] is True
        with monkeypatch.context() as m:
            m.setattr(accounts, "_conn", adb)
            m.delenv("CLEO_MEDIA_SECRET", raising=False)
            assert accounts.media_secret() == built["secret"]
            assert accounts.used_seconds("user_a", 0) == 62.0
            assert accounts.used_seconds("user_b", 0) == 20.0

        # idempotent: the second boot sees the marker
        again = pg_cutover.migrate_if_needed(database, str(path))
        assert again.status == "already" and again.marker == result.marker
        with database.connection() as conn:
            assert conn.execute("SELECT count(*) FROM jobs"
                                ).fetchone()[0] == 4
    finally:
        database.close()


def test_cutover_refuses_to_merge_into_used_database(pg_server, tmp_path,
                                                     monkeypatch):
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    database = pg.Database(pg_server.fresh(), max_size=2)
    try:
        database.apply_schema()
        pg.PgJobStore(database).create("/x.mp4", {})
        with pytest.raises(pg_cutover.CutoverError, match="already has rows"):
            pg_cutover.migrate_if_needed(database, str(path))
    finally:
        database.close()


# ── db.startup(): selection, fallback, safety stops ─────────────────


def test_selection_by_environment(isolated, monkeypatch, tmp_path):
    monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "a.db"))
    assert db.configured_backend() == "sqlite"
    monkeypatch.setenv("DATABASE_URL", "postgresql://x/y")
    assert db.configured_backend() == "postgres"
    monkeypatch.setenv("CLEO_DB_BACKEND", "sqlite")
    assert db.configured_backend() == "sqlite"
    monkeypatch.setenv("CLEO_DB_BACKEND", "postgres")
    assert db.configured_backend() == "postgres"
    monkeypatch.setenv("CLEO_DB_BACKEND", "mysql")
    with pytest.raises(db.ConfigError):
        db.configured_backend()
    monkeypatch.setenv("CLEO_DB_BACKEND", "postgres")
    monkeypatch.delenv("DATABASE_URL")
    with pytest.raises(db.ConfigError, match="DATABASE_URL is not set"):
        db.startup()
    monkeypatch.delenv("CLEO_DB_BACKEND")
    assert db.startup() == "sqlite"
    assert isinstance(jobs._open_store(), jobs.JobStore)
    assert accounts._is_sqlite(accounts._db())


def test_lifespan_refuses_to_start_on_bad_config(isolated, monkeypatch):
    monkeypatch.setenv("CLEO_DB_BACKEND", "postgres")
    with pytest.raises(db.ConfigError):
        with TestClient(M.app):
            pass


def test_startup_migrates_then_uses_postgres(isolated, pg_server, tmp_path,
                                             monkeypatch, capsys):
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    assert db.startup() == "postgres"
    out = capsys.readouterr().out
    assert "[db] migrated SQLite → Postgres" in out and str(path) in out
    assert "backend: postgres" in out and "nobody" not in out
    marker = Path(db.cutover_marker_path(str(path)))
    assert json.loads(marker.read_text())["counts"]["jobs"] == 4
    store = jobs._open_store()
    assert isinstance(store, pg.PgJobStore)
    assert store.get("j1").filename == "v1.mp4"
    assert isinstance(accounts._db(), pg.AccountsDB)
    assert accounts.get_user("user_a")["email"] == "a@example.com"
    assert accounts.db_is_persistent()

    # Rollback switch: CLEO_DB_BACKEND=sqlite runs on the old file, loudly.
    pg._database.close()
    for name, value in (("_active", None), ("_database", None)):
        setattr(db if name == "_active" else pg, name, value)
    jobs._store_impl = None
    accounts._conn = None
    monkeypatch.setenv("CLEO_DB_BACKEND", "sqlite")
    assert db.startup() == "sqlite"
    out = capsys.readouterr().out
    assert "WARNING: running on SQLite (CLEO_DB_BACKEND=sqlite)" in out
    assert jobs._open_store().get("j1").filename == "v1.mp4"

    # After the cutover an unreachable Postgres stops the boot.
    jobs._store_impl._conn.close()
    db._active, jobs._store_impl = None, None
    monkeypatch.delenv("CLEO_DB_BACKEND")
    monkeypatch.setenv("DATABASE_URL", UNREACHABLE)
    with pytest.raises(db.Unavailable, match="already cut over"):
        db.startup()


def test_corrupt_row_keeps_sqlite_until_fixed(isolated, pg_server, tmp_path,
                                              monkeypatch, capsys):
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch, corrupt=True)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    assert db.startup() == "sqlite"
    out = capsys.readouterr().out
    assert "[db] MIGRATION FAILED — staying on SQLite" in out
    assert "badjob" in out
    assert not Path(db.cutover_marker_path(str(path))).exists()
    store = jobs._open_store()
    assert isinstance(store, jobs.JobStore)
    assert store.get("j1").owner_id == "user_a"   # the app keeps working
    check = pg.Database(url, max_size=1)
    try:
        assert pg_cutover.marker(check) is None
        with check.connection() as conn:     # everything rolled back
            for table in pg.TABLES:
                assert conn.execute(f"SELECT count(*) FROM {table}"
                                    ).fetchone()[0] == 0, table
    finally:
        check.close()

    # The operator deletes the broken row; the next boot migrates.
    with store._lock:
        store._conn.execute("DELETE FROM jobs WHERE id = 'badjob'")
        store._conn.commit()
    store._conn.close()
    db._active, jobs._store_impl = None, None
    assert db.startup() == "postgres"
    assert "[db] migrated SQLite → Postgres" in capsys.readouterr().out
    assert jobs._open_store().get("oldjob").updated_at == 5.0


def test_unreachable_postgres_before_cutover(isolated, tmp_path, monkeypatch,
                                             capsys):
    path = tmp_path / "cleo_jobs.db"
    monkeypatch.setenv("CLEO_JOB_DB", str(path))
    monkeypatch.setenv("DATABASE_URL", UNREACHABLE)
    # No SQLite data either: nothing safe to run on.
    with pytest.raises(db.Unavailable, match="no SQLite data"):
        db.startup()
    sqlite3.connect(str(path)).close()
    assert db.startup() == "sqlite"
    assert "MIGRATION FAILED — staying on SQLite" in capsys.readouterr().out


def test_fresh_deploy_creates_schema_only(isolated, pg_server, tmp_path,
                                          monkeypatch, capsys):
    monkeypatch.setenv("CLEO_JOB_DB", str(tmp_path / "missing.db"))
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    assert db.startup() == "postgres"
    assert "fresh Postgres database" in capsys.readouterr().out
    assert not (tmp_path / "missing.db").exists()     # no SQLite created
    assert json.loads(pg_cutover.marker(pg._database))["fresh"] is True
    assert pg._database.schema_version() == pg.MIGRATIONS[-1][0]
    # The volume turns up later: its data is not copied — say so, loudly.
    sqlite3.connect(str(tmp_path / "missing.db")).close()
    pg._database.close()
    db._active, pg._database, jobs._store_impl = None, None, None
    assert db.startup() == "postgres"
    assert "Its data was NOT copied" in capsys.readouterr().out


def test_two_processes_boot_at_once_and_migrate_once(pg_server, tmp_path,
                                                     monkeypatch):
    path = tmp_path / "cleo_jobs.db"
    built = build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    script = "from backend import db; print('ACTIVE', db.startup())"
    env = {**os.environ, "PYTHONPATH": str(REPO), "DATABASE_URL": url,
           "CLEO_JOB_DB": str(path), "CLEO_DB_BACKEND": ""}
    procs = [subprocess.Popen([sys.executable, "-c", script], env=env,
                              cwd=str(REPO), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
             for _ in range(3)]
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=120)
        assert p.returncode == 0, err[-3000:]
        outs.append(out)
    assert all("ACTIVE postgres" in o for o in outs)
    assert sum("[db] migrated SQLite" in o for o in outs) == 1
    database = pg.Database(url, max_size=1)
    try:
        with database.connection() as conn:
            for table in pg.TABLES:
                n = conn.execute(f"SELECT count(*) FROM {table}"
                                 ).fetchone()[0]
                # meta also holds the marker now
                assert n == built["counts"][table] + (table == "meta")
    finally:
        database.close()


# ── review fixes: identity, bad values, stale import, marker, split brain


def _reboot(monkeypatch=None) -> None:
    """Forget this process's database choice, as a new boot would."""
    if pg._database is not None:
        pg._database.close()
    impl = jobs._store_impl
    if isinstance(impl, jobs.JobStore):
        impl._conn.close()
    if accounts._conn is not None and accounts._is_sqlite(accounts._conn):
        accounts._conn.close()
    db._active, db._fallback, pg._database = None, None, None
    jobs._store_impl, accounts._conn = None, None


def _pg_counts(url: str) -> dict[str, int]:
    database = pg.Database(url, max_size=1)
    try:
        with database.connection() as conn:
            return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                    for t in pg.TABLES}
    finally:
        database.close()


def _odd_values(path: Path, monkeypatch) -> None:
    """What the SQLite code paths store but Postgres would refuse or
    change: key order, a big float, a half emoji from a JSON request,
    NUL in a refund note and in a webhook payload."""
    st = jobs.JobStore()
    try:
        st.update("j1", outputs={"primary": "/o/p.mp4", "9:16": "/o/v.mp4",
                                 "1:1": "/o/s.mp4", "hook_1": "/o/h.mp4"},
                  settings={"zz": 1, "output_formats": ["9:16", "1:1"],
                            "aa": 2},
                  costs={"whisper": 0.5, "bytes": 2e16},
                  edited_phrases=[{"text": json.loads('"caf\\udcff"')}])
    finally:
        st._conn.close()
    conn = sqlite3.connect(str(path), isolation_level=None)
    with monkeypatch.context() as m:
        conn.row_factory = sqlite3.Row
        m.setattr(accounts, "_conn", conn)
        accounts.charge("j9", "user_a", 5, enforce=False)
        accounts.refund("j9", "ffmpeg said \x00!")
        add_sub("sub_3",
                raw_json=accounts.dump_json({"user_name": "Bob\x00"}))
    conn.close()


def test_migrated_jobs_read_back_like_sqlite(isolated, pg_server, tmp_path,
                                            monkeypatch):
    """Key order (outputs 'primary' first, settings, costs) and big floats
    survive the cutover; lone surrogates / NUL are cleaned, not fatal."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    _odd_values(path, monkeypatch)
    src = jobs.JobStore()
    try:
        before = src.get("j1")
        blob = json.loads(src._conn.execute(
            "SELECT data FROM jobs WHERE id = 'j1'").fetchone()[0])
    finally:
        src._conn.close()
    monkeypatch.setenv("DATABASE_URL", pg_server.fresh())
    assert db.startup() == "postgres"
    got = jobs._open_store().get("j1")
    assert list(got.outputs) == list(before.outputs)
    assert got.to_dict()["outputs"] == ["primary", "9:16", "1:1", "hook_1"]
    assert list(got.settings) == list(before.settings)
    assert list(got.costs) == ["whisper", "bytes"]
    assert isinstance(got.costs["bytes"], float)
    assert got.edited_phrases == [{"text": "caf\ufffd"}]
    [(outputs, settings)] = _sql_pg(
        "SELECT data->>'outputs', data->>'settings' FROM jobs "
        "WHERE id = 'j1'")
    assert (outputs, settings) == (blob["outputs"], blob["settings"])
    assert accounts.get_usage("j9")["note"] == "ffmpeg said !"
    assert json.loads(accounts.get_subscription("sub_3")["raw_json"]) == \
        {"user_name": "Bob"}


def _sql_pg(query: str) -> list[tuple]:
    with pg.database().connection() as conn:
        return conn.execute(query).fetchall()


def test_cutover_error_names_the_row(isolated, pg_server, tmp_path,
                                     monkeypatch, capsys):
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    monkeypatch.setenv("DATABASE_URL", pg_server.fresh())
    real_dump = pg.dump_job

    def dump_job(job):
        if job.id == "j2":
            raise ValueError("refused")
        return real_dump(job)
    with monkeypatch.context() as m:
        m.setattr(pg, "dump_job", dump_job)
        assert db.startup() == "sqlite"
    assert "MIGRATION FAILED" in (out := capsys.readouterr().out)
    assert "jobs row 'j2' can't be written to Postgres" in out
    _reboot()
    real_value = pg_cutover._value

    def value(table, column, v):
        if table == "usage" and v == "j3":
            raise ValueError("refused")
        return real_value(table, column, v)
    with monkeypatch.context() as m:
        m.setattr(pg_cutover, "_value", value)
        assert db.startup() == "sqlite"
    assert "usage row 'j3' can't be written" in capsys.readouterr().out
    _reboot()
    assert db.startup() == "postgres"


def test_copy_failure_names_a_row_only_for_data_errors():
    """Postgres attaches 'COPY …, line N' to every error during the COPY:
    only data errors (SQLSTATE 22 / 23, or refused on our side for the
    row) name a row and say 'fix or delete'; a cancel, a lost
    connection, a full disk or a shutdown don't."""
    import psycopg
    import psycopg.errors as E
    ids = ["a1", "b2"]
    for e in (E.QueryCanceled("canceling statement due to user request"),
              E.DiskFull("could not extend file"),
              E.AdminShutdown("terminating connection"),
              psycopg.OperationalError("the connection is lost"),
              psycopg.OperationalError("sending copy data failed: server "
                                       "closed the connection unexpectedly")):
        for current in (True, False):
            msg = str(pg_cutover._copy_failed("jobs", ids, e, current))
            assert "row '" not in msg and "fix or delete" not in msg, msg
            assert "copying jobs to Postgres failed" in msg
            assert "the next boot tries again" in msg
    for current in (True, False):
        msg = str(pg_cutover._copy_failed(
            "jobs", ids, sqlite3.DatabaseError("database disk image is "
                                               "malformed"), current))
        assert "reading jobs from SQLite failed" in msg and "row '" not in msg
        assert "the SQLite file can't be read, not Postgres" in msg
        assert "nothing needs fixing" not in msg
        assert "the next boot tries again" not in msg
    for e in (psycopg.DataError("PostgreSQL text fields cannot contain NUL "
                                "(0x00) bytes"),
              ValueError("refused"), UnicodeEncodeError(
                  "utf-8", "\udcff", 0, 1, "surrogates not allowed")):
        msg = str(pg_cutover._copy_failed("jobs", ids, e, current=True))
        assert msg.startswith("jobs row 'b2' can't be written")
        assert msg.endswith("fix or delete it in SQLite")
    for e in (E.InvalidTextRepresentation("invalid input syntax"),
              E.UniqueViolation("duplicate key value")):
        msg = str(pg_cutover._copy_failed("jobs", ids, e))
        assert "can't be written" in msg and "fix or delete" in msg
    assert "fix or delete" not in str(pg_cutover._copy_failed(
        "jobs", ids, ValueError("x"), current=False))


def _damage_a_page_of(path: Path, table: str) -> None:
    """Overwrite one leaf page of `table`'s b-tree (a disk / volume
    fault), leaving the schema readable."""
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        root = conn.execute("SELECT rootpage FROM sqlite_master WHERE "
                            "type = 'table' AND name = ?",
                            (table,)).fetchone()[0]
    finally:
        conn.close()
    with open(path, "r+b") as f:
        f.seek((root - 1) * page_size)
        f.write(b"\xff" * page_size)


@pytest.mark.parametrize("table", ["jobs", "job_keys", "usage"])
def test_unreadable_sqlite_file_is_blamed_not_postgres(
        table, isolated, pg_server, tmp_path, monkeypatch, capsys):
    """A damaged SQLite page: the log says the SQLite file can't be read
    and needs repairing — not 'nothing needs fixing in SQLite; the next
    boot tries again' (it fails every boot until the file is fixed)."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    _damage_a_page_of(path, table)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    assert db.startup() == "sqlite"
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if "MIGRATION FAILED" in ln)
    assert "from SQLite failed" in line and "malformed" in line, line
    assert "the SQLite file can't be read, not Postgres" in line, line
    assert "PRAGMA integrity_check" in line, line
    assert "nothing needs fixing" not in line, line
    assert "the next boot tries again" not in line, line
    assert "row '" not in line, line
    assert not Path(db.cutover_marker_path(str(path))).exists()
    assert set(_pg_counts(url).values()) == {0}         # rolled back


def test_value_error_names_the_row(isolated, pg_server, tmp_path,
                                   monkeypatch, capsys):
    """A usage row whose created_at isn't a Unix time: the message names
    the row and says to fix or delete it, like any other bad row."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    conn = sqlite3.connect(str(path))
    conn.execute("UPDATE usage SET created_at = 'yesterday' "
                 "WHERE job_id = 'j3'")
    conn.commit()
    conn.close()
    monkeypatch.setenv("DATABASE_URL", pg_server.fresh())
    assert db.startup() == "sqlite"
    line = next(ln for ln in capsys.readouterr().out.splitlines()
                if "MIGRATION FAILED" in ln)
    assert "usage row 'j3': usage.created_at: 'yesterday' is not a Unix " \
        "time — fix or delete it in SQLite" in line, line


@pytest.mark.parametrize("how", ["cancel", "terminate"])
def test_postgres_failing_during_the_copy_blames_no_row(
        how, isolated, pg_server, tmp_path, monkeypatch, capsys):
    """pg_cancel_backend / pg_terminate_backend on the running COPY (as a
    restart or an operator would): the log must not tell the operator
    to delete a (valid) row from SQLite — the next boot just migrates."""
    import psycopg
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    real = jobs.job_from_dict
    killed = []

    def job_from_dict(d):
        if d.get("id") == "j2" and not killed:
            with psycopg.connect(url, autocommit=True) as c:
                for (pid,) in c.execute(
                        "SELECT pid FROM pg_stat_activity WHERE datname = "
                        "current_database() AND pid <> pg_backend_pid() "
                        "AND query LIKE 'COPY jobs%'").fetchall():
                    c.execute(f"SELECT pg_{how}_backend(%s)", (pid,))
                    killed.append(pid)
        return real(d)
    with monkeypatch.context() as m:
        m.setattr(jobs, "job_from_dict", job_from_dict)
        assert db.startup() == "sqlite"
    assert killed
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if "MIGRATION FAILED" in ln)
    assert "row '" not in line and "fix or delete" not in line, line
    assert "copying jobs to Postgres failed" in line
    assert not Path(db.cutover_marker_path(str(path))).exists()
    assert set(_pg_counts(url).values()) == {0}         # rolled back
    _reboot()
    assert db.startup() == "postgres"                   # a retry just works
    assert "[db] migrated SQLite → Postgres" in capsys.readouterr().out


def test_marker_file_without_sqlite_file_refuses_an_empty_database(
        isolated, pg_server, tmp_path, monkeypatch, capsys):
    """After the cutover the operator deletes the stale SQLite file (the
    marker file stays); DATABASE_URL then points at an empty database:
    the boot stops instead of stamping it 'fresh' and serving users an
    empty account (new media secret, no projects, no ledger)."""
    path = tmp_path / "cleo_jobs.db"
    built = build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    assert db.startup() == "postgres"
    marker = Path(db.cutover_marker_path(str(path)))
    info = marker.read_text()
    _reboot()
    for suffix in ("", "-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)
    empty = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", empty)
    capsys.readouterr()
    with pytest.raises(db.Unavailable, match="refusing to start") as e:
        db.startup()
    assert "the file is gone now" in str(e.value)
    assert "fresh Postgres database" not in capsys.readouterr().out
    assert set(_pg_counts(empty).values()) == {0}       # no 'fresh' marker
    assert marker.read_text() == info
    assert not path.exists()
    _reboot()                                           # again: still no
    with pytest.raises(db.Unavailable, match="refusing to start"):
        db.startup()
    _reboot()
    monkeypatch.setenv("DATABASE_URL", url)             # the right database
    assert db.startup() == "postgres"
    monkeypatch.delenv("CLEO_MEDIA_SECRET", raising=False)
    assert accounts.media_secret() == built["secret"]
    assert jobs._open_store().get("j1").owner_id == "user_a"


def test_empty_postgres_after_cutover_is_not_refilled(isolated, pg_server,
                                                      tmp_path, monkeypatch,
                                                      capsys):
    """After the cutover, DATABASE_URL pointing at an empty database
    (re-created service, wrong reference) must not bring the stale SQLite
    snapshot back: the boot stops, loudly, and copies nothing."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    monkeypatch.setenv("DATABASE_URL", pg_server.fresh())
    assert db.startup() == "postgres"
    marker = Path(db.cutover_marker_path(str(path)))
    info = marker.read_text()
    _reboot()
    empty = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", empty)
    with pytest.raises(db.Unavailable, match="refusing to start") as e:
        db.startup()
    assert "already migrated" in str(e.value)
    assert _pg_counts(empty)["jobs"] == 0 and _pg_counts(empty)["meta"] == 0
    assert marker.read_text() == info
    _reboot()
    capsys.readouterr()
    with pytest.raises(db.Unavailable):     # the app refuses to start
        with TestClient(M.app):
            pass
    assert "[db] NOT STARTING: [db] refusing to start" in \
        capsys.readouterr().out
    assert _pg_counts(empty)["jobs"] == 0


def test_marker_write_failure_before_commit_stays_on_sqlite(
        isolated, pg_server, tmp_path, monkeypatch, capsys):
    """The marker file is written before the cutover commits: if that
    fails (full volume) nothing is committed and SQLite stays the truth."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)

    def full(marker, body):
        raise OSError(28, "No space left on device")
    with monkeypatch.context() as m:
        m.setattr(db, "_write_marker_file", full)
        assert db.startup() == "sqlite"
    assert "MIGRATION FAILED" in capsys.readouterr().out
    assert not Path(db.cutover_marker_path(str(path))).exists()
    assert set(_pg_counts(url).values()) == {0}   # rolled back
    _reboot()
    assert db.startup() == "postgres"             # next boot: migrates


def test_marker_write_failure_after_commit_fails_closed(
        isolated, pg_server, tmp_path, monkeypatch, capsys):
    """The final marker can't be written after the commit: the pending
    one (written before) keeps guarding — a later boot with Postgres down
    refuses to run on the stale SQLite file."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    real = db._write_marker_file

    def final_fails(marker, body):
        if '"pending": true' not in body:
            raise OSError(28, "No space left on device")
        return real(marker, body)
    with monkeypatch.context() as m:
        m.setattr(db, "_write_marker_file", final_fails)
        assert db.startup() == "postgres"
    assert "could not write the cutover marker" in capsys.readouterr().out
    marker = Path(db.cutover_marker_path(str(path)))
    assert json.loads(marker.read_text())["pending"] is True
    _reboot()
    monkeypatch.setenv("DATABASE_URL", UNREACHABLE)
    with pytest.raises(db.Unavailable, match="already cut over"):
        db.startup()
    _reboot()
    monkeypatch.setenv("DATABASE_URL", url)       # Postgres is back
    assert db.startup() == "postgres"
    assert "pending" not in json.loads(marker.read_text())
    assert _pg_counts(url)["jobs"] == 4


def test_pending_marker_of_an_uncommitted_cutover_is_ignored(
        isolated, pg_server, tmp_path, monkeypatch, capsys):
    """A pending marker whose cutover never committed (crash before the
    COMMIT): SQLite is still the truth, the boot migrates."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    marker = Path(db.cutover_marker_path(str(path)))
    marker.write_text(json.dumps({"at": "x", "pending": True}))
    monkeypatch.setenv("DATABASE_URL", pg_server.fresh())
    assert db.startup() == "postgres"
    out = capsys.readouterr().out
    assert "never committed" in out and "[db] migrated SQLite" in out
    assert "pending" not in json.loads(marker.read_text())


def test_transient_failure_while_a_peer_cuts_over_uses_postgres(
        isolated, pg_server, tmp_path, monkeypatch, capsys):
    """Two processes boot at once; this one fails transiently while the
    other one commits the cutover: this one must not stay on SQLite."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    real = pg_cutover.migrate_if_needed
    calls = []

    def flaky(database, sqlite_path, **kw):
        if not calls:
            calls.append(1)
            peer = pg.Database(url, max_size=1)   # the other process
            try:
                assert real(peer, sqlite_path).status == "migrated"
            finally:
                peer.close()
            raise OSError("server closed the connection unexpectedly")
        return real(database, sqlite_path, **kw)
    monkeypatch.setattr(pg_cutover, "migrate_if_needed", flaky)
    assert db.startup() == "postgres"
    assert "committed after all" in capsys.readouterr().out
    assert not db.fell_back()
    assert Path(db.cutover_marker_path(str(path))).exists()
    assert jobs._open_store().get("j1").owner_id == "user_a"


def test_sqlite_fallback_stops_when_a_peer_cuts_over(
        isolated, pg_server, tmp_path, monkeypatch, capsys):
    """A process that did fall back to SQLite exits once another process
    cut over (so the restart runs on Postgres)."""
    path = tmp_path / "cleo_jobs.db"
    build_sqlite(path, monkeypatch, corrupt=True)
    url = pg_server.fresh()
    monkeypatch.setenv("DATABASE_URL", url)
    assert db.startup() == "sqlite" and db.fell_back()
    assert db.peer_cut_over() is None
    exits = []
    monkeypatch.setattr(M, "_CUTOVER_WATCH_S", 0.0)
    monkeypatch.setattr(M, "_exit_process", exits.append)
    # The other process: the broken row fixed, it migrates.
    conn = sqlite3.connect(str(path))
    conn.execute("DELETE FROM jobs WHERE id = 'badjob'")
    conn.commit()
    conn.close()
    peer = pg.Database(url, max_size=1)
    try:
        assert pg_cutover.migrate_if_needed(peer, str(path)).status == \
            "migrated"
    finally:
        peer.close()
    assert "has the cutover marker" in db.peer_cut_over()
    M._cutover_watch()
    assert exits == [1]
    assert "another process cut over to Postgres" in capsys.readouterr().out


# ── import rule ──────────────────────────────────────────────────────


def test_modules_import_without_psycopg(tmp_path):
    """The desktop app and the Modal image have no psycopg: backend.jobs /
    costs / llm / whisper_groq / pipeline must import (and the SQLite
    store work) with it blocked."""
    script = textwrap.dedent(f"""
        import sys
        class Block:
            def find_spec(self, name, path=None, target=None):
                if name.split(".")[0] in ("psycopg", "psycopg_pool",
                                          "psycopg_binary"):
                    raise ImportError("blocked: " + name)
        sys.meta_path.insert(0, Block())
        import os
        os.environ["CLEO_JOB_DB"] = {str(tmp_path / "j.db")!r}
        os.environ.pop("DATABASE_URL", None)
        import backend.jobs, backend.costs, backend.llm
        import backend.whisper_groq, backend.pipeline
        from backend.jobs import store
        job = store.create("/x.mp4", {{}})
        assert store.get(job.id).id == job.id
        bad = [m for m in sys.modules if m.split(".")[0].startswith("psycopg")]
        assert not bad, bad
        print("IMPORT-OK")
    """)
    r = subprocess.run([sys.executable, "-c", script], cwd=str(REPO),
                       env={**os.environ, "PYTHONPATH": str(REPO)},
                       capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert "IMPORT-OK" in r.stdout
