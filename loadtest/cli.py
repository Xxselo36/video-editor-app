"""Command line: python -m loadtest <scenario> [options] (see README.md)."""
from __future__ import annotations

import argparse
import asyncio
import os
import signal
import sys
import traceback

from . import report
from .common import (
    DEFAULT_BASE_URL, RESULTS_DIR, UsageError, admin_identity, auth_mode, call,
    delete_jobs, is_local, make_session, read_ids, user_identities,
)
from .scenarios import abuse, burst, editor_saves, media, poll_soak

SCENARIOS = {m.NAME: m for m in (poll_soak, editor_saves, media, burst, abuse)}
# Scenarios that cost real money on a real target (Groq, Claude, Modal).
EXPENSIVE = {"burst"}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m loadtest",
        description="CleoCuts load tests (WP7). Every scenario except "
                    "poll-soak needs an explicit --base-url.")
    sub = p.add_subparsers(dest="scenario", required=True, metavar="scenario")
    common = argparse.ArgumentParser(add_help=False)
    g = common.add_argument_group("common")
    g.add_argument("--base-url", default=None,
                   help=f"API to test (poll-soak default: {DEFAULT_BASE_URL})")
    g.add_argument("--identity", choices=["auto", "admin", "user", "none"],
                   default="auto",
                   help="who the load is sent as: admin = X-Admin-Token "
                        "(CLEO_ADMIN_TOKEN), user = Clerk test users "
                        "(CLEO_TEST_BEARER / CLEO_TEST_SESSION_IDS), none = "
                        "anonymous; auto = admin if the token is set")
    g.add_argument("--ids", help="job ids, comma-separated")
    g.add_argument("--ids-file", help="file with job ids (comma/line separated)")
    g.add_argument("--procs", type=int, default=0,
                   help="load-generator processes (0 = auto)")
    g.add_argument("--timeout", type=float, default=30.0,
                   help="per-request timeout, seconds")
    g.add_argument("--p95-ms", type=float, default=200.0,
                   help="p95 threshold for cheap reads")
    g.add_argument("--max-error-rate", type=float, default=0.001,
                   help="allowed share of transport errors (timeouts, resets)")
    g.add_argument("--max-refusal-rate", type=float,
                   default=report.MAX_REFUSAL_RATE,
                   help="allowed share of 429/503 refusals (with Retry-After) "
                        "per endpoint; above it the endpoint counts as not "
                        "measured (FAIL)")
    g.add_argument("--out", default=str(RESULTS_DIR),
                   help="directory for the .md/.json report")
    g.add_argument("--seed", type=int, default=None)
    g.add_argument("--i-understand-this-costs-money", dest="costs_ok",
                   action="store_true",
                   help="required for burst, and for uploads in abuse against "
                        "a non-local target")
    for mod in SCENARIOS.values():
        sp = sub.add_parser(mod.NAME, parents=[common], help=mod.HELP,
                            description=mod.__doc__,
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        mod.add_args(sp)
    sub.add_parser("whoami", parents=[common],
                   help="check the configured identities (GET /me)")
    sub.add_parser("cleanup", parents=[common],
                   help="delete job ids left over by an aborted run")
    return p


def resolve_base_url(args) -> str:
    if args.base_url:
        base = args.base_url.rstrip("/")
    elif args.scenario == "poll-soak":
        base = DEFAULT_BASE_URL
    else:
        raise UsageError(f"{args.scenario} needs an explicit --base-url "
                         "(only poll-soak defaults to production)")
    if not base.startswith(("http://", "https://")):
        raise UsageError(f"--base-url must start with http:// or https://: {base}")
    if args.scenario in EXPENSIVE and not args.costs_ok:
        raise UsageError(f"{args.scenario} costs real money (Groq, Claude, "
                         "Modal): add --i-understand-this-costs-money")
    return base


async def _whoami(args, base: str) -> int:
    idents = ([admin_identity()] if admin_identity() else []) + user_identities()
    if not idents:
        print("no identities configured (CLEO_ADMIN_TOKEN, CLEO_TEST_BEARER, "
              "CLEO_TEST_SESSION_IDS + CLERK_SECRET_KEY)")
        return 1
    bad = 0
    async with make_session(args.timeout) as s:
        for ident in idents:
            try:
                r = await call(s, None, "", "GET", base + "/me",
                               headers=await ident.headers(s))
            except Exception as e:
                print(f"{ident.label}: {e}")
                bad += 1
                continue
            body = r.json() if r.status == 200 else None
            if isinstance(body, dict):
                user = (body.get("user") or {}).get("id")
                mins = body.get("minutes") or {}
                print(f"{ident.label}: auth_enabled={body.get('auth_enabled')} "
                      f"user={user} plan={body.get('plan')} "
                      f"remaining_s={mins.get('remaining_seconds')}")
            else:
                print(f"{ident.label}: HTTP {r.status or r.error}")
                bad += 1
    return 1 if bad else 0


async def _cleanup(args, base: str) -> int:
    if args.ids_file and not os.path.exists(args.ids_file) and not args.ids:
        print(f"{args.ids_file}: no such file — nothing was created")
        return 0
    ids = read_ids(args.ids, args.ids_file)
    if not ids and args.ids_file:
        print(f"{args.ids_file} lists no job ids — nothing to delete")
        return 0
    if not ids:
        raise UsageError("cleanup needs --ids / --ids-file")
    from .common import resolve_identities
    ident = resolve_identities(args.identity)[0]
    async with make_session(args.timeout) as s:
        await auth_mode(s, base, ident)
        left = await delete_jobs(s, base, ident, ids, timeout=1800)
    if left:
        print("could not delete: " + ",".join(left))
    return 1 if left else 0


def _sigterm_as_interrupt() -> None:
    """SIGTERM (CI cancel / timeout, `kill`) takes the Ctrl-C path, so the
    scenarios' cleanup `finally` blocks run. Re-raised as SIGINT: inside
    asyncio.run that cancels the main task (its finally still awaits)
    instead of tearing the loop down."""
    def handler(signum, frame):
        signal.raise_signal(signal.SIGINT)
    try:
        signal.signal(signal.SIGTERM, handler)
    except ValueError:  # not the main thread (tests)
        pass


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _sigterm_as_interrupt()
    try:
        base = resolve_base_url(args)
        if args.scenario == "whoami":
            return asyncio.run(_whoami(args, base))
        if args.scenario == "cleanup":
            return asyncio.run(_cleanup(args, base))
        if not is_local(base):
            print(f"target: {base} (not local)", file=sys.stderr)
        res = SCENARIOS[args.scenario].main(args, base)
    except UsageError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    except Exception:
        traceback.print_exc()
        return 1
    res.meta.setdefault("Commit", report.git_rev())
    path, text = report.write(res, args.out)
    print(text)
    print(f"report: {path}", file=sys.stderr)
    return 0 if res.verdict == report.PASS else 1
