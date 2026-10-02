// Claim on sign-in (UX12, review F2): local ids go to POST /me/claim once
// per user; missing and other accounts' ids are dropped; an older backend
// claims through the status rows; failures are tried again next time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./test-storage";
import { CLAIM_BATCH, CLAIMED_KEY, claimLocalJobs } from "./claim";

const storage = new MemoryStorage();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => vi.unstubAllGlobals());

type Call = { path: string; body: unknown };

function fakeFetch(answer: (path: string, body: { job_ids?: string[] } | null) => Response) {
  const calls: Call[] = [];
  const f = async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    return answer(path, body);
  };
  return { f, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

describe("claimLocalJobs", () => {
  it("claims once, drops missing and other accounts' ids", async () => {
    const { f, calls } = fakeFetch((_p, body) => {
      const ids = body?.job_ids ?? [];
      return json({
        claimed: ids.filter((i) => i.startsWith("mine")),
        owned_elsewhere: ids.filter((i) => i.startsWith("theirs")),
        missing: ids.filter((i) => i.startsWith("gone")),
      });
    });
    const out = await claimLocalJobs("u1", ["mine1", "theirs1", "gone1", "mine1", "upl-x", "../bad"], f);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: "/me/claim", body: { job_ids: ["mine1", "theirs1", "gone1", "upl-x"] } });
    expect(out).toEqual({ claimed: ["mine1"], drop: ["theirs1", "gone1"], done: true });
    // Sent before: not again (one call per sign-in, not per page load).
    const again = await claimLocalJobs("u1", ["mine1", "theirs1", "mine2"], f);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ job_ids: ["mine2"] });
    expect(again.claimed).toEqual(["mine2"]);
    // Another user on this device: their own call.
    await claimLocalJobs("u2", ["mine1"], f);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(storage.getItem(`${CLAIMED_KEY}:u1`)!)).toEqual(["mine1", "theirs1", "gone1", "upl-x", "mine2"]);
  });

  it("batches of 200", async () => {
    const { f, calls } = fakeFetch((_p, body) => json({ claimed: body?.job_ids ?? [], owned_elsewhere: [], missing: [] }));
    const ids = Array.from({ length: CLAIM_BATCH + 7 }, (_, i) => `j${i}`);
    const out = await claimLocalJobs("u3", ids, f);
    expect(calls.map((c) => (c.body as { job_ids: string[] }).job_ids.length)).toEqual([CLAIM_BATCH, 7]);
    expect(out.claimed).toHaveLength(CLAIM_BATCH + 7);
  });

  it("a backend before UX12 (404): the status rows claim", async () => {
    const { f, calls } = fakeFetch((path) =>
      path === "/me/claim" ? json({ detail: "Not Found" }, 404) : json({ jobs: [{ id: "a" }], missing: ["b"] }),
    );
    const out = await claimLocalJobs("u4", ["a", "b"], f);
    expect(calls.map((c) => c.path)).toEqual(["/me/claim", "/jobs/status?ids=a,b"]);
    expect(out).toEqual({ claimed: ["a"], drop: ["b"], done: true });
  });

  it("rate limited or offline: nothing dropped, tried again next time", async () => {
    let n = 0;
    const { f } = fakeFetch(() => {
      n++;
      if (n === 1) return json({ detail: "too_many_requests" }, 429);
      return json({ claimed: ["a"], owned_elsewhere: [], missing: [] });
    });
    expect(await claimLocalJobs("u5", ["a"], f)).toEqual({ claimed: [], drop: [], done: false });
    expect(await claimLocalJobs("u5", ["a"], f)).toEqual({ claimed: ["a"], drop: [], done: true });
    const offline = await claimLocalJobs("u6", ["a"], async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(offline.done).toBe(false);
  });
});
