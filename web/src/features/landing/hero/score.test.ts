import { describe, expect, it } from "vitest";
import { AT, FINISHED, HEAD_MS, MARKED, PIECES, POSTS, STEPS, keptLength, shiftAt, type PieceId } from "./score";

describe("hero score", () => {
  it("pieces fill the tape exactly", () => {
    expect(PIECES.reduce((n, p) => n + p.g, 0)).toBe(100);
    expect(AT.pre).toBe(0);
    expect(AT.post + PIECES[PIECES.length - 1].g).toBe(100);
  });

  it("posts sit on seams between pieces", () => {
    const seams = new Set(PIECES.map((p) => AT[p.id]));
    for (const post of POSTS) expect(seams.has(post.at)).toBe(true);
  });

  it("the finished tape keeps only the takes, closed up from the left", () => {
    const gone = new Set<PieceId>(FINISHED.gone);
    expect(keptLength(gone)).toBe(15 + 12 + 19);
    // the first kept take starts at 0 after the trim
    expect(AT.a - shiftAt(AT.a, gone)).toBe(0);
    // the finish post ends up at the kept end
    const finish = POSTS.find((p) => p.id === "finish")!;
    expect(finish.at - shiftAt(finish.at, gone)).toBe(keptLength(gone));
  });

  it("every marked removal is removed in the finished state", () => {
    for (const m of MARKED) expect(FINISHED.gone).toContain(m.id);
  });

  it("removals only grow during a loop, and each is marked before it goes", () => {
    let prev = new Set<PieceId>();
    let marked = new Set<PieceId>();
    // from the reset (raw) to the end of the loop
    const start = STEPS.findIndex((s) => s.fade === "snap");
    for (const s of STEPS.slice(start)) {
      for (const id of prev) expect(s.gone).toContain(id);
      for (const id of s.gone) if (!prev.has(id)) expect(marked.has(id)).toBe(true);
      for (const id of s.mark ?? []) marked.add(id);
      prev = new Set(s.gone);
    }
  });

  it("the playhead steps add up to its run time", () => {
    const run = STEPS.filter((s) => s.head === "run").reduce((n, s) => n + s.ms, 0);
    expect(run).toBe(HEAD_MS);
  });
});
