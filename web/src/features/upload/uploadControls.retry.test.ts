// "Try again" of a failed upload (D2): from the start screen it goes on
// with the same gate and callbacks and keeps the thumbnail (the screen
// draws its tiles with that frame); from its Projects tile an upload the
// start screen started does the same, any other starts as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGate } from "./gate";
import type { StartOpts } from "./uploadManager";
import type { StartPart } from "./uploadState";

const removed: string[] = [];
const started: { name: string; opts: StartOpts | undefined }[] = [];
vi.mock("./records", () => ({ removeUploadRecord: (id: string) => removed.push(id) }));
vi.mock("./uploadManager", () => ({
  startUpload: async (f: File, _s: unknown, _p: unknown, opts?: StartOpts) => void started.push({ name: f.name, opts }),
}));

const settings = { style: "tight" } as never;
let revoked: string[] = [];

beforeEach(() => {
  revoked = [];
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => void revoked.push(u));
});
afterEach(() => {
  removed.length = 0;
  started.length = 0;
});

/** A failed upload of this page, waiting for "Let's go", with a thumbnail
 *  (`start`: what the start screen started it with). */
async function failed(id: string, thumb: string | Promise<string | null>, start?: StartPart) {
  const s = await import("./uploadState");
  s.retries.set(id, { file: new File([], `${id}.mp4`), settings, preset: null, ...(start ? { start } : {}) });
  if (typeof thumb === "string") s.setThumb(id, thumb);
  else s.setThumbWhenReady(id, thumb);
  s.setAwaitingGo(id, true);
  return s;
}

describe("retryUpload", () => {
  it("from the start screen: the same gate and callbacks, and the thumbnail goes along", async () => {
    const s = await failed("upl-a", "blob:frame");
    const { retryUpload } = await import("./uploadControls");
    const gate = createGate();
    const onEnd = vi.fn();
    expect(retryUpload("upl-a", { gate, duration: 9, onEnd })).toBe(true);
    expect(removed).toEqual(["upl-a"]);
    expect(s.isAwaitingGo("upl-a")).toBe(false);
    expect(started).toHaveLength(1);
    const opts = started[0].opts!;
    expect(opts).toMatchObject({ gate, duration: 9, onEnd });
    await expect(opts.thumb).resolves.toBe("blob:frame");
    expect(revoked).toEqual([]);
    // The failed upload has none left (the new one sets it).
    await expect(s.takeThumb("upl-a")).resolves.toBeNull();
  });

  it("a frame still being grabbed goes along too", async () => {
    let arrive!: (u: string) => void;
    const s = await failed("upl-b", new Promise<string | null>((res) => (arrive = res)));
    const { retryUpload } = await import("./uploadControls");
    expect(retryUpload("upl-b", { gate: createGate() })).toBe(true);
    arrive("blob:late");
    await expect(started[0].opts!.thumb).resolves.toBe("blob:late");
    await Promise.resolve();
    await expect(s.takeThumb("upl-b")).resolves.toBeNull();
    expect(revoked).toEqual([]);
  });

  it("a thumbnail of its own replaces the old one", async () => {
    await failed("upl-c", "blob:old");
    const { retryUpload } = await import("./uploadControls");
    const thumb = Promise.resolve("blob:new");
    expect(retryUpload("upl-c", { thumb })).toBe(true);
    expect(started[0].opts!.thumb).toBe(thumb);
    expect(revoked).toEqual(["blob:old"]);
  });

  it("from a tile (no options), an upload not from the start screen: a plain new upload, as before", async () => {
    await failed("upl-d", "blob:tile");
    const { retryUpload } = await import("./uploadControls");
    expect(retryUpload("upl-d")).toBe(true);
    expect(started).toEqual([{ name: "upl-d.mp4", opts: { source: undefined } }]);
    expect(revoked).toEqual(["blob:tile"]);
    // Nothing of this page's to try again.
    expect(retryUpload("upl-gone")).toBe(false);
  });

  it("from a tile (no options), an upload the start screen started: its gate and callbacks go on, and the thumbnail along", async () => {
    const gate = createGate();
    gate.open();
    const start: StartPart = { gate, duration: 7, onCard: vi.fn(), onSettingsRead: vi.fn(), onStarting: vi.fn(), onEnd: vi.fn() };
    const s = await failed("upl-e", "blob:start", start);
    const { retryUpload } = await import("./uploadControls");
    expect(retryUpload("upl-e")).toBe(true);
    const opts = started[0].opts!;
    expect(opts).toMatchObject({ ...start, source: undefined });
    await expect(opts.thumb).resolves.toBe("blob:start");
    expect(revoked).toEqual([]);
    expect(s.isAwaitingGo("upl-e")).toBe(false);
  });

  it("from a tile (no options), the upload of a start screen's video that went on without it: its wishes go along (Last used)", async () => {
    const lastUsed = { target_aspect: "original" as const, remove_fillers: false, spoken_language: "fr", caption_style_last: "elegant" };
    const s = await failed("upl-f", "blob:f");
    s.retries.set("upl-f", { ...s.retries.get("upl-f")!, lastUsed });
    const { retryUpload } = await import("./uploadControls");
    expect(retryUpload("upl-f")).toBe(true);
    expect(started[0].opts).toMatchObject({ lastUsed });
  });
});

describe("retryUploadWith (after a reload)", () => {
  it("hands the record's wishes on: remembered as Last used when POST /jobs goes out", async () => {
    const lastUsed = { target_aspect: "9:16" as const, remove_fillers: true, spoken_language: "auto", caption_style_last: "neon" };
    const { retryUploadWith } = await import("./uploadControls");
    expect(await retryUploadWith("upl-g", new File([], "g.mp4"), settings, null, undefined, lastUsed)).toBe(true);
    expect(removed).toEqual(["upl-g"]);
    expect(started).toEqual([{ name: "g.mp4", opts: { source: undefined, lastUsed } }]);
  });
});

