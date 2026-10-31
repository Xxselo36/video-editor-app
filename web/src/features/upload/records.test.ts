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

  it("another tab's 'interrupted' (this one was frozen) goes with the next heartbeat, and when the page is back", async () => {
    const r = await running("upl-other");
    const store = await import("@/features/jobs/jobsStore");
    // Another tab's markStaleUploads, through the shared store.
    store.updateUpload("upl-other", { errorCode: "upload_interrupted", resuming: false });
    expect(await code("upl-other")).toBe("upload_interrupted");
    r.uploadProgress("upl-other", { pct: 42, lastProgressAt: Date.now() });
    await vi.waitFor(async () => expect(await code("upl-other")).toBeNull());
    expect(store.getLocalJob("upl-other")?.upload?.pct).toBe(42);
    store.updateUpload("upl-other", { errorCode: "upload_interrupted" });
    r.pageShown();
    await vi.waitFor(async () => expect(await code("upl-other")).toBeNull());
    // A record of no upload of this page keeps the mark.
    r.liveUploads.delete("upl-other");
    store.updateUpload("upl-other", { errorCode: "upload_interrupted" });
    r.uploadProgress("upl-other", { pct: 43, lastProgressAt: Date.now() });
    await new Promise((res) => setTimeout(res, 10));
    expect(await code("upl-other")).toBe("upload_interrupted");
  });

  it("a resumed upload is 'resuming' again after another tab's mark (the beat carries it)", async () => {
    const r = await running("upl-res");
    const store = await import("@/features/jobs/jobsStore");
    store.updateUpload("upl-res", { resuming: true });
    // markStaleUploads in another tab: interrupted, resuming off.
    store.updateUpload("upl-res", { errorCode: "upload_interrupted", resuming: false });
    r.uploadProgress("upl-res", { pct: 61, lastProgressAt: Date.now(), resuming: true });
    await vi.waitFor(async () => expect(await code("upl-res")).toBeNull());
    expect(store.getLocalJob("upl-res")?.upload?.resuming).toBe(true);
    r.liveUploads.delete("upl-res");
  });

  it("pagehide keeps 'starting' and 'resuming' of a running upload", async () => {
    const r = await running("upl-flags");
    const store = await import("@/features/jobs/jobsStore");
    store.updateUpload("upl-flags", { starting: true, resuming: true });
    r.pageHidden(false);
    await vi.waitFor(async () => expect(await code("upl-flags")).toBe("upload_interrupted"));
    r.pageShown();
    await vi.waitFor(async () => expect(await code("upl-flags")).toBeNull());
    expect(store.getLocalJob("upl-flags")?.upload).toMatchObject({ starting: true, resuming: true });
    r.liveUploads.delete("upl-flags");
  });

  it("a server's answer while the page is hidden keeps its code (not 'interrupted')", async () => {
    const r = await running("upl-refusal");
    r.pageHidden(false);
    await vi.waitFor(async () => expect(await code("upl-refusal")).toBe("upload_interrupted"));
    r.recordUploadFailed("upl-refusal", { code: "video_too_long", params: { max_minutes: 30 } });
    r.liveUploads.delete("upl-refusal");
    await vi.waitFor(async () => expect(await code("upl-refusal")).toBe("video_too_long"));
    // A request the browser cut meanwhile: interrupted.
    const c = await running("upl-cut2");
    c.recordUploadFailed("upl-cut2", new Error("R2 network error"));
    c.liveUploads.delete("upl-cut2");
    await vi.waitFor(async () => expect(await code("upl-cut2")).toBe("upload_interrupted"));
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

describe("the start screen's choices (D7)", () => {
  it("follow on the record, the caption style whole: \"Try again\" after a reload starts with them", async () => {
    const r = await running("upl-choices");
    const store = await import("@/features/jobs/jobsStore");
    const settings = {
      style: "none",
      voice_triggers: false,
      remove_fillers: false,
      smartcam_enabled: false,
      smartcam_format: "portrait" as const,
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "karaoke",
      caption_style: { presetId: "karaoke", overrides: { wordsPerPage: 2 } },
    };
    r.recordUploadSettings("upl-choices", settings);
    await vi.waitFor(() => expect(store.getLocalJob("upl-choices")?.upload?.settings).toEqual(settings));
    // A record that went (cancelled) doesn't come back with them.
    r.removeUploadRecord("upl-choices");
    r.recordUploadSettings("upl-choices", settings);
    await new Promise((res) => setTimeout(res, 10));
    expect(store.getLocalJob("upl-choices")).toBeNull();
    r.liveUploads.delete("upl-choices");
  });
});

describe("what the record keeps for later and for other tabs", () => {
  const lastUsed = { target_aspect: "original" as const, remove_fillers: false, spoken_language: "fr", caption_style_last: "elegant" };

  it("the choices as wanted go with the settings", async () => {
    const r = await running("upl-wanted");
    const store = await import("@/features/jobs/jobsStore");
    r.recordUploadSettings("upl-wanted", info.settings, lastUsed);
    await vi.waitFor(() => expect(store.getLocalJob("upl-wanted")?.upload).toMatchObject({ settings: info.settings, lastUsed }));
    r.liveUploads.delete("upl-wanted");
  });

  it("waiting for Let's go, and all bytes stored: written at once, so another tab shows it", async () => {
    const r = await running("upl-waits");
    const store = await import("@/features/jobs/jobsStore");
    r.recordUploadWaiting("upl-waits", true);
    r.recordUploadStored("upl-waits");
    await vi.waitFor(() => expect(store.getLocalJob("upl-waits")?.upload).toMatchObject({ awaitingGo: true, pct: 100 }));
    r.recordUploadWaiting("upl-waits", false);
    await vi.waitFor(() => expect(store.getLocalJob("upl-waits")?.upload?.awaitingGo).toBe(false));
    r.liveUploads.delete("upl-waits");
  });

  it("the stopped upload a new one of the same file continues: the newest of that size, after the writes before", async () => {
    const r = await import("./records");
    const store = await import("@/features/jobs/jobsStore");
    const add = async (id: string, fileSize: number, extra: object) => {
      r.addUploadRecord(id, { ...info, fileSize, settings: { style: id } as never, lastUsed });
      await vi.waitFor(() => expect(store.getLocalJob(id)).not.toBeNull());
      store.updateUpload(id, extra);
      await new Promise((res) => setTimeout(res, 5));
    };
    await add("upl-old", 777, { errorCode: "upload_interrupted" });
    await add("upl-new", 777, { errorCode: "upload_interrupted" });
    await add("upl-runs", 777, {});
    await add("upl-other", 778, { errorCode: "upload_interrupted" });
    expect(await r.stoppedUpload(777)).toMatchObject({ settings: { style: "upl-new" }, lastUsed });
    // Removed just before (X, say): not that one.
    r.removeUploadRecord("upl-new");
    expect(await r.stoppedUpload(777)).toMatchObject({ settings: { style: "upl-old" } });
    expect(await r.stoppedUpload(779)).toBeNull();
  });
});

