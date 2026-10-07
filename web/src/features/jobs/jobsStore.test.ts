// The jobs store (UX12): the one-time migration of the lists of before,
// what it stores (ids, names, upload records — no statuses), the upload
// lifecycle and dead uploads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage, fakeWindow } from "./test-storage";

const storage = new MemoryStorage();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("window", fakeWindow(storage));
});
afterEach(async () => {
  (await import("./jobsStore"))._resetForTests();
  vi.unstubAllGlobals();
});

const ACTIVE = "cleocuts.activeJobs.v1";
const LIBRARY = "cleo-library-v1";
const V2 = "cleocuts.jobs.v2";

describe("migration", () => {
  it("reads the cards and the library once; they stay as they were", async () => {
    const cards = [
      { jobId: "rev1", phase: "reviewing", timestamp: 3, filename: "echt.mp4", presetId: null, presetLabel: null },
      { jobId: "upl-9", phase: "uploading", timestamp: 4, filename: "big.mov", uploadPct: 12 },
    ];
    const lib = [{ jobId: "done1", timestamp: 1, filename: "fertig.mp4", outputs: ["primary"] }];
    storage.setItem(ACTIVE, JSON.stringify(cards));
    storage.setItem(LIBRARY, JSON.stringify(lib));
    storage.setItem("cleocuts.activeJob.v1", "{}");
    const s = await import("./jobsStore");
    expect(s.getLocalJobs().map((j) => j.jobId)).toEqual(["upl-9", "rev1", "done1"]);
    const stored = JSON.parse(storage.getItem(V2)!);
    expect(stored.map((j: { jobId: string }) => j.jobId)).toEqual(["upl-9", "rev1", "done1"]);
    expect(storage.getItem("cleocuts.jobs.v2.migrated")).toBe("1");
    // Additive: the old lists are untouched (rollback); the v1 store goes.
    expect(JSON.parse(storage.getItem(ACTIVE)!)).toEqual(cards);
    expect(JSON.parse(storage.getItem(LIBRARY)!)).toEqual(lib);
    expect(storage.getItem("cleocuts.activeJob.v1")).toBeNull();

    // Once: a project deleted later doesn't come back from the old lists.
    s.forgetJobs(["done1"]);
    s._resetForTests();
    expect(s.getLocalJobs().map((j) => j.jobId)).toEqual(["upl-9", "rev1"]);
  });
});

describe("old-build tabs", () => {
  it("jobs written to the old lists after the migration are taken over; deleted ones never come back", async () => {
    storage.setItem(LIBRARY, JSON.stringify([{ jobId: "done1", timestamp: 1, filename: "a.mp4" }]));
    const s = await import("./jobsStore");
    expect(s.getLocalJobs().map((j) => j.jobId)).toEqual(["done1"]);
    s.forgetJobs(["done1"]);
    // An old tab (still open) adds a job and an upload card afterwards.
    storage.setItem(
      ACTIVE,
      JSON.stringify([
        { jobId: "new1", phase: "analyzing", timestamp: 5, filename: "b.mp4" },
        { jobId: "upl-7", phase: "uploading", timestamp: 6, filename: "c.mp4" },
      ]),
    );
    s._resetForTests();
    // new1 joins; done1 (deleted here) and the old tab's upload don't.
    expect(s.getLocalJobs().map((j) => j.jobId)).toEqual(["new1"]);
    s._resetForTests();
    expect(s.getLocalJobs().map((j) => j.jobId)).toEqual(["new1"]); // idempotent
  });

  it("the migrated flag is set only once the list was written", async () => {
    storage.setItem(LIBRARY, JSON.stringify([{ jobId: "done1", timestamp: 1, filename: "a.mp4" }]));
    const set = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      if (k === V2) throw new Error("QuotaExceededError");
      set(k, v);
    };
    const s = await import("./jobsStore");
    expect(s.getLocalJobs().map((j) => j.jobId)).toEqual(["done1"]); // in memory
    expect(storage.getItem("cleocuts.jobs.v2.migrated")).toBeNull();
    storage.setItem = set;
  });
});

describe("uploads", () => {
  it("a cancel that came too late keeps the upload's name and says so", async () => {
    const s = await import("./jobsStore");
    s.addUpload("upl-2", { filename: "late.mp4" }, {});
    s.removeJob("upl-2"); // the cancel removed the record
    s.uploadCreated("upl-2", "job9", { filename: "late.mp4", fileSize: 3 }, { cancelTooLate: true });
    expect(s.getLocalJob("job9")).toMatchObject({ filename: "late.mp4", note: "cancel_too_late" });
  });

  it("record → heartbeat → the job: no status is ever stored", async () => {
    const s = await import("./jobsStore");
    s.addUpload("upl-1", { filename: "clip.mp4", fileSize: 10, presetId: "tiktok", presetLabel: "TikTok / Reels" }, {});
    s.updateUpload("upl-1", { pct: 40, lastProgressAt: Date.now() });
    expect(s.getLocalJob("upl-1")?.upload?.pct).toBe(40);
    s.uploadCreated("upl-1", "abc123", { filename: "other-name.mp4" });
    const jobs = s.getLocalJobs();
    expect(jobs.map((j) => j.jobId)).toEqual(["abc123"]);
    expect(jobs[0]).toMatchObject({ filename: "clip.mp4", presetId: "tiktok" });
    expect(jobs[0].upload).toBeUndefined();
    expect(storage.getItem(V2)).not.toMatch(/status|phase|"error"/);
  });

  it("a failed upload keeps its code; a dead one is marked interrupted", async () => {
    const s = await import("./jobsStore");
    s.addUpload("upl-a", { filename: "a.mp4" }, {});
    s.uploadFailed("upl-a", { code: "no_audio" });
    expect(s.getLocalJob("upl-a")?.upload?.errorCode).toBe("no_audio");

    s.addUpload("upl-b", { filename: "b.mp4" }, {});
    s.liveUploads.add("upl-b");
    s.addUpload("upl-c", { filename: "c.mp4" }, {});
    s.updateUpload("upl-c", { lastProgressAt: Date.now() - 60_000 });
    s.markStaleUploads();
    // This page's own upload stays; the silent one is interrupted.
    expect(s.getLocalJob("upl-b")?.upload?.errorCode).toBeUndefined();
    expect(s.getLocalJob("upl-c")?.upload?.errorCode).toBe("upload_interrupted");
    s.liveUploads.clear();
  });

  it("an upload running in another tab (its Web Lock) is never marked, however late its heartbeat", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: async () => {},
        query: async () => ({ held: [{ name: "cleocuts-upload-rec:upl-elsewhere" }, { name: "something-else" }] }),
      },
    });
    const s = await import("./jobsStore");
    for (const id of ["upl-elsewhere", "upl-dead"]) {
      s.addUpload(id, { filename: `${id}.mp4` }, {});
      s.updateUpload(id, { lastProgressAt: Date.now() - 120_000 });
    }
    s.markStaleUploads();
    await vi.waitFor(() => expect(s.getLocalJob("upl-dead")?.upload?.errorCode).toBe("upload_interrupted"));
    expect(s.getLocalJob("upl-elsewhere")?.upload?.errorCode).toBeUndefined();
  });
});

describe("per user", () => {
  it("accounts off: one list under the plain key", async () => {
    const s = await import("./jobsStore");
    s.rememberJob({ jobId: "j1", timestamp: 1, filename: "x.mp4" });
    expect(storage.getItem(V2)).toContain("j1");
  });
});
