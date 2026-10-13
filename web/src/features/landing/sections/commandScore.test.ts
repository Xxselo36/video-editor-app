import { describe, expect, it } from "vitest";
import {
  GAP,
  HANDOFF_P,
  POST_W,
  SAMPLES,
  SEAL_P,
  T,
  closeSamples,
  hingeAngle,
  projectedWidth,
  scoreRow,
  spring,
  springProgress,
  springTime,
  travelFor,
  type Piece,
  type Track,
} from "./commandScore";

/** The rows as CommandRows.tsx draws them. */
const START: Piece[] = [{ k: "gone", g: 2 }, { k: "post" }, { k: "seg", g: 3 }, { k: "seg", g: 2 }];
const CUT: Piece[] = [{ k: "seg", g: 2 }, { k: "gone", g: 3 }, { k: "post" }, { k: "seg", g: 3 }];
const KEEP: Piece[] = [{ k: "seg", g: 3 }, { k: "post" }, { k: "new", g: 3 }];
const STOPGO: Piece[] = [{ k: "seg", g: 2 }, { k: "post" }, { k: "gone", g: 2 }, { k: "post" }, { k: "seg", g: 2 }];
const FINISH: Piece[] = [{ k: "seg", g: 3 }, { k: "seg", g: 2 }, { k: "post" }, { k: "gone", g: 2 }];
const ROWS = { START, CUT, KEEP, STOPGO, FINISH };

/** The strip's flex layout (basis 0, posts fixed, 1px gaps): each piece's
 *  left edge and width. */
function layout(parts: Piece[], width: number): { x: number; w: number }[] {
  const posts = parts.filter((p) => p.k === "post").length;
  const free = width - posts * POST_W - (parts.length - 1) * GAP;
  const sum = parts.reduce((s, p) => s + (p.k === "post" ? 0 : p.g), 0);
  let x = 0;
  return parts.map((p) => {
    const w = p.k === "post" ? POST_W : (p.g / sum) * free;
    const box = { x, w };
    x += w + GAP;
    return box;
  });
}

const goneWidth = (parts: Piece[], width: number) => layout(parts, width)[parts.findIndex((p) => p.k === "gone")].w;
const tracksOf = (tracks: Track[], el: string) => tracks.filter((t) => t.target.el === el);

describe("spring", () => {
  it("is critically damped: 72% at 200 ms, 96% at 400 ms, no overshoot", () => {
    expect(spring(0)).toBe(0);
    expect(spring(0.2)).toBeGreaterThan(0.7);
    expect(spring(0.2)).toBeLessThan(0.74);
    expect(spring(0.4)).toBeGreaterThan(0.95);
    expect(spring(0.4)).toBeLessThan(0.97);
    let last = 0;
    for (let ms = 1; ms <= 2000; ms++) {
      const v = spring(ms / 1000);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThanOrEqual(1);
      last = v;
    }
  });

  it("starts from zero velocity", () => {
    const start = (spring(0.001) - spring(0)) / 0.001;
    let peak = 0;
    for (let ms = 0; ms < 600; ms++) peak = Math.max(peak, (spring((ms + 1) / 1000) - spring(ms / 1000)) / 0.001);
    expect(start).toBeLessThan(peak * 0.03);
  });

  it("lands exactly at 1 at the end of the close, and springTime inverts it", () => {
    expect(springProgress(0)).toBe(0);
    expect(springProgress(T.close)).toBe(1);
    for (const p of [0.1, 0.5, SEAL_P, HANDOFF_P]) expect(springProgress(springTime(p))).toBeCloseTo(p, 6);
  });
});

describe("hinge angle", () => {
  it("turns the piece so it projects to the target width", () => {
    for (const w of [24, 60, 120, 200])
      for (const f of [0.95, 0.6, 0.25, 0.02]) expect(projectedWidth(w, hingeAngle(w, w * f))).toBeCloseTo(w * f, 4);
    expect(hingeAngle(80, 80)).toBe(0);
    expect(hingeAngle(80, 0)).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe("the close", () => {
  it("keeps the fold edge within 1 px of the movers at every sample", () => {
    for (const w of [36, 80, 104, 150])
      for (const merge of [false, true]) {
        const travel = travelFor(w, 2, merge);
        const samples = closeSamples(w, travel);
        expect(samples).toHaveLength(SAMPLES + 1);
        for (const s of samples) {
          const edge = projectedWidth(w, s.theta);
          const moverLeft = w + GAP - s.shift;
          const gap = moverLeft - edge;
          // never a visible hole between the piece and what closes on it
          expect(gap).toBeLessThanOrEqual(GAP + 1e-3);
          // and in contact (not overlapping) while any of the piece shows
          if (w - s.shift > 0) expect(gap).toBeCloseTo(GAP, 3);
        }
      }
  });

  it("moves the movers from rest, accelerating, without a velocity jump", () => {
    const samples = closeSamples(100, travelFor(100, 2, false));
    const steps = samples.slice(1).map((s, i) => s.shift - samples[i].shift);
    expect(samples[0].shift).toBe(0);
    expect(steps[0]).toBeLessThan(steps[1] * 0.5);
    expect(steps[1]).toBeLessThan(steps[2]);
    for (const d of steps) expect(d).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < steps.length; i++) expect(Math.abs(steps[i] - steps[i - 1])).toBeLessThan(travelFor(100, 2, false) * 0.06);
    expect(samples[SAMPLES].shift).toBeCloseTo(travelFor(100, 2, false), 9);
  });

  it("keeps the folding piece opaque past half way, gone by p = 0.9", () => {
    const samples = closeSamples(100, 101);
    for (const s of samples) {
      if (s.p < 0.55) expect(s.opacity).toBe(1);
      if (s.p >= 0.9) expect(s.opacity).toBe(0);
    }
  });
});

describe("where the strips land", () => {
  for (const width of [304, 342, 358, 220])
    it(`at ${width} px: one marker per cut, the go post on the stop post`, () => {
      // “Cleo stop … go”: the go post lands exactly on the stop post.
      const sg = layout(STOPGO, width);
      const travelSg = travelFor(goneWidth(STOPGO, width), 2, true);
      expect(sg[3].x - travelSg).toBeCloseTo(sg[1].x, 9);
      // The take before “Cleo stop” never moves (not a mover).
      expect(scoreRow(STOPGO, sg[2].w).travel).toBeCloseTo(travelSg, 9);

      // “Cleo cut”: the post lands one gap after the take before it.
      const cut = layout(CUT, width);
      expect(cut[2].x - travelFor(cut[1].w, 2, false)).toBeCloseTo(cut[0].x + cut[0].w + GAP, 9);

      // “Cleo start”: the post lands at the strip's start.
      const start = layout(START, width);
      expect(start[1].x - travelFor(start[0].w, 3, false)).toBeCloseTo(0, 9);
    });

  it("draws the dashed rail over exactly the freed end", () => {
    const width = 342;
    for (const parts of [START, CUT, STOPGO]) {
      const w = goneWidth(parts, width);
      const s = scoreRow(parts, w);
      const last = layout(parts, width).at(-1)!;
      // the last piece's new right edge, one gap, then the rail to the end
      expect(last.x + last.w - s.travel + GAP + s.rail).toBeCloseTo(width, 9);
    }
    // “Cleo finish”: nothing moves; the rail takes the piece's place.
    const fin = layout(FINISH, width);
    const s = scoreRow(FINISH, fin[3].w);
    expect(s.rail).toBeCloseTo(fin[3].w, 9);
    expect(fin[3].x + s.rail).toBeCloseTo(width, 9);
    expect(tracksOf(s.tracks, "movers")).toHaveLength(0);
  });
});

describe("the score", () => {
  it("hands off once the close is at p ≥ 0.92 (≈1030, keep 860, stop/go ≈1810)", () => {
    const single = scoreRow(CUT, 100);
    const closeAt = T.say + T.closeAfter;
    expect(springProgress(single.handoff - closeAt)).toBeGreaterThanOrEqual(HANDOFF_P - 1e-3);
    expect(springProgress(single.handoff - closeAt - 10)).toBeLessThan(HANDOFF_P);
    expect(single.handoff).toBeGreaterThan(1015);
    expect(single.handoff).toBeLessThan(1045);

    expect(scoreRow(KEEP, 0).handoff).toBe(860);

    const sg = scoreRow(STOPGO, 90);
    const goSaid = T.sayPair + T.skip - T.goLead + T.sayPair;
    expect(goSaid).toBe(1200);
    expect(springProgress(sg.handoff - (goSaid + T.closeAfter))).toBeGreaterThanOrEqual(HANDOFF_P - 1e-3);
    expect(sg.handoff).toBeGreaterThan(1795);
    expect(sg.handoff).toBeLessThan(1825);
  });

  it("ends the ink and the post's rise on the same frame (said)", () => {
    const s = scoreRow(CUT, 100);
    const ink = s.tracks.find((t) => t.target.el === "ink")!;
    expect(ink.delay + ink.duration).toBe(T.say);
    const post = tracksOf(s.tracks, "post")[0];
    const peak = post.frames.findIndex((f) => f.scale === "1 1");
    expect(post.delay + post.frames[peak].offset * post.duration).toBeCloseTo(T.say, 6);
    expect(post.frames[0]).toMatchObject({ opacity: 0 });
  });

  it("seals the landed post once, near p = 0.9", () => {
    for (const [parts, w, landing] of [
      [CUT, 100, 0],
      [STOPGO, 90, 1],
    ] as const) {
      const s = scoreRow(parts, w);
      const posts = tracksOf(s.tracks, "post");
      const flares = posts.filter((t) => t.frames.some((f) => f.scale === "1 1.32"));
      expect(flares).toHaveLength(1);
      expect(flares[0].target).toEqual({ el: "post", post: landing });
    }
  });

  it("grows the stop/go hatch at the speed of time between the two posts", () => {
    const s = scoreRow(STOPGO, 90);
    const clip = s.tracks.find((t) => t.target.el === "hatchClip")!;
    expect([clip.delay, clip.delay + clip.duration]).toEqual([340, 880]);
    expect(clip.frames[0].easing).toBe("linear");
  });

  it("marks out of the post: leftward for start and cut, rightward for finish", () => {
    const from = (parts: Piece[]) => scoreRow(parts, 80).tracks.find((t) => t.target.el === "hatchClip")!.frames[0].translate;
    expect(from(START)).toBe("100% 0");
    expect(from(CUT)).toBe("100% 0");
    expect(from(FINISH)).toBe("-100% 0");
  });

  it("keeps everything in place for “Cleo keep”: no fold, no rail, the next scene comes in", () => {
    const s = scoreRow(KEEP, 0);
    for (const el of ["gone", "movers", "rail", "hatchClip"]) expect(tracksOf(s.tracks, el)).toHaveLength(0);
    for (const el of ["ring", "newClip", "newPiece", "ghost"]) expect(tracksOf(s.tracks, el)).toHaveLength(1);
    expect(s.travel).toBe(0);
    expect(s.rail).toBe(0);
  });

  it("writes well-formed tracks for every row", () => {
    for (const [name, parts] of Object.entries(ROWS)) {
      const s = scoreRow(parts, goneWidth(parts.some((p) => p.k === "gone") ? parts : START, 300));
      for (const t of s.tracks) {
        expect(t.delay, name).toBeGreaterThanOrEqual(0);
        expect(t.duration, name).toBeGreaterThan(0);
        expect(t.frames[0].offset).toBe(0);
        expect(t.frames.at(-1)!.offset).toBe(1);
        for (let i = 1; i < t.frames.length; i++) expect(t.frames[i].offset).toBeGreaterThanOrEqual(t.frames[i - 1].offset);
        expect(t.delay + t.duration).toBeLessThanOrEqual(s.end);
      }
      // one track per element and property: posts get one each
      const posts = tracksOf(s.tracks, "post").map((t) => (t.target.el === "post" ? t.target.post : -1));
      expect(new Set(posts).size, name).toBe(posts.length);
    }
  });
});
