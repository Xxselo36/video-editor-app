import { describe, expect, it } from "vitest";
import {
  PICK_MS,
  TURN_MS,
  bends,
  faceOpacity,
  facing,
  lerpPose,
  moveKeyframes,
  norm,
  passesFor,
  restPose,
  target,
  veilOpacity,
  type Pose,
  type Slot,
} from "./ring";
import { captionWords, spokenUntil } from "./words";
import { HOLD, MAX_DWELL, MIN_DWELL } from "./ring";

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

  it("a style stays in front for whole passes, 4.5 to 8 s", () => {
    for (const lang of ["en", "de", "ja", "hi"]) {
      const pass = spokenUntil(captionWords("3 tips for better hooks", lang)) + HOLD;
      const n = passesFor(pass);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n * pass).toBeGreaterThanOrEqual(Math.min(MIN_DWELL, pass));
      if (n > 1) expect(n * pass).toBeLessThanOrEqual(MAX_DWELL);
    }
    expect(passesFor(2.645)).toBe(2);
    expect(passesFor(1.2)).toBe(4);
    expect(passesFor(9)).toBe(1);
  });
});
