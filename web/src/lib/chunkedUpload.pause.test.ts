// A multipart upload waits out a lost connection (the owner's iPhone,
// 2026-10: Safari in the background cuts or freezes the part requests).
// While the page lives the upload never stops for a transient failure:
// it pauses ("waiting for connection") and continues — at once on
// online / visible / pageshow / focus — from the next missing part with
// the File in memory, without a new init.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** "moved": the whole part goes out, then the connection drops. */
type Plan = "ok" | "network" | "abort" | "hang" | "moved" | "403";
/** Outcomes per part number, in order (then "ok"). */
const plans = new Map<number, Plan[]>();
const puts: [part: number, plan: Plan, url: string][] = [];
const api: string[] = [];
let completeFails = 0;
/** API calls (by name) whose next request never answers. */
const hangOnce = new Set<string>();
let signs = 0;

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  return {
    ...real,
    apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
      const name = path.split("/").pop()!;
      if (name === "telemetry") return json({});
      api.push(name);
      if (hangOnce.delete(name)) return new Promise<Response>(() => {});
      if (name === "init") {
        return json({
          ticket: "t1",
          storage_key: "uploads/k1",
          part_size: 10,
          parts_total: 3,
          parts: [1, 2, 3].map((n) => ({ part_number: n, url: `https://r2.test/k1?partNumber=${n}` })),
        });
      }
      if (name === "sign") {
        signs++;
        const body = JSON.parse(String(init?.body)) as { part_numbers: number[] };
        return json({
          parts: body.part_numbers.map((n) => ({ part_number: n, url: `https://r2.test/k1?partNumber=${n}&s=${signs}` })),
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
    puts.push([n, plan, this.url]);
    this.pending = true;
    setTimeout(() => {
      if (!this.pending || plan === "hang") return;
      this.pending = false;
      if (plan === "ok" || plan === "403") {
        this.upload.onprogress?.({ loaded: body.size });
        this.status = plan === "ok" ? 200 : 403;
        this.onload?.();
      } else if (plan === "moved") {
        this.upload.onprogress?.({ loaded: body.size });
        this.onerror?.();
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
  hangOnce.clear();
  signs = 0;
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

const realNow = Date.now.bind(Date);
/** Date.now `ms` ahead of the real clock (timers stay real). */
function later(ms: number) {
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
}

describe("presigned part URLs across a long pause (6 h)", () => {
  it("knows each URL's end: X-Amz-Expires, else 6 h, minus a margin", async () => {
    const { signedUrl } = await import("@/lib/chunkedUpload");
    expect(signedUrl("https://r2/k?partNumber=1&X-Amz-Expires=3600", 0)).toEqual({
      url: "https://r2/k?partNumber=1&X-Amz-Expires=3600",
      at: 0,
      until: 3600_000 - 600_000,
    });
    expect(signedUrl("https://r2/k?partNumber=1", 0).until).toBe(6 * 3600_000 - 600_000);
    // A short TTL is never "stale at once".
    expect(signedUrl("https://r2/k?X-Amz-Expires=60", 0).until).toBe(30_000);
  });

  it("an expired URL that fails as a network error (no CORS headers) is signed again, not retried forever", async () => {
    plans.set(1, ["hang"]);
    const { p } = await start();
    await vi.waitFor(() => expect(tries(1)).toBe(1));
    // Overnight: the URL from init ran out; R2's 403 reads as status 0.
    later(7 * 3600_000);
    await vi.waitFor(() => {
      fire("visibilitychange");
      expect(tries(1)).toBe(2);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(api).toContain("sign");
    const urls = puts.filter(([n]) => n === 1).map(([, , u]) => u);
    expect(urls[0]).not.toContain("&s=");
    expect(urls[1]).toContain("&s=");
    expect(api.filter((c) => c === "init")).toHaveLength(1);
  });

  it("stale URLs are signed again before use, in one batch", async () => {
    plans.set(1, ["network"]);
    const { p } = await start();
    await vi.waitFor(() => expect(tries(1)).toBe(1));
    later(7 * 3600_000);
    fire("online");
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    // Parts 1 (and any still waiting) went with new URLs, one /sign.
    expect(signs).toBe(1);
    expect(puts.filter(([n]) => n === 1).at(-1)![2]).toContain("&s=1");
  });

  it("a 403 after every long pause is signed again (no one-time limit); a 403 on a fresh URL is an answer", async () => {
    plans.set(1, ["hang", "hang"]);
    const { p } = await start();
    await vi.waitFor(() => expect(tries(1)).toBe(1));
    later(7 * 3600_000);
    await vi.waitFor(() => {
      fire("visibilitychange");
      expect(tries(1)).toBe(2);
    });
    // Locked again for the night with the re-signed URL hanging.
    later(14 * 3600_000);
    await vi.waitFor(() => {
      fire("visibilitychange");
      expect(tries(1)).toBe(3);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(signs).toBe(2);

    // A new upload (the finished one's record goes).
    (await import("@/lib/uploadResume"))._useMemoryStoreForTests();
    plans.set(1, ["403", "403"]);
    const second = await start();
    // Fresh URL from init, 403: re-signed only when old — here it isn't.
    await expect(second.p).rejects.toThrow();
  });
});

describe("a hung API call", () => {
  it("is cut when the page comes back and tried again", async () => {
    hangOnce.add("complete");
    const { p } = await start();
    await vi.waitFor(() => expect(api.filter((c) => c === "complete")).toHaveLength(1));
    later(60_000);
    await vi.waitFor(() => {
      fire("focus");
      expect(api.filter((c) => c === "complete")).toHaveLength(2);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
  });

  it("init is not cut on wake (it isn't idempotent): only its own deadline ends it", async () => {
    hangOnce.add("init");
    const ctl = new AbortController();
    const { p } = await start(ctl.signal);
    await vi.waitFor(() => expect(api).toEqual(["init"]));
    later(60_000);
    fire("focus");
    await new Promise((r) => setTimeout(r, 30));
    expect(api).toEqual(["init"]);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("waiting is shown only when nothing gets through", () => {
  it("failures after the part went out don't count as 'in a row'", async () => {
    plans.set(1, ["moved", "moved", "moved"]);
    const { p, paused } = await start();
    await vi.waitFor(() => {
      fire("online");
      expect(tries(1)).toBe(4);
    });
    await expect(p).resolves.toMatchObject({ storage_key: "uploads/k1" });
    expect(paused).toEqual([]);
  });
});
