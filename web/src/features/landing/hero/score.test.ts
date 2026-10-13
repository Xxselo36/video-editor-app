import { describe, expect, it } from "vitest";
import {
  AT,
  CLOSE_DELAY_MS,
  CLOSE_MS,
  FINISHED,
  FIRST,
  FLAG_TARGET,
  HEAD_FROM,
  HEAD_MS,
  LIFT_DELAY,
  LIFT_MS,
  LOOP_FROM,
  MARKED,
  MARK_MS,
  PIECES,
  PIECE_IN_MS,
  PIECE_STAGGER_MS,
  POSTS,
  PULSE_MS,
  RENDER_MS,
  SCAN_MS,
  SEAL,
  STEPS,
  chipAct,
  chipsAt,
  flagAt,
  headAt,
  keptLength,
  renderAt,
  shiftAt,
  statusOf,
  type FlagId,
  type PieceId,
  type Post,
  type Step,
} from "./score";

/** Where a point at `x` % ends up on the finished tape. */
const finishedAt = (x: number) => x - shiftAt(x, new Set<PieceId>(FINISHED.gone));
const post = (id: Post["id"]) => POSTS.find((p) => p.id === id)!;
const pieceAt = (x: number) => PIECES.findIndex((p) => AT[p.id] === x);
const piece = (id: PieceId) => PIECES.find((p) => p.id === id)!;
const SNAP = STEPS.findIndex((s) => s.fade === "snap");
/** From the reset (raw) to the end of the loop. */
const loop = STEPS.slice(SNAP);
/** One pass of the loop as it plays: from the hold after the captions to the captions. */
const cycle = STEPS.slice(LOOP_FROM);
const talkSteps = STEPS.filter((s) => s.phase === "talk" && s.flash);
const reads = STEPS.filter((s) => s.sweep === "read");
const READ = STEPS.findIndex((s) => s.sweep === "read");
const RENDER = STEPS.findIndex((s) => s.sweep === "render");
/** Act 2's single lifts, between the read and the ends. */
const lifts = STEPS.slice(READ + 1).filter((s, n, a) => s.phase === "edit" && s.gone.length === (a[n - 1]?.gone.length ?? 0) + 1);
const ends = STEPS.find((s) => s.flag === "trimStart")!;
/** How long each flag's chip shows, over the steps that carry it in a row. */
function chipTimes(): { flag: FlagId; ms: number }[] {
  const out: { flag: FlagId; ms: number }[] = [];
  STEPS.forEach((s, n) => {
    if (!s.flag) return;
    if (STEPS[n - 1]?.flag === s.flag) out[out.length - 1].ms += s.ms;
    else out.push({ flag: s.flag, ms: s.ms });
  });
  return out;
}

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

  it("the scene “Cleo keep” starts is sealed as kept once the pause after the post has gone", () => {
    const keep = post("keep");
    // the seal waits for the removal right after the post…
    expect(AT[SEAL.when]).toBe(keep.at);
    expect(FINISHED.gone).toContain(SEAL.when);
    // …and lands on the first take after it, which is never removed and
    // then sits right on the post
    expect(piece(SEAL.piece).kind).toBe("take");
    expect(FINISHED.gone).not.toContain(SEAL.piece);
    expect(AT[SEAL.piece]).toBe(AT[SEAL.when] + piece(SEAL.when).g);
    expect(AT[SEAL.piece]).toBeLessThan(post("stop").at);
    const sealing = STEPS.find((s) => s.phase === "edit" && s.gone.includes(SEAL.when))!;
    expect(sealing.flag).toBe("pause");
    const g = new Set<PieceId>(sealing.gone);
    expect(AT[SEAL.piece] - shiftAt(AT[SEAL.piece], g)).toBe(keep.at - shiftAt(keep.at, g));
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

  it("removals only grow during a loop; each is marked before it goes and stays marked until then", () => {
    let prev = new Set<PieceId>();
    const marked = new Set<PieceId>();
    for (const s of loop) {
      for (const id of prev) expect(s.gone).toContain(id);
      for (const id of s.gone) if (!prev.has(id)) expect(marked.has(id)).toBe(true);
      // no hatch is taken back before its piece lifts
      for (const id of marked) if (!s.gone.includes(id)) expect(s.mark ?? []).toContain(id);
      for (const id of s.mark ?? []) marked.add(id);
      prev = new Set(s.gone);
    }
    expect(prev).toEqual(new Set(FINISHED.gone));
  });

  it("Act 1 says every command once, left to right", () => {
    expect(talkSteps.map((s) => s.flash)).toEqual(POSTS.map((p) => p.id));
    // and nothing is removed or marked while recording
    for (const s of talkSteps) {
      expect(s.gone).toEqual([]);
      expect(s.mark).toBeUndefined();
    }
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
    // it ends at “Cleo finish” and lands there
    expect(from).toBe(post("finish").at);
    expect(talkSteps[talkSteps.length - 1].head).toBe("end");
  });

  it("the playhead steps add up to its run time, and its clock agrees with them", () => {
    const run = STEPS.filter((s) => s.head === "run");
    expect(run.reduce((n, s) => n + s.ms, 0)).toBe(HEAD_MS);
    // the step clock follows the one playhead clock: each run step ends
    // when the playhead reaches its `to`
    let t = 0;
    for (const s of run) {
      t += s.ms;
      expect(headAt(s.to!)).toBe(t);
    }
    expect(headAt(HEAD_FROM)).toBe(0);
    expect(headAt(post("finish").at)).toBe(HEAD_MS);
  });

  it("each command's chip shows long enough to read", () => {
    const times = chipTimes();
    for (const c of times) expect(c.ms).toBeGreaterThanOrEqual(chipAct(c.flag) === 1 ? 600 : 440);
    // every flag once per loop, Act 1's before Act 2's
    expect(new Set(times.map((c) => c.flag)).size).toBe(times.length);
    expect(times.map((c) => chipAct(c.flag))).toEqual([...times].map((c) => chipAct(c.flag)).sort());
  });

  it("each act has one chip that travels; the act before leaves for one step", () => {
    STEPS.forEach((s, n) => {
      const chips = chipsAt(n);
      const current = chips.filter((c) => !c.leaving);
      // one current chip when there is a flag, showing it
      expect(current.length).toBe(s.flag ? 1 : 0);
      if (s.flag) expect(current[0].slots[current[0].on]).toBe(s.flag);
      // a leaving chip only right after its act's last flag
      for (const c of chips.filter((x) => x.leaving)) {
        expect(STEPS[n - 1].flag && chipAct(STEPS[n - 1].flag!)).toBe(c.act);
        expect(c.slots[c.on]).toBe(STEPS[n - 1].flag);
      }
      // a new label goes into the other slot, so the old one can fade out
      const prev = n > 0 ? chipsAt(n - 1).find((c) => !c.leaving) : undefined;
      if (prev && current[0] && prev.act === current[0].act && STEPS[n - 1].flag !== s.flag) {
        expect(current[0].on).not.toBe(prev.on);
        expect(current[0].slots[prev.on]).toBe(STEPS[n - 1].flag);
      }
    });
  });

  it("chips point at their posts in Act 1 and inside the piece they lift in Act 2", () => {
    for (const s of talkSteps) expect(flagAt(s.flag!, new Set(s.gone))).toBe(post(s.flash as Post["id"]).at);
    for (const s of STEPS) {
      if (!s.flag || chipAct(s.flag) !== 2) continue;
      const g = new Set<PieceId>(s.gone);
      const t = FLAG_TARGET[s.flag];
      if ("piece" in t) {
        // the piece lifting this step, at its resting place
        expect(s.gone).toContain(t.piece);
        const left = AT[t.piece] - shiftAt(AT[t.piece], g);
        expect(flagAt(s.flag, g)).toBeGreaterThan(left);
        expect(flagAt(s.flag, g)).toBeLessThan(left + piece(t.piece).g);
      } else {
        // “Cleo finish” at the end of the kept tape
        expect(flagAt(s.flag, g)).toBe(keptLength(g));
      }
    }
  });

  it("Cleo reads once, right after the playhead lands, and marks everything that goes", () => {
    expect(reads).toHaveLength(1);
    const read = reads[0];
    expect(STEPS[READ - 1].head).toBe("end");
    // the landing is a beat, not the old 700 ms hold
    expect(STEPS[READ - 1].ms).toBeLessThanOrEqual(400);
    expect(read.phase).toBe("edit");
    expect(read.gone).toEqual([]);
    expect(new Set(read.mark)).toEqual(new Set(FINISHED.gone));
    // the status says Cleo edits while she reads
    expect(statusOf(read)).toBeUndefined();
    // the finish chip stays while she reads
    expect(read.flag).toBe(STEPS[READ - 1].flag);
    // it lasts until the scan has passed the far end and the last hatch
    // and pulse there have finished (nothing is cut off mid-way)
    const lastPiece = Math.max(...FINISHED.gone.map((id) => AT[id]));
    const lastPost = Math.max(...POSTS.map((p) => p.at));
    expect(read.ms).toBeGreaterThanOrEqual(SCAN_MS);
    expect(read.ms).toBeGreaterThanOrEqual((lastPiece / 100) * SCAN_MS + MARK_MS);
    expect(read.ms).toBeGreaterThanOrEqual((lastPost / 100) * SCAN_MS + PULSE_MS);
  });

  it("Act 2 lifts one removal per step, teaching the first and speeding up", () => {
    expect(lifts.map((s) => s.flag)).toEqual(["cutTake", "um", "pause", "skip"]);
    expect(lifts[0].ms).toBeGreaterThanOrEqual(600);
    for (let n = 1; n < lifts.length; n++) expect(lifts[n].ms).toBeLessThan(lifts[n - 1].ms);
    // fast, but each lift has begun before the next starts closing
    for (const s of lifts) expect(s.ms).toBeGreaterThan(CLOSE_DELAY_MS);
    // the legend item lands with its lift
    expect(lifts.map((s) => s.li)).toEqual(["take", "fillers", "pauses", "skip"]);
  });

  it("the ends go together, the tail just after the head, before the render head runs", () => {
    expect(ends.gone).toEqual(expect.arrayContaining(["pre", "post"]));
    expect(STEPS[STEPS.indexOf(ends) - 1].gone).not.toContain("pre");
    expect(STEPS[STEPS.indexOf(ends) - 1].gone).not.toContain("post");
    const late = LIFT_DELAY.post ?? 0;
    expect(late).toBeGreaterThan(0);
    expect(LIFT_DELAY.pre ?? 0).toBe(0);
    // both have lifted off, and the tape has closed, before the render head sets off
    expect(ends.ms).toBeGreaterThanOrEqual(late + LIFT_MS);
    expect(ends.ms).toBeGreaterThanOrEqual(CLOSE_DELAY_MS + CLOSE_MS * 0.85);
    expect(STEPS[STEPS.indexOf(ends) + 1].sweep).toBe("render");
    // “Cleo start” over the head of the tape as it goes, and its post flares
    expect(ends.flag).toBe("trimStart");
    expect(ends.flash).toBe("start");
  });

  it("the render head runs over the kept tape to “Cleo finish”, and the video lights as it lands", () => {
    expect(STEPS.filter((s) => s.sweep === "render" && s.frame === "raw")).toHaveLength(1);
    const render = STEPS[RENDER];
    expect(render.ms).toBe(RENDER_MS);
    expect(render.gone).toEqual(FINISHED.gone);
    expect(render.flag).toBe("trimFinish");
    // the next step is the payoff, on the frame the head lands
    const payoff = STEPS[RENDER + 1];
    expect(payoff).toBe(STEPS[STEPS.length - 1]);
    expect(payoff).toMatchObject({ frame: "lit", reveal: true, play: true, flash: "finish" });
    // its glints run on through the payoff
    expect(payoff.sweep).toBe("render");
    // the kept takes glint in tape order, from “Cleo start” on
    const kept = PIECES.filter((p) => !FINISHED.gone.includes(p.id)).map((p) => renderAt(p.id));
    expect(kept[0]).toBe(0);
    for (let n = 1; n < kept.length; n++) expect(kept[n]).toBeGreaterThan(kept[n - 1]);
    for (const r of kept) expect(r).toBeLessThan(1);
    // only the loop's payoff reveals (the first load just plays)
    expect(STEPS.filter((s) => s.reveal)).toEqual([payoff]);
  });

  it("the phone video starts one step before it shows", () => {
    // TakeStrip plays the clip from STEPS.length - 2 on: that step is the
    // render, still raw, and the next one shows it
    expect(STEPS[STEPS.length - 2].sweep).toBe("render");
    expect(STEPS[STEPS.length - 2].frame).toBe("raw");
    expect(STEPS[STEPS.length - 1].frame).toBe("lit");
  });

  it("the seam is one event: out, an invisible swap, and the raw tape back in", () => {
    const out = STEPS[SNAP - 1];
    const snap = STEPS[SNAP];
    const back = STEPS[SNAP + 1];
    expect(out).toMatchObject({ fade: "out", frame: "lit", gone: FINISHED.gone });
    expect(snap).toMatchObject({ fade: "snap", frame: "raw", gone: [] });
    expect(back).toMatchObject({ fade: "in", frame: "raw", gone: [], phase: "talk" });
    expect(out.ms + snap.ms + back.ms).toBe(880);
    expect(out.ms).toBeGreaterThanOrEqual(300);
    expect(snap.ms).toBeLessThanOrEqual(60);
    // every piece is back before recording starts
    expect((PIECES.length - 1) * PIECE_STAGGER_MS + PIECE_IN_MS).toBeLessThanOrEqual(back.ms);
    // and the first post is planted right after
    expect(STEPS[SNAP + 2]).toMatchObject({ head: "run", flash: "start" });
  });

  it("the scrub head fills with the captions and empties only while hidden", () => {
    const order = [...STEPS.map((_, n) => n), ...STEPS.slice(LOOP_FROM).map((_, n) => n + LOOP_FROM)];
    for (let k = 1; k < order.length; k++) {
      const a: Step = STEPS[order[k - 1]];
      const b: Step = STEPS[order[k]];
      // it runs exactly on the play steps
      expect(b.scrub === "run").toBe(!!b.play);
      // it never jumps back while it shows: only on the seam's swap
      if (a.scrub && !b.scrub) expect(b.fade).toBe("snap");
      // it starts each run from empty
      if (b.scrub === "run") expect(a.scrub).toBeUndefined();
    }
  });

  it("the status line never ping-pongs: in Act 2 it changes at most once a step", () => {
    const shown = (s: Step) => statusOf(s) ?? s.phase ?? "ready";
    let changes = 0;
    let named = false;
    for (let n = 1; n < cycle.length; n++) {
      if (shown(cycle[n]) !== shown(cycle[n - 1])) changes++;
      // once Act 2 names a removal it never falls back to “Cleo edits”
      if (cycle[n].phase === "edit") {
        if (named) expect(statusOf(cycle[n])).toBeDefined();
        if (statusOf(cycle[n])) named = true;
      }
    }
    // ready → talk → edits → four removals → ready
    expect(changes).toBeLessThanOrEqual(7);
  });

  it("the loop stays short (its captions aside)", () => {
    const ms = cycle.reduce((n, s) => n + (s.play ? 0 : s.ms), 0);
    expect(ms).toBeLessThanOrEqual(10500);
  });

  it("the loop ends on the captions playing and goes on from the finished hold", () => {
    expect(STEPS[FIRST].frame).toBe("lit");
    expect(STEPS[STEPS.length - 1]).toMatchObject({ frame: "lit", play: true, gone: FINISHED.gone });
    expect(STEPS[LOOP_FROM]).toMatchObject({ frame: "lit", gone: FINISHED.gone });
    expect(STEPS[LOOP_FROM].play).toBeFalsy();
    expect(LOOP_FROM).toBeGreaterThan(FIRST);
    expect(LOOP_FROM).toBeLessThan(SNAP);
    // the first load plays the result, never an undo or a sweep
    for (const s of STEPS.slice(FIRST, LOOP_FROM)) {
      expect(s).toMatchObject({ frame: "lit", gone: FINISHED.gone });
      expect(s.flag ?? s.sweep ?? s.head ?? s.flash ?? s.fade).toBeUndefined();
    }
  });
});
