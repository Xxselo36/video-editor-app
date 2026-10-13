/**
 * The score of one command row ("Spoken Cut", sections/CommandRows.tsx):
 * how each element of the row moves as the row's progress p runs from 0
 * to 1, as keyframes, from the row's pieces and the one width measured
 * when the row is scored. p is the scroll (commandScroll.ts): 0 when the
 * row's strip reaches the middle line, 1 once its lane is scrolled
 * through. The scroll position is the clock, so there are no durations
 * here: every track spans the whole lane, holds its first value until its
 * step starts and its last one after, and carries its curves on its
 * keyframes. Pure (no DOM), so the choreography and the contact math are
 * unit-tested (commandScore.test.ts).
 *
 * A single command (“Cleo start”, “Cleo cut”, “Cleo finish”):
 *   .00–.30  said: the ink wipes over the word (linear, a scrub head)
 *            behind the voice caret, and the post rises in the strip;
 *            ink and post land together.
 *   .26–.44  marked: the hatch wipes out of the post across the piece.
 *   .44–.52  the piece lifts 2px.
 *   .52–1    it folds away on a hinge at its left edge while everything
 *            after it rides its edge shut, on the hinge spring's shape;
 *            the dashed rail fades in where the video got shorter.
 * “Cleo keep”: said the same way, then a green ring lights on the kept
 *   take and the next scene wipes in out of the post over its dashed slot
 *   (.32–.82); nothing moves left.
 * “Cleo stop … go”: “stop” is said (.00–.14), the hatch grows from its
 *   post (linear, .14–.36), “go” is said as it arrives (.35–.49), then the
 *   lift and the close as above; the go post lands exactly on the stop
 *   post (one marker).
 *
 * Curves are named here (Curve) and resolved by the caller: scrub (the
 * page's --ease-scrub, symmetric, so a step reads the same scrolled back)
 * for the mark, the lift and the next scene; ease for opacity; linear for
 * the scrub heads and between the close's samples.
 */

/** Strip pieces: flex-grow weights; posts are 3px bars. */
export type Piece = { k: "seg" | "gone" | "new"; g: number } | { k: "post" };

export type Curve = "linear" | "scrub" | "ease";

/** One keyframe; `easing` runs from this keyframe to the next. */
export type Frame = { offset: number; easing?: Curve; [prop: string]: string | number | undefined };

/** What a track moves (CommandRows.tsx resolves these to elements). */
export type Target =
  | { el: "ink" | "inkIn" | "voice" | "caret"; unit: number }
  | { el: "post"; post: number }
  | { el: "hatchClip" | "hatch" | "gone" | "movers" | "rail" | "ring" | "ghost" | "newClip" | "newPiece" };

/** The one property a track animates. */
export type Prop = "translate" | "scale" | "opacity" | "transform";

/** One animation per element: one property over the row's whole lane. */
export type Track = { target: Target; prop: Prop; frames: Frame[] };

export type RowScore = {
  tracks: Track[];
  /** how far the pieces after the removed one travel (px; 0: none) */
  travel: number;
  /** the dashed rail's width at the strip's end, where it got shorter
   *  (px; 0: no rail) */
  rail: number;
};

export const GAP = 1;
export const POST_W = 3;
export const PERSPECTIVE = 280;
/** The removed piece lifts this far before it folds (px). */
export const LIFT = 2;
/** The close is baked into SAMPLES + 1 keyframes. */
export const SAMPLES = 24;
/** Critically damped spring (damping 1), response in seconds. */
export const SPRING_RESPONSE = 0.5;
/** The hinge spring's nominal length: the close follows its shape over
 *  this long (ms), stretched over the close's share of the lane. */
export const T_SPRING = 600;
/** The voice caret: a static glyph of 4 bars. */
export const CARET_BARS = 4;

/** The close's shape under the finger: the hinge spring's (front-loaded,
 *  like the hero's closes), or a sine in-out, gentler to scrub. The fold
 *  stays in contact with the movers on either. */
export type CloseShape = "spring" | "sine";
export const CLOSE_SHAPE: CloseShape = "spring";

type Range = readonly [number, number];

/** Where each step sits in a row's progress (keyframe offsets). */
export const P = {
  /** “Cleo start”, “Cleo cut”, “Cleo finish”; “Cleo keep” is said the
   *  same way. */
  single: {
    say: [0, 0.3],
    caretIn: [0, 0.04],
    caretOut: [0.3, 0.38],
    mark: [0.26, 0.44],
    lift: [0.44, 0.52],
    close: [0.52, 1],
    rail: [0.52, 0.76],
  },
  /** “Cleo keep”: the ring lights and goes out again as the next scene
   *  lands; the dashed slot fades as it fills. */
  keep: {
    ringIn: [0.26, 0.4],
    ringOut: [0.4, 0.82],
    next: [0.32, 0.82],
    ghost: [0.64, 0.82],
  },
  /** “Cleo stop … go”: two units, the skipped speech between them. */
  pair: {
    say: [
      [0, 0.14],
      [0.35, 0.49],
    ],
    caretIn: [
      [0, 0.03],
      [0.35, 0.38],
    ],
    caretOut: [
      [0.14, 0.2],
      [0.49, 0.55],
    ],
    skip: [0.14, 0.36],
    lift: [0.5, 0.56],
    close: [0.56, 1],
    rail: [0.56, 0.78],
  },
} as const;

/** Step response of a critically damped spring after `s` seconds: starts
 *  at zero velocity, never overshoots. */
export function spring(s: number): number {
  const w = (2 * Math.PI) / SPRING_RESPONSE;
  return 1 - (1 + w * s) * Math.exp(-w * s);
}

/** The spring over `total` ms, normalised to land exactly at 1. */
export function springProgress(ms: number, total = T_SPRING): number {
  if (ms <= 0) return 0;
  if (ms >= total) return 1;
  return spring(ms / 1000) / spring(total / 1000);
}

/** The close's progress at `u` (0–1) of its share of the lane. */
export function closeShape(u: number, shape: CloseShape = CLOSE_SHAPE): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return shape === "spring" ? springProgress(u * T_SPRING) : (1 - Math.cos(Math.PI * u)) / 2;
}

/** The on-screen width of a piece `w` px wide, turned `theta` (rad) on a
 *  hinge at its left edge, seen through perspective(PERSPECTIVE px). */
export function projectedWidth(w: number, theta: number): number {
  return (w * Math.cos(theta) * PERSPECTIVE) / (PERSPECTIVE + w * Math.sin(theta));
}

/** The hinge angle at which the piece looks `target` px wide (bisection;
 *  the projection falls monotonically from w at 0 to 0 at 90°). */
export function hingeAngle(w: number, target: number): number {
  if (target >= w) return 0;
  if (target <= 0) return Math.PI / 2;
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (projectedWidth(w, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The folding piece holds full opacity until the close is past half way,
 *  then fades out by p = 0.9. */
export function foldOpacity(p: number): number {
  return p < 0.55 ? 1 : Math.max(0, 1 - (p - 0.55) / 0.35);
}

export type CloseSample = { u: number; p: number; theta: number; shift: number; opacity: number };

/** The close, sampled at SAMPLES + 1 even steps `u` of its share of the
 *  lane: at each the movers have travelled `shift` px and the piece is
 *  turned so its far edge stays exactly GAP px from them (while there is
 *  any piece left to show). */
export function closeSamples(w: number, travel: number, shape: CloseShape = CLOSE_SHAPE): CloseSample[] {
  const out: CloseSample[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const p = closeShape(u, shape);
    const shift = travel * p;
    out.push({ u, p, theta: hingeAngle(w, w - shift), shift, opacity: foldOpacity(p) });
  }
  return out;
}

/** How far the pieces after the removed one travel: its width and the gap
 *  after it, plus the go post and its gap when that post lands on the
 *  stop post. Nothing after it: the piece just folds away. */
export function travelFor(w: number, movers: number, merge: boolean): number {
  if (!movers) return w;
  return w + GAP + (merge ? POST_W + GAP : 0);
}

/** The strip's flex layout (basis 0, posts fixed, GAP between pieces):
 *  each piece's left edge and width in a strip `width` px wide. For the
 *  tests; the page measures the removed piece itself. */
export function pieceWidths(parts: readonly Piece[], width: number): { x: number; w: number }[] {
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

type Value = string | number;
type Step = readonly [at: Range, to: Value, curve: Curve];

/** One property of one element over the lane: `from`, then each step in
 *  turn (on its curve, to its value), with hold frames at 0 and 1 unless
 *  a step already starts or ends there. */
function steps(target: Target, prop: Prop, from: Value, ...moves: Step[]): Track {
  const frames: Frame[] = [];
  let value = from;
  for (const [[a, b], to, curve] of moves) {
    const last = frames[frames.length - 1];
    if (last?.offset === a) last.easing = curve;
    else {
      if (!last && a > 0) frames.push({ offset: 0, [prop]: value });
      frames.push({ offset: a, easing: curve, [prop]: value });
    }
    frames.push({ offset: b, [prop]: to });
    value = to;
  }
  if (frames[frames.length - 1].offset < 1) frames.push({ offset: 1, [prop]: value });
  return { target, prop, frames };
}

/** One step: `from` until `at[0]`, on `curve` to `to` at `at[1]`, held. */
function span(target: Target, prop: Prop, at: Range, from: Value, to: Value, curve: Curve): Track {
  return steps(target, prop, from, [at, to, curve]);
}

const px = (n: number) => `${n.toFixed(3)}px`;
const deg = (rad: number) => `${((rad * 180) / Math.PI).toFixed(3)}deg`;
/** The removed piece's one transform list (identical functions in every
 *  keyframe, so it interpolates per function): the lift, then the hinge. */
const fold = (lift: number, theta: number) =>
  `translateY(${-lift}px) perspective(${PERSPECTIVE}px) rotateY(${deg(theta)})`;

/**
 * The row's score. `goneWidth`: the removed piece's laid-out width (px),
 * measured when the row is scored (unused for “Cleo keep”).
 */
export function scoreRow(parts: readonly Piece[], goneWidth: number): RowScore {
  const tracks: Track[] = [];
  const postIdx = parts.flatMap((p, i) => (p.k === "post" ? [i] : []));
  const pair = postIdx.length > 1;

  /** Unit `u` is said over `at` behind its caret; its post rises with
   *  the ink and lands with it. */
  const say = (u: number, at: Range, caretIn: Range, caretOut: Range) => {
    tracks.push(
      // The counter-translate wipe: the edge moves, the glyphs never do.
      span({ el: "ink", unit: u }, "translate", at, "-100% 0", "0 0", "linear"),
      span({ el: "inkIn", unit: u }, "translate", at, "100% 0", "0 0", "linear"),
      // The caret rides just ahead of the ink edge.
      span({ el: "voice", unit: u }, "translate", at, "-100% 0", "0 0", "linear"),
      steps({ el: "caret", unit: u }, "opacity", 0, [caretIn, 1, "ease"], [caretOut, 0, "ease"]),
      span({ el: "post", post: u }, "scale", at, "1 0", "1 1", "linear"),
    );
  };

  if (parts.some((p) => p.k === "new")) {
    // “Cleo keep”: the kept take rings, the next scene comes in.
    const { say: at, caretIn, caretOut } = P.single;
    const { ringIn, ringOut, next, ghost } = P.keep;
    say(0, at, caretIn, caretOut);
    tracks.push(
      steps({ el: "ring" }, "opacity", 0, [ringIn, 1, "ease"], [ringOut, 0, "ease"]),
      span({ el: "newClip" }, "translate", next, "-100% 0", "0 0", "scrub"),
      span({ el: "newPiece" }, "translate", next, "100% 0", "0 0", "scrub"),
      span({ el: "ghost" }, "opacity", ghost, 1, 0, "ease"),
    );
    return { tracks, travel: 0, rail: 0 };
  }

  const gi = parts.findIndex((p) => p.k === "gone");
  const movers = parts.length - gi - 1;
  const w = goneWidth;
  let lift: Range;
  let close: Range;
  let railAt: Range;
  if (pair) {
    const { say: at, caretIn, caretOut, skip } = P.pair;
    say(0, at[0], caretIn[0], caretOut[0]);
    // The skipped speech: the hatch grows out of the stop post at the
    // speed of the scroll, rightward; “Cleo go” is said as it arrives.
    tracks.push(
      span({ el: "hatchClip" }, "translate", skip, "-100% 0", "0 0", "linear"),
      span({ el: "hatch" }, "translate", skip, "100% 0", "0 0", "linear"),
    );
    say(1, at[1], caretIn[1], caretOut[1]);
    ({ lift, close, rail: railAt } = P.pair);
  } else {
    const { say: at, caretIn, caretOut, mark } = P.single;
    say(0, at, caretIn, caretOut);
    // Out of the post: leftward when the post is after the piece.
    const from = postIdx[0] > gi ? 1 : -1;
    tracks.push(
      span({ el: "hatchClip" }, "translate", mark, `${from * 100}% 0`, "0 0", "scrub"),
      span({ el: "hatch" }, "translate", mark, `${-from * 100}% 0`, "0 0", "scrub"),
    );
    ({ lift, close, rail: railAt } = P.single);
  }

  // The lift, then the fold and the close on one sampled shape: the
  // piece's far edge rides the movers at every sample.
  const travel = travelFor(w, movers, pair);
  const samples = closeSamples(w, travel);
  const at = (s: CloseSample) => close[0] + (close[1] - close[0]) * s.u;
  const hinge: Frame[] = samples.map((s) => ({ offset: at(s), transform: fold(LIFT, s.theta) }));
  tracks.push({
    target: { el: "gone" },
    prop: "transform",
    frames: [
      { offset: 0, transform: fold(0, 0) },
      { offset: lift[0], easing: "scrub", transform: fold(0, 0) },
      ...(lift[1] === close[0] ? hinge : [{ offset: lift[1], transform: fold(LIFT, 0) }, ...hinge]),
    ],
  });
  // Its own track (transforms and opacity tick at different rates on
  // iOS); the fade follows the same samples.
  tracks.push({
    target: { el: "gone" },
    prop: "opacity",
    frames: [{ offset: 0, opacity: 1 }, ...samples.map((s) => ({ offset: at(s), opacity: Number(s.opacity.toFixed(4)) }))],
  });
  if (movers) {
    tracks.push({
      target: { el: "movers" },
      prop: "translate",
      frames: [{ offset: 0, translate: "0px 0" }, ...samples.map((s) => ({ offset: at(s), translate: `${px(-s.shift)} 0` }))],
    });
  }
  // Where the strip got shorter: a dashed rail at its end (the strip
  // keeps its length; the empty end reads as a shorter video).
  tracks.push(span({ el: "rail" }, "opacity", railAt, 0, 1, "ease"));
  return { tracks, travel, rail: movers ? travel - GAP : w };
}
