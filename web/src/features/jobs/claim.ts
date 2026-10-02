/**
 * Claim on sign-in (UX12, review F2): the projects this browser made
 * before its user signed in (the anonymous beta kept them in
 * localStorage) become the account's, so they show up in Projects on
 * every device.
 *
 * There are no owner tokens: a job id is the only key to an anonymous
 * job, and the backend already gives an unowned job to the first
 * signed-in user who asks for it (store.claim). This makes it explicit
 * and complete: all local ids go to POST /me/claim once after sign-in —
 * and again when new ones appear — and the ids the server reports as
 * `missing` (expired, deleted) or `owned_elsewhere` (another account's,
 * e.g. on a shared computer) are dropped from this device's list.
 *
 * Ids already sent are remembered per user (localStorage), so it's one
 * call per sign-in, not one per page load. A backend without the
 * endpoint (404) gets the ids through GET /jobs/status, which claims as
 * a side effect; 429 / 5xx / offline: tried again next time.
 */
import { apiFetch } from "@/lib/api";
import { STATUS_BATCH_MAX } from "@/lib/jobStatus";

/** Ids per POST /me/claim (the backend's limit). */
export const CLAIM_BATCH = 200;

export const CLAIMED_KEY = "cleocuts.jobs.claimed";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export type ClaimOutcome = {
  /** Ids the account has now. */
  claimed: string[];
  /** Ids to drop from this device's list (missing or another account's). */
  drop: string[];
  /** False: stopped early (offline, rate limit) — the rest goes next time. */
  done: boolean;
};

function readSent(userId: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(`${CLAIMED_KEY}:${userId}`) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSent(userId: string, ids: Set<string>): void {
  try {
    // The newest 1000 are plenty: the device list keeps 100.
    localStorage.setItem(`${CLAIMED_KEY}:${userId}`, JSON.stringify([...ids].slice(-1000)));
  } catch {
    /* blocked: claimed again next time (idempotent) */
  }
}

const inflight = new Map<string, Promise<ClaimOutcome>>();

/** Claim `ids` for `userId` (the ones not sent before). */
export function claimLocalJobs(userId: string, ids: string[], fetcher: Fetch = apiFetch): Promise<ClaimOutcome> {
  const running = inflight.get(userId);
  if (running) return running;
  const p = run(userId, ids, fetcher).finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

async function run(userId: string, ids: string[], fetcher: Fetch): Promise<ClaimOutcome> {
  const sent = readSent(userId);
  const todo = [...new Set(ids)].filter((id) => ID_RE.test(id) && !sent.has(id));
  const out: ClaimOutcome = { claimed: [], drop: [], done: true };
  for (let i = 0; i < todo.length; i += CLAIM_BATCH) {
    const batch = todo.slice(i, i + CLAIM_BATCH);
    let r: Response;
    try {
      r = await fetcher("/me/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_ids: batch }),
      });
    } catch {
      out.done = false;
      break;
    }
    if (r.status === 404 || r.status === 405) {
      // A backend from before UX12: the status rows claim too.
      const ok = await viaStatus(batch, fetcher, out);
      if (!ok) {
        out.done = false;
        break;
      }
    } else if (r.ok) {
      let body: { claimed?: unknown; owned_elsewhere?: unknown; missing?: unknown };
      try {
        body = (await r.json()) as typeof body;
      } catch {
        out.done = false;
        break;
      }
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      out.claimed.push(...strs(body.claimed));
      out.drop.push(...strs(body.owned_elsewhere), ...strs(body.missing));
    } else {
      out.done = false; // 401 (session gone), 429, 5xx: next time
      break;
    }
    batch.forEach((id) => sent.add(id));
    writeSent(userId, sent);
  }
  return out;
}

async function viaStatus(batch: string[], fetcher: Fetch, out: ClaimOutcome): Promise<boolean> {
  for (let i = 0; i < batch.length; i += STATUS_BATCH_MAX) {
    const ids = batch.slice(i, i + STATUS_BATCH_MAX);
    try {
      const r = await fetcher(`/jobs/status?ids=${ids.map(encodeURIComponent).join(",")}`, { cache: "no-store" });
      if (!r.ok) return false;
      const body = (await r.json()) as { jobs?: { id?: unknown }[]; missing?: unknown };
      const seen = new Set((body.jobs ?? []).map((j) => String(j.id ?? "")));
      out.claimed.push(...ids.filter((id) => seen.has(id)));
      out.drop.push(...ids.filter((id) => !seen.has(id)));
    } catch {
      return false;
    }
  }
  return true;
}
