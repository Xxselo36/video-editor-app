// Timeline edits left on this device (save-11): the key the editor's
// autosave writes them under, and when the Vorschau counts them (valid
// clips, a week at most). writeUnsaved and the check share the key, so a
// copy written before the split is still found.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { writeUnsaved } from "./unsaved";
import { copyIsStored, hasUnsavedTimeline, readUnsaved, timelinePayload, unsavedKey, unsavedTimeline } from "./unsavedKey";

const store = new Map<string, string>();
const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 3600 * 1000;
const clip = (id: string, start: number, end: number): EditorSeg => ({ id, start, end });
const backup = { segs: [clip("a", 0, 5), clip("b", 6, 8)], base: 3, known: [3, 4], at: NOW - 60_000 };
const put = (v: unknown) => store.set(unsavedKey("j1"), JSON.stringify(v));

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  // (nothing this document kept from the test before)
  writeUnsaved("j1", null);
  writeUnsaved("j2", null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unsavedKey", () => {
  it("is the key copies were always stored under", () => {
    expect(unsavedKey("j1")).toBe("cleocuts.editor.unsaved.v1.j1");
  });
});

describe("hasUnsavedTimeline", () => {
  it("finds the copy the editor wrote for this job only, and nothing once it is cleared", () => {
    writeUnsaved("j1", backup);
    expect(hasUnsavedTimeline("j1", NOW)).toBe(true);
    expect(readUnsaved("j1", NOW)).toEqual(backup);
    expect(hasUnsavedTimeline("j2", NOW)).toBe(false);
    writeUnsaved("j1", null);
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
  });

  it("a copy older than a week no longer counts, and goes when it is read (nothing else would remove it)", () => {
    put({ ...backup, at: NOW - WEEK + 60_000 });
    expect(hasUnsavedTimeline("j1", NOW)).toBe(true);
    put({ ...backup, at: NOW - WEEK - 60_000 });
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
    expect(store.has(unsavedKey("j1"))).toBe(false);
  });

  it("counts valid clips only: none, empty or broken ones, no rev, not JSON", () => {
    for (const bad of [
      { ...backup, segs: [] },
      { ...backup, segs: "a" },
      { ...backup, segs: [clip("a", 0, 5), clip("b", 4, 4)] },
      { ...backup, segs: [{ start: 0, end: 5 }] },
      { ...backup, segs: [clip("a", 0, Number.NaN)] },
      { ...backup, base: "3" },
    ]) {
      put(bad);
      expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
      expect(store.has(unsavedKey("j1"))).toBe(false);
    }
    store.set(unsavedKey("j1"), "{");
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
  });

  it("storage blocked (private mode) or missing (server render): false, never a throw", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
    vi.stubGlobal("localStorage", undefined);
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
  });
});

describe("unsavedTimeline (the Vorschau, Fertigstellen): a copy counts only while the server lacks its timeline", () => {
  const stored = timelinePayload(backup.segs);

  it("the server has it (a keepalive save that landed after the tab closed): it doesn't count, and it goes", () => {
    writeUnsaved("j1", backup);
    expect(copyIsStored(backup, stored, 30)).toBe(true);
    expect(unsavedTimeline("j1", stored, 30, NOW)).toBeNull();
    expect(store.has(unsavedKey("j1"))).toBe(false);
  });

  it("the server has another timeline: the copy counts and stays", () => {
    writeUnsaved("j1", backup);
    const other = [{ start: 0, end: 5 }, { start: 6, end: 10 }];
    expect(copyIsStored(backup, other, 30)).toBe(false);
    expect(unsavedTimeline("j1", other, 30, NOW)).toEqual(backup);
    expect(unsavedTimeline("j1", undefined, 30, NOW)).toEqual(backup);
    expect(store.has(unsavedKey("j1"))).toBe(true);
  });

  it("no copy, or one with no clip a save would send: nothing", () => {
    expect(unsavedTimeline("j1", stored, 30, NOW)).toBeNull();
    const off = { ...backup, segs: backup.segs.map((x) => ({ ...x, disabled: true })) };
    expect(copyIsStored(off, [], 30)).toBe(true);
  });

  it("storage blocked: nothing, never a throw", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(unsavedTimeline("j1", stored, 30, NOW)).toBeNull();
  });

  it("storage full or blocked: this document keeps the copy (the Vorschau and Fertigstellen see it); no older one stays stored", () => {
    put(backup);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: (k: string) => void store.delete(k),
    });
    const newer = { ...backup, segs: [clip("a", 0, 4), clip("b", 6, 8)], at: NOW };
    writeUnsaved("j1", newer);
    expect(store.has(unsavedKey("j1"))).toBe(false);
    expect(readUnsaved("j1", NOW)).toEqual(newer);
    expect(unsavedTimeline("j1", stored, 30, NOW)).toEqual(newer);
    // the server has it: it goes from here too
    expect(unsavedTimeline("j1", timelinePayload(newer.segs), 30, NOW)).toBeNull();
    expect(readUnsaved("j1", NOW)).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    writeUnsaved("j1", newer);
    expect(hasUnsavedTimeline("j1", NOW)).toBe(true);
    expect(hasUnsavedTimeline("j2", NOW)).toBe(false);
    writeUnsaved("j1", null);
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
  });
});
