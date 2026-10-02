// UX12 re-review: POST /jobs gave no usable answer — the job it may have
// created is looked for a few times (it may not be listed at once), and
// a cancel is no longer taken once POST /jobs went out.
import { beforeEach, describe, expect, it, vi } from "vitest";

const serverLists: (Record<string, unknown>[] | null)[] = [];
const fetchServerJobs = vi.fn(async () => serverLists.shift() ?? null);
vi.mock("@/lib/account", () => ({
  fetchServerJobs: () => fetchServerJobs(),
  refreshMe: vi.fn(),
  paywallFrom: vi.fn(() => null),
  toMs: (v: unknown) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : null),
}));
const known = new Set<string>();
vi.mock("./records", () => ({
  knownJobIds: async () => known,
  liveUploads: vi.fn(),
  recordJobCreated: vi.fn(),
  recordUploadFailed: vi.fn(),
  removeUploadRecord: vi.fn(),
  uploadProgress: vi.fn(),
  recordUploadStarting: vi.fn(),
  addUploadRecord: vi.fn(),
  projectsV2: () => true,
}));

const SINCE = 1_800_000_000_000;
const job = (id: string, filename = "clip.mp4", created = SINCE / 1000 + 2) => ({ id, filename, created_at: created });

beforeEach(() => {
  serverLists.length = 0;
  fetchServerJobs.mockClear();
  known.clear();
});

describe("findJobCreatedFor", () => {
  it("asks again until the new job is listed", async () => {
    const { findJobCreatedFor } = await import("./uploadJob");
    serverLists.push([], null, [job("j-new")]);
    await expect(findJobCreatedFor("clip.mp4", SINCE, [1, 1])).resolves.toBe("j-new");
    expect(fetchServerJobs).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last try", async () => {
    const { findJobCreatedFor } = await import("./uploadJob");
    serverLists.push([], [], [], [job("late")]);
    await expect(findJobCreatedFor("clip.mp4", SINCE, [1, 1])).resolves.toBeNull();
    expect(fetchServerJobs).toHaveBeenCalledTimes(3);
  });

  it("skips jobs of another file, older ones and ones this device has", async () => {
    const { findJobCreatedFor } = await import("./uploadJob");
    known.add("mine");
    serverLists.push([job("other", "b.mp4"), job("old", "clip.mp4", SINCE / 1000 - 3600), job("mine")]);
    await expect(findJobCreatedFor("clip.mp4", SINCE, [])).resolves.toBeNull();
  });
});

describe("cancelUpload", () => {
  it("is not taken once POST /jobs went out (the job may exist)", async () => {
    const { cancelUpload } = await import("./uploadControls");
    const { controllers, live } = await import("./uploadState");
    const records = await import("./records");
    const ctl = new AbortController();
    controllers.set("upl-1", ctl);
    live.set("upl-1", { id: "upl-1", pct: 100, resuming: false, starting: true });
    await cancelUpload("upl-1");
    expect(ctl.signal.aborted).toBe(false);
    expect(records.removeUploadRecord).not.toHaveBeenCalled();
    // Before that point it still cancels.
    live.set("upl-1", { id: "upl-1", pct: 40, resuming: false });
    await cancelUpload("upl-1");
    expect(ctl.signal.aborted).toBe(true);
    expect(records.removeUploadRecord).toHaveBeenCalledWith("upl-1");
  });
});
