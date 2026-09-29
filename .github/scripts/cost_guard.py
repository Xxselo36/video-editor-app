"""Cost guard: is the last 24 h of processing spend under the limit?

Reads GET /admin/costs (X-Admin-Token) and adds up usd_all_in of every
job that was created or updated in the last 24 hours. A job's whole
cost counts once it had any activity in the window, so the sum is an
upper bound for the window (a re-render of an old job counts that job's
earlier costs too); jobs created *and* deleted inside the window are
gone from the list and not counted.

Job times come from the /admin/costs rows when they carry created_at /
updated_at, otherwise from GET /jobs (all jobs for the admin token).
With accounts off /jobs is 404: if even the all-time total is under
the limit, the last 24 h are too; if not, the jobs' updated_at comes
from GET /jobs/status (anonymous while accounts are off, 50 ids per
request). Only when that fails too does the guard fail and say so
instead of guessing.

Env: CLEO_ADMIN_TOKEN (required), CLEO_API (default
https://api.cleocuts.com), COST_ALERT_USD_PER_DAY (default 10; set
from a repo *secret*, because the runner prints every non-secret step
env value in the public log).

Logs are public: prints OK / ABOVE THRESHOLD and what to do — never
dollar amounts, job ids or response bodies. Exit 1 on ABOVE THRESHOLD
or when the check can't run.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WINDOW_S = 24 * 3600
DEFAULT_LIMIT = 10.0
RETRY_WAIT_S = 30
STATUS_BATCH = 50  # GET /jobs/status takes at most 50 ids

API = os.environ.get("CLEO_API", "https://api.cleocuts.com").rstrip("/")


def _escape_data(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_prop(s: str) -> str:
    return _escape_data(s).replace(":", "%3A").replace(",", "%2C")


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


class CheckError(Exception):
    """The check could not run; str() is safe to print."""


def get_json(path: str, token: str, *, sleep=time.sleep):
    """GET API+path as the admin. One retry after RETRY_WAIT_S for
    network errors and 5xx; returns (status, parsed body or None)."""
    last = ""
    for attempt in (1, 2):
        req = urllib.request.Request(API + path, headers={
            "X-Admin-Token": token, "Accept": "application/json",
            "User-Agent": "cleocuts-ops-watch"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return e.code, None
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError) as e:
            reason = getattr(e, "reason", e)
            last = type(reason).__name__
        except ValueError:
            raise CheckError(f"{path.split('?')[0]} did not return JSON")
        if attempt == 1:
            print(f"{path.split('?')[0]}: {last}, retrying in "
                  f"{RETRY_WAIT_S} s", flush=True)
            sleep(RETRY_WAIT_S)
    raise CheckError(f"{path.split('?')[0]} failed twice ({last})")


def _ts(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def window_spend(costs: dict, job_times: dict[str, tuple] | None,
                 now: float) -> float:
    """Sum of usd_all_in over the jobs active since now - WINDOW_S.

    job_times: id → (created_at, updated_at) from GET /jobs, used for
    rows without their own timestamps. A row whose job isn't there
    (created between the two requests) counts — erring towards alerts.
    """
    cutoff = now - WINDOW_S
    total = 0.0
    for row in costs.get("rows") or []:
        if "created_at" in row or "updated_at" in row:
            times = (row.get("created_at"), row.get("updated_at"))
        elif job_times is not None:
            times = job_times.get(row.get("job_id"), (now, now))
        else:
            raise CheckError("no job times")
        if max(_ts(t) for t in times) >= cutoff:
            total += float(row.get("usd_all_in") or 0.0)
    return total


def check(token: str, limit: float, now: float, *, fetch=get_json) -> bool:
    """True if the last 24 h are at or under `limit` (raises CheckError
    when that can't be told)."""
    status, costs = fetch("/admin/costs", token)
    if status == 401:
        raise CheckError(
            "The API rejected CLEO_ADMIN_TOKEN (401). The GitHub secret "
            "and CLEO_ADMIN_TOKEN on Railway (backend service → "
            "Variables) must be the same value.")
    if status == 404:
        raise CheckError(
            "/admin/costs answered 404: CLEO_ADMIN_TOKEN is not set on "
            "the backend (Railway → backend service → Variables).")
    if status != 200 or not isinstance(costs, dict):
        raise CheckError(f"/admin/costs answered HTTP {status}")

    rows = costs.get("rows") or []
    if not rows:
        return True
    timed = all("created_at" in r or "updated_at" in r for r in rows)
    job_times = None
    if not timed:
        status, jobs = fetch("/jobs", token)
        if status == 200 and isinstance(jobs, list):
            job_times = {j.get("id"): (j.get("created_at"),
                                       j.get("updated_at"))
                         for j in jobs if isinstance(j, dict)}
        else:
            print(f"/jobs: HTTP {status}, falling back to the all-time "
                  "total, then GET /jobs/status", flush=True)
    if timed or job_times is not None:
        return window_spend(costs, job_times, now) <= limit
    # No job times: the all-time total bounds the last 24 h from above.
    if sum(float(r.get("usd_all_in") or 0.0) for r in rows) <= limit:
        return True
    job_times = status_times(rows, token, fetch)
    if job_times is not None:
        return window_spend(costs, job_times, now) <= limit
    raise CheckError(
        "Can't tell the last 24 h apart: neither GET /jobs nor GET "
        "/jobs/status answered, and /admin/costs rows carry no "
        "created_at / updated_at (see OPERATIONS.md → Kosten-Check).")


def status_times(rows: list, token: str,
                 fetch=get_json) -> dict[str, tuple] | None:
    """id → (None, updated_at) from GET /jobs/status, which works while
    accounts are off (/jobs is 404 then) and never claims jobs; None if
    it doesn't answer. updated_at is set on create and on every change,
    so it alone tells whether the job was active. Jobs it lists as
    missing are left out and so count (see window_spend)."""
    ids = list(dict.fromkeys(str(r.get("job_id")) for r in rows
                             if r.get("job_id")))
    times: dict[str, tuple] = {}
    for i in range(0, len(ids), STATUS_BATCH):
        chunk = ",".join(ids[i:i + STATUS_BATCH])
        status, body = fetch(
            "/jobs/status?ids=" + urllib.parse.quote(chunk, safe=","), token)
        if status != 200 or not isinstance(body, dict):
            print(f"/jobs/status: HTTP {status}", flush=True)
            return None
        for j in body.get("jobs") or []:
            if isinstance(j, dict) and j.get("id"):
                times[j["id"]] = (None, j.get("updated_at"))
    return times


def main() -> int:
    token = os.environ.get("CLEO_ADMIN_TOKEN", "")
    if not token:
        annotate("error", "Cost guard not configured",
                 "The CLEO_ADMIN_TOKEN repo secret is not set (Settings → "
                 "Secrets and variables → Actions).")
        return 1
    raw = os.environ.get("COST_ALERT_USD_PER_DAY", "").strip()
    try:
        limit = float(raw) if raw else DEFAULT_LIMIT
        if not limit > 0:
            raise ValueError
    except ValueError:
        annotate("error", "Cost guard misconfigured",
                 "The COST_ALERT_USD_PER_DAY repo secret must be a "
                 "positive number of US dollars, e.g. 10.")
        return 1

    try:
        ok = check(token, limit, time.time())
    except CheckError as e:
        print("cost guard: CHECK FAILED", flush=True)
        annotate("error", "Cost guard could not run", str(e))
        summary("Cost guard: CHECK FAILED")
        return 1
    if ok:
        print("cost guard: OK", flush=True)
        summary("Cost guard: OK")
        return 0
    print("cost guard: ABOVE THRESHOLD", flush=True)
    annotate("error", "Spend above COST_ALERT_USD_PER_DAY",
             "Processing spend in the last 24 h is above the limit. Look "
             "at GET /admin/costs (see OPERATIONS.md → Kosten-Alarm) for "
             "the jobs behind it; raise the COST_ALERT_USD_PER_DAY repo "
             "secret if the spend is expected.")
    summary("Cost guard: ABOVE THRESHOLD")
    return 1


if __name__ == "__main__":
    sys.exit(main())
