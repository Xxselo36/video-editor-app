import { describe, expect, it } from "vitest";
import {
  AT,
  FINISHED,
  FIRST,
  HEAD_FROM,
  HEAD_MS,
  LOOP_FROM,
  MARKED,
  PIECES,
  POSTS,
  STEPS,
  keptLength,
  shiftAt,
  type PieceId,
  type Post,
} from "./score";

/** Where a point at `x` % ends up on the finished tape. */
const finishedAt = (x: number) => x - shiftAt(x, new Set<PieceId>(FINISHED.gone));
const post = (id: Post["id"]) => POSTS.find((p) => p.id === id)!;
const pieceAt = (x: number) => PIECES.findIndex((p) => AT[p.id] === x);
/** From the reset (raw) to the end of the loop. */
const loop = STEPS.slice(STEPS.findIndex((s) => s.fade === "snap"));
const talkSteps = STEPS.filter((s) => s.phase === "talk" && s.flash);

describe("hero score", () => {
  it("pieces fill the tape exactly", () => {
    expect(PIECES.reduce((n, p) => n + p.g, 0)).toBe(100);
    expect(AT.pre).toBe(0);
    expect(AT.post + PIECES[PIECES.length - 1].g).toBe(100);
  });

  it("posts sit on seams between pieces, left to right", () => {
    const seams = new Set(PIECES.map((p) => AT[p.id]));
    for (const p of POSTS) expect(seams.has(p.at)).toBe(true);
    for (let n = 1; n < POSTS.length; n++) expect(POSTS[n].at).toBeGreaterThan(POSTS[n - 1].at);
    // every command has its post, once
    expect(new Set(POSTS.map((p) => p.cmd)).size).toBe(POSTS.length);
  });

  it("the finished tape keeps only the takes, closed up from the left", () => {
    const gone = new Set<PieceId>(FINISHED.gone);
    expect(keptLength(gone)).toBe(13 + 10 + 10 + 13);
    // the edit removes no take
    for (const p of PIECES) if (p.kind === "take") expect(gone.has(p.id)).toBe(false);
    // the first kept take starts at 0 after the trim
    expect(finishedAt(AT.a)).toBe(0);
    // start and finish end up at the ends of the kept tape
    expect(finishedAt(post("start").at)).toBe(0);
    expect(finishedAt(post("finish").at)).toBe(keptLength(gone));
  });

  it("“Cleo keep” ends the first good scene, before the pause", () => {
    const keep = post("keep");
    const n = pieceAt(keep.at);
    // the take after the filler word is before it, the pause after it
    expect(PIECES[n - 2].kind).toBe("filler");
    expect(PIECES[n - 1].kind).toBe("take");
    expect(PIECES[n].kind).toBe("pause");
    // it comes after the cut and before the skipped sentence
    expect(keep.at).toBeGreaterThan(post("cut").at);
    expect(keep.at).toBeLessThan(post("stop").at);
  });

  it("“Cleo keep” removes nothing and is never lifted", () => {
    const keep = post("keep");
    expect(keep.leavesWith).toBeUndefined();
    expect(PIECES.some((p) => p.cmd === "keep")).toBe(false);
    // only Act 1 names it; the edit never flags or flares it
    for (const s of STEPS) if (s.flag === "keep" || s.flash === "keep") expect(s.phase).toBe("talk");
    // on the finished tape it is the seam between the two scenes' takes
    const x = finishedAt(keep.at);
    expect(x).toBe(finishedAt(AT.c));
    expect(x).toBe(finishedAt(AT.b) + PIECES[pieceAt(AT.b)].g);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(keptLength(new Set<PieceId>(FINISHED.gone)));
  });

  it("every marked removal is removed in the finished state", () => {
    for (const m of MARKED) expect(FINISHED.gone).toContain(m.id);
  });

  it("each marked removal leaves its own seam on the finished tape", () => {
    const gone = new Set<PieceId>(FINISHED.gone);
    const seams = MARKED.map((m) => finishedAt(AT[m.id]));
    expect(new Set(seams).size).toBe(MARKED.length);
    // none hides under the finish post at the kept end
    for (const x of seams) expect(x).toBeLessThan(keptLength(gone));
  });

  it("a marker never hides under a post that stays: it sits beside it", () => {
    const staying = POSTS.filter((p) => !p.leavesWith).map((p) => finishedAt(p.at));
    for (const m of MARKED) expect(m.beside).toBe(staying.includes(finishedAt(AT[m.id])));
    // the bad take beside “Cleo start”, the pause beside “Cleo keep”
    expect(MARKED.filter((m) => m.beside).map((m) => m.id)).toEqual(["bad", "pause"]);
  });

  it("removals only grow during a loop, and each is marked before it goes", () => {
    let prev = new Set<PieceId>();
    const marked = new Set<PieceId>();
    for (const s of loop) {
      for (const id of prev) expect(s.gone).toContain(id);
      for (const id of s.gone) if (!prev.has(id)) expect(marked.has(id)).toBe(true);
      for (const id of s.mark ?? []) marked.add(id);
      prev = new Set(s.gone);
    }
  });

  it("Act 1 says every command once, left to right", () => {
    expect(talkSteps.map((s) => s.flash)).toEqual(POSTS.map((p) => p.id));
    // and nothing is removed while recording
    for (const s of talkSteps) expect(s.gone).toEqual([]);
  });

  it("the playhead reaches each post at its seam, at one speed", () => {
    const perPct = HEAD_MS / (post("finish").at - HEAD_FROM);
    let from = HEAD_FROM;
    for (const s of talkSteps) {
      // its post flares as the playhead gets there
      expect(from).toBe(post(s.flash as Post["id"]).at);
      expect(s.to).toBeDefined();
      if (s.head === "run") expect(Math.abs(s.ms - (s.to! - from) * perPct)).toBeLessThanOrEqual(1);
      from = s.to!;
    }
    // it ends at “Cleo finish” and goes out there
    expect(from).toBe(post("finish").at);
    expect(talkSteps[talkSteps.length - 1].head).toBe("end");
  });

  it("the playhead steps add up to its run time", () => {
    const run = STEPS.filter((s) => s.head === "run").reduce((n, s) => n + s.ms, 0);
    expect(run).toBe(HEAD_MS);
  });

  it("each command's chip holds long enough to read", () => {
    for (const s of talkSteps) expect(s.ms).toBeGreaterThanOrEqual(600);
  });

  it("the loop stays short (its captions aside)", () => {
    const ms = STEPS.slice(LOOP_FROM).reduce((n, s) => n + (s.play ? 0 : s.ms), 0);
    expect(ms).toBeLessThanOrEqual(14000);
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
