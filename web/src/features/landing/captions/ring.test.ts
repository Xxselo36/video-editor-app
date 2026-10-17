import { describe, expect, it } from "vitest";
import { LANGS, type Lang } from "@/i18n/langs";
import { deLanding } from "@/i18n/messages/de/landing";
import { enLanding } from "@/i18n/messages/en/landing";
import { esLanding } from "@/i18n/messages/es/landing";
import { frLanding } from "@/i18n/messages/fr/landing";
import { hiLanding } from "@/i18n/messages/hi/landing";
import { idLanding } from "@/i18n/messages/id/landing";
import { itLanding } from "@/i18n/messages/it/landing";
import { jaLanding } from "@/i18n/messages/ja/landing";
import { koLanding } from "@/i18n/messages/ko/landing";
import { nlLanding } from "@/i18n/messages/nl/landing";
import { plLanding } from "@/i18n/messages/pl/landing";
import { ptLanding } from "@/i18n/messages/pt/landing";
import { ruLanding } from "@/i18n/messages/ru/landing";
import { trLanding } from "@/i18n/messages/tr/landing";
import {
  FAN_MS,
  FAN_STAGGER_MS,
  HOLD,
  PICK_MS,
  TURN_MS,
  bends,
  faceOpacity,
  facing,
  lerpPose,
  moveKeyframes,
  norm,
  passEnds,
  passLength,
  passProgress,
  restPose,
  RingScore,
  target,
  veilOpacity,
  type Pose,
  type Slot,
} from "./ring";
import { captionWords, spokenUntil } from "./words";

const LANDING: Record<Lang, Partial<Record<keyof typeof enLanding, string>>> = {
  en: enLanding,
  de: deLanding,
  es: esLanding,
  fr: frLanding,
  pt: ptLanding,
  it: itLanding,
  tr: trLanding,
  pl: plLanding,
  nl: nlLanding,
  ru: ruLanding,
  ja: jaLanding,
  ko: koLanding,
  id: idLanding,
  hi: hiLanding,
};

/** One frame of the page's ticker at 60 fps (s). */
const TICK = 1 / 60;

/** The front caption's clock from `c0`, tick by tick: where it stands at
 *  the first `n` pass ends. */
function passEndsFrom(c0: number, pass: number, n: number): number[] {
  const out: number[] = [];
  let c = c0;
  for (let k = 0; out.length < n && k < 10_000; k++) {
    const prev = c;
    c += TICK;
    if (passEnds(prev, c, pass)) out.push(c);
  }
  return out;
}

/** The brand curve, cubic-bezier(0.16, 1, 0.3, 1): progress at time share x. */
function brandEase(x: number): number {
  const [x1, y1, x2, y2] = [0.16, 1, 0.3, 1];
  const bez = (s: number, p1: number, p2: number) => 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (bez(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, y1, y2);
}

/** The value of linear keyframes (offset, opacity) at share p. */
function sample(frames: Keyframe[], p: number): number {
  for (let n = 1; n < frames.length; n++) {
    const a = frames[n - 1];
    const b = frames[n];
    const oa = a.offset as number;
    const ob = b.offset as number;
    if (p <= ob) return (a.opacity as number) + (((b.opacity as number) - (a.opacity as number)) * (p - oa)) / (ob - oa || 1);
  }
  return frames[frames.length - 1].opacity as number;
}

/** The two geometries (CaptionPlayer.module.css): ring radius and camera
 *  distance in frame widths. */
const LOOKS = [
  { name: "desktop", ring: 0.9, persp: 5.6 },
  { name: "phone", ring: 0.75, persp: 4 },
];

/** A frame's horizontal extent on screen (in frame widths, 0 = the middle). */
function span(p: Pose, ring: number, persp: number): [number, number] {
  const ar = (p.a * Math.PI) / 180;
  const fr = (facing(p) * Math.PI) / 180;
  const cx = ring * Math.sin(ar);
  const cz = ring * Math.cos(ar) - ring;
  const xs = [-0.5, 0.5].map((e) => {
    const x = cx + e * Math.cos(fr);
    const z = cz - e * Math.sin(fr);
    return (x * persp) / (persp - z);
  });
  return [Math.min(...xs), Math.max(...xs)];
}

type Item = { from: Pose; to: Pose; face: Keyframe[] };

/** A move of the three frames: from their poses to the slots given. */
function move(from: Pose[], slots: Slot[]): Item[] {
  return from.map((p, i) => {
    const to = target(p, slots[i]);
    const kf = moveKeyframes(p, to, 100, faceOpacity(p.a), veilOpacity(p.a));
    return { from: p, to, face: kf.face };
  });
}

const REST: Pose[] = [restPose(0), restPose(1), restPose(2)];
/** The auto turn: the right frame comes to the front. */
const TURN_LEFT: Slot[] = [2, 0, 1];
/** A pick of the left frame. */
const TURN_RIGHT: Slot[] = [1, 2, 0];

describe("captions ring", () => {
  it("rest poses face a quarter of their angle, and the sides 30° outward", () => {
    expect(facing(restPose(0))).toBe(0);
    expect(facing(restPose(1))).toBe(30);
    expect(facing(restPose(2))).toBe(-30);
  });

  it("every keyframe uses the same functions in the same order", () => {
    for (const slots of [TURN_LEFT, TURN_RIGHT]) {
      for (const p of REST) {
        const kf = moveKeyframes(p, target(p, slots[REST.indexOf(p)]), 120, 1, 0.5);
        const lists = kf.transform.map((k) => String(k.transform).replace(/\([^)]*\)/g, "()"));
        expect(new Set(lists).size).toBe(1);
        expect(lists[0]).toBe("rotateY() translateZ() rotateY()");
      }
    }
  });

  it("a turn moves the whole ring one step, the wrapping frame through the back", () => {
    const left = move(REST, TURN_LEFT);
    expect(left.map((m) => m.to.a - m.from.a)).toEqual([-120, -120, -120]);
    expect(left[2].to.a).toBe(-240);
    const right = move(REST, TURN_RIGHT);
    expect(right.map((m) => m.to.a - m.from.a)).toEqual([120, 120, 120]);
    expect(right[1].to.a).toBe(240);
  });

  it("each move ends exactly in its slot's rest pose (modulo 360°)", () => {
    for (const slots of [TURN_LEFT, TURN_RIGHT]) {
      move(REST, slots).forEach((m, i) => {
        const rest = restPose(slots[i]);
        expect(norm(m.to.a - rest.a)).toBeCloseTo(0, 9);
        expect(norm(m.to.f - rest.f)).toBeCloseTo(0, 9);
      });
    }
  });

  it("no frame ever shows its back, also when a pick interrupts a turn", () => {
    const interrupted = move(REST, TURN_LEFT).map((m) => lerpPose(m.from, m.to, 0.37));
    for (const items of [move(REST, TURN_LEFT), move(REST, TURN_RIGHT), move(interrupted, [0, 1, 2]), move(interrupted, [1, 2, 0])]) {
      for (const m of items) {
        for (let p = 0; p <= 1.0001; p += 0.01) expect(Math.abs(facing(lerpPose(m.from, m.to, p)))).toBeLessThanOrEqual(30.0001);
      }
    }
  });

  it("an interrupted turn keeps the ring together (all frames turn by the same angle)", () => {
    const mid = move(REST, TURN_LEFT).map((m) => lerpPose(m.from, m.to, 0.6));
    for (const slots of [[0, 1, 2], [1, 2, 0], [2, 0, 1]] as Slot[][]) {
      const deltas = move(mid, slots).map((m) => m.to.a - m.from.a);
      expect(deltas[1]).toBeCloseTo(deltas[0], 9);
      expect(deltas[2]).toBeCloseTo(deltas[0], 9);
    }
  });

  it("keyframes at the bends reproduce the opacities exactly", () => {
    for (const [a0, a1] of [
      [-120, -240],
      [120, 240],
      [0, -120],
      [-150, 0],
      [84, 240],
    ]) {
      const kf = moveKeyframes({ a: a0, f: 0 }, { a: a1, f: 0 }, 100, faceOpacity(a0), veilOpacity(a0));
      for (let p = 0; p <= 1; p += 0.005) {
        const a = a0 + (a1 - a0) * p;
        expect(sample(kf.face, p)).toBeCloseTo(faceOpacity(a), 6);
        expect(sample(kf.veil, p)).toBeCloseTo(veilOpacity(a), 6);
      }
      expect(bends(a0, a1)[0]).toBe(0);
      expect(bends(a0, a1).at(-1)).toBe(1);
    }
  });

  // Sampled every 16 ms on the brand curve: wherever the wrapping frame
  // could be seen between the two frames passing in front of it, it is
  // gone.
  for (const look of LOOKS) {
    for (const [name, slots, ms] of [
      ["auto turn", TURN_LEFT, TURN_MS],
      ["pick", TURN_RIGHT, PICK_MS],
    ] as const) {
      it(`${look.name}, ${name}: the wrapping frame never shows through the gap`, () => {
        const items = move(REST, slots);
        const wrap = items.findIndex((m) => Math.abs(m.to.a - m.from.a) > 0 && Math.abs(norm(m.to.a)) === 120 && Math.abs(m.to.a) > 180);
        expect(wrap).toBeGreaterThanOrEqual(0);
        const others = items.filter((_, i) => i !== wrap);
        for (let t = 0; t <= ms; t += 16) {
          const p = brandEase(t / ms);
          const [l1, r1] = span(lerpPose(others[0].from, others[0].to, p), look.ring, look.persp);
          const [l2, r2] = span(lerpPose(others[1].from, others[1].to, p), look.ring, look.persp);
          const gapL = Math.min(r1, r2);
          const gapR = Math.max(l1, l2);
          const [wl, wr] = span(lerpPose(items[wrap].from, items[wrap].to, p), look.ring, look.persp);
          const inGap = gapL < gapR && wr > gapL && wl < gapR;
          if (inGap) expect(sample(items[wrap].face, p)).toBeLessThanOrEqual(0.05);
        }
      });
    }
  }

  // The clock starts below zero after the reveal, a turn or a pick (the
  // lead-in while the ring brings the style round, so its first word
  // lands as the ring settles) or a pick of the style in front (its
  // settled page for the hold first), and at zero on a reload mid-page.
  it("each style plays its caption once, every word and the hold, then the ring turns (every language)", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      const words = captionWords(LANDING[lang]["site.demo.caption"] ?? "", lang);
      expect(words.length, lang).toBeGreaterThan(0);
      const lastEnd = spokenUntil(words);
      const pass = passLength(lastEnd);
      expect(pass, lang).toBeCloseTo(lastEnd + HOLD, 9);
      const lead = words[0].start;
      for (const c0 of [lead - (FAN_STAGGER_MS + FAN_MS) / 1000, lead - TURN_MS / 1000, lead - PICK_MS / 1000, lead - HOLD, 0]) {
        const [first, next] = passEndsFrom(c0, pass, 2);
        // The turn: one pass on the caption's clock (to the tick), never
        // as the clock comes up through zero, and after every word and
        // the settled page.
        expect(first, lang).toBeGreaterThanOrEqual(pass);
        expect(first - pass, lang).toBeLessThan(TICK);
        for (const w of words) expect(first, lang).toBeGreaterThanOrEqual(w.end + HOLD);
        // Held past it, the caption plays on and the next chance comes a
        // whole pass later, at its seam: a turn never cuts a word.
        expect(Math.abs(next - first - pass), lang).toBeLessThan(TICK);
      }
    }
  });

  it("a pass ends only where the clock crosses a whole pass", () => {
    expect(passEnds(-0.4, 0.01, 2.6)).toBe(false);
    expect(passEnds(2.59, 2.61, 2.6)).toBe(true);
    expect(passEnds(2.61, 2.63, 2.6)).toBe(false);
    expect(passEnds(5.19, 5.21, 2.6)).toBe(true);
    expect(passEnds(1.3, 1.3, 2.6)).toBe(false);
  });

  it("the pill's line runs over one pass, full as the turn comes, and again while held", () => {
    expect(passProgress(-0.9, 2.6)).toBe(0);
    expect(passProgress(0, 2.6)).toBe(0);
    expect(passProgress(1.3, 2.6)).toBeCloseTo(0.5, 9);
    expect(passProgress(2.6 - TICK, 2.6)).toBeGreaterThan(0.99);
    expect(passProgress(2.6 + 0.65, 2.6)).toBeCloseTo(0.25, 9);
  });
});

/** A ring with no frames to animate (as where the browser can't): a turn
 *  is the front changing at once, on the same clock and holds. */
function score(lang: Lang = "en") {
  const turns: { at: number; to: number }[] = [];
  let now = 0;
  const ring = new RingScore({
    setFront: (i) => turns.push({ at: now, to: i }),
    setMoving: () => {},
    setPending: () => {},
  });
  const words = captionWords(LANDING[lang]["site.demo.caption"] ?? "", lang);
  ring.setWords(words);
  const pass = passLength(spokenUntil(words));
  const lead = words[0].start;
  /** Ticks the clock for `s` seconds at 60 fps. */
  const run = (s: number) => {
    for (let k = Math.round(s / TICK); k > 0; k--) {
      now += TICK;
      ring.tick(TICK);
    }
  };
  return { ring, turns, run, pass, lead, now: () => now };
}

/** Seconds a style stays in front after it came by a turn of `ms`. */
const dwell = (pass: number, lead: number, ms: number) => pass - (lead - ms / 1000);

describe("the ring's score", () => {
  it("turns by itself, one pass per style, round and round", () => {
    const { turns, run, pass, lead } = score();
    run(pass + 3 * dwell(pass, lead, TURN_MS) + 0.1);
    expect(turns.map((t) => t.to)).toEqual([1, 2, 0, 1]);
    expect(turns[0].at).toBeCloseTo(pass, 1);
    for (let n = 1; n < turns.length; n++) expect(turns[n].at - turns[n - 1].at).toBeCloseTo(dwell(pass, lead, TURN_MS), 1);
  });

  it("after a pick the style plays its one pass, then the turns go on", () => {
    const { ring, turns, run, pass, lead, now } = score();
    run(1);
    ring.pick(2);
    const picked = now();
    expect(turns).toEqual([{ at: picked, to: 2 }]);
    run(dwell(pass, lead, PICK_MS) + dwell(pass, lead, TURN_MS) + 0.1);
    expect(turns.map((t) => t.to)).toEqual([2, 0, 1]);
    expect(turns[1].at - picked).toBeCloseTo(dwell(pass, lead, PICK_MS), 1);
    // and again: a second pick doesn't stop them either
    ring.pick(0);
    run(dwell(pass, lead, PICK_MS) + 0.1);
    expect(turns.map((t) => t.to)).toEqual([2, 0, 1, 0, 1]);
  });

  it("the style in front, picked again, starts over from its settled page", () => {
    const { ring, turns, run, pass, lead, now } = score();
    const seeks: number[] = [];
    ring.handles[0] = { seek: (t) => seeks.push(t), duration: pass, still: 0 };
    run(pass - 0.5);
    ring.pick(0);
    const picked = now();
    expect(seeks.at(-1)).toBe(spokenUntil(captionWords(enLanding["site.demo.caption"], "en")));
    expect(turns).toEqual([]);
    run(pass - lead + HOLD + 0.1);
    expect(turns).toHaveLength(1);
    expect(turns[0].at - picked).toBeCloseTo(pass - lead + HOLD, 1);
  });

  it("a hold keeps the style in front; let go, the turn comes at a pass end after the wait", () => {
    const { ring, turns, run, pass } = score();
    ring.hold("stage", true);
    run(3 * pass);
    expect(turns).toEqual([]);
    const released = 3 * pass;
    ring.hold("stage", false);
    run(pass + TURN_MS / 1000 + 0.1);
    expect(turns).toHaveLength(1);
    const wait = turns[0].at - released;
    expect(wait).toBeGreaterThanOrEqual(TURN_MS / 1000 - TICK);
    expect(wait).toBeLessThan(TURN_MS / 1000 + pass);
    // at a pass end: the caption is never cut
    expect((turns[0].at / pass) % 1).toBeLessThan(TICK / pass + 1e-9);
  });

  it("a mouse holds only once it moves, not when the page scrolls under it", () => {
    const { ring, turns, run, pass } = score();
    ring.mouse("stage", "enter", 720, 450);
    ring.mouse("stage", "move", 720, 450);
    run(pass + 0.1);
    expect(turns).toHaveLength(1);
    ring.mouse("stage", "move", 724, 452);
    expect(ring.holds.has("stage")).toBe(true);
    ring.mouse("stage", "leave", 724, 452);
    expect(ring.holds.size).toBe(0);
    // a reload with the cursor resting on the stage: its first move is no move
    const fresh = score();
    fresh.ring.mouse("stage", "move", 300, 300);
    expect(fresh.ring.holds.size).toBe(0);
  });

  it("a mouse that lands with a single event holds; a cursor the ring scrolls under after moving elsewhere doesn't", () => {
    const { ring, turns, run, pass } = score();
    // seen elsewhere on the page, then one event lands on the controls and the mouse rests
    ring.seen(5, 5);
    ring.mouse("controls", "enter", 535, 750);
    ring.mouse("controls", "move", 535, 750);
    ring.seen(535, 750);
    expect(ring.holds.has("controls")).toBe(true);
    run(2 * pass);
    expect(turns).toEqual([]);
    ring.mouse("controls", "leave", 535, 750);
    expect(ring.holds.size).toBe(0);
    // the mouse moves on over the page and rests; the page scrolls the stage under it
    ring.seen(1300, 450);
    ring.seen(720, 450);
    ring.mouse("stage", "enter", 720, 450);
    ring.mouse("stage", "move", 720, 450);
    expect(ring.holds.size).toBe(0);
    run(pass + TURN_MS / 1000 + 0.1);
    expect(turns).toHaveLength(1);
  });

  it("no hold outlives the controls (reduced motion, unmount)", () => {
    const { ring, turns, run, pass } = score();
    ring.hold("controls", true);
    ring.hold("focus", true);
    ring.reset();
    run(pass + 0.1);
    expect(turns).toHaveLength(1);
  });

  it("the line follows the clock, from empty after every turn", () => {
    const { ring, run, pass } = score();
    const line = { currentTime: null as CSSNumberish | null };
    ring.setLine(line);
    run(pass / 2);
    expect(line.currentTime as number).toBeCloseTo(500, -1);
    ring.pick(1);
    ring.setLine(line);
    expect(line.currentTime).toBe(0);
  });
});
