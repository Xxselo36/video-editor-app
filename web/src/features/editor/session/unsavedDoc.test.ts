// Text changes left on this device (journeys-2, unsavedDoc.ts): what is
// kept of the doc autosave's state, how long, with blocked or full
// storage, and what the next open of the editor does with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWord, hideWords, mergeWords, setStyle, type EditDoc } from "@/features/editor/state/doc";
import { DocSaver, type PatchBody } from "@/features/editor/state/docSave";
import {
  applyDocCopy,
  decideDocCopy,
  decideDocCopyOnOpen,
  docCopyOf,
  docHasCopy,
  dropDocCopy,
  readDocCopy,
  unsavedDocKey,
  writeDocCopy,
  type DocCopy,
} from "./unsavedDoc";

const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 3600 * 1000;
const store = new Map<string, string>();

function docOf(n: number): EditDoc {
  return {
    v: 2,
    language: "en",
    words: Array.from({ length: n }, (_, i) => ({ id: `w${i + 1}`, text: `word${i + 1}`, start: i, end: i + 0.8 })),
    clips: null,
    style: { presetId: "power", overrides: {} },
    format: { aspect: "9:16" },
    rev: 0,
  };
}
const base = docOf(6);
const known = (d: EditDoc, rev: number) => ({ words: d.words, style: d.style, format: d.format, rev });
const fixed = editWord(base, "w3", "zehn");

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  // (nothing this document kept from the test before)
  writeDocCopy("j1", null);
  writeDocCopy("j2", null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("docCopyOf: what is kept", () => {
  it("nothing the server doesn't have: no copy", () => {
    expect(docCopyOf({ known: known(base, 7), local: base, unacked: [] }, NOW)).toBeNull();
  });

  it("the changed words, the deleted ids, style and format when they changed; the rev they were made on", () => {
    const local = setStyle(hideWords(editWord(editWord(base, "w3", "zehn"), "w5", ""), ["w1"], true), {
      presetId: "karaoke",
      overrides: {},
    });
    const c = docCopyOf({ known: known(base, 7), local, unacked: [] }, NOW)!;
    expect(c.base).toBe(7);
    expect(c.known).toEqual([]);
    expect(c.upsert.map((w) => [w.id, w.text, !!w.hidden])).toEqual(
      expect.arrayContaining([
        ["w3", "zehn", false],
        ["w1", "word1", true],
      ]),
    );
    expect(c.delete).toEqual(["w5"]);
    expect(c.style?.presetId).toBe("karaoke");
    expect(c.format).toBeUndefined();
    expect(c.at).toBe(NOW);
    // the server's doc with it is this device's
    const server = { ...base, words: mergeWords(base.words, c.upsert, c.delete), style: c.style! };
    expect(server.words.map((w) => w.text)).toEqual(local.words.map((w) => w.text));
  });

  it("a request still out may have been stored: its rev is known, and what it touched goes as this device has it now", () => {
    // sent "zehn" for w3 (no answer yet), then undone here
    const sent: PatchBody = { base_rev: 7, rev: 8, words: { upsert: [fixed.words[2]], delete: [] } };
    const c = docCopyOf({ known: known(base, 7), local: base, unacked: [sent] }, NOW)!;
    expect(c.known).toEqual([8]);
    expect(c.upsert).toEqual([base.words[2]]);
    // on a server that stored that request, it brings back "word3"
    const server = { ...base, words: mergeWords(base.words, [fixed.words[2]], []) };
    expect(applyDocCopy(server, c).words[2].text).toBe("word3");
  });

  it("of a real autosave whose save didn't get through (500, retrying)", async () => {
    const saver = new DocSaver(base, 7, {
      jobId: "j1",
      fetch: async () => new Response("{}", { status: 500 }),
      debounceMs: 0,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    saver.schedule(fixed);
    await saver.flush();
    expect(saver.status).toBe("retrying");
    const c = docCopyOf(saver, NOW)!;
    expect(c.base).toBe(7);
    expect(c.known).toHaveLength(1);
    expect(c.upsert.map((w) => w.text)).toEqual(["zehn"]);
  });
});

describe("readDocCopy / writeDocCopy", () => {
  const copy: DocCopy = { base: 7, known: [8], upsert: [fixed.words[2]], delete: ["w5"], at: NOW - 60_000 };

  it("one key per job; null clears it", () => {
    writeDocCopy("j1", copy);
    expect(store.has(unsavedDocKey("j1"))).toBe(true);
    expect(unsavedDocKey("j1")).toBe("cleocuts.editor.unsavedDoc.v1.j1");
    expect(readDocCopy("j1", NOW)).toEqual(copy);
    expect(readDocCopy("j2", NOW)).toBeNull();
    writeDocCopy("j1", null);
    expect(readDocCopy("j1", NOW)).toBeNull();
  });

  it("at most a week old; an older one goes when it is read (nothing else would remove it)", () => {
    writeDocCopy("j1", { ...copy, at: NOW - WEEK + 60_000 });
    expect(readDocCopy("j1", NOW)).not.toBeNull();
    writeDocCopy("j1", { ...copy, at: NOW - WEEK - 60_000 });
    expect(readDocCopy("j1", NOW)).toBeNull();
    expect(store.has(unsavedDocKey("j1"))).toBe(false);
  });

  it("only a valid copy that changes something counts", () => {
    for (const bad of [
      { ...copy, base: "7" },
      { ...copy, at: undefined },
      { ...copy, upsert: [{ id: "w3" }] },
      { ...copy, upsert: "w3" },
      { ...copy, delete: [3] },
      { ...copy, style: { overrides: {} } },
      { ...copy, upsert: [], delete: [] },
    ]) {
      store.set(unsavedDocKey("j1"), JSON.stringify(bad));
      expect(readDocCopy("j1", NOW)).toBeNull();
      expect(store.has(unsavedDocKey("j1"))).toBe(false);
    }
    store.set(unsavedDocKey("j1"), "{");
    expect(readDocCopy("j1", NOW)).toBeNull();
    expect(store.has(unsavedDocKey("j1"))).toBe(false);
  });

  it("storage blocked or full: never a throw; this document keeps the copy (the Vorschau sees it), no older one stays stored", () => {
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
    expect(() => writeDocCopy("j1", copy)).not.toThrow();
    expect(readDocCopy("j1", NOW)).toEqual(copy);
    expect(readDocCopy("j2", NOW)).toBeNull();
    writeDocCopy("j1", null);
    expect(readDocCopy("j1", NOW)).toBeNull();
    // full: the older stored copy goes, the newer one is kept here
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: (k: string) => void store.delete(k),
    });
    store.set(unsavedDocKey("j1"), JSON.stringify(copy));
    const newer = { ...copy, upsert: [{ ...fixed.words[2], text: "elf" }] };
    writeDocCopy("j1", newer);
    expect(store.has(unsavedDocKey("j1"))).toBe(false);
    expect(readDocCopy("j1", NOW)).toEqual(newer);
    // dropped once the server has it (only while it is that copy)
    dropDocCopy("j1", copy);
    expect(readDocCopy("j1", NOW)).toEqual(newer);
    dropDocCopy("j1", newer);
    expect(readDocCopy("j1", NOW)).toBeNull();
    // no storage at all: nothing thrown, kept here all the same
    vi.stubGlobal("localStorage", undefined);
    expect(() => writeDocCopy("j1", copy)).not.toThrow();
    expect(readDocCopy("j1", NOW)).toEqual(copy);
    writeDocCopy("j1", null);
    expect(readDocCopy("j1", NOW)).toBeNull();
  });

  it("a copy too big for the shared storage isn't stored: this document keeps it until a smaller one is", () => {
    const words = Array.from({ length: 12_000 }, (_, i) => ({ id: `n${i}`, text: "x".repeat(60), start: i, end: i + 0.5 }));
    writeDocCopy("j1", { ...copy, upsert: words });
    expect(store.has(unsavedDocKey("j1"))).toBe(false);
    expect(readDocCopy("j1", NOW)?.upsert).toHaveLength(12_000);
    writeDocCopy("j1", copy);
    expect(store.has(unsavedDocKey("j1"))).toBe(true);
    expect(readDocCopy("j1", NOW)).toEqual(copy);
    writeDocCopy("j1", null);
    expect(readDocCopy("j1", NOW)).toBeNull();
  });

  it("dropDocCopy drops it only while it is the same copy", () => {
    writeDocCopy("j1", copy);
    const newer = { ...copy, at: copy.at + 1 };
    writeDocCopy("j1", newer);
    dropDocCopy("j1", copy);
    expect(readDocCopy("j1", NOW)).toEqual(newer);
    dropDocCopy("j1", newer);
    expect(readDocCopy("j1", NOW)).toBeNull();
  });
});

describe("the next open: decideDocCopy", () => {
  const copy = docCopyOf({ known: known(base, 7), local: fixed, unacked: [] }, NOW)!;

  it("the server has it (a keepalive save that landed after the tab closed): nothing to do", () => {
    expect(docHasCopy(fixed, copy)).toBe(true);
    expect(decideDocCopy(copy, { doc: fixed, rev: 9 })).toEqual({ kind: "none" });
    expect(decideDocCopy(null, { doc: base, rev: 7 })).toEqual({ kind: "none" });
  });

  it("the server is still at the rev it was made on (or at one of this device's): back by itself", () => {
    expect(docHasCopy(base, copy)).toBe(false);
    expect(decideDocCopy(copy, { doc: base, rev: 7 })).toEqual({ kind: "auto", copy });
    expect(decideDocCopy({ ...copy, known: [8] }, { doc: base, rev: 8 }).kind).toBe("auto");
    const back = applyDocCopy(base, copy);
    expect(back.words.map((w) => w.text)).toEqual(fixed.words.map((w) => w.text));
    expect(applyDocCopy(back, copy)).toBe(back);
  });

  it("another tab or device saved since: the server's doc stays (moved), nothing applied by itself", () => {
    const theirs = editWord(base, "w4", "vier");
    expect(decideDocCopy(copy, { doc: theirs, rev: 12 })).toEqual({ kind: "moved" });
  });

  it("at the open, after newer v1 sentence edits (they don't move the rev): those win over an older copy; one they carry is nothing to bring back", () => {
    // "zehn" kept here an hour ago; the v1 editor saved the sentence with "10" since
    const old = { ...copy, at: NOW - 3_600_000 };
    const v1 = editWord(base, "w3", "10");
    expect(decideDocCopy(old, { doc: base, rev: 7 }).kind).toBe("auto");
    expect(decideDocCopyOnOpen(old, { doc: base, rev: 7 }, v1, NOW)).toEqual({ kind: "moved" });
    // the sentence save carried the copy's change (its PATCH failed, /phrases didn't)
    expect(decideDocCopyOnOpen(old, { doc: base, rev: 7 }, fixed, NOW)).toEqual({ kind: "none" });
    // sentence edits saved before the copy was made: the copy is the newer change
    expect(decideDocCopyOnOpen(old, { doc: base, rev: 7 }, v1, old.at - 60_000)).toEqual({ kind: "auto", copy: old });
    // none applied: as before
    expect(decideDocCopyOnOpen(old, { doc: base, rev: 7 }, base, null)).toEqual({ kind: "auto", copy: old });
    expect(decideDocCopyOnOpen(old, { doc: base, rev: 12 }, base, null)).toEqual({ kind: "moved" });
    expect(decideDocCopyOnOpen(null, { doc: base, rev: 7 }, v1, NOW)).toEqual({ kind: "none" });
  });

  it("a style the server checked (keys in another order) is the same style", () => {
    const styled = setStyle(base, { presetId: "karaoke", overrides: { size: 1.2, color: "#fff" } });
    const c = docCopyOf({ known: known(base, 7), local: styled, unacked: [] }, NOW)!;
    const server = { ...base, style: { overrides: { color: "#fff", size: 1.2 }, presetId: "karaoke" } };
    expect(docHasCopy(server, c)).toBe(true);
  });
});
