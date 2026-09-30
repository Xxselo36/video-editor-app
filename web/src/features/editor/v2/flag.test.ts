import { afterEach, describe, expect, it, vi } from "vitest";

/** readChoice() for a build with NEXT_PUBLIC_EDITOR_V2=mode, at ?search,
 *  with `stored` in localStorage. */
async function choice(mode: string | undefined, search: string, stored: string | null = null) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_EDITOR_V2", mode);
  const store = new Map<string, string>(stored ? [["cleocuts.editor.version.v1", stored]] : []);
  vi.stubGlobal("window", { location: { search } });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  const { readChoice } = await import("./flag");
  return { on: readChoice(), stored: store.get("cleocuts.editor.version.v1") ?? null };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("editor v2 flag", () => {
  it("off: v1, and ?editor=v2 does nothing", async () => {
    expect(await choice(undefined, "?editor=v2")).toEqual({ on: false, stored: null });
  });

  it('"1": v2 unless this browser chose v1', async () => {
    expect((await choice("1", "")).on).toBe(true);
    expect(await choice("1", "?editor=v1")).toEqual({ on: false, stored: "v1" });
    expect((await choice("1", "", "v1")).on).toBe(false);
  });

  it('"optin": v1 unless this browser opted in with ?editor=v2', async () => {
    expect((await choice("optin", "")).on).toBe(false);
    expect(await choice("optin", "?editor=v2")).toEqual({ on: true, stored: "v2" });
    expect((await choice("optin", "", "v2")).on).toBe(true);
    expect(await choice("optin", "?editor=v1", "v2")).toEqual({ on: false, stored: "v1" });
  });
});
