// Upload records when the page goes away (the owner's iPhone, 2026-10):
// a document load cuts this page's uploads — Safari reports that to the
// request as a network error — and the next page must show them as
// interrupted, never as "connection_lost". A real loss in a page that
// stays keeps its code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage, fakeWindow } from "@/features/jobs/test-storage";

const storage = new MemoryStorage();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  // The v2 opt-in: records go to the jobs store (the Projects page).
  vi.stubGlobal("window", { ...fakeWindow(storage), location: { search: "?editor=v2" } });
});
afterEach(async () => {
  (await import("./records")).pageShown();
  (await import("@/features/jobs/jobsStore"))._resetForTests();
  vi.unstubAllGlobals();
});

const info = {
  filename: "lauf.mov",
  fileSize: 1234,
  presetId: null,
  presetLabel: null,
  settings: { style: "tight" } as never,
};

async function code(id: string): Promise<string | null | undefined> {
  const store = await import("@/features/jobs/jobsStore");
  return store.getLocalJobs().find((j) => j.jobId === id)?.upload?.errorCode;
}

/** An upload record of this page, as uploadCard puts it up. */
async function running(id: string) {
  const r = await import("./records");
  r.liveUploads.add(id);
  r.addUploadRecord(id, info);
  await vi.waitFor(async () => expect(await code(id)).toBeUndefined());
  return r;
}

describe("upload records as the page goes", () => {
  it("a lost connection in a page that stays keeps its code", async () => {
    const r = await running("upl-real");
    r.liveUploads.delete("upl-real");
    r.recordUploadFailed("upl-real", new Error("R2 network error"));
    await vi.waitFor(async () => expect(await code("upl-real")).toBe("connection_lost"));
  });

  it("pagehide: this page's running uploads are interrupted", async () => {
    const r = await running("upl-live");
    r.pageHidden(false);
    await vi.waitFor(async () => expect(await code("upl-live")).toBe("upload_interrupted"));
    // The browser cuts the request after that: still interrupted.
    r.recordUploadFailed("upl-live", new Error("Upload aborted"));
    await new Promise((res) => setTimeout(res, 10));
    expect(await code("upl-live")).toBe("upload_interrupted");
  });

  it("a request Safari cut as the navigation started (before pagehide) is interrupted, not connection_lost", async () => {
    const r = await running("upl-cut");
    // uploadJob's catch, then its finally: no longer live.
    r.recordUploadFailed("upl-cut", new Error("R2 network error"));
    r.liveUploads.delete("upl-cut");
    await vi.waitFor(async () => expect(await code("upl-cut")).toBe("connection_lost"));
    r.pageHidden(false);
    await vi.waitFor(async () => expect(await code("upl-cut")).toBe("upload_interrupted"));
  });

  it("keeps a server's refusal, and a cut from long before, as they were", async () => {
    const r = await running("upl-refused");
    await running("upl-old");
    r.recordUploadFailed("upl-refused", { code: "too_many_active_jobs", params: {} });
    r.recordUploadFailed("upl-old", new Error("Upload stalled"));
    r.liveUploads.delete("upl-refused");
    r.liveUploads.delete("upl-old");
    await vi.waitFor(async () => expect(await code("upl-old")).toBe("connection_lost"));
    r.pageHidden(false, Date.now() + r.PAGE_CUT_MS + 1);
    await new Promise((res) => setTimeout(res, 10));
    expect(await code("upl-refused")).toBe("too_many_active_jobs");
    expect(await code("upl-old")).toBe("connection_lost");
  });

  it("the back/forward cache (persisted) changes nothing", async () => {
    const r = await running("upl-bf");
    r.pageHidden(true);
    await new Promise((res) => setTimeout(res, 10));
    expect(await code("upl-bf")).toBeUndefined();
    r.liveUploads.delete("upl-bf");
  });
});

describe("the page comes back (iOS: pagehide for a page that only went to the background)", () => {
  it("its running uploads are running again: no stopped tile", async () => {
    const r = await running("upl-bg");
    r.pageHidden(false);
    await vi.waitFor(async () => expect(await code("upl-bg")).toBe("upload_interrupted"));
    // visible / focus / pageshow: the same document, the upload still runs.
    r.pageShown();
    await vi.waitFor(async () => expect(await code("upl-bg")).toBeNull());
    r.liveUploads.delete("upl-bg");
  });

  it("an upload that ended meanwhile stays as it was", async () => {
    const r = await running("upl-ended");
    r.pageHidden(false);
    await vi.waitFor(async () => expect(await code("upl-ended")).toBe("upload_interrupted"));
    r.liveUploads.delete("upl-ended");
    r.pageShown();
    await new Promise((res) => setTimeout(res, 10));
    expect(await code("upl-ended")).toBe("upload_interrupted");
  });
});
