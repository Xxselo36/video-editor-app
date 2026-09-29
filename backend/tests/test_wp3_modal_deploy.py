"""The Modal deploy can't take render_burn_concat down with it: the
workflow deploys render_r2 only when the Modal secret "cleocuts-r2"
exists, and the probe (ops-watch, diagnose) checks the render function
the API actually uses (CLEO_MODAL_RENDER_FN)."""
from __future__ import annotations

import importlib.util
import sys
import types

from backend import media
from conftest import REPO


def test_modal_deploy_checks_the_secret_first():
    wf = (REPO / ".github" / "workflows" / "modal-deploy.yml").read_text()
    deploy = wf[wf.index("- name: Deploy"):]
    assert "modal secret list --json" in deploy and "cleocuts-r2" in deploy
    assert "CLEO_MODAL_R2=1" in deploy and "CLEO_MODAL_R2=0" in deploy
    assert deploy.index("modal secret list") < deploy.index("modal deploy")
    # The probe checks the function the API uses.
    for name in ("modal-deploy.yml", "ops-watch.yml"):
        text = (REPO / ".github" / "workflows" / name).read_text()
        assert "--function" in text and "vars.CLEO_MODAL_RENDER_FN" in text


def _probe_module():
    path = REPO / ".github" / "scripts" / "modal_probe.py"
    spec = importlib.util.spec_from_file_location("modal_probe_t", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_probe_spawns_the_function_the_api_uses(monkeypatch):
    probe = _probe_module()
    spawned = []

    class ClientError(Exception):
        pass

    class _Call:
        def get(self, timeout):
            raise ClientError("An error occurred (404) when calling the "
                              "HeadObject operation: Not Found")

    class _Fn:
        def __init__(self, name):
            self.name = name

        def spawn(self, **kw):
            spawned.append((self.name, kw))
            return _Call()

    fake = types.SimpleNamespace(Function=types.SimpleNamespace(
        from_name=lambda app, name: _Fn(name)))
    monkeypatch.setitem(sys.modules, "modal", fake)
    exc = probe.probe(5, "render_r2")
    assert spawned[0][0] == "render_r2"
    kw = spawned[0][1]
    assert kw["out_prefix"].startswith(f"jobs/{kw['job_id']}/r1/")
    assert media.valid_job_id(kw["job_id"])
    assert probe.classify(exc, 5)[0] is True
    probe.probe(5, "render_burn_concat")
    assert spawned[1][0] == "render_burn_concat"
    assert "input_filename" in spawned[1][1]


def test_render_r2_is_only_in_a_deploy_with_the_secret():
    """`modal deploy` without CLEO_MODAL_R2=1 must not reference the
    cleocuts-r2 secret at all (Modal would refuse the whole deploy)."""
    import os
    import subprocess
    import pytest
    pytest.importorskip("modal")
    code = ("import backend.modal_render as m; "
            "print(sorted(m.app.registered_functions))")
    for flag, want in (("0", ["render_burn_concat"]),
                       ("1", ["render_burn_concat", "render_r2"])):
        env = {**os.environ, "CLEO_MODAL_R2": flag}
        out = subprocess.run([sys.executable, "-c", code], cwd=REPO, env=env,
                             capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr[-500:]
        assert out.stdout.strip().splitlines()[-1] == repr(want)
