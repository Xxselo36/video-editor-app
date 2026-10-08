// POST /jobs after the upload (PR #66 review): a lost connection is
// waited out for as long as it was really gone (offline, the page
// hidden), but no answer while online and visible — a server bug can
// look like that — stops after POST_JOBS_NET_CAP_MS; network failures
// don't use up the 5xx budget; Cancel stops a wait for the connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/account", () => ({
  fetchServerJobs: vi.fn(async () => null),
  refreshMe: vi.fn(),
  paywallFrom: vi.fn(() => null),
  toMs: () => null,
}));
vi.mock("./records", () => ({
  knownJobIds: async () => new Set(),
  liveUploads: new Set(),
  recordJobCreated: vi.fn(),
  recordUploadFailed: vi.fn(),
  removeStoppedUploads: vi.fn(),
  removeUploadRecord: vi.fn(),
  uploadProgress: vi.fn(),
}));

/** "hold": the try stays out until `answerHeld` gives its answer. */
type Answer = number | "net" | "hold";
const answers: Answer[] = [];
let tries = 0;
let answerHeld: (status: number | "net") => void = () => {};
const xhr = (status: number) =>
  ({ status, responseText: status === 200 ? '{"id":"j1"}' : '{"detail":"storage_error"}' }) as XMLHttpRequest;
const post = async () => {
  tries++;
  const a = answers.shift() ?? 200;
  if (a === "net") throw new Error("Network error");
  if (a === "hold") {
    return new Promise<XMLHttpRequest>((resolve, reject) => {
      answerHeld = (st) => (st === "net" ? reject(new Error("Network error")) : resolve(xhr(st)));
    });
  }
  return xhr(a);
};

beforeEach(() => {
  vi.useFakeTimers();
  answers.length = 0;
  tries = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

async function run(opts: { lost?: () => boolean; signal?: AbortSignal; legacyApi?: boolean } = {}) {
  const { postJobsWithRetry } = await import("./uploadJob");
  const paused: boolean[] = [];
  const p = postJobsWithRetry(post, {
    lost: opts.lost ?? (() => false),
    signal: opts.signal,
    legacyApi: opts.legacyApi,
    setPaused: (on) => paused.push(on),
  });
  return { p, paused };
}

describe("POST /jobs retries", () => {
  it("no answer while online and visible: stops after the cap (then findJobCreatedFor / the error)", async () => {
    const { POST_JOBS_NET_CAP_MS } = await import("./uploadJob");
    answers.push(...Array<Answer>(500).fill("net"));
    const { p, paused } = await run();
    await vi.advanceTimersByTimeAsync(POST_JOBS_NET_CAP_MS + 60_000);
    const r = await p;
    expect(r.stopped).toBe(false);
    expect(r.failure).toBeInstanceOf(Error);
    expect(tries).toBeGreaterThan(10);
    expect(tries).toBeLessThan(80);
    expect(paused).toEqual([true, false]);
  });

  it("a connection really gone (offline / hidden) is waited out past the cap, then the job is created", async () => {
    const { POST_JOBS_NET_CAP_MS } = await import("./uploadJob");
    answers.push(...Array<Answer>(120).fill("net"), 200);
    const { p, paused } = await run({ lost: () => true });
    await vi.advanceTimersByTimeAsync(3 * POST_JOBS_NET_CAP_MS);
    const r = await p;
    expect(r.failure).toBeNull();
    expect(r.res?.status).toBe(200);
    expect(tries).toBe(121);
    expect(paused).toEqual([true, false]);
  });

  it("network failures don't use up the 5xx budget", async () => {
    answers.push(...Array<Answer>(10).fill("net"), 502, 502, 502, 502, 502, 502, 502, 200);
    const { p } = await run({ lost: () => true });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const r = await p;
    expect(r.failure).toBeNull();
    expect(tries).toBe(18);
  });

  it("a 5xx alone keeps its ~75 s budget", async () => {
    answers.push(...Array<Answer>(20).fill(502));
    const { p } = await run();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const r = await p;
    expect(r.failure).toBeInstanceOf(Error);
    expect(tries).toBe(8);
  });

  it("Cancel while it waits for the connection stops it", async () => {
    answers.push(...Array<Answer>(100).fill("net"));
    const ctl = new AbortController();
    const { p } = await run({ lost: () => true, signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(30_000);
    const before = tries;
    ctl.abort();
    const r = await p;
    expect(r.stopped).toBe(true);
    expect(tries).toBe(before);
  });

  it("a backend from before WP3 (not idempotent): one try", async () => {
    answers.push("net");
    const { p } = await run({ legacyApi: true });
    const r = await p;
    expect(r.failure).toBeInstanceOf(Error);
    expect(tries).toBe(1);
  });

  it("Cancel during a try stops at once; the try still out is handed over (its answer may be the job)", async () => {
    answers.push("net", "net", "hold");
    const ctl = new AbortController();
    const { p, paused } = await run({ lost: () => true, signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tries).toBe(3);
    expect(paused).toEqual([true]);
    ctl.abort();
    const r = await p;
    expect(r.stopped).toBe(true);
    expect(r.inflight).toBeDefined();
    answerHeld(200);
    await expect(r.inflight).resolves.toMatchObject({ status: 200 });
  });

  it("an answer that comes after Cancel goes the cancel way (no paywall, no sign-in); a job among them is handed over", async () => {
    const { postJobsWithRetry } = await import("./uploadJob");
    for (const status of [401, 402, 200]) {
      const ctl = new AbortController();
      // The try goes out, Cancel comes while it is out, then its answer.
      const late = async () => {
        ctl.abort();
        return xhr(status);
      };
      const r = await postJobsWithRetry(late, { signal: ctl.signal, setPaused: () => {}, lost: () => false });
      expect(r.stopped).toBe(true);
      // (uploadJob: a 2xx there is the job — "couldn't be cancelled any more".)
      await expect(r.inflight).resolves.toMatchObject({ status });
    }
  });

  it("the cap's clock only pauses while the connection is gone (it doesn't start over)", async () => {
    const { POST_JOBS_NET_CAP_MS } = await import("./uploadJob");
    answers.push(...Array<Answer>(2000).fill("net"));
    let n = 0;
    // Every other failure with the page hidden (a phone): half the time counts.
    const { p } = await run({ lost: () => n++ % 2 === 1 });
    await vi.advanceTimersByTimeAsync(3 * POST_JOBS_NET_CAP_MS);
    const r = await p;
    expect(r.stopped).toBe(false);
    expect(r.failure).toBeInstanceOf(Error);
  });

  it("withTimeout: a token fetch that hangs is a failed try", async () => {
    const { withTimeout } = await import("./uploadJob");
    const hung = withTimeout(new Promise<never>(() => {}), 30_000);
    const seen = hung.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(seen).resolves.toBe("Network error");
    await expect(withTimeout(Promise.resolve(7), 30_000)).resolves.toBe(7);
  });
});
