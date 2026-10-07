// A multipart upload waits out a lost connection (the owner's iPhone,
// 2026-10: Safari in the background cuts or freezes the part requests).
// While the page lives the upload never stops for a transient failure:
// it pauses ("waiting for connection") and continues — at once on
// online / visible / pageshow / focus — from the next missing part with
// the File in memory, without a new init.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Plan = "ok" | "network" | "abort" | "hang";
/** Outcomes per part number, in order (then "ok"). */
const plans = new Map<number, Plan[]>();
const puts: [part: number, plan: Plan][] = [];
const api: string[] = [];
let completeFails = 0;

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  return {
    ...real,
    apiFetch: vi.fn(async (path: string) => {
      const name = path.split("/").pop()!;
      if (name === "telemetry") return json({});
      api.push(name);
      if (name === "init") {
        return json({
          ticket: "t1",
          storage_key: "uploads/k1",
          part_size: 10,
          parts_total: 3,
          parts: [1, 2, 3].map((n) => ({ part_number: n, url: `https://r2.test/k1?partNumber=${n}` })),
        });
      }
      if (name === "complete") {
        if (completeFails > 0) {
          completeFails--;
          throw new TypeError("Load failed");
        }
        return json({ ok: true });
      }
      return json({ detail: "unexpected" }, 500);
    }),
  };
});

class FakeXHR {
  upload: { onprogress?: (e: { loaded: number }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 0;
  private url = "";
  private pending = false;
  open(_method: string, url: string) {
    this.url = url;
  }
  abort() {
    if (!this.pending) return;
    this.pending = false;
    this.onabort?.();
  }
  send(body: Blob) {
    const n = Number(new URL(this.url).searchParams.get("partNumber"));
    const plan = plans.get(n)?.shift() ?? "ok";
    puts.push([n, plan]);
    this.pending = true;
    setTimeout(() => {
      if (!this.pending || plan === "hang") return;
      this.pending = false;
      if (plan === "ok") {
        this.upload.onprogress?.({ loaded: body.size });
        this.status = 200;
        this.onload?.();
      } else if (plan === "network") this.onerror?.();
      else this.onabort?.();
    }, 0);
  }
}

// One set of page listeners for the whole file (the uploader adds its
// own once).
const listeners = new Map<string, Set<() => void>>();
const target = {
  addEventListener: (ev: string, f: () => void) => {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev)!.add(f);
  },
  removeEventListener: (ev: string, f: () => void) => void listeners.get(ev)?.delete(f),
};
const fire = (ev: string) => listeners.get(ev)?.forEach((f) => f());
const nav = { userAgent: "Mozilla/5.0 (iPhone)", onLine: true };

beforeEach(async () => {
  plans.clear();
  puts.length = 0;
  api.length = 0;
  completeFails = 0;
  nav.onLine = true;
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", { ...target, visibilityState: "visible" });
  vi.stubGlobal("navigator", nav);
  (await import("@/lib/uploadResume"))._useMemoryStoreForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const file = () => new File([new Uint8Array(30).fill(7)], "clip.mp4", { type: "video/mp4" });
const tries = (n: number) => puts.filter(([p]) => p === n).length;

async function start(signal?: AbortSignal) {
  const { uploadResumable } = await import("@/lib/chunkedUpload");
  const paused: boolean[] = [];
  const p = uploadResumable({ file: file(), signal, onPaused: (on) => paused.push(on) });
  // (Never an unhandled rejection while a test waits for something else.)
  p.catch(() => {});
  return { p, paused };
}

describe("a part fails with a network error", () => {
  it("pauses, then continues on `online` / visible from the next part, without a new init", async () => {
    plans.set(2, ["network", "network"]);
    const { p, paused } = await start();
    // The first retry waits its backoff — or less: the connection is back.
    await vi.waitFor(() => {
      fire("online");
      expect(tries(2)).toBe(2);
    });
    // Two in a row: "waiting for connection".
    await vi.waitFor(() => expect(paused).toEqual([true]));
    // Back from the background (visibilityState is "visible").
    fire("visibilitychange");
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(paused).toEqual([true, false]);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
    expect(api.filter((c) => c === "complete")).toHaveLength(1);
    // Part 1 was in already: never sent again; part 2 three times.
    expect(tries(1)).toBe(1);
    expect(tries(2)).toBe(3);
    expect(tries(3)).toBe(1);
  });

  it("offline: paused at once, and still never a failure", async () => {
    nav.onLine = false;
    plans.set(1, ["network", "network", "network", "network", "network", "network"]);
    const { p, paused } = await start();
    await vi.waitFor(() => expect(paused).toEqual([true]));
    // More failures than the old 4 attempts: it keeps waiting.
    await vi.waitFor(() => {
      fire("focus");
      expect(tries(1)).toBe(7);
    });
    nav.onLine = true;
    fire("online");
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(paused).toEqual([true, false]);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
  });

  it("an abort the browser did itself (iOS in the background) is retried, not a cancel", async () => {
    plans.set(1, ["abort"]);
    const { p } = await start();
    await vi.waitFor(() => {
      fire("pageshow");
      expect(tries(1)).toBe(2);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
  });

  it("a part left hanging in the background goes again as soon as the page is back", async () => {
    plans.set(1, ["hang"]);
    const { p } = await start();
    await vi.waitFor(() => expect(tries(1)).toBe(1));
    // Minutes later (the stall watchdog's timer was frozen meanwhile).
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 120_000);
    await vi.waitFor(() => {
      fire("visibilitychange");
      expect(tries(1)).toBe(2);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(api.filter((c) => c === "init")).toHaveLength(1);
  });

  it("the complete call waits out a network error too", async () => {
    completeFails = 2;
    const { p, paused } = await start();
    await vi.waitFor(() => {
      fire("online");
      expect(api.filter((c) => c === "complete").length).toBe(3);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(paused).toEqual([true, false]);
    expect(api.filter((c) => c === "init")).toHaveLength(1);
  });

  it("Cancel while it waits stops it", async () => {
    nav.onLine = false;
    plans.set(1, Array<Plan>(50).fill("network"));
    const ctl = new AbortController();
    const { p, paused } = await start(ctl.signal);
    await vi.waitFor(() => expect(paused).toEqual([true]));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(api).not.toContain("complete");
  });
});
