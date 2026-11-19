// The Vorschau's poll (useJobPoll → jobPoll.ts): the editor's last saves
// before the first answer and after it, and the preview of the stored
// timeline (asked for when nothing builds it, once more after a failure;
// given up on one the server keeps refusing or that never ends);
// requests without an answer; and at rest, the look at the job's status
// row that notices what another device did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobStatus } from "@/features/jobs/types";

const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init) }));
vi.mock("@/features/jobs/localJobs", () => ({ setExportHint: () => {} }));

const { changedSince, previewBehind, previewOutdated, startJobPoll, BUILD_MAX_MS, PREVIEW_ERRORS, REQUEST_MS, REST_MS, SAVES_WAIT_MS } =
  await import("./jobPoll");
const { trackSave } = await import("@/lib/pendingSaves");
type Load = import("./jobPoll").Load;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const seg = (start: number, end: number, speed = 1) => ({ start, end, speed, fadeIn: 0, fadeOut: 0, volume: 1 });

/** A job in review whose preview v1 shows its stored timeline (rev 1). */
const ready = (over: Partial<JobStatus> = {}): JobStatus =>
  ({
    id: "j",
    status: "awaiting_review",
    duration: 30,
    edit_rev: 1,
    edit_segments: [seg(0, 5), seg(6, 12)],
    preview_segments: [
      [0, 5],
      [6, 12],
    ],
    preview_version: 1,
    preview_status: "ready",
    ...over,
  }) as JobStatus;

/** The same job after a cut was stored (rev 2): its preview not rebuilt yet. */
const cut = (status: JobStatus["preview_status"], over: Partial<JobStatus> = {}): JobStatus =>
  ready({ edit_rev: 2, edit_segments: [seg(0, 5), seg(8, 12)], preview_status: status, ...over });

/** The row GET /jobs/status lists for `job` (backend _status_rows: the fields a look at rest compares). */
const statusRow = (id: string, job: JobStatus) => ({
  id,
  status: job.status,
  message: "",
  progress: 100,
  renders_ok: job.renders_ok ?? 0,
  preview_version: job.preview_version ?? null,
  title: job.title ?? null,
  updated_at: job.updated_at ?? null,
});

/** A weak ETag of a body (the backend's is its SHA-1). */
const etagOf = (body: unknown) => {
  let h = 0;
  for (const c of JSON.stringify(body)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `W/"${h}"`;
};

/**
 * A fake backend: GET /jobs/{id} answers `job` (404 once `gone`); POST
 * /jobs/{id}/preview `post()` ("net": no answer); GET /jobs/status?ids=
 * (a look at rest, counted apart: `checks`) its status row with an ETag,
 * an empty 304 for the same one again (`unchanged`).
 */
function backend(first: JobStatus) {
  const srv = {
    job: first,
    gone: false,
    gets: 0,
    posts: 0,
    checks: 0,
    unchanged: 0,
    post: (): Response | "net" => json({ preview_status: "building" }),
  };
  apiFetch.mockImplementation(async (path, init) => {
    if (init?.method === "POST") {
      expect(path).toMatch(/^\/jobs\/[^/]+\/preview$/);
      srv.posts++;
      const a = srv.post();
      if (a === "net") throw new TypeError("offline");
      return a;
    }
    if (path.startsWith("/jobs/status?")) {
      srv.checks++;
      const id = new URLSearchParams(path.split("?")[1]).get("ids")!;
      const body = srv.gone ? { jobs: [], missing: [id] } : { jobs: [statusRow(id, srv.job)], missing: [] };
      const tag = etagOf(body);
      if (new Headers(init?.headers).get("If-None-Match") === tag) {
        srv.unchanged++;
        return new Response(null, { status: 304, headers: { ETag: tag } });
      }
      return json(body, 200, { ETag: tag });
    }
    srv.gets++;
    return srv.gone ? json({ detail: "not_found" }, 404) : json(srv.job);
  });
  return srv;
}

function events() {
  const ev = { loads: [] as Load[], settled: [] as number[], failed: [] as boolean[], editor: 0 };
  const on = {
    v2: true,
    load: (l: Load) => ev.loads.push(l),
    // the length of `loads` when it came: which job came with it
    settled: () => ev.settled.push(ev.loads.length),
    previewFailed: (f: boolean) => ev.failed.push(f),
    toEditor: () => ev.editor++,
  };
  return { ev, on };
}

const lastJob = (loads: Load[]) => {
  const l = loads[loads.length - 1];
  return l?.state === "job" ? l.job : null;
};

/** A save the test settles itself. */
function save() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};

let stop: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  stop?.();
  stop = null;
  apiFetch.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("previewBehind: does the preview show the stored timeline?", () => {
  it("yes: ready, with the stored clips (within the server's 1 ms rounding; the speed is the player's)", () => {
    expect(previewBehind(ready())).toBe(false);
    expect(previewBehind(ready({ preview_segments: [[0.0004, 5], [6, 12.0006]] }))).toBe(false);
    expect(previewBehind(ready({ edit_segments: [seg(0, 5, 2), seg(6, 12)] }))).toBe(false);
  });

  it("no: the server builds it, nothing builds it, or its build failed", () => {
    expect(previewBehind(cut("building"))).toBe(true);
    expect(previewBehind(cut("stale"))).toBe(true);
    expect(previewBehind(cut("failed"))).toBe(true);
    // the first preview of a fresh job (proxy playback): version 0, stale
    expect(previewBehind(ready({ preview_version: 0, preview_status: "stale" }))).toBe(true);
  });

  it("no: its clips aren't the stored ones, whatever the status says", () => {
    expect(previewBehind(cut("ready"))).toBe(true);
    expect(previewBehind(cut(undefined))).toBe(true);
    expect(previewBehind(ready({ preview_status: undefined }))).toBe(false);
  });

  it("only in review", () => {
    expect(previewBehind(cut("stale", { status: "done" }))).toBe(false);
    expect(previewBehind(cut("stale", { status: "processing" }))).toBe(false);
  });

  it("previewOutdated: the same rule while Fertigstellen runs (the frame plays none such then either)", () => {
    expect(previewOutdated(cut("building", { status: "processing" }))).toBe(true);
    expect(previewOutdated(cut("stale", { status: "pending" }))).toBe(true);
    expect(previewOutdated(cut("ready", { status: "processing" }))).toBe(true);
    expect(previewOutdated(ready({ status: "processing" }))).toBe(false);
    expect(previewOutdated(ready({ status: "processing", preview_status: undefined }))).toBe(false);
  });
});

describe("the editor's last saves", () => {
  it("the first GET waits for them; the job then is from after them (settled)", async () => {
    const srv = backend(ready());
    const s = save();
    trackSave("j-a", s.p);
    const { ev, on } = events();
    stop = startJobPoll("j-a", on).stop;
    await vi.advanceTimersByTimeAsync(SAVES_WAIT_MS - 1000);
    expect(srv.gets).toBe(0);
    expect(ev.loads).toEqual([]);
    srv.job = ready({ edit_rev: 3 });
    s.resolve();
    await flush();
    expect(srv.gets).toBe(1);
    expect(lastJob(ev.loads)?.edit_rev).toBe(3);
    expect(ev.settled).toEqual([1]);
    // ready, nothing out: no more polls
    await vi.advanceTimersByTimeAsync(20_000);
    expect(srv.gets).toBe(1);
  });

  it("still out after the wait: the job as it is, polled on, asked again the moment they settle", async () => {
    const srv = backend(ready());
    const s = save();
    trackSave("j-b", s.p);
    const { ev, on } = events();
    stop = startJobPoll("j-b", on).stop;
    await vi.advanceTimersByTimeAsync(SAVES_WAIT_MS - 1);
    expect(srv.gets).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(srv.gets).toBe(1);
    expect(lastJob(ev.loads)?.edit_rev).toBe(1);
    expect(ev.settled).toEqual([]);
    // a ready job, but a save is out: the poll goes on
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(2);
    await vi.advanceTimersByTimeAsync(900);
    // the save lands: the server has the cut; asked at once, not 2 s later
    srv.job = cut("building");
    s.resolve();
    await flush();
    expect(srv.gets).toBe(3);
    expect(lastJob(ev.loads)?.edit_rev).toBe(2);
    expect(ev.settled).toEqual([ev.loads.length]);
  });

  it("they land while the first GET after the wait is out, read before them: asked again at once, the stored cut, settled", async () => {
    const s = save();
    trackSave("j-m", s.p);
    let job = ready();
    let gets = 0;
    let answerFirst!: () => void;
    apiFetch.mockImplementation(async () => {
      gets++;
      // the first GET is read on the server now, its answer comes later (a slow link)
      if (gets === 1) {
        const asRead = job;
        return new Promise<Response>((r) => (answerFirst = () => r(json(asRead))));
      }
      return json(job);
    });
    const { ev, on } = events();
    stop = startJobPoll("j-m", on).stop;
    await vi.advanceTimersByTimeAsync(SAVES_WAIT_MS);
    await flush();
    expect(gets).toBe(1);
    // the save lands (the server has the cut, its preview built) before that GET's answer
    job = cut("ready", { preview_segments: [[0, 5], [8, 12]], preview_version: 2 });
    s.resolve();
    await flush();
    answerFirst();
    await flush();
    expect(gets).toBe(2);
    expect(lastJob(ev.loads)?.edit_rev).toBe(2);
    expect(lastJob(ev.loads)?.preview_version).toBe(2);
    expect(ev.settled).toEqual([ev.loads.length]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gets).toBe(2);
  });

  it("nothing out: asked at once, nothing settled", async () => {
    const srv = backend(ready());
    const { ev, on } = events();
    stop = startJobPoll("j-c", on).stop;
    await flush();
    expect(srv.gets).toBe(1);
    expect(ev.settled).toEqual([]);
  });
});

describe("the preview of the stored timeline", () => {
  it("stale: asked for once per revision (POST /preview), then followed while it builds, until it is ready", async () => {
    const srv = backend(cut("stale"));
    const { ev, on } = events();
    stop = startJobPoll("j-d", on).stop;
    await flush();
    expect(srv.gets).toBe(1);
    expect(srv.posts).toBe(1);
    srv.job = cut("building");
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(3);
    expect(srv.posts).toBe(1);
    // a newer timeline is stored: asked for that one
    srv.job = cut("stale", { edit_rev: 3, edit_segments: [seg(0, 4), seg(8, 12)] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(4);
    expect(srv.posts).toBe(2);
    srv.job = ready({ edit_rev: 3, edit_segments: [seg(0, 4), seg(8, 12)], preview_segments: [[0, 4], [8, 12]], preview_version: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(5);
    expect(lastJob(ev.loads)?.preview_version).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(srv.gets).toBe(5);
    expect(srv.posts).toBe(2);
    expect(ev.failed).toEqual([]);
  });

  it("stale again after its build started (lost: a backend restart or deploy): asked again, at most twice, then given up", async () => {
    const srv = backend(cut("stale"));
    const { ev, on } = events();
    stop = startJobPoll("j-l", on).stop;
    await flush();
    expect(srv.posts).toBe(1);
    // The POST said "building", but nothing builds it any more: the same revision is stale again.
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(2);
    expect(srv.posts).toBe(2);
    // a GET saw this one building; lost again
    srv.job = cut("building");
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.posts).toBe(2);
    srv.job = cut("stale");
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(4);
    expect(srv.posts).toBe(3);
    expect(ev.failed).toEqual([]);
    // lost a third time: given up (previewFailed: the Vorschau says so), no more polls
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(5);
    expect(srv.posts).toBe(3);
    expect(ev.failed).toEqual([true]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.gets).toBe(5);
    expect(srv.posts).toBe(3);
  });

  it("a fresh job's first preview (version 0, stale) is asked for the same way", async () => {
    const srv = backend(ready({ preview_version: 0, preview_status: "stale" }));
    const { on } = events();
    stop = startJobPoll("j-e", on).stop;
    await flush();
    expect(srv.posts).toBe(1);
  });

  it("failed: asked once more; failed again: given up (previewFailed), no more polls", async () => {
    const srv = backend(cut("failed"));
    const { ev, on } = events();
    stop = startJobPoll("j-f", on).stop;
    await flush();
    expect(srv.posts).toBe(1);
    expect(ev.failed).toEqual([]);
    srv.job = cut("building");
    await vi.advanceTimersByTimeAsync(2000);
    srv.job = cut("failed");
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.posts).toBe(1);
    expect(ev.failed).toEqual([true]);
    const gets = srv.gets;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(srv.gets).toBe(gets);
    expect(srv.posts).toBe(1);
  });

  it("refused (410: nothing to build from): once more, then given up", async () => {
    const srv = backend(cut("stale"));
    srv.post = () => json({ detail: "normalized video no longer on disk" }, 410);
    const { ev, on } = events();
    stop = startJobPoll("j-g", on).stop;
    await flush();
    expect(srv.posts).toBe(2);
    expect(ev.failed).toEqual([true]);
  });

  it("no answer to the POST: asked again with a later answer", async () => {
    const srv = backend(cut("stale"));
    srv.post = () => "net";
    const { ev, on } = events();
    stop = startJobPoll("j-h", on).stop;
    await flush();
    expect(srv.posts).toBe(1);
    srv.post = () => json({ preview_status: "building" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(2);
    expect(srv.posts).toBe(2);
    expect(ev.failed).toEqual([]);
  });

  it(`POST /preview refused for good (500, 503): given up after ${PREVIEW_ERRORS} answers in a row, nothing more asked`, async () => {
    for (const status of [500, 503]) {
      const srv = backend(cut("stale"));
      srv.post = () => json({ detail: "server_error" }, status);
      const { ev, on } = events();
      const poll = startJobPoll(`j-n${status}`, on);
      await flush();
      expect(srv.posts).toBe(1);
      expect(ev.failed).toEqual([]);
      // asked again with each later answer (2, 4, 8, 16 s apart: about half a minute)
      await vi.advanceTimersByTimeAsync(31_000);
      expect(srv.posts).toBe(PREVIEW_ERRORS);
      expect(ev.failed).toEqual([true]);
      const gets = srv.gets;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(srv.posts).toBe(PREVIEW_ERRORS);
      expect(srv.gets).toBe(gets);
      poll.stop();
    }
  });

  it("one refusal in a deploy (503), then it builds: asked again, never given up", async () => {
    const srv = backend(cut("stale"));
    srv.post = () => json({ detail: "unavailable" }, 503);
    const { ev, on } = events();
    stop = startJobPoll("j-o", on).stop;
    await flush();
    expect(srv.posts).toBe(1);
    srv.post = () => json({ preview_status: "building" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.posts).toBe(2);
    srv.job = cut("building");
    await vi.advanceTimersByTimeAsync(2000);
    srv.job = cut("ready", { preview_segments: [[0, 5], [8, 12]], preview_version: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastJob(ev.loads)?.preview_version).toBe(2);
    expect(ev.failed).toEqual([]);
  });

  it("building that never ends (a hung encode): followed, given up after BUILD_MAX_MS; a newer revision starts over", async () => {
    const srv = backend(cut("building"));
    const { ev, on } = events();
    const poll = startJobPoll("j-p", on);
    stop = poll.stop;
    await flush();
    await vi.advanceTimersByTimeAsync(BUILD_MAX_MS - 10_000);
    expect(ev.failed).toEqual([]);
    expect(srv.gets).toBeGreaterThan(400);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(ev.failed).toEqual([true]);
    const gets = srv.gets;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(srv.gets).toBe(gets);
    expect(srv.posts).toBe(0);
    // a newer cut: followed again
    srv.job = cut("building", { edit_rev: 5 });
    poll.refresh();
    await flush();
    expect(ev.failed).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(gets + 2);
  });

  it("given up on a revision, a newer one starts over", async () => {
    const srv = backend(cut("failed"));
    srv.post = () => json({ preview_status: "failed" });
    const { ev, on } = events();
    const poll = startJobPoll("j-i", on);
    stop = poll.stop;
    await flush();
    expect(srv.posts).toBe(1);
    expect(ev.failed).toEqual([true]);
    srv.post = () => json({ preview_status: "building" });
    srv.job = cut("stale", { edit_rev: 4 });
    poll.refresh();
    await flush();
    expect(srv.posts).toBe(2);
    expect(ev.failed).toEqual([true, false]);
  });
});

describe("requests without an answer (a stalled connection)", () => {
  /** A request that never answers; it fails once its signal aborts. */
  const never = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

  it("a GET: given up after REQUEST_MS, asked again; showing the tab meanwhile only queues", async () => {
    let gets = 0;
    apiFetch.mockImplementation(async (_path, init) => {
      gets++;
      if (gets === 1) return never(init);
      return json(ready({ status: "processing" }));
    });
    const { ev, on } = events();
    const poll = startJobPoll("j-q", on);
    stop = poll.stop;
    await flush();
    poll.refresh();
    await flush();
    expect(gets).toBe(1);
    await vi.advanceTimersByTimeAsync(REQUEST_MS + 2000);
    expect(gets).toBeGreaterThanOrEqual(2);
    expect(lastJob(ev.loads)?.status).toBe("processing");
  });

  it("a POST /preview: given up after REQUEST_MS, asked again with a later answer", async () => {
    const srv = backend(cut("stale"));
    let posts = 0;
    apiFetch.mockImplementation(async (path, init) => {
      if (init?.method === "POST") {
        posts++;
        if (posts === 1) return never(init);
        return json({ preview_status: "building" });
      }
      srv.gets++;
      return json(srv.job);
    });
    const { ev, on } = events();
    stop = startJobPoll("j-r", on).stop;
    await flush();
    expect(posts).toBe(1);
    await vi.advanceTimersByTimeAsync(REQUEST_MS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts).toBe(2);
    expect(ev.failed).toEqual([]);
  });
});

describe("setJob", () => {
  it("shows the job at once; an answer to a request sent before it is dropped", async () => {
    const srv = backend(ready());
    let release!: () => void;
    apiFetch.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      return json(ready({ title: "old" }));
    });
    const { ev, on } = events();
    const poll = startJobPoll("j-k", on);
    stop = poll.stop;
    await flush();
    poll.setJob(ready({ status: "processing", title: "new" }));
    expect(lastJob(ev.loads)?.title).toBe("new");
    release();
    await flush();
    expect(lastJob(ev.loads)?.title).toBe("new");
    // processing: polled on from there
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(1);
  });
});

describe("at rest: a look at the job's status row every REST_MS", () => {
  it("changedSince: another state, export, preview, name or a later write; the same row: no", () => {
    const job = ready({ renders_ok: 1, title: "Morgenroutine", updated_at: 100 });
    expect(changedSince(job, statusRow("j", job))).toBe(false);
    expect(changedSince(job, { ...statusRow("j", job), status: "done" })).toBe(true);
    expect(changedSince(job, { ...statusRow("j", job), renders_ok: 2 })).toBe(true);
    expect(changedSince(job, { ...statusRow("j", job), preview_version: 2 })).toBe(true);
    expect(changedSince(job, { ...statusRow("j", job), title: "Abendroutine" })).toBe(true);
    expect(changedSince(job, { ...statusRow("j", job), updated_at: 160 })).toBe(true);
    // a side without the time (a server before it): the other fields decide
    expect(changedSince(ready({ renders_ok: 1, title: "Morgenroutine" }), { ...statusRow("j", job), updated_at: 160 })).toBe(false);
    expect(changedSince(ready(), statusRow("j", ready()))).toBe(false);
  });

  it("a ready job: nothing for REST_MS, then a look at its row (an empty 304 from the second on); never the whole job while nothing changed", async () => {
    const srv = backend(ready({ updated_at: 100 }));
    const { ev, on } = events();
    stop = startJobPoll("j-s1", on).stop;
    await flush();
    expect(srv.gets).toBe(1);
    await vi.advanceTimersByTimeAsync(REST_MS - 1);
    expect(srv.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(srv.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * REST_MS);
    expect(srv.checks).toBe(4);
    expect(srv.unchanged).toBe(3);
    expect(srv.gets).toBe(1);
    expect(ev.loads).toHaveLength(1);
  });

  it("an export finished on another device: the next look sees it and shows the whole job; at rest again after", async () => {
    const srv = backend(ready({ updated_at: 100 }));
    const { ev, on } = events();
    stop = startJobPoll("j-s2", on).stop;
    await flush();
    srv.job = ready({ status: "done", renders_ok: 1, updated_at: 160 });
    await vi.advanceTimersByTimeAsync(REST_MS);
    await flush();
    expect(srv.checks).toBe(1);
    expect(srv.gets).toBe(2);
    expect(lastJob(ev.loads)?.status).toBe("done");
    await vi.advanceTimersByTimeAsync(2 * REST_MS);
    expect(srv.checks).toBe(3);
    expect(srv.gets).toBe(2);
  });

  it("an export started elsewhere: shown as it runs, then followed every 2 s until it is done", async () => {
    const srv = backend(ready({ updated_at: 100 }));
    const { ev, on } = events();
    stop = startJobPoll("j-s3", on).stop;
    await flush();
    srv.job = ready({ status: "processing", updated_at: 150 });
    await vi.advanceTimersByTimeAsync(REST_MS);
    await flush();
    expect(lastJob(ev.loads)?.status).toBe("processing");
    const gets = srv.gets;
    await vi.advanceTimersByTimeAsync(2000);
    expect(srv.gets).toBe(gets + 1);
    srv.job = ready({ status: "done", renders_ok: 1, updated_at: 170 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(lastJob(ev.loads)?.status).toBe("done");
  });

  it("deleted on another device: the look finds it missing, the GET says gone; no looks after that", async () => {
    const srv = backend(ready());
    const { ev, on } = events();
    stop = startJobPoll("j-s4", on).stop;
    await flush();
    srv.gone = true;
    await vi.advanceTimersByTimeAsync(REST_MS);
    await flush();
    expect(srv.gets).toBe(2);
    expect(ev.loads[ev.loads.length - 1]).toEqual({ state: "gone" });
    const checks = srv.checks;
    await vi.advanceTimersByTimeAsync(5 * REST_MS);
    expect(srv.checks).toBe(checks);
    expect(srv.gets).toBe(2);
  });

  it("signed out meanwhile (401, 403 to a look): no more looks; shown again (refresh), the GET decides", async () => {
    for (const status of [401, 403]) {
      const srv = backend(ready());
      const { on } = events();
      const poll = startJobPoll(`j-s10-${status}`, on);
      await flush();
      const answering = apiFetch.getMockImplementation()!;
      apiFetch.mockImplementation(async (path, init) => {
        if (path.startsWith("/jobs/status?")) {
          srv.checks++;
          return json({ detail: "auth_required" }, status);
        }
        return answering(path, init);
      });
      await vi.advanceTimersByTimeAsync(10 * REST_MS);
      expect(srv.checks).toBe(1);
      expect(srv.gets).toBe(1);
      // signed in again: the tab shown again asks the whole job, the looks go on
      apiFetch.mockImplementation(answering);
      poll.refresh();
      await flush();
      expect(srv.gets).toBe(2);
      await vi.advanceTimersByTimeAsync(REST_MS);
      expect(srv.checks).toBe(2);
      poll.stop();
    }
  });

  it("v1's project page: no looks at rest (it stays as it was)", async () => {
    const srv = backend(ready({ status: "done", renders_ok: 1 }));
    const { on } = events();
    stop = startJobPoll("j-s9", { ...on, v2: false }).stop;
    await flush();
    expect(srv.gets).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * REST_MS);
    expect(srv.checks).toBe(0);
    expect(srv.gets).toBe(1);
  });

  it("not while a video plays: the look waits for one with nothing playing", async () => {
    const srv = backend(ready());
    const { on } = events();
    let playing = true;
    stop = startJobPoll("j-s5", { ...on, playing: () => playing }).stop;
    await flush();
    await vi.advanceTimersByTimeAsync(2 * REST_MS);
    expect(srv.checks).toBe(0);
    playing = false;
    await vi.advanceTimersByTimeAsync(REST_MS);
    expect(srv.checks).toBe(1);
  });

  it("not while the tab is hidden: no look and none scheduled; shown again (refresh), the looks go on", async () => {
    const srv = backend(ready());
    const { on } = events();
    const doc = { hidden: false };
    vi.stubGlobal("document", doc);
    const poll = startJobPoll("j-s6", on);
    stop = poll.stop;
    await flush();
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(5 * REST_MS);
    expect(srv.checks).toBe(0);
    expect(srv.gets).toBe(1);
    doc.hidden = false;
    poll.refresh();
    await flush();
    expect(srv.gets).toBe(2);
    await vi.advanceTimersByTimeAsync(REST_MS);
    expect(srv.checks).toBe(1);
  });

  it("a look still out when the tab shows again (a GET meanwhile): it schedules nothing of its own", async () => {
    const srv = backend(ready());
    const { on } = events();
    const poll = startJobPoll("j-s7", on);
    stop = poll.stop;
    await flush();
    let answer!: () => void;
    const answering = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementationOnce(async (path, init) => {
      await new Promise<void>((r) => (answer = r));
      return answering(path, init);
    });
    await vi.advanceTimersByTimeAsync(REST_MS);
    poll.refresh();
    await flush();
    expect(srv.gets).toBe(2);
    // its answer comes 10 s later: the looks keep the GET's pace
    await vi.advanceTimersByTimeAsync(10_000);
    answer();
    await flush();
    expect(srv.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(REST_MS - 10_000);
    expect(srv.checks).toBe(2);
    await vi.advanceTimersByTimeAsync(REST_MS - 1);
    expect(srv.checks).toBe(2);
    expect(srv.gets).toBe(2);
  });

  it("a look without an answer: the next one REST_MS later, no quicker retries; a server without /jobs/status: the whole job", async () => {
    const srv = backend(ready());
    const { on } = events();
    const answering = apiFetch.getMockImplementation()!;
    stop = startJobPoll("j-s8", on).stop;
    await flush();
    apiFetch.mockImplementation(async (path, init) => {
      if (path.startsWith("/jobs/status?")) throw new TypeError("offline");
      return answering(path, init);
    });
    await vi.advanceTimersByTimeAsync(REST_MS + 10_000);
    expect(apiFetch.mock.calls.filter(([p]) => p.startsWith("/jobs/status?"))).toHaveLength(1);
    expect(srv.gets).toBe(1);
    // an older server: /jobs/status is /jobs/{id} with the id "status" (404)
    apiFetch.mockImplementation(async (path, init) => (path.startsWith("/jobs/status?") ? json({ detail: "not_found" }, 404) : answering(path, init)));
    await vi.advanceTimersByTimeAsync(REST_MS);
    await flush();
    expect(srv.gets).toBe(2);
  });
});
