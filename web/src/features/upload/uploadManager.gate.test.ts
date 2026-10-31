// uploadManager with the start screen's gate (D1): POST /jobs waits for
// "Let's go", the upload is "awaiting go" until then (also after a
// failure), the start screen's frame is the tile's thumbnail, and the
// caller hears how the upload ended.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGate } from "./gate";

type How = "created" | "failed" | "cancelled";
type Cb = {
  tempId: string;
  signal?: AbortSignal;
  ready?: Promise<void>;
  duration?: number | null;
  onCreated: (id: string) => void;
  onFailed?: () => void;
  onStarting?: () => void;
  onUploaded?: (id: string) => void;
  onEnd?: (id: string) => void;
};
const runs: Cb[] = [];
const ends = new Map<string, (how: How) => void>();
/** End the upload `id` the way `how` (cancelled: also by its signal). */
const end = (id: string, how: How) => ends.get(id)?.(how);
vi.mock("./uploadJob", () => ({
  uploadJob: vi.fn(async (_f: File, _s: unknown, _p: unknown, cb: Cb) => {
    runs.push(cb);
    // The bytes are stored at once here.
    cb.onUploaded?.(cb.tempId);
    const how = await new Promise<How>((resolve) => {
      ends.set(cb.tempId, resolve);
      cb.signal?.addEventListener("abort", () => resolve("cancelled"));
    });
    if (how === "created") {
      cb.onStarting?.();
      cb.onCreated(`job-${cb.tempId}`);
    } else if (how === "failed") {
      cb.onFailed?.();
    }
    cb.onEnd?.(cb.tempId);
  }),
}));
const grabFrame = vi.fn(async () => "blob:grabbed");
vi.mock("./grabFrame", () => ({ grabFrame: () => grabFrame() }));

const settings = {
  style: "tight",
  voice_triggers: true,
  remove_fillers: true,
  smartcam_enabled: false,
  smartcam_format: "portrait" as const,
  resolution: "1080",
  output_formats: [],
};
let n = 0;
const video = () => new File([new Uint8Array(++n)], `clip-${n}.mp4`, { type: "video/mp4", lastModified: n });

/** Start an upload of a new file; its temporary id once the card is up. */
async function start(opts: Parameters<typeof import("./uploadManager").startUpload>[3] = {}) {
  const { startUpload } = await import("./uploadManager");
  let id = "";
  const run = startUpload(video(), settings, null, { ...opts, onCard: (t) => (id = t) });
  await vi.waitFor(() => expect(runs.at(-1)?.tempId).toBe(id));
  return { id, run, cb: runs.at(-1)! };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startUpload with a gate", () => {
  it("passes the gate to the upload, marks it uploaded, and it awaits go until the gate opens", async () => {
    const { getLiveUpload, isAwaitingGo } = await import("./uploadManager");
    const gate = createGate();
    const { id, run, cb } = await start({ gate });
    expect(cb.ready).toBe(gate.promise);
    expect(getLiveUpload(id)).toMatchObject({ pct: 100, uploaded: true });
    expect(isAwaitingGo(id)).toBe(true);
    gate.open();
    await vi.waitFor(() => expect(isAwaitingGo(id)).toBe(false));
    end(id, "created");
    await run;
  });

  it("a failure keeps it awaiting go; giving the upload up ends that", async () => {
    const { isAwaitingGo } = await import("./uploadManager");
    const { cancelUpload } = await import("./uploadControls");
    const ended: [string | null, How][] = [];
    const { id, run } = await start({ gate: createGate(), onEnd: (job, how) => ended.push([job, how]) });
    end(id, "failed");
    await run;
    expect(ended).toEqual([[null, "failed"]]);
    expect(isAwaitingGo(id)).toBe(true);
    await cancelUpload(id);
    expect(isAwaitingGo(id)).toBe(false);
  });

  it("without a gate (or with an open one) nothing awaits go", async () => {
    const { isAwaitingGo } = await import("./uploadManager");
    const plain = await start();
    expect(plain.cb.ready).toBeUndefined();
    expect(isAwaitingGo(plain.id)).toBe(false);
    end(plain.id, "created");
    await plain.run;
    const open = await start({ gate: createGate(true) });
    expect(isAwaitingGo(open.id)).toBe(false);
    end(open.id, "created");
    await open.run;
  });

  it("says how the upload ended: created, cancelled before POST /jobs, failed", async () => {
    const { cancelUpload } = await import("./uploadControls");
    const ended: [string | null, How][] = [];
    const onEnd = (job: string | null, how: How) => ended.push([job, how]);
    const starting = vi.fn();
    const created = await start({ gate: createGate(true), onEnd, onStarting: starting });
    end(created.id, "created");
    await created.run;
    expect(starting).toHaveBeenCalledTimes(1);
    const cancelled = await start({ gate: createGate(), onEnd });
    await cancelUpload(cancelled.id);
    await cancelled.run;
    const failed = await start({ onEnd });
    end(failed.id, "failed");
    await failed.run;
    expect(ended).toEqual([
      [`job-${created.id}`, "created"],
      [null, "cancelled"],
      [null, "failed"],
    ]);
  });

  it("hands the length read at the pick to the upload", async () => {
    const known = await start({ duration: 12.5 });
    expect(known.cb.duration).toBe(12.5);
    end(known.id, "created");
    await known.run;
    const unknown = await start({ duration: null });
    expect(unknown.cb.duration).toBeNull();
    end(unknown.id, "created");
    await unknown.run;
  });

  it("the start screen's frame is the tile's thumbnail (no grab of its own); it follows the job", async () => {
    const { takeThumb } = await import("./uploadState");
    grabFrame.mockClear();
    const { id, run } = await start({ thumb: Promise.resolve("blob:frame") });
    end(id, "created");
    await run;
    expect(grabFrame).not.toHaveBeenCalled();
    await expect(takeThumb(`job-${id}`)).resolves.toBe("blob:frame");
    // Without one, the tile's frame is grabbed here.
    const plain = await start();
    end(plain.id, "created");
    await plain.run;
    expect(grabFrame).toHaveBeenCalledTimes(1);
  });

  it("<html data-uploading> while an upload runs, on a phone too", async () => {
    const attrs = new Map<string, boolean>();
    vi.stubGlobal("document", {
      documentElement: { toggleAttribute: (name: string, on: boolean) => attrs.set(name, on) },
    });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 });
    const { id, run } = await start({ gate: createGate() });
    expect(attrs.get("data-uploading")).toBe(true);
    end(id, "failed");
    await run;
    expect(attrs.get("data-uploading")).toBe(false);
  });
});
