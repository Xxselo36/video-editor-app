// The pending start (D1 to D3): it waits for "Let's go" while the screen
// comes and goes, its callbacks work with no screen mounted, and it is
// let go once its job exists or the upload is given up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpload, StartOpts } from "@/features/upload/uploadManager";
import { initialChoices, lastUsedPrefs, settingsOf, type Choices } from "./choices";
import { uploadSettings } from "./defaults";

type Started = { file: File; settings: () => unknown; opts: StartOpts };
const started: Started[] = [];
// startUpload puts the card up before its first await (onCard); a file
// that already uploads in this page gets nothing.
let busyFile: File | null = null;
let nextId = 1;
const updateUploadSettings = vi.fn();
const cancelUpload = vi.fn<(id: string) => Promise<void>>(async () => {});
const retryUpload = vi.fn((_id: string, opts?: StartOpts) => {
  opts?.onCard?.(`upl-${nextId++}`);
  return true;
});
const saveLastUsed = vi.fn<(prefs: unknown) => Promise<void>>(async () => {});
let live: LiveUpload | null = null;
let awaiting = true;

vi.mock("@/features/upload/uploadManager", () => ({
  startUpload: async (file: File, settings: () => unknown, _preset: unknown, opts: StartOpts) => {
    if (file === busyFile) return;
    started.push({ file, settings, opts });
    opts.onCard?.(`upl-${nextId++}`);
  },
  updateUploadSettings: (...a: unknown[]) => updateUploadSettings(...a),
}));
vi.mock("@/features/upload/uploadControls", () => ({
  cancelUpload: (id: string) => cancelUpload(id),
  retryUpload: (id: string, opts?: StartOpts) => retryUpload(id, opts),
}));
vi.mock("@/features/upload/uploadState", () => ({
  getLiveUpload: () => live,
  isAwaitingGo: () => awaiting,
}));
vi.mock("./lastUsed", () => ({ saveLastUsed: (p: unknown) => saveLastUsed(p) }));

const probe = { width: 1080, height: 1920, duration: 42 };
const first = (): Choices => initialChoices({ saved: null, standard: null, lastStyle: null, live: undefined });
const sent = (c: Choices) => uploadSettings(settingsOf(c, probe), { captionStyle: c.style });

async function pick(name = "a.mp4", choices = first()) {
  const store = await import("./pendingStart");
  const file = new File([], name);
  const frame = Promise.resolve("blob:frame");
  const ok = store.beginStart(file, { probe, frame, choices });
  return { store, ok, file, frame, opts: started.at(-1)?.opts };
}

beforeEach(() => {
  vi.resetModules();
  started.length = 0;
  busyFile = null;
  nextId = 1;
  live = null;
  awaiting = true;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("pendingStart", () => {
  it("uploads at once, waits for Let's go, and is shown again when the screen comes back", async () => {
    const { store, ok, file, frame, opts } = await pick();
    expect(ok).toBe(true);
    expect(opts).toMatchObject({ thumb: frame, duration: 42 });
    expect(opts!.gate!.isOpen).toBe(false);
    const s = store.getPendingStart()!;
    expect(s).toMatchObject({ tempId: "upl-1", file, committed: false, failed: false });
    // Leaving and coming back neither starts nor discards it: the same
    // upload, gate, choices and frame (now kept from later prefs).
    store.restoreStart();
    const back = store.getPendingStart()!;
    expect(back).toMatchObject({ tempId: "upl-1", file, committed: false, failed: false, touched: true });
    expect(back.gate).toBe(s.gate);
    expect(back.choices).toBe(s.choices);
    expect(back.frame).toBe(s.frame);
    expect(s.gate.isOpen).toBe(false);
  });

  it("POST /jobs reads the choices when it goes out; the record follows each change", async () => {
    const { store } = await pick();
    const settings = started[0].settings;
    expect(settings()).toEqual(sent(first()));
    store.changeChoices((c) => ({ ...c, style: { presetId: "neon", overrides: {} }, captionsOnly: true }));
    const now = store.getPendingStart()!.choices;
    expect(now).toMatchObject({ style: { presetId: "neon" }, captionsOnly: true });
    expect(settings()).toEqual(sent(now));
    expect(settings()).toMatchObject({ style: "none", caption_style: { presetId: "neon", overrides: {} } });
    expect(updateUploadSettings).toHaveBeenLastCalledWith("upl-1", sent(now), lastUsedPrefs(now));
  });

  it("the record keeps the choices as wanted from the pick on, and so does the new upload of Try again", async () => {
    const { store, opts } = await pick();
    // ("Try again" after a reload remembers them as the last used.)
    expect(updateUploadSettings).toHaveBeenCalledWith("upl-1", sent(first()), lastUsedPrefs(first()));
    opts!.onEnd!(null, "failed");
    expect(store.retryStart()).toBe(true);
    expect(updateUploadSettings).toHaveBeenLastCalledWith("upl-2", sent(first()), lastUsedPrefs(first()));
  });

  it("after Let's go a new visit starts fresh, and the choices it went with are still remembered", async () => {
    const { store, opts } = await pick();
    store.changeChoices((c) => ({ ...c, style: { presetId: "karaoke", overrides: {} }, aspect: "original" }));
    const chosen = store.getPendingStart()!.choices;
    store.goStart();
    expect(opts!.gate!.isOpen).toBe(true);
    expect(store.getPendingStart()!.committed).toBe(true);
    store.restoreStart();
    expect(store.getPendingStart()).toBeNull();
    // The bytes are up later: POST /jobs goes out with no screen around.
    opts!.onStarting!();
    expect(saveLastUsed).toHaveBeenCalledWith(lastUsedPrefs(chosen));
    expect(started[0].settings()).toEqual(sent(chosen));
  });

  it("created while shown: the screen goes on to Projects as it is, and the next visit starts fresh", async () => {
    const shown = vi.fn();
    const { store, opts } = await pick();
    const hide = store.showStart(shown);
    store.goStart();
    opts!.onStarting!();
    opts!.onEnd!("job-1", "created");
    expect(shown).toHaveBeenCalledTimes(1);
    // No flash of the first screen on the way: the start stays until then.
    expect(store.getPendingStart()).toMatchObject({ committed: true, starting: true });
    hide();
    store.restoreStart();
    expect(store.getPendingStart()).toBeNull();
  });

  it("created with no screen showing it: let go at once", async () => {
    const shown = vi.fn();
    const { store, opts } = await pick();
    store.goStart();
    // Another visit: this start went, so it isn't shown.
    store.restoreStart();
    const hide = store.showStart(shown);
    opts!.onEnd!("job-1", "created");
    expect(shown).not.toHaveBeenCalled();
    expect(store.getPendingStart()).toBeNull();

    // A start nothing shows (the screen was left before "Let's go").
    hide();
    const second = await pick("b.mp4");
    store.goStart();
    second.opts!.onEnd!("job-2", "created");
    expect(store.getPendingStart()).toBeNull();
  });

  it("cancelled (its tile's Cancel): let go", async () => {
    const { store, opts } = await pick();
    opts!.onEnd!(null, "cancelled");
    expect(store.getPendingStart()).toBeNull();
  });

  it("failed: kept, and Try again goes on with the same gate and the start's callbacks", async () => {
    const { store, opts } = await pick();
    opts!.onEnd!(null, "failed");
    expect(store.getPendingStart()).toMatchObject({ failed: true, tempId: "upl-1" });
    store.restoreStart();
    expect(store.getPendingStart()?.failed).toBe(true);
    expect(store.retryStart()).toBe(true);
    expect(retryUpload).toHaveBeenCalledWith("upl-1", expect.objectContaining({ gate: opts!.gate, duration: 42 }));
    expect(store.getPendingStart()).toMatchObject({ tempId: "upl-2", failed: false });
  });

  it("a failed start given up on its tile is let go when the screen comes back", async () => {
    const { store, opts } = await pick();
    opts!.onEnd!(null, "failed");
    awaiting = false;
    store.restoreStart();
    expect(store.getPendingStart()).toBeNull();
  });

  it("given up on its tile while its upload still winds down (the abort's answer still out): let go too, never shown again", async () => {
    const { store } = await pick();
    // The tile's Cancel: no longer waiting for Let's go; onEnd comes later.
    awaiting = false;
    store.restoreStart();
    expect(store.getPendingStart()).toBeNull();
  });

  it("Try again without the File: let go, so the video is picked again", async () => {
    const { store, opts } = await pick();
    opts!.onEnd!(null, "failed");
    retryUpload.mockReturnValueOnce(false);
    expect(store.retryStart()).toBe(false);
    expect(store.getPendingStart()).toBeNull();
  });

  it("the choices are locked while POST /jobs is out, and free again after a failure", async () => {
    const { store, opts } = await pick();
    store.goStart();
    opts!.onStarting!();
    store.changeChoices((c) => ({ ...c, fillers: false }));
    expect(store.getPendingStart()!.choices.fillers).toBe(true);
    opts!.onEnd!(null, "failed");
    store.changeChoices((c) => ({ ...c, fillers: false }));
    expect(store.getPendingStart()!.choices.fillers).toBe(false);
  });

  it("once POST /jobs has read the choices they are locked (the legacy upload's bytes still going), free again after a failure", async () => {
    const { store, opts } = await pick();
    store.goStart();
    opts!.onSettingsRead!();
    expect(store.getPendingStart()).toMatchObject({ sent: true, starting: false });
    store.changeChoices((c) => ({ ...c, style: { presetId: "neon", overrides: {} } }));
    store.offerChoices({ ...first(), aspect: "original" });
    expect(store.getPendingStart()!.choices).toEqual(first());
    // The body is sent: what is remembered is what went.
    opts!.onStarting!();
    expect(saveLastUsed).toHaveBeenCalledWith(lastUsedPrefs(first()));
    opts!.onEnd!(null, "failed");
    expect(store.getPendingStart()).toMatchObject({ sent: false, starting: false, failed: true });
    store.changeChoices((c) => ({ ...c, fillers: false }));
    expect(store.getPendingStart()!.choices.fillers).toBe(false);
  });

  it("shown again after leaving, a waiting start keeps its choices: prefs read on the way back don't replace them", async () => {
    const { store } = await pick();
    updateUploadSettings.mockClear();
    const chosen = store.getPendingStart()!.choices;
    // Left before "Let's go", back on Neues Video: its prefs are read
    // anew (another video's POST wrote Karaoke as the last used meanwhile).
    store.restoreStart();
    store.offerChoices({ ...first(), style: { presetId: "karaoke", overrides: {} } });
    expect(store.getPendingStart()!.choices).toEqual(chosen);
    expect(updateUploadSettings).not.toHaveBeenCalled();
  });

  it("a pick that continues its stopped upload comes with that video's choices: prefs that answer later leave them", async () => {
    const store = await import("./pendingStart");
    const resumed: Choices = { ...first(), style: { presetId: "elegant", overrides: {} }, fillers: false, aspect: "original", language: "fr" };
    expect(store.beginStart(new File([], "r.mp4"), { probe, frame: Promise.resolve(null), choices: resumed, touched: true })).toBe(true);
    store.offerChoices(first());
    expect(store.getPendingStart()!.choices).toEqual(resumed);
    expect(started[0].settings()).toEqual(sent(resumed));
  });

  it("prefs that answer later apply only to untouched choices", async () => {
    const { store } = await pick();
    const later = { ...first(), style: { presetId: "neon", overrides: {} }, aspect: "original" as const };
    store.offerChoices(later);
    expect(store.getPendingStart()!.choices).toEqual(later);
    expect(store.getPendingStart()!.touched).toBe(false);
    store.changeChoices((c) => ({ ...c, language: "de" }));
    store.offerChoices(first());
    expect(store.getPendingStart()!.choices).toMatchObject({ style: { presetId: "neon" }, language: "de" });
  });

  it("X cancels the upload; not once POST /jobs is out, unless it waits for the connection", async () => {
    const { store } = await pick();
    live = { id: "upl-1", pct: 100, resuming: false, starting: true };
    store.cancelStart();
    expect(cancelUpload).not.toHaveBeenCalled();
    expect(store.getPendingStart()).not.toBeNull();
    live = { ...live, paused: true };
    store.cancelStart();
    expect(cancelUpload).toHaveBeenCalledWith("upl-1");
    expect(store.getPendingStart()).toBeNull();
  });

  it("the same file uploading already: nothing starts and the frame goes", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const store = await import("./pendingStart");
    busyFile = new File([], "busy.mp4");
    const frame = Promise.resolve("blob:busy");
    expect(store.beginStart(busyFile, { probe, frame, choices: first() })).toBe(false);
    expect(store.getPendingStart()).toBeNull();
    await frame;
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith("blob:busy");
  });
});
