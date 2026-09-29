"""Nightly Postgres backup (backend/pg_backup.py): the dump restores into
a second database with identical contents (Python restore and plain
psql), and the R2 run happens once per 24 h, in one process, keeping 14
days. Runs in both suite modes on databases of its own.
"""
from __future__ import annotations

import gzip
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import backend.main as M
from backend import db
from conftest import REPO

pg = pytest.importorskip("backend.pg")
from backend import pg_backup  # noqa: E402


def _fill(database) -> None:
    """Rows in every table, with the awkward bits: tabs, newlines,
    backslashes, unicode, NULLs, NaN in job JSON, timestamps."""
    st = pg.PgJobStore(database)
    for i in range(25):
        job = st.create(f"/in{i}.mp4", {"caption_preset": "clean"},
                        owner_id=f"user_{i % 3}",
                        idempotency_key=f"uploads/k{i}.mp4" if i % 2 else None,
                        filename=f"tab\there\nline\\{i} ☃ 😀.mp4")
        st.update(job.id, subtitles=[{"text": "a\tb\nc\\d \"q\" ü"}] * 3,
                  audio_levels={"peak": float("nan")}, status="done")
    # The media GC queue is backed up too (a restore must not forget
    # superseded renders / previews of live jobs).
    st.gc_add(["jobs/0123456789ab/r1/"], 1_790_000_000.5, store="r2")
    st.gc_add(["jobs/0123456789ab/"], 1_790_000_100.0, store="local")
    st.gc_add(["jobs/0123456789ab/"], 1_790_000_200.0)
    adb = pg.AccountsDB(database)
    with adb.transaction() as tx:
        tx.execute("INSERT INTO meta (key, value) VALUES (?, ?)",
                   ("media_secret", "s3cr3t\\n"))
        tx.execute("INSERT INTO users (id, email, created_at, updated_at) "
                   "VALUES (?, ?, ?, ?)", ("user_0", None, db.ts(1.5),
                                           db.ts(1_790_000_000.25)))
        tx.execute("INSERT INTO subscriptions (id, user_id, test_mode, "
                   "raw_json, renews_at) VALUES (?, ?, ?, ?, ?)",
                   ("s1", "user_0", True, '{"a": [1, "x\\ty"]}', None))
        tx.execute("INSERT INTO usage (job_id, user_id, seconds_billed, "
                   "created_at, refunded, note) VALUES (?, ?, ?, ?, ?, ?)",
                   ("j1", "user_0", 61.0, db.ts(1_790_000_000.123456),
                    False, "x\ty"))
        tx.execute("INSERT INTO billing_events (key, created_at) "
                   "VALUES (?, ?)", ("evt", db.ts(1_790_000_000.0)))


def _fingerprint(database) -> dict[str, tuple[int, str]]:
    out = {}
    with database.connection() as conn:
        for table in pg.TABLES + ("schema_migrations",):
            key = pg.PRIMARY_KEYS.get(table, "version")
            out[table] = conn.execute(
                f"SELECT count(*), md5(coalesce(string_agg(t::text, '|' "
                f"ORDER BY t.{key}), '')) FROM {table} t").fetchone()
    return out


@pytest.fixture
def two_dbs(pg_server):
    src_url, dst_url = pg_server.fresh(), pg_server.fresh()
    src = pg.Database(src_url, max_size=4)
    src.apply_schema()
    _fill(src)
    yield src, dst_url
    src.close()


def test_export_restores_identically(two_dbs, tmp_path):
    src, dst_url = two_dbs
    dump = tmp_path / "b.sql.gz"
    counts = pg_backup.export(src, str(dump))
    assert counts == {"meta": 1, "users": 1, "subscriptions": 1,
                      "usage": 1, "billing_events": 1, "jobs": 25,
                      "media_gc": 3}
    text = gzip.open(dump, "rt", encoding="utf-8").read()
    assert text.startswith("-- CleoCuts Postgres backup")
    assert "COPY jobs (id, owner_id" in text and text.rstrip().endswith(
        "COMMIT;")
    assert pg_backup.restore(dst_url, str(dump)) == counts
    dst = pg.Database(dst_url, max_size=2)
    try:
        assert _fingerprint(dst) == _fingerprint(src)
        # and the app can use the restored database as is
        job = pg.PgJobStore(dst).list_by_owner("user_1", limit=1)[0]
        assert "\t" in job.filename and "😀" in job.filename
        assert job.audio_levels["peak"] != job.audio_levels["peak"]  # NaN
        assert dst.apply_schema() == []
        gc = {(r["prefix"], r["store"]): r["not_before"]
              for r in pg.PgJobStore(dst).gc_all()}
        assert gc == {("jobs/0123456789ab/r1/", "r2"): 1_790_000_000.5,
                      ("jobs/0123456789ab/", "local"): 1_790_000_100.0,
                      ("jobs/0123456789ab/", None): 1_790_000_200.0}
        with pytest.raises(RuntimeError, match="not empty"):
            pg_backup.restore(dst_url, str(dump))
    finally:
        dst.close()


def test_cli_export_and_psql_restore(two_dbs, tmp_path):
    """The documented restore path: the CLI writes the dump, plain psql
    loads it."""
    import pgserver._commands as cmds
    src, dst_url = two_dbs
    dump = tmp_path / "cli.sql.gz"
    r = subprocess.run([sys.executable, "-m", "backend.pg_backup", "export",
                        str(dump)], cwd=str(REPO), capture_output=True,
                       text=True, timeout=120,
                       env={**os.environ, "PYTHONPATH": str(REPO),
                            "DATABASE_URL": src.url})
    assert r.returncode == 0, r.stderr[-2000:]
    psql = Path(cmds.POSTGRES_BIN_PATH) / "psql"
    if not psql.exists():
        pytest.skip("no psql binary")
    with gzip.open(dump, "rb") as f:
        r = subprocess.run([str(psql), dst_url, "-v", "ON_ERROR_STOP=1",
                            "-q"], input=f.read(), capture_output=True,
                           timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    dst = pg.Database(dst_url, max_size=1)
    try:
        assert _fingerprint(dst) == _fingerprint(src)
    finally:
        dst.close()


class FakeR2:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.objects: dict[str, dict] = {}
        self.deleted: list[str] = []
        self.fail = False

    def upload(self, path, key):
        if self.fail:
            raise OSError("r2 down")
        dest = self.root / key.replace("/", "_")
        shutil.copy(path, dest)
        self.objects[key] = {"key": key, "size": dest.stat().st_size,
                             "last_modified": None, "file": dest}

    def list(self, prefix):
        return [o for k, o in self.objects.items() if k.startswith(prefix)]

    def delete(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)


@pytest.fixture
def r2(monkeypatch, tmp_path):
    import backend.storage as storage
    fake = FakeR2(tmp_path)
    monkeypatch.setattr(storage, "r2_available", lambda: True)
    monkeypatch.setattr(storage, "backup_put", fake.upload)
    monkeypatch.setattr(storage, "backup_list", fake.list)
    monkeypatch.setattr(storage, "backup_delete", fake.delete)
    return fake


def test_nightly_run_once_a_day_keeps_14_days(two_dbs, r2, capsys):
    src, dst_url = two_dbs
    day = 86400
    now = 1_790_000_000.0          # 2026-09-21
    for back in (1, 13, 14, 15, 40):
        key = pg_backup.backup_key(now - back * day)
        r2.objects[key] = {"key": key, "size": 1, "last_modified": None}
    r2.objects["backups/pg/notes.txt"] = {"key": "backups/pg/notes.txt"}

    key = pg_backup.maybe_run(src, now=now)
    assert key == "backups/pg/2026-09-21.sql.gz"
    assert sorted(r2.deleted) == [pg_backup.backup_key(now - 40 * day),
                                  pg_backup.backup_key(now - 15 * day)]
    assert "backups/pg/notes.txt" in r2.objects        # not ours: kept
    assert "[backup] backups/pg/2026-09-21.sql.gz" in capsys.readouterr().out
    # The uploaded dump is restorable.
    assert pg_backup.restore(dst_url, str(r2.objects[key]["file"]))["jobs"] \
        == 25

    # Hourly ticks: nothing until 24 h later.
    assert pg_backup.maybe_run(src, now=now + 3600) is None
    assert pg_backup.maybe_run(src, now=now + 23 * 3600) is None
    assert pg_backup.maybe_run(src, now=now + day) == \
        "backups/pg/2026-09-22.sql.gz"


def test_one_runner_and_failure_retry(two_dbs, r2):
    src, _ = two_dbs
    now = 1_790_000_000.0
    # Another process claimed the run a minute ago: skip.
    assert pg_backup._claim(src, now - 60)
    assert pg_backup.maybe_run(src, now=now) is None
    # A claim older than STALE_CLAIM_S is a dead run: take over.
    later = now + pg_backup.STALE_CLAIM_S + 1
    r2.fail = True
    with pytest.raises(OSError, match="r2 down"):
        pg_backup.maybe_run(src, now=later)
    with src.connection() as conn:
        state = pg_backup._state(conn)
    assert state["running_since"] is None and "r2 down" in state["last_error"]
    assert "last_ok" not in state
    r2.fail = False                   # next hourly tick retries
    assert pg_backup.maybe_run(src, now=later + 3600)
    with src.connection() as conn:
        assert pg_backup._state(conn)["last_ok"] == later + 3600


def test_backup_needs_postgres_and_r2(two_dbs, monkeypatch, r2):
    src, _ = two_dbs
    import backend.storage as storage
    monkeypatch.setattr(db, "is_postgres", lambda: False)
    M._backup_tick()                               # SQLite: nothing
    assert r2.objects == {}
    monkeypatch.setattr(db, "is_postgres", lambda: True)
    monkeypatch.setattr(pg, "_database", src)
    monkeypatch.setattr(storage, "r2_available", lambda: False)
    M._backup_tick()                               # no R2: nothing
    assert r2.objects == {}
    monkeypatch.setattr(storage, "r2_available", lambda: True)
    M._backup_tick()
    assert list(r2.objects)[0].startswith("backups/pg/")


def test_restored_database_is_not_the_media_owner(two_dbs, tmp_path):
    """The orphan sweep's owner binding (meta media_owner_fp) stays out
    of the dump: a restored database has the owner id but not the
    binding, so it can't pass as the database that owns the bucket."""
    src, dst_url = two_dbs
    adb = pg.AccountsDB(src)
    with adb.transaction() as tx:
        tx.execute("INSERT INTO meta (key, value) VALUES (?, ?)",
                   ("media_owner_fp", "fp-of-src"))
        tx.execute("INSERT INTO meta (key, value) VALUES (?, ?)",
                   ("media_owner_id", "owner-1"))
    dump = tmp_path / "b.sql.gz"
    assert pg_backup.export(src, str(dump))["meta"] == 2
    pg_backup.restore(dst_url, str(dump))
    dst = pg.Database(dst_url, max_size=2)
    try:
        meta = {r["key"]: r["value"] for r in
                pg.AccountsDB(dst).read("SELECT key, value FROM meta")}
        assert meta["media_owner_id"] == "owner-1"
        assert "media_owner_fp" not in meta
        # Another database of the same cluster is another identity.
        ident = "SELECT (SELECT oid FROM pg_database WHERE datname = " \
                "current_database())::text AS o"
        assert pg.AccountsDB(dst).read(ident) != adb.read(ident)
    finally:
        dst.close()
