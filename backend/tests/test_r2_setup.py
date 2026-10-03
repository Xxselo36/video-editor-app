"""backend/r2_setup.py --apply / --roundtrip (R2 on moto, in-process),
.github/scripts/modal_r2_secret.py (a stub `modal` CLI on PATH) and the
workflow that runs them, .github/workflows/r2-setup.yml. Its log is
public: nothing here may print a credential, the bucket or the account."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import stat
import sys
import textwrap

import pytest

from backend import r2_setup, storage
from conftest import R2_BUCKET, R2_ENDPOINT, R2_ENV, REPO

WORKFLOW = REPO / ".github" / "workflows" / "r2-setup.yml"


def _assert_no_secrets(out: str) -> None:
    for name in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID",
                 "R2_BUCKET"):
        assert R2_ENV[name] not in out, name
    assert R2_ENDPOINT not in out and "X-Amz-Signature" not in out


def _printed_config(capsys, *args: str) -> tuple[dict, dict]:
    """The two JSON documents --print-config prints."""
    assert r2_setup.main(["--print-config", *args]) == 0
    text = capsys.readouterr().out
    blocks = [b for b in re.split(r"^#.*$", text, flags=re.M) if b.strip()]
    cors, life = (json.loads(b) for b in blocks)
    return cors, life


# ── --apply ──────────────────────────────────────────────────────────


@pytest.fixture
def r2(r2):
    """conftest's r2, with the bucket's CORS and lifecycle removed again
    afterwards (under CLEO_TEST_MEDIA=r2 the bucket is the session's)."""
    yield r2
    r2.delete_bucket_cors(Bucket=R2_BUCKET)
    r2.delete_bucket_lifecycle(Bucket=R2_BUCKET)


def test_r2_setup_apply_sets_exactly_the_printed_config(r2, capsys):
    bucket = storage.bucket()
    r2.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": [{
        "AllowedOrigins": ["https://old.example"],
        "AllowedMethods": ["GET"]}]})
    r2.put_bucket_lifecycle_configuration(
        Bucket=bucket, LifecycleConfiguration={"Rules": [
            {"ID": "Default Multipart Abort Rule", "Status": "Enabled",
             "Filter": {"Prefix": ""},
             "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}},
            {"ID": "uploads-expire-9d", "Status": "Enabled",
             "Filter": {"Prefix": "uploads/"}, "Expiration": {"Days": 2}}]})
    want_cors, want_life = _printed_config(capsys)

    assert r2_setup.main(["--apply"]) == 0
    out = capsys.readouterr().out
    _assert_no_secrets(out)
    assert "PASS  CORS  (set: 1 rule, 2 origin(s); had 1 rule(s))" in out
    assert ("PASS  lifecycle  (set: 3 rules: uploads-expire-9d, "
            "uploads-abort-mpu-8d, jobs-abort-mpu-2d; replaced: "
            "Default Multipart Abort Rule)") in out
    assert out.strip().splitlines()[-1] == "applied"

    have_cors = r2.get_bucket_cors(Bucket=bucket)["CORSRules"]
    assert r2_setup._cors_key(have_cors) == r2_setup._cors_key(
        want_cors["CORSRules"])
    assert have_cors[0]["AllowedOrigins"] == r2_setup.DEFAULT_ORIGINS
    have_life = r2.get_bucket_lifecycle_configuration(Bucket=bucket)["Rules"]
    assert r2_setup._lifecycle_key(have_life) == r2_setup._lifecycle_key(
        want_life["Rules"])
    assert r2_setup.lifecycle_problems(have_life) == []


def test_r2_setup_apply_is_idempotent(r2, capsys):
    assert r2_setup.main(["--apply"]) == 0
    capsys.readouterr()
    client = storage._client()
    calls: list[str] = []

    def record(model, **kw):
        calls.append(model.name)
    client.meta.events.register("before-call.s3", record,
                                unique_id="r2-setup-test")
    try:
        assert r2_setup.main(["--apply"]) == 0
    finally:
        client.meta.events.unregister("before-call.s3",
                                      unique_id="r2-setup-test")
    out = capsys.readouterr().out
    assert "PASS  CORS  (unchanged: 1 rule, 2 origin(s))" in out
    assert "PASS  lifecycle  (unchanged: 3 rules:" in out
    assert calls == ["GetBucketCors", "GetBucketLifecycleConfiguration"]
    _assert_no_secrets(out)


def test_r2_setup_apply_with_other_origins(r2, capsys):
    origins = "https://staging.example,http://localhost:3000"
    want_cors, _ = _printed_config(capsys, "--origins", origins)
    assert r2_setup.main(["--apply", "--origins", origins]) == 0
    have = r2.get_bucket_cors(Bucket=storage.bucket())["CORSRules"]
    assert have[0]["AllowedOrigins"] == origins.split(",")
    assert r2_setup._cors_key(have) == r2_setup._cors_key(
        want_cors["CORSRules"])
    # Back to the defaults: the old origins go.
    assert r2_setup.main(["--apply"]) == 0
    have = r2.get_bucket_cors(Bucket=storage.bucket())["CORSRules"]
    assert have[0]["AllowedOrigins"] == r2_setup.DEFAULT_ORIGINS


def test_r2_setup_apply_reports_refusals_without_secrets(r2, capsys,
                                                        monkeypatch):
    from botocore.exceptions import ClientError
    client = storage._client()

    def refuse(**kw):
        raise ClientError({"Error": {"Code": "AccessDenied",
                                     "Message": "Access Denied"},
                           "ResponseMetadata": {"HTTPStatusCode": 403}},
                          "PutBucketCors")
    monkeypatch.setattr(client, "put_bucket_cors", refuse)
    assert r2_setup.main(["--apply"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  CORS" in out and "the token was refused" in out
    assert "PASS  lifecycle" in out            # the other half still ran
    assert out.strip().splitlines()[-1] == "1 FAILED"
    _assert_no_secrets(out)
    # --apply --check: no check after a failed apply.
    monkeypatch.setattr(r2_setup, "check", lambda *a, **k: pytest.fail())
    assert r2_setup.main(["--apply", "--check"]) == 1


def test_r2_setup_apply_missing_bucket(r2, capsys, monkeypatch):
    monkeypatch.setenv("R2_BUCKET", "cleo-no-such-bucket")
    assert r2_setup.main(["--apply"]) == 1
    out = capsys.readouterr().out
    assert len(re.findall(r"^FAIL  ", out, flags=re.M)) == 2
    assert "NoSuchBucket" in out and "R2_BUCKET?" in out
    assert "cleo-no-such-bucket" not in out
    _assert_no_secrets(out)


def test_r2_setup_apply_and_roundtrip_need_r2(no_r2, capsys):
    assert r2_setup.main(["--apply"]) == 2
    assert r2_setup.main(["--roundtrip"]) == 2
    assert "R2 is not configured" in capsys.readouterr().out


# ── --roundtrip ──────────────────────────────────────────────────────


def test_r2_setup_roundtrip(r2, capsys):
    calls: list[str] = []
    client = storage._client()

    def record(model, **kw):
        calls.append(model.name)
    client.meta.events.register("before-call.s3", record,
                                unique_id="r2-setup-rt")
    try:
        assert r2_setup.main(["--roundtrip"]) == 0
    finally:
        client.meta.events.unregister("before-call.s3",
                                      unique_id="r2-setup-rt")
    out = capsys.readouterr().out
    for name in ("put_file", "head", "get_file, same bytes", "delete"):
        assert f"PASS  {name}" in out
    assert out.strip().splitlines()[-1] == "round trip passed"
    _assert_no_secrets(out)
    # Objects only (what an "Object Read & Write" token may do) …
    assert not [c for c in calls if "Bucket" in c], calls
    # … and nothing left behind.
    assert "Contents" not in r2.list_objects_v2(Bucket=R2_BUCKET,
                                                Prefix="uploads/")


def test_r2_setup_roundtrip_fails_cleanly(r2, capsys, monkeypatch):
    monkeypatch.setenv("R2_BUCKET", "cleo-no-such-bucket")
    assert r2_setup.main(["--roundtrip"]) == 1
    out = capsys.readouterr().out
    # boto3's S3UploadFailedError names the bucket: blanked out.
    assert "FAIL  round trip  (S3UploadFailedError: An error occurred " \
           "(NoSuchBucket)" in out
    assert "cleo-no-such-bucket" not in out
    _assert_no_secrets(out)


# ── the Modal secret (stub modal CLI) ────────────────────────────────


MODAL_ENV = {"R2_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",
             "R2_BUCKET": "cleo-sim-media",
             "R2_MODAL_ACCESS_KEY_ID": "modalkeyid0000000000000000000001",
             "R2_MODAL_SECRET_ACCESS_KEY": "modalsecret" + "7" * 53,
             "MODAL_TOKEN_ID": "ak-faketokenid123",
             "MODAL_TOKEN_SECRET": "as-faketokensecret456"}


def _secret_script():
    path = REPO / ".github" / "scripts" / "modal_r2_secret.py"
    spec = importlib.util.spec_from_file_location("modal_r2_secret_t", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def stub_modal(tmp_path, monkeypatch):
    """A fake `modal` CLI first on PATH: records its argv and, for
    `secret create --from-json F`, F's mode and content; answers
    `secret list --json` with $STUB_LIST; exits $STUB_RC."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "calls.jsonl"
    stub = bin_dir / "modal"
    stub.write_text(f"#!{sys.executable}\n" + textwrap.dedent(f"""
        import json, os, stat, sys
        rec = {{"argv": sys.argv[1:]}}
        if "--from-json" in sys.argv:
            p = sys.argv[sys.argv.index("--from-json") + 1]
            rec["mode"] = stat.S_IMODE(os.stat(p).st_mode)
            rec["dir_mode"] = stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode)
            rec["file"] = p
            rec["content"] = json.load(open(p))
        with open({str(log)!r}, "a") as f:
            f.write(json.dumps(rec) + "\\n")
        if sys.argv[1:3] == ["secret", "list"]:
            print(os.environ.get("STUB_LIST", "[]"))
        else:
            print("Created a new secret")
        if os.environ.get("STUB_SAY"):
            print(os.environ["STUB_SAY"], file=sys.stderr)
        sys.exit(int(os.environ.get("STUB_RC", "0")))
    """))
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("RUNNER_TEMP", str(tmp_path))
    for k, v in MODAL_ENV.items():
        monkeypatch.setenv(k, v)

    def calls() -> list[dict]:
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]
    return calls


def test_r2_setup_modal_secret_apply(stub_modal, capsys):
    mod = _secret_script()
    assert mod.main(["apply"]) == 0
    out = capsys.readouterr().out
    assert out.strip() == ("Modal secret cleocuts-r2 saved (keys: "
                           "R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, "
                           "R2_SECRET_ACCESS_KEY)")
    (call,) = stub_modal()
    argv = call["argv"]
    assert argv[:3] == ["secret", "create", "cleocuts-r2"]
    assert "--force" in argv and "--from-json" in argv
    for v in MODAL_ENV.values():                 # no value on the argv
        assert not any(v in a for a in argv)
    assert call["mode"] == 0o600 and call["dir_mode"] == 0o700
    assert call["content"] == {
        "R2_ACCOUNT_ID": MODAL_ENV["R2_ACCOUNT_ID"],
        "R2_BUCKET": MODAL_ENV["R2_BUCKET"],
        "R2_ACCESS_KEY_ID": MODAL_ENV["R2_MODAL_ACCESS_KEY_ID"],
        "R2_SECRET_ACCESS_KEY": MODAL_ENV["R2_MODAL_SECRET_ACCESS_KEY"]}
    assert not os.path.exists(call["file"])      # deleted right after
    assert not os.path.exists(os.path.dirname(call["file"]))
    for v in MODAL_ENV.values():
        assert v not in out


def test_r2_setup_modal_secret_apply_values_are_trimmed(stub_modal,
                                                       monkeypatch, capsys):
    monkeypatch.setenv("R2_BUCKET", " cleo-sim-media\n")
    assert _secret_script().main(["apply"]) == 0
    assert stub_modal()[0]["content"]["R2_BUCKET"] == "cleo-sim-media"


def test_r2_setup_modal_secret_apply_failure_is_scrubbed(stub_modal,
                                                        monkeypatch, capsys):
    monkeypatch.setenv("STUB_RC", "1")
    monkeypatch.setenv("STUB_SAY", "boom: " + " ".join(MODAL_ENV.values()))
    assert _secret_script().main(["apply"]) == 1
    out = capsys.readouterr().out
    assert "::error title=Modal secret not saved::" in out and "boom" in out
    for v in MODAL_ENV.values():
        assert v not in out


def test_r2_setup_modal_secret_apply_needs_every_value(stub_modal,
                                                      monkeypatch, capsys):
    monkeypatch.setenv("R2_MODAL_SECRET_ACCESS_KEY", "  ")
    assert _secret_script().main(["apply"]) == 2
    assert "R2_MODAL_SECRET_ACCESS_KEY is not set" in capsys.readouterr().out
    assert stub_modal() == []


def test_r2_setup_modal_secret_check(stub_modal, monkeypatch, capsys):
    mod = _secret_script()
    monkeypatch.setenv("STUB_LIST", json.dumps(
        [{"Name": "other-secret"}, {"Name": "cleocuts-r2"}]))
    assert mod.main(["check"]) == 0
    out = capsys.readouterr().out
    assert out.strip() == "Modal secret cleocuts-r2 exists"
    assert stub_modal()[0]["argv"] == ["secret", "list", "--json"]
    monkeypatch.setenv("STUB_LIST", json.dumps([{"Name": "other-secret"}]))
    assert mod.main(["check"]) == 1
    out = capsys.readouterr().out
    assert "does not exist" in out and "mode=apply" in out
    assert "other-secret" not in out
    monkeypatch.setenv("STUB_RC", "1")
    monkeypatch.setenv("STUB_SAY", "bad token " + MODAL_ENV["MODAL_TOKEN_ID"])
    assert mod.main(["check"]) == 1
    out = capsys.readouterr().out
    assert "Modal secret list failed" in out
    assert MODAL_ENV["MODAL_TOKEN_ID"] not in out


# ── the workflow ─────────────────────────────────────────────────────


def _workflow() -> dict:
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(WORKFLOW.read_text())


def test_r2_setup_workflow_shape():
    wf = _workflow()
    on = wf[True]                     # YAML 1.1: the key `on` is True
    assert list(on) == ["workflow_dispatch"]
    inputs = on["workflow_dispatch"]["inputs"]
    assert inputs["mode"]["options"] == ["check", "apply"]
    assert inputs["mode"]["default"] == "check"
    assert inputs["origin"]["default"] == "https://cleocuts.com"
    assert wf["permissions"] == {"contents": "read"}
    assert wf["concurrency"]["group"] == "r2-setup"
    (job,) = wf["jobs"].values()
    assert 0 < job["timeout-minutes"] <= 30
    # boto3 / botocore pinned like backend/requirements.txt.
    req = (REPO / "backend" / "requirements.txt").read_text()
    install = next(s for s in job["steps"] if s.get("id") == "install")
    for pin in re.findall(r"^(boto(?:3|core)[^\s#]*)", req, flags=re.M):
        assert f'"{pin}"' in install["run"]


def test_r2_setup_workflow_keeps_secrets_out_of_scripts():
    """Secrets and inputs reach a step only through env (the log shows
    run: scripts expanded); each step gets the token it needs."""
    steps = _workflow()["jobs"]["r2"]["steps"]
    for s in steps:
        assert "${{" not in s.get("run", ""), s.get("name")
        for v in (s.get("with") or {}).values():
            assert "secrets." not in str(v)
    by_id = {s.get("id"): s for s in steps}

    def env(step_id):
        return {k: v.replace(" ", "") for k, v in
                (by_id[step_id].get("env") or {}).items()}
    admin = {"R2_ACCESS_KEY_ID": "${{secrets.R2_ADMIN_ACCESS_KEY_ID}}",
             "R2_SECRET_ACCESS_KEY": "${{secrets.R2_ADMIN_SECRET_ACCESS_KEY}}"}
    modal = {"R2_ACCESS_KEY_ID": "${{secrets.R2_MODAL_ACCESS_KEY_ID}}",
             "R2_SECRET_ACCESS_KEY": "${{secrets.R2_MODAL_SECRET_ACCESS_KEY}}"}
    for step_id, token in (("bucket", admin), ("check", admin),
                           ("roundtrip", modal)):
        e = env(step_id)
        assert {k: e[k] for k in token} == token, step_id
        assert e["R2_BUCKET"] == "${{secrets.R2_BUCKET}}"
        assert e["R2_ACCOUNT_ID"] == "${{secrets.R2_ACCOUNT_ID}}"
    assert "--apply" in by_id["bucket"]["run"]
    assert "--roundtrip" in by_id["roundtrip"]["run"]
    assert "--check --origin" in by_id["check"]["run"]
    # The Modal secret gets the Modal token only, after its round trip.
    e = env("modal_secret")
    assert "ADMIN" not in json.dumps(e)
    assert e["R2_MODAL_ACCESS_KEY_ID"] == "${{secrets.R2_MODAL_ACCESS_KEY_ID}}"
    assert "steps.roundtrip.outcome == 'success'" in by_id["modal_secret"]["if"]
    assert "modal_r2_secret.py apply" in by_id["modal_secret"]["run"]
    assert "modal_r2_secret.py check" in by_id["secret_exists"]["run"]
    order = [s.get("id") for s in steps]
    assert (order.index("bucket") < order.index("roundtrip")
            < order.index("modal_secret") < order.index("check"))
    # The first step names missing secrets and masks bucket + account.
    first = steps[0]["run"]
    assert '::add-mask::$acct' in first and '::add-mask::$bucket' in first
    for name in ("R2_ACCOUNT_ID", "R2_BUCKET", "R2_ADMIN_ACCESS_KEY_ID",
                 "R2_ADMIN_SECRET_ACCESS_KEY", "R2_MODAL_ACCESS_KEY_ID",
                 "R2_MODAL_SECRET_ACCESS_KEY", "MODAL_TOKEN_ID",
                 "MODAL_TOKEN_SECRET"):
        assert name in first and name in steps[0]["env"]
