"""The Modal secret "cleocuts-r2" (render_r2's access to the media
bucket, DEPLOY.md 10.2) for .github/workflows/r2-setup.yml.

    python .github/scripts/modal_r2_secret.py apply
        Creates the secret, or replaces all of its values:
            R2_ACCOUNT_ID         = $R2_ACCOUNT_ID
            R2_BUCKET             = $R2_BUCKET
            R2_ACCESS_KEY_ID      = $R2_MODAL_ACCESS_KEY_ID
            R2_SECRET_ACCESS_KEY  = $R2_MODAL_SECRET_ACCESS_KEY
        with `modal secret create cleocuts-r2 --from-json <file> --force`.
        The values go from the environment into a 0600 file in a private
        temp dir (deleted right after) — never onto a command line.

    python .github/scripts/modal_r2_secret.py check
        Does the secret exist? (`modal secret list --json`; prints only
        found / missing, no other secret names.)

The modal CLI reads MODAL_TOKEN_ID / MODAL_TOKEN_SECRET from the
environment. The workflow log is public: this prints names only; what
the modal CLI says is shown only when it fails, with every secret value
blanked out.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

NAME = "cleocuts-r2"
# key in the Modal secret → env var the workflow sets
KEYS = {"R2_ACCOUNT_ID": "R2_ACCOUNT_ID",
        "R2_BUCKET": "R2_BUCKET",
        "R2_ACCESS_KEY_ID": "R2_MODAL_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY": "R2_MODAL_SECRET_ACCESS_KEY"}
_SENSITIVE_ENV = (*KEYS.values(), "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET")


def _scrub(text: str) -> str:
    """text with every secret value from the environment replaced."""
    values = {os.environ.get(k, "") for k in _SENSITIVE_ENV}
    values |= {v.strip() for v in values}
    for v in sorted((v for v in values if len(v) >= 4), key=len,
                    reverse=True):
        text = text.replace(v, "***")
    return text


def _modal(*args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["modal", *args], capture_output=True,
                              text=True, timeout=180,
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        return subprocess.CompletedProcess(
            ["modal", *args[:2]], 127, "", f"{type(e).__name__}")


def _tail(proc: subprocess.CompletedProcess, lines: int = 15) -> str:
    out = (proc.stdout or "") + (proc.stderr or "")
    return _scrub("\n".join(out.strip().splitlines()[-lines:]))


def apply() -> int:
    values = {}
    for key, env in KEYS.items():
        v = os.environ.get(env, "").strip()
        if not v:
            print(f"::error title=Missing secret::{env} is not set — "
                  f"the Modal secret {NAME} was not changed.", flush=True)
            return 2
        values[key] = v
    tmp_root = os.environ.get("RUNNER_TEMP") or None
    with tempfile.TemporaryDirectory(prefix="modal-secret-",
                                     dir=tmp_root) as d:
        path = os.path.join(d, "secret.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(values, f)
        try:
            proc = _modal("secret", "create", NAME, "--from-json", path,
                          "--force")
        finally:
            os.unlink(path)
    if proc.returncode != 0:
        print(f"::error title=Modal secret not saved::modal secret create "
              f"{NAME} failed (exit {proc.returncode}) — MODAL_TOKEN_ID / "
              "MODAL_TOKEN_SECRET wrong, or Modal unreachable. Its output:",
              flush=True)
        print(_tail(proc), flush=True)
        return 1
    print(f"Modal secret {NAME} saved (keys: {', '.join(values)})",
          flush=True)
    return 0


def check() -> int:
    proc = _modal("secret", "list", "--json")
    if proc.returncode != 0:
        print("::error title=Modal secret list failed::Could not list the "
              "Modal secrets — MODAL_TOKEN_ID / MODAL_TOKEN_SECRET wrong, or "
              "Modal unreachable. Its output:", flush=True)
        print(_tail(proc), flush=True)
        return 1
    try:
        names = {s.get("name") or s.get("Name")
                 for s in json.loads(proc.stdout)}
    except (ValueError, AttributeError, TypeError):
        print("::error title=Modal secret list::unexpected output of "
              "`modal secret list --json`", flush=True)
        return 1
    if NAME not in names:
        print(f"::error title=Modal secret missing::The Modal secret {NAME} "
              "does not exist. Run this workflow with mode=apply.",
              flush=True)
        return 1
    print(f"Modal secret {NAME} exists", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["apply"]:
        return apply()
    if argv == ["check"]:
        return check()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
