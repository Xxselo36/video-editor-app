// A stopped tile in tab B of an upload that still runs in tab A (its Web
// Lock, lib/uploadLock): B never removes A's record or uploads the same
// file a second time (PR #66 review).
import { afterEach, describe, expect, it, vi } from "vitest";

const removed: string[] = [];
const started: string[] = [];
vi.mock("./records", () => ({ removeUploadRecord: (id: string) => removed.push(id) }));
vi.mock("./uploadManager", () => ({ startUpload: async (f: File) => void started.push(f.name) }));

function locksHeld(...ids: string[]) {
  vi.stubGlobal("navigator", {
    locks: {
      request: async () => {},
      query: async () => ({ held: ids.map((id) => ({ name: `cleocuts-upload-rec:${id}` })) }),
    },
  });
}

afterEach(() => {
  removed.length = 0;
  started.length = 0;
  vi.unstubAllGlobals();
});

const settings = { style: "smooth" } as never;

describe("an upload running in another tab", () => {
  it("is not removed or uploaded again from here", async () => {
    locksHeld("upl-a");
    const c = await import("./uploadControls");
    expect(await c.runsElsewhere("upl-a")).toBe(true);
    await c.cancelUpload("upl-a");
    expect(removed).toEqual([]);
    expect(await c.retryUploadWith("upl-a", new File([], "a.mp4"), settings, null)).toBe(false);
    expect(started).toEqual([]);
  });

  it("a record no tab runs is removed and uploaded again as before", async () => {
    locksHeld("upl-other");
    const c = await import("./uploadControls");
    expect(await c.runsElsewhere("upl-b")).toBe(false);
    await c.cancelUpload("upl-b");
    expect(removed).toEqual(["upl-b"]);
    expect(await c.retryUploadWith("upl-b", new File([], "b.mp4"), settings, null)).toBe(true);
    expect(started).toEqual(["b.mp4"]);
  });
});
