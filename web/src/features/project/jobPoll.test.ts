// The Vorschau's poll (useJobPoll → jobPoll.ts): the editor's last saves
// before the first answer and after it, and the preview of the stored
// timeline (asked for when nothing builds it, once more after a failure;
// given up on one the server keeps refusing or that never ends);
// requests without an answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobStatus } from "@/features/jobs/types";

const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init) }));
vi.mock("@/features/jobs/localJobs", () => ({ setExportHint: () => {} }));

const { previewBehind, previewOutdated, startJobPoll, BUILD_MAX_MS, PREVIEW_ERRORS, REQUEST_MS, SAVES_WAIT_MS } = await import(
  "./jobPoll"
);
const { trackSave } = await import("@/lib/pendingSaves");
type Load = import("./jobPoll").Load;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

/** A fake backend: GET /jobs/{id} answers `job`; POST /jobs/{id}/preview `post()` ("net": no answer). */
function backend(first: JobStatus) {
  const srv = {
    job: first,
    gets: 0,
    posts: 0,
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
    srv.gets++;
    return json(srv.job);
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
