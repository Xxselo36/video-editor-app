import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "cleocuts.captions.engine.v1";

/** readCaptionsV2() at ?search with `stored` in localStorage. */
async function read(search: string, stored: string | null = null) {
  vi.resetModules();
  const store = new Map<string, string>(stored ? [[KEY, stored]] : []);
  vi.stubGlobal("window", { location: { search } });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  const { readCaptionsV2 } = await import("./flag");
  return { on: readCaptionsV2(), stored: store.get(KEY) ?? null };
}

afterEach(() => vi.unstubAllGlobals());

describe("v2 export captions opt-in (per browser)", () => {
  it("off unless this browser opted in", async () => {
    expect(await read("")).toEqual({ on: false, stored: null });
    expect(await read("?editor=v2")).toEqual({ on: false, stored: null });
  });

  it("?captions=v2 switches it on and is remembered; ?captions=v1 off", async () => {
    expect(await read("?editor=v2&captions=v2")).toEqual({ on: true, stored: "v2" });
    expect(await read("", "v2")).toEqual({ on: true, stored: "v2" });
    expect(await read("?captions=v1", "v2")).toEqual({ on: false, stored: "v1" });
    expect(await read("?captions=bogus", "v2")).toEqual({ on: false, stored: "v2" });
  });

  it("without storage (private mode) it stays off", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { search: "?captions=v2" } });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const { readCaptionsV2 } = await import("./flag");
    expect(readCaptionsV2()).toBe(false);
  });
});
