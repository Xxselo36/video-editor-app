// Timeline edits left on this device (save-11): the key the editor's
// autosave writes them under, and when the Vorschau counts them (valid
// clips, a week at most). writeUnsaved and the check share the key, so a
// copy written before the split is still found.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { writeUnsaved } from "./unsaved";
import { hasUnsavedTimeline, readUnsaved, unsavedKey } from "./unsavedKey";

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

  it("a copy older than a week no longer counts", () => {
    put({ ...backup, at: NOW - WEEK + 60_000 });
    expect(hasUnsavedTimeline("j1", NOW)).toBe(true);
    put({ ...backup, at: NOW - WEEK - 60_000 });
    expect(hasUnsavedTimeline("j1", NOW)).toBe(false);
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
