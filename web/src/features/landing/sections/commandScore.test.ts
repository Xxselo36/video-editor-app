import { describe, expect, it } from "vitest";
import {
  GAP,
  P,
  PERSPECTIVE,
  SAMPLES,
  T_SPRING,
  closeSamples,
  closeShape,
  hingeAngle,
  pieceWidths,
  projectedWidth,
  scoreRow,
  spring,
  springProgress,
  travelFor,
  type CloseShape,
  type Frame,
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
const SHAPES: CloseShape[] = ["spring", "sine"];

const goneWidth = (parts: Piece[], width: number) => {
  const gi = parts.findIndex((p) => p.k === "gone");
  return gi < 0 ? 0 : pieceWidths(parts, width)[gi].w;
};
const scored = (parts: Piece[], width = 342) => scoreRow(parts, goneWidth(parts, width));
const tracksOf = (tracks: Track[], el: string) => tracks.filter((t) => t.target.el === el);
const track = (tracks: Track[], el: string, prop?: string) =>
  tracks.find((t) => t.target.el === el && (!prop || t.prop === prop))!;
/** A track's value at its first and its last keyframe. */
const first = (t: Track) => t.frames[0][t.prop];
const last = (t: Track) => t.frames[t.frames.length - 1][t.prop];
/** The first number in a keyframe value ("-12.500px 0" → -12.5). */
const num = (v: Frame[string]) => (typeof v === "number" ? v : parseFloat(String(v)));
const rotateY = (v: Frame[string]) => Number(/rotateY\((-?[\d.]+)deg\)/.exec(String(v))![1]);
const liftOf = (v: Frame[string]) => Number(/translateY\((-?[\d.]+)px\)/.exec(String(v))![1]);
/** Where a track's change starts and ends: the offsets of its first and
 *  last keyframes that are not holds. */
function spanOf(t: Track): [number, number] {
  const f = t.frames;
  let a = 0;
  while (a < f.length - 1 && f[a + 1][t.prop] === f[a][t.prop]) a++;
  let b = f.length - 1;
  while (b > 0 && f[b - 1][t.prop] === f[b][t.prop]) b--;
  return [f[a].offset, f[b].offset];
}

describe("spring", () => {
  it("is critically damped: 72% at 200 ms, 96% at 400 ms, no overshoot", () => {
    expect(spring(0)).toBe(0);
    expect(spring(0.2)).toBeGreaterThan(0.7);
    expect(spring(0.2)).toBeLessThan(0.74);
    expect(spring(0.4)).toBeGreaterThan(0.95);
    expect(spring(0.4)).toBeLessThan(0.97);
    let prev = 0;
    for (let ms = 1; ms <= 2000; ms++) {
      const v = spring(ms / 1000);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("starts from zero velocity", () => {
    const start = (spring(0.001) - spring(0)) / 0.001;
    let peak = 0;
    for (let ms = 0; ms < 600; ms++) peak = Math.max(peak, (spring((ms + 1) / 1000) - spring(ms / 1000)) / 0.001);
    expect(start).toBeLessThan(peak * 0.03);
  });

  it("lands exactly at 1 at the end of the close, on either shape", () => {
    expect(springProgress(0)).toBe(0);
    expect(springProgress(T_SPRING)).toBe(1);
    for (const shape of SHAPES) {
      expect(closeShape(0, shape)).toBe(0);
      expect(closeShape(1, shape)).toBe(1);
      expect(closeShape(0.5, shape)).toBeGreaterThan(0.45);
    }
    expect(closeShape(0.25, "spring")).toBeCloseTo(springProgress(T_SPRING / 4), 12);
    expect(closeShape(0.5, "sine")).toBeCloseTo(0.5, 12);
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
  for (const shape of SHAPES)
    it(`keeps the fold edge within 1 px of the movers at every sample (${shape})`, () => {
      for (const w of [36, 80, 104, 150])
        for (const merge of [false, true]) {
          const travel = travelFor(w, 2, merge);
          const samples = closeSamples(w, travel, shape);
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
    const samples = closeSamples(100, travelFor(100, 2, false), "spring");
    const steps = samples.slice(1).map((s, i) => s.shift - samples[i].shift);
    expect(samples[0].shift).toBe(0);
    expect(steps[0]).toBeLessThan(steps[1] * 0.5);
    expect(steps[1]).toBeLessThan(steps[2]);
    for (const d of steps) expect(d).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < steps.length; i++) expect(Math.abs(steps[i] - steps[i - 1])).toBeLessThan(travelFor(100, 2, false) * 0.06);
    expect(samples[SAMPLES].shift).toBeCloseTo(travelFor(100, 2, false), 9);
  });

  it("keeps the folding piece opaque past half way, gone by p = 0.9", () => {
    for (const shape of SHAPES)
      for (const s of closeSamples(100, 101, shape)) {
        if (s.p < 0.55) expect(s.opacity).toBe(1);
        if (s.p >= 0.9) expect(s.opacity).toBe(0);
      }
  });
});

describe("where the strips land", () => {
  for (const width of [304, 342, 358, 220])
    it(`at ${width} px: one marker per cut, the go post on the stop post`, () => {
      // “Cleo stop … go”: the go post lands exactly on the stop post.
      const sg = pieceWidths(STOPGO, width);
      const travelSg = travelFor(goneWidth(STOPGO, width), 2, true);
      expect(sg[3].x - travelSg).toBeCloseTo(sg[1].x, 9);
      // The take before “Cleo stop” never moves (not a mover).
      expect(scoreRow(STOPGO, sg[2].w).travel).toBeCloseTo(travelSg, 9);

      // “Cleo cut”: the post lands one gap after the take before it.
      const cut = pieceWidths(CUT, width);
      expect(cut[2].x - travelFor(cut[1].w, 2, false)).toBeCloseTo(cut[0].x + cut[0].w + GAP, 9);

      // “Cleo start”: the post lands at the strip's start.
      const start = pieceWidths(START, width);
      expect(start[1].x - travelFor(start[0].w, 3, false)).toBeCloseTo(0, 9);
    });

  it("draws the dashed rail over exactly the freed end", () => {
    const width = 342;
    for (const parts of [START, CUT, STOPGO]) {
      const s = scored(parts, width);
      const end = pieceWidths(parts, width).at(-1)!;
      // the last piece's new right edge, one gap, then the rail to the end
      expect(end.x + end.w - s.travel + GAP + s.rail).toBeCloseTo(width, 9);
    }
    // “Cleo finish”: nothing moves; the rail takes the piece's place.
    const fin = pieceWidths(FINISH, width);
    const s = scoreRow(FINISH, fin[3].w);
    expect(s.rail).toBeCloseTo(fin[3].w, 9);
    expect(fin[3].x + s.rail).toBeCloseTo(width, 9);
    expect(tracksOf(s.tracks, "movers")).toHaveLength(0);
  });
});

describe("the score", () => {
  it("has one animation per element and property (13, 12, 9, 17, 10 with the movers)", () => {
    const movers = { START: 3, CUT: 2, KEEP: 0, STOPGO: 2, FINISH: 0 };
    const effects = { START: 13, CUT: 12, KEEP: 9, STOPGO: 17, FINISH: 10 };
    for (const [name, parts] of Object.entries(ROWS) as [keyof typeof ROWS, Piece[]][]) {
      const s = scored(parts);
      const keys = s.tracks.map((t) => `${JSON.stringify(t.target)} ${t.prop}`);
      expect(new Set(keys).size, name).toBe(keys.length);
      expect(s.tracks.length - (movers[name] ? 1 : 0) + movers[name], name).toBe(effects[name]);
    }
  });

  it("writes every track over the whole lane: offsets from 0 to 1, never back", () => {
    for (const [name, parts] of Object.entries(ROWS))
      for (const t of scored(parts).tracks) {
        const offsets = t.frames.map((f) => f.offset);
        expect(offsets[0], name).toBe(0);
        expect(offsets.at(-1), name).toBe(1);
        for (let i = 1; i < offsets.length; i++) expect(offsets[i], name).toBeGreaterThanOrEqual(offsets[i - 1]);
      }
  });

  it("animates only translate, scale, opacity or the one transform list", () => {
    const allowed = new Set(["offset", "easing", "translate", "scale", "opacity", "transform"]);
    const list = new RegExp(`^translateY\\(-?[\\d.]+px\\) perspective\\(${PERSPECTIVE}px\\) rotateY\\([\\d.]+deg\\)$`);
    for (const [name, parts] of Object.entries(ROWS))
      for (const t of scored(parts).tracks)
        for (const f of t.frames) {
          for (const k of Object.keys(f)) expect(allowed.has(k), `${name} ${k}`).toBe(true);
          expect(f[t.prop], name).toBeDefined();
          if (t.prop === "transform") expect(String(f.transform), name).toMatch(list);
        }
  });

  it("starts unsaid: no ink, no post, no mark, nothing moved", () => {
    for (const [name, parts] of Object.entries(ROWS)) {
      const s = scored(parts);
      const at0 = (el: string, prop?: string) => first(track(s.tracks, el, prop));
      expect(at0("ink"), name).toBe("-100% 0");
      expect(at0("inkIn"), name).toBe("100% 0");
      expect(at0("caret"), name).toBe(0);
      for (const t of tracksOf(s.tracks, "post")) expect(first(t), name).toBe("1 0");
      if (parts === KEEP) {
        expect(at0("ring")).toBe(0);
        expect(at0("ghost")).toBe(1);
        expect(at0("newClip")).toBe("-100% 0");
        continue;
      }
      expect(Math.abs(num(at0("hatchClip"))), name).toBe(100);
      expect(Math.abs(num(at0("hatch"))), name).toBe(100);
      expect(rotateY(at0("gone", "transform")), name).toBe(0);
      expect(liftOf(at0("gone", "transform")), name).toBe(0);
      expect(at0("gone", "opacity"), name).toBe(1);
      expect(at0("rail"), name).toBe(0);
      for (const t of tracksOf(s.tracks, "movers")) expect(num(first(t)), name).toBe(0);
    }
  });

  it("ends edited: said, marked, closed, the rail on (keep: the next scene in, the ring out again)", () => {
    for (const [name, parts] of Object.entries(ROWS)) {
      const s = scored(parts);
      const at1 = (el: string, prop?: string) => last(track(s.tracks, el, prop));
      for (const t of tracksOf(s.tracks, "ink")) expect(last(t), name).toBe("0 0");
      for (const t of tracksOf(s.tracks, "caret")) expect(last(t), name).toBe(0);
      for (const t of tracksOf(s.tracks, "post")) expect(last(t), name).toBe("1 1");
      if (parts === KEEP) {
        expect(at1("newClip")).toBe("0 0");
        expect(at1("newPiece")).toBe("0 0");
        expect(at1("ghost")).toBe(0);
        // As before the scroll drove it: the ring flashes as the take is
        // kept and is out again once the next scene is in.
        expect(at1("ring")).toBe(0);
        continue;
      }
      expect(at1("hatchClip"), name).toBe("0 0");
      expect(at1("gone", "opacity"), name).toBe(0);
      expect(rotateY(at1("gone", "transform")), name).toBeCloseTo(90, 2);
      expect(at1("rail"), name).toBe(1);
      for (const t of tracksOf(s.tracks, "movers")) expect(num(last(t)), name).toBeCloseTo(-s.travel, 2);
    }
  });

  it("moves every property one way only, except the caret (and the keep ring) blinking", () => {
    const oneWay = (values: number[], label: string) => {
      const sign = Math.sign(values.at(-1)! - values[0]);
      for (let i = 1; i < values.length; i++) expect(sign * (values[i] - values[i - 1]), label).toBeGreaterThanOrEqual(-1e-9);
    };
    for (const [name, parts] of Object.entries(ROWS))
      for (const t of scored(parts).tracks) {
        if (t.target.el === "caret" || t.target.el === "ring") continue;
        const label = `${name} ${t.target.el} ${t.prop}`;
        if (t.prop !== "transform") oneWay(t.frames.map((f) => num(f[t.prop])), label);
        else {
          oneWay(t.frames.map((f) => liftOf(f.transform)), `${label} lift`);
          oneWay(t.frames.map((f) => rotateY(f.transform)), `${label} hinge`);
        }
      }
  });

  it("moves the movers on the close's shape, sample by sample", () => {
    for (const parts of [START, CUT, STOPGO]) {
      const s = scored(parts);
      const close = parts === STOPGO ? P.pair.close : P.single.close;
      const frames = track(s.tracks, "movers").frames.slice(1);
      expect(frames).toHaveLength(SAMPLES + 1);
      frames.forEach((f, k) => {
        expect(f.offset).toBeCloseTo(close[0] + ((close[1] - close[0]) * k) / SAMPLES, 12);
        expect(-num(f.translate)).toBeCloseTo(s.travel * closeShape(k / SAMPLES), 2);
      });
    }
  });

  it("lands the ink and the post together, marks before said, folds only once the close starts", () => {
    for (const parts of [START, CUT, FINISH]) {
      const s = scored(parts);
      const said = spanOf(track(s.tracks, "ink"))[1];
      expect(spanOf(track(s.tracks, "post"))[1]).toBe(said);
      expect(spanOf(track(s.tracks, "hatchClip"))[0]).toBeLessThan(said);
      for (const f of track(s.tracks, "gone", "transform").frames)
        if (f.offset < P.single.close[0]) expect(rotateY(f.transform)).toBe(0);
        else if (f.offset > P.single.close[0]) expect(rotateY(f.transform)).toBeGreaterThan(0);
    }
    const sg = scored(STOPGO);
    const inks = tracksOf(sg.tracks, "ink").map(spanOf);
    const posts = tracksOf(sg.tracks, "post").map(spanOf);
    expect(posts.map((p) => p[1])).toEqual(inks.map((p) => p[1]));
    for (const f of track(sg.tracks, "gone", "transform").frames)
      if (f.offset < P.pair.close[0]) expect(rotateY(f.transform)).toBe(0);
  });

  it("grows the stop/go hatch linearly between “Cleo stop” said and “Cleo go” said", () => {
    const s = scored(STOPGO);
    const [stop, go] = tracksOf(s.tracks, "ink").map(spanOf);
    const clip = track(s.tracks, "hatchClip");
    const [a, b] = spanOf(clip);
    expect(a).toBeGreaterThanOrEqual(stop[1]);
    expect(b).toBeGreaterThan(go[0]);
    expect(b).toBeLessThanOrEqual(go[1]);
    expect(clip.frames.find((f) => f.offset === a)!.easing).toBe("linear");
    expect(first(clip)).toBe("-100% 0");
  });

  it("marks out of the post: leftward for start and cut, rightward for finish", () => {
    const from = (parts: Piece[]) => first(track(scored(parts).tracks, "hatchClip"));
    expect(from(START)).toBe("100% 0");
    expect(from(CUT)).toBe("100% 0");
    expect(from(FINISH)).toBe("-100% 0");
  });

  it("keeps everything in place for “Cleo keep”: no fold, no rail, the next scene comes in", () => {
    const s = scoreRow(KEEP, 0);
    for (const el of ["gone", "movers", "rail", "hatchClip", "hatch"]) expect(tracksOf(s.tracks, el)).toHaveLength(0);
    for (const el of ["ring", "newClip", "newPiece", "ghost"]) expect(tracksOf(s.tracks, el)).toHaveLength(1);
    expect(s.travel).toBe(0);
    expect(s.rail).toBe(0);
  });
});
