import { describe, expect, it } from "vitest";
import { EMPTY_TL_HISTORY, sameSegs, TL_HISTORY_LIMIT, tlCommit, tlRedo, tlUndo, type TlHistoryState } from "./history";
import type { EditorSeg } from "./mechanics";

const seg = (id: string, start: number, end: number, x: Partial<EditorSeg> = {}): EditorSeg => ({ id, start, end, ...x });

describe("timeline undo history (pure steps)", () => {
  it("a commit equal to the clips on screen is no edit: no step, nothing to save (state-5)", () => {
    const present = [seg("a", 0, 4), seg("b", 6, 10)];
    const copy = present.map((s) => ({ ...s }));
    const r = tlCommit(EMPTY_TL_HISTORY, present, copy, undefined, 0);
    expect(r).toEqual({ st: EMPTY_TL_HISTORY, apply: false, added: false });
    // default effects written out are still the same list
    expect(sameSegs(present, [seg("a", 0, 4, { speed: 1, volume: 1, fadeIn: 0 }), seg("b", 6, 10)])).toBe(true);
    expect(sameSegs(present, [seg("a", 0, 4.01), seg("b", 6, 10)])).toBe(false);
    expect(sameSegs(present, [present[1], present[0]])).toBe(false);
  });

  it("redo keeps the whole history (it cut it to 30 entries, state-8)", () => {
    let st: TlHistoryState = EMPTY_TL_HISTORY;
    let present = [seg("a", 0, 10)];
    for (let k = 1; k <= 45; k++) {
      const next = [seg("a", 0, 10 + k)];
      st = tlCommit(st, present, next, undefined, k * 2000).st;
      present = next;
    }
    expect(st.history).toHaveLength(45);
    const u = tlUndo(st, present)!;
    expect(u.st.history).toHaveLength(44);
    const r = tlRedo(u.st, u.to)!;
    expect(r.st.history).toHaveLength(45);
    expect(r.to).toBe(present);
    // the limit is the same both ways
    for (let k = 0; k < 80; k++) st = tlCommit(st, [seg("a", 0, k)], [seg("a", 0, k + 0.5)], undefined, 1e6 + k * 2000).st;
    expect(st.history).toHaveLength(TL_HISTORY_LIMIT);
  });

  it("a slider moved again right after Undo is a new step, not merged into nothing (state-9)", () => {
    const p0 = [seg("a", 0, 10)];
    const p1 = [seg("a", 0, 10, { speed: 1.5 })];
    const c1 = tlCommit(EMPTY_TL_HISTORY, p0, p1, "a:speed", 1000);
    expect(c1.added).toBe(true);
    const u = tlUndo(c1.st, p1)!;
    expect(u.to).toBe(p0);
    const p2 = [seg("a", 0, 10, { speed: 2 })];
    const c2 = tlCommit(u.st, p0, p2, "a:speed", 1300);
    expect(c2.added).toBe(true);
    expect(c2.st.history).toEqual([p0]);
    // within one drag it still merges
    const c3 = tlCommit(c2.st, p2, [seg("a", 0, 10, { speed: 1.25 })], "a:speed", 1500);
    expect(c3.added).toBe(false);
    expect(c3.st.history).toEqual([p0]);
  });
});
