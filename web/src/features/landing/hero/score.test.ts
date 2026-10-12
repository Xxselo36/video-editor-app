import { describe, expect, it } from "vitest";
import { AT, FINISHED, FIRST, HEAD_MS, LOOP_FROM, MARKED, PIECES, POSTS, STEPS, keptLength, shiftAt, type PieceId } from "./score";

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
    expect(keptLength(gone)).toBe(13 + 10 + 10 + 13);
    // the first kept take starts at 0 after the trim
    expect(AT.a - shiftAt(AT.a, gone)).toBe(0);
    // the finish post ends up at the kept end
    const finish = POSTS.find((p) => p.id === "finish")!;
    expect(finish.at - shiftAt(finish.at, gone)).toBe(keptLength(gone));
  });

  it("every marked removal is removed in the finished state", () => {
    for (const m of MARKED) expect(FINISHED.gone).toContain(m.id);
  });

  it("each marked removal leaves its own seam on the finished tape", () => {
    const gone = new Set<PieceId>(FINISHED.gone);
    const seams = MARKED.map((m) => AT[m.id] - shiftAt(AT[m.id], gone));
    expect(new Set(seams).size).toBe(MARKED.length);
    // none hides under the finish post at the kept end
    for (const x of seams) expect(x).toBeLessThan(keptLength(gone));
  });

  it("removals only grow during a loop, and each is marked before it goes", () => {
    let prev = new Set<PieceId>();
    const marked = new Set<PieceId>();
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

  it("the loop ends on the captions playing and goes on from the finished hold", () => {
    expect(STEPS[FIRST].frame).toBe("lit");
    expect(STEPS[STEPS.length - 1]).toMatchObject({ frame: "lit", play: true, gone: FINISHED.gone });
    expect(STEPS[LOOP_FROM]).toMatchObject({ frame: "lit", gone: FINISHED.gone });
    expect(STEPS[LOOP_FROM].play).toBeFalsy();
    expect(LOOP_FROM).toBeGreaterThan(FIRST);
    expect(LOOP_FROM).toBeLessThan(STEPS.findIndex((s) => s.fade === "snap"));
  });
});
