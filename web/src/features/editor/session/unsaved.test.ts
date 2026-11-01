import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { timelinePayload } from "./timelineSave";
import { decideUnsaved, dropOffered, readUnsaved, writeUnsaved } from "./unsaved";

const clip = (id: string, start: number, end: number): EditorSeg => ({ id, start, end });
const mine = [clip("a", 0, 5), clip("b", 6, 8)];
const server = [clip("a", 0, 5), clip("b", 6, 10)];

describe("edits left unsaved on this device (save-11)", () => {
  const backup = { segs: mine, base: 100, known: [100, 150], at: 0 };

  it("the server has them: nothing to offer", () => {
    expect(decideUnsaved(backup, { rev: 150, segments: timelinePayload(mine) }, 30)).toEqual({ kind: "none" });
    expect(decideUnsaved(null, { rev: 1, segments: [] }, 30)).toEqual({ kind: "none" });
  });

  it("nobody saved since (the rev the edit was made on, or one of this device's): back by themselves", () => {
    expect(decideUnsaved(backup, { rev: 100, segments: timelinePayload(server) }, 30).kind).toBe("auto");
    expect(decideUnsaved(backup, { rev: 150, segments: timelinePayload(server) }, 30).kind).toBe("auto");
  });

  it("another tab or device saved since: offered, never applied by itself", () => {
    const d = decideUnsaved(backup, { rev: 999, segments: timelinePayload(server) }, 30);
    expect(d.kind).toBe("offer");
    expect(d.kind !== "none" && d.segs).toEqual(mine);
  });
});

describe("an offered copy left alone (the editor left in the app, no Restore, no edit)", () => {
  const store = new Map<string, string>();
  const copy = { segs: mine, base: 100, known: [100], at: Date.now() - 60_000 };
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

  it("goes: the decision carries the copy as read, dropOffered removes it", () => {
    writeUnsaved("j1", copy);
    const d = decideUnsaved(readUnsaved("j1"), { rev: 999, segments: timelinePayload(server) }, 30);
    expect(d.kind).toBe("offer");
    dropOffered("j1", d.kind === "none" ? copy : d.copy);
    expect(readUnsaved("j1")).toBeNull();
  });

  it("stays when one was written since (Restore or an edit: the autosave's), or for another job", () => {
    writeUnsaved("j1", copy);
    writeUnsaved("j2", copy);
    const offered = readUnsaved("j1")!;
    const since = { segs: mine, base: 999, known: [100, 999], at: Date.now() };
    writeUnsaved("j1", since);
    dropOffered("j1", offered);
    expect(readUnsaved("j1")).toEqual(since);
    expect(readUnsaved("j2")).toEqual(copy);
  });

  it("blocked storage: nothing thrown", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => dropOffered("j1", copy)).not.toThrow();
  });
});
