// "Zuletzt benutzt" (D4, D5): saveLastUsed writes this browser's prefs at
// once and, signed in, the account's through PUT /me/prefs with exactly
// the four keys the server takes (it refuses unknown ones). A failed PUT
// keeps the local copy. (When it is called: pendingStart.test.ts and
// pendingStart.upload.test.ts, as POST /jobs goes out.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LastUsedPrefs } from "./lastUsed";

const PREFS_KEY = "cleocuts.prefs.v1";
const store = new Map<string, string>();
const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();

const LAST: LastUsedPrefs = {
  target_aspect: "original",
  remove_fillers: false,
  spoken_language: "de",
  caption_style_last: "karaoke",
};

/** lastUsed with accounts `enabled` (a module constant) and `signedIn`. */
async function load({ enabled, signedIn }: { enabled: boolean; signedIn: boolean }) {
  vi.resetModules();
  vi.doMock("@/lib/auth", () => ({ AUTH_ENABLED: enabled, getAuthState: () => ({ loaded: true, signedIn }) }));
  vi.doMock("@/lib/api", () => ({ apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init) }));
  return import("./lastUsed");
}

const local = () => JSON.parse(store.get(PREFS_KEY) ?? "null") as Record<string, unknown> | null;

beforeEach(() => {
  store.clear();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/auth");
  vi.doUnmock("@/lib/api");
});

describe("saveLastUsed", () => {
  it("signed in: this browser's prefs and one PUT /me/prefs with exactly the four keys", async () => {
    // (Prefs of before stay: "Dein Standard", the old pace.)
    store.set(PREFS_KEY, JSON.stringify({ caption_style_default: { presetId: "neon", overrides: {} }, style: "smooth" }));
    const { saveLastUsed } = await load({ enabled: true, signedIn: true });
    await saveLastUsed(LAST);
    expect(local()).toEqual({ caption_style_default: { presetId: "neon", overrides: {} }, style: "smooth", ...LAST });
    expect(apiFetch).toHaveBeenCalledOnce();
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/me/prefs");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual(LAST);
    expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual([
      "caption_style_last",
      "remove_fillers",
      "spoken_language",
      "target_aspect",
    ]);
  });

  it("signed out, or no accounts: this browser's prefs only", async () => {
    let m = await load({ enabled: true, signedIn: false });
    await m.saveLastUsed(LAST);
    expect(local()).toEqual(LAST);
    m = await load({ enabled: false, signedIn: false });
    await m.saveLastUsed({ ...LAST, caption_style_last: "none" });
    expect(local()).toEqual({ ...LAST, caption_style_last: "none" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("a PUT that fails (offline, an older server) never fails it: this browser's copy stays", async () => {
    apiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const { saveLastUsed } = await load({ enabled: true, signedIn: true });
    await expect(saveLastUsed(LAST)).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(local()).toEqual(LAST);
  });
});
