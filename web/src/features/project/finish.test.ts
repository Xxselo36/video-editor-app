// Fertigstellen on the Vorschau (finish.ts): it never renders while the
// editor's last saves are out or while this device keeps changes the
// server doesn't have (the copies are read right before every POST), and
// a copy the server already has doesn't count.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editWord, type EditDoc } from "@/features/editor/state/doc";
import { docCopyOf, unsavedDocKey } from "@/features/editor/session/unsavedDoc";
import { unsavedKey } from "@/features/editor/session/unsavedKey";
import { runFinish, SAVES_WAIT_MS, unsavedOnDevice, type FinishDeps, type FinishStep } from "./finish";

const store = new Map<string, string>();
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

/** Fertigstellen with fakes; `log` is what happened, in order. */
function deps(o: { pending?: boolean; settles?: boolean; unsaved?: boolean | null; live?: () => boolean } = {}) {
  const log: string[] = [];
  const d: FinishDeps<string> = {
    pending: () => o.pending ?? false,
    waitForSaves: async (ms) => {
      log.push(`wait ${ms}`);
      return o.settles ?? true;
    },
    unsaved: async () => {
      log.push("copies");
      return o.unsaved === undefined ? false : o.unsaved;
    },
    live: o.live ?? (() => true),
    step: (s: FinishStep) => log.push(s),
    post: async () => {
      log.push("POST");
      return "answer";
    },
  };
  return { d, log };
}

describe("runFinish", () => {
  it("nothing out, nothing on this device: the copies are read right before the POST", async () => {
    const { d, log } = deps();
    expect(await runFinish(d)).toEqual({ kind: "posted", answer: "answer" });
    expect(log).toEqual(["checking", "copies", "starting", "POST"]);
  });

  it("a change on this device the server doesn't have: no POST (also without saves out)", async () => {
    const { d, log } = deps({ unsaved: true });
    expect(await runFinish(d)).toEqual({ kind: "unsaved" });
    expect(log).toEqual(["checking", "copies"]);
  });

  it("the editor's saves out: waited for (8 s), then the copies, then the POST", async () => {
    const { d, log } = deps({ pending: true });
    expect((await runFinish(d)).kind).toBe("posted");
    expect(log).toEqual(["saving", `wait ${SAVES_WAIT_MS}`, "checking", "copies", "starting", "POST"]);
    expect(SAVES_WAIT_MS).toBe(8000);
  });

  it("saves that settled but failed (their copy stays): no POST", async () => {
    const { d, log } = deps({ pending: true, unsaved: true });
    expect(await runFinish(d)).toEqual({ kind: "unsaved" });
    expect(log).not.toContain("POST");
  });

  it("saves still out after 8 s: still saving, no POST", async () => {
    const { d, log } = deps({ pending: true, settles: false });
    expect(await runFinish(d)).toEqual({ kind: "stillSaving" });
    expect(log).toEqual(["saving", `wait ${SAVES_WAIT_MS}`]);
  });

  it("can't tell (the server's doc couldn't be read): no POST", async () => {
    const { d, log } = deps({ unsaved: null });
    expect(await runFinish(d)).toEqual({ kind: "unknown" });
    expect(log).not.toContain("POST");
  });

  it("the page went away meanwhile (Feinschliff opened): nothing starts", async () => {
    let n = 0;
    const { d, log } = deps({ pending: true, live: () => ++n < 2 });
    expect(await runFinish(d)).toEqual({ kind: "left" });
    expect(log).not.toContain("POST");
  });
});

describe("unsavedOnDevice", () => {
  const job = { id: "j1", duration: 30, edit_segments: [{ start: 0, end: 5 }, { start: 6, end: 10 }] };
  const doc: EditDoc = {
    v: 2,
    language: "en",
    words: [
      { id: "w1", text: "one", start: 0, end: 0.5 },
      { id: "w2", text: "ten", start: 1, end: 1.5 },
    ],
    clips: null,
    style: { presetId: "power", overrides: {} },
    format: { aspect: "9:16" },
    rev: 3,
  };
  const fixed = editWord(doc, "w2", "zehn");
  const copy = docCopyOf({ known: { ...doc, rev: 3 }, local: fixed, unacked: [] }, Date.now())!;
  const timeline = (segs: { start: number; end: number }[]) =>
    JSON.stringify({ segs: segs.map((x, i) => ({ id: `s${i}`, ...x })), base: 1, known: [], at: Date.now() });

  it("nothing kept: false, without asking the server", async () => {
    const read = vi.fn();
    expect(await unsavedOnDevice(job, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("a timeline the server doesn't have: true; one it has (a save that landed after the tab closed): false, and it goes", async () => {
    store.set(unsavedKey("j1"), timeline([{ start: 0, end: 5 }]));
    expect(await unsavedOnDevice(job)).toBe(true);
    store.set(unsavedKey("j1"), timeline(job.edit_segments));
    expect(await unsavedOnDevice(job)).toBe(false);
    expect(store.has(unsavedKey("j1"))).toBe(false);
  });

  it("text changes the server's doc doesn't have: true; ones it has: false, and the copy goes", async () => {
    store.set(unsavedDocKey("j1"), JSON.stringify(copy));
    expect(await unsavedOnDevice(job, async () => ({ doc }))).toBe(true);
    expect(store.has(unsavedDocKey("j1"))).toBe(true);
    expect(await unsavedOnDevice(job, async () => ({ doc: fixed }))).toBe(false);
    expect(store.has(unsavedDocKey("j1"))).toBe(false);
  });

  it("the server's doc can't be read now: null (can't tell)", async () => {
    store.set(unsavedDocKey("j1"), JSON.stringify(copy));
    expect(await unsavedOnDevice(job, async () => null)).toBeNull();
    expect(await unsavedOnDevice(job, () => Promise.reject(new TypeError("offline")))).toBeNull();
    expect(store.has(unsavedDocKey("j1"))).toBe(true);
  });
});
