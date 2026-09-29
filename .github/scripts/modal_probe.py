"""Can Modal run a CleoCuts render right now?

Spawns the render function the API uses (--function, default
$CLEO_MODAL_RENDER_FN, else render_burn_concat) for a job that has no
input. When Modal schedules the call, a container starts and the
function fails right away because the input isn't there
(render_burn_concat: FileNotFoundError on the volume; render_r2: a 404
for the mezz object from R2 — which also proves the cleocuts-r2 secret
reaches the bucket): that is the healthy answer. Anything else (workspace spend limit reached,
bad tokens, app not deployed, no answer in time) prints a ::error::
annotation saying what to do and exits 1.

Used by .github/workflows/ops-watch.yml (every 6 h) and by the diagnose
mode of .github/workflows/modal-deploy.yml. Needs `pip install modal`
and MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in the environment.

Cost: the call occupies one 8-core / 8 GiB container (the function's
reservation) for a few seconds, plus Modal's idle window before the
container scales down — see OPERATIONS.md for the numbers.

Logs are public: prints the outcome and Modal's (truncated) error text,
never tokens or ids.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import time

APP = "cleocuts-render"
FUNCTIONS = ("render_burn_concat", "render_r2")
FUNCTION = (os.environ.get("CLEO_MODAL_RENDER_FN", "").strip()
            if os.environ.get("CLEO_MODAL_RENDER_FN", "").strip() in FUNCTIONS
            else "render_burn_concat")
PROBE_JOB_ID = "diag-probe"
# render_r2 checks that out_prefix belongs to the job: a well-formed id
# whose mezz doesn't exist.
PROBE_R2_JOB_ID = "000000000000"

SPEND_LIMIT_FIX = (
    "Renders fail until this is fixed. Raise the Modal spend limit: Modal "
    "dashboard → Settings → Usage → workspace spend limit, then re-run "
    "this workflow to confirm.")
TOKEN_FIX = (
    "Create a new token (Modal dashboard → Settings → API Tokens) and "
    "update MODAL_TOKEN_ID / MODAL_TOKEN_SECRET in both places: GitHub repo "
    "secrets and Railway → backend service → Variables.")
DEPLOY_FIX = (
    "Deploy it: Actions → Deploy Modal render → Run workflow (diagnose "
    "unticked), or `modal deploy backend/modal_render.py`.")
STUCK_FIX = (
    "Check status.modal.com and Modal dashboard → Apps → cleocuts-render "
    "(queued calls, crashing containers) and Settings → Usage (spend "
    "limit). Actions → Deploy Modal render with diagnose ticked prints "
    "the app's recent error lines.")


def _escape_data(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_prop(s: str) -> str:
    return _escape_data(s).replace(":", "%3A").replace(",", "%2C")


def _redact(text: str) -> str:
    """Modal's error text, one line, cut, without our token values."""
    for name in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"):
        value = os.environ.get(name, "")
        if len(value) >= 6:
            text = text.replace(value, "***")
    text = " ".join(text.split())
    return text[:200] + ("…" if len(text) > 200 else "")


def annotate(level: str, title: str, message: str) -> None:
    print(f"::{level} title={_escape_prop(title)}::{_escape_data(message)}",
          flush=True)


def summary(line: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def classify(exc: BaseException, timeout: float,
             spawned: bool = True) -> tuple[bool, str, str]:
    """(healthy, title, what to do) for what the probe raised; `spawned`:
    it came from waiting for the call (not from lookup or spawn)."""
    try:
        from modal import exception as mexc
    except Exception:  # classification must never crash the probe
        mexc = None

    def is_a(name: str) -> bool:
        cls = getattr(mexc, name, None) if mexc else None
        return isinstance(cls, type) and isinstance(exc, cls)

    name = type(exc).__name__
    text = _redact(str(exc))
    low = text.lower()
    detail = f" ({name}: {text})" if text else f" ({name})"

    # The container ran and found no input: Modal works end to end
    # (render_r2: R2 answered 404 for the probe's mezz).
    if spawned and (isinstance(exc, FileNotFoundError)
                    or name == "FileNotFoundError"
                    or "input not found at" in low
                    or ("404" in low and "not found" in low)
                    or "nosuchkey" in low):
        return True, "Modal OK", "the container started and answered"
    # Only before the spawn is an ImportError ours; after it, it's the
    # container's (bad deploy) and ends up as "Modal probe failed".
    if not spawned and isinstance(exc, ImportError):
        return False, "Modal client missing", (
            f"pip install modal before running the probe.{detail}")
    # The 2026-09-28 outage: RESOURCE_EXHAUSTED "workspace billing cycle
    # spend limit reached". Match the text too, whatever type it has.
    if "spend limit" in low or "billing cycle" in low:
        return False, "Modal spend limit reached", SPEND_LIMIT_FIX + detail
    if is_a("ResourceExhaustedError"):
        return False, "Modal refused the call (resource exhausted)", (
            "Usually the workspace spend limit or a rate limit. "
            + SPEND_LIMIT_FIX + detail)
    if is_a("AuthError") or is_a("PermissionDeniedError"):
        return False, "Modal rejected the token", TOKEN_FIX + detail
    if is_a("NotFoundError"):
        return False, f"Modal app {APP} / function not found", (
            DEPLOY_FIX + " render_r2 is only deployed when the Modal secret "
            "cleocuts-r2 exists (DEPLOY.md section 10)." + detail)
    # FunctionCall.get(timeout) raises the builtin TimeoutError; Modal's
    # own timeouts (OutputExpiredError, ...) derive from modal's.
    if isinstance(exc, TimeoutError) or is_a("TimeoutError"):
        return False, "Modal did not run the probe", (
            f"No answer within {timeout:.0f} s: no capacity, a stuck "
            f"queue or a crashing container. {STUCK_FIX}{detail}")
    if is_a("ConnectionError") or isinstance(
            exc, (ConnectionError, socket.gaierror, socket.herror)):
        return False, "Could not reach Modal", (
            "Network or Modal API trouble. Re-run the workflow; if it "
            f"keeps failing check status.modal.com.{detail}")
    return False, "Modal probe failed", (
        "The call failed inside Modal (crashing container or bad deploy?) "
        f"or with an unexpected error. {STUCK_FIX} If it started after a "
        f"deploy, redeploy the last good commit.{detail}")


# The spawned probe call until it has answered; every other way out
# (timeout, connection error, Ctrl-C, watchdog) cancels it, so a queued
# call can't start an 8-core container hours later when Modal recovers.
_spawned = None


def _cancel_spawned(wait: float = 15) -> None:
    """Best effort, never raises, returns within `wait` s."""
    global _spawned
    call, _spawned = _spawned, None
    if call is None:
        return

    def run() -> None:
        try:
            try:
                # One input per container: this stops only the probe's.
                call.cancel(terminate_containers=True)
            except TypeError:  # a client without the flag
                call.cancel()
        except BaseException:  # noqa: BLE001
            pass
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(wait)


def _watchdog(seconds: float) -> threading.Timer:
    """Hard stop for hangs inside the Modal client (lookup, spawn)."""
    def bail() -> None:
        annotate("error", "Modal probe hung",
                 f"No result within {seconds:.0f} s (lookup, spawn or wait "
                 f"never returned). {STUCK_FIX}")
        summary(f"Modal probe: FAILED — hung for {seconds:.0f} s")
        sys.stdout.flush()
        _cancel_spawned(wait=10)
        os._exit(1)
    t = threading.Timer(seconds, bail)
    t.daemon = True
    t.start()
    return t


def probe(timeout: float, function: str = FUNCTION) -> BaseException | None:
    """Run the call; the exception it ends with (None: it returned)."""
    global _spawned
    import modal

    fn = modal.Function.from_name(APP, function)
    if function == "render_r2":
        call = _spawned = fn.spawn(
            job_id=PROBE_R2_JOB_ID, gen=1,
            mezz_key=f"jobs/{PROBE_R2_JOB_ID}/diag-probe-missing.mp4",
            out_prefix=f"jobs/{PROBE_R2_JOB_ID}/r1/", segments=[],
            subtitles=[], caption_preset="none", cut_style="clean",
            language=None, output_formats=[], segment_effects=[],
            hooks=[])
    else:
        call = _spawned = fn.spawn(
            job_id=PROBE_JOB_ID, input_filename="none.mp4", segments=[],
            subtitles=[], caption_preset="none", cut_style="clean",
            language=None, output_formats=[])
    print("probe: spawned, waiting for the container …", flush=True)
    try:
        call.get(timeout=timeout)
    except BaseException as e:  # noqa: BLE001 — every outcome is data here
        if not classify(e, timeout)[0]:
            _cancel_spawned()
        if isinstance(e, (KeyboardInterrupt, SystemExit)):
            raise
        return e
    finally:
        _spawned = None
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--timeout", type=float, default=180,
                    help="seconds to wait for the container's answer")
    ap.add_argument("--function", default=FUNCTION, choices=FUNCTIONS,
                    help="the render function to probe (the one the API "
                         "uses: CLEO_MODAL_RENDER_FN)")
    ap.add_argument("--grace", type=float, default=90,
                    help="extra seconds for lookup + spawn before the "
                         "watchdog gives up")
    args = ap.parse_args(argv)

    if not (os.environ.get("MODAL_TOKEN_ID")
            and os.environ.get("MODAL_TOKEN_SECRET")):
        annotate("error", "Modal probe not configured",
                 "MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are not set. Add them "
                 "as repo secrets (Settings → Secrets and variables → "
                 "Actions).")
        return 1

    dog = _watchdog(args.timeout + args.grace)
    t0 = time.time()
    spawned = True
    try:
        exc = probe(args.timeout, args.function)
    except BaseException as e:  # import, lookup or spawn failed
        if isinstance(e, (KeyboardInterrupt, SystemExit)):
            raise
        exc, spawned = e, False
    finally:
        dog.cancel()
    took = time.time() - t0

    if exc is None:
        # Someone put a real file at /vol/diag-probe/none.mp4 — odd, but
        # Modal clearly ran it.
        annotate("warning", "Modal probe rendered something",
                 "The probe call returned a result instead of "
                 "FileNotFoundError. Modal works; check the volume for a "
                 "stray diag-probe folder.")
        summary(f"Modal probe: OK (returned) after {took:.0f} s")
        return 0

    healthy, title, fix = classify(exc, args.timeout, spawned)
    if healthy:
        print(f"probe: OK — {fix} after {took:.0f} s "
              f"({type(exc).__name__}, expected)", flush=True)
        summary(f"Modal probe: OK after {took:.0f} s")
        return 0
    print(f"probe: FAILED after {took:.0f} s — {title}", flush=True)
    annotate("error", title, fix)
    summary(f"Modal probe: FAILED — {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
