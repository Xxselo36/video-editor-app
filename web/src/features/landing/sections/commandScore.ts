/**
 * The score of one command row ("Spoken Cut", sections/CommandRows.tsx):
 * when each element of the row moves and how, as keyframes, from the
 * row's pieces and the one width measured when the row is armed. Pure (no
 * DOM), so the timing and the contact math are unit-tested
 * (commandScore.test.ts). t = 0 is the row's start (ms).
 *
 * A single command (“Cleo start”, “Cleo cut”, “Cleo finish”):
 *   0–420     said: the ink wipes over the word (linear, the speed of
 *             speech) behind a 4-bar voice caret, and the post rises in
 *             the strip like a level meter; ink and post peak together.
 *   380–640   marked: the hatch wipes out of the post across the piece.
 *   560–720   the piece lifts 2px.
 *   700–1300  it folds away on a hinge at its left edge while everything
 *             after it rides its edge shut on one critically damped
 *             spring; the landed post flares once (the seal, p = 0.9).
 *   ≈1030     the next row may start (handoff, p = 0.92).
 * “Cleo keep”: said, then a green ring on the kept take and the next
 *   scene wipes in out of the post over its dashed slot; nothing moves
 *   left. Handoff 860.
 * “Cleo stop … go”: “stop” is said (340), the hatch grows from its post
 *   at the speed of time (340–880), “go” is said as it arrives (860–1200),
 *   then the lift and the fold as above; the go post lands exactly on the
 *   stop post (one marker). Handoff ≈ 1810.
 *
 * Curves are named here (Curve) and resolved by the caller: brand (the
 * page's --ease-out), sine (between level-meter steps), ease (opacity out,
 * decays), linear (the voice and anything baked into keyframes).
 */

/** Strip pieces: flex-grow weights; posts are 3px bars. */
export type Piece = { k: "seg" | "gone" | "new"; g: number } | { k: "post" };

export type Curve = "brand" | "sine" | "ease" | "linear";

/** One keyframe; `easing` runs from this keyframe to the next. */
export type Frame = { offset: number; easing?: Curve; [prop: string]: string | number | undefined };

/** What a track moves (CommandRows.tsx resolves these to elements). */
export type Target =
  | { el: "ink" | "inkIn" | "voice" | "caret"; unit: number }
  | { el: "bar"; unit: number; bar: number }
  | { el: "post"; post: number }
  | { el: "hatchClip" | "hatch" | "gone" | "movers" | "rail" | "ring" | "ghost" | "newClip" | "newPiece" };

/** One animation: linear between its keyframes (their own curves apply). */
export type Track = { target: Target; delay: number; duration: number; frames: Frame[] };

export type RowScore = {
  tracks: Track[];
  /** when the next row may start (the close at p ≥ 0.92) */
  handoff: number;
  /** when the last track ends */
  end: number;
  /** how far the pieces after the removed one travel (px; 0: none) */
  travel: number;
  /** the dashed rail's width at the strip's end, where it got shorter
   *  (px; 0: no rail) */
  rail: number;
};

export const GAP = 1;
export const POST_W = 3;
export const PERSPECTIVE = 280;
/** The close is baked into SAMPLES + 1 keyframes. */
export const SAMPLES = 24;
/** Critically damped spring (damping 1), response in seconds. */
export const SPRING_RESPONSE = 0.5;

export const T = {
  /** a command is said (ink, caret, post) */
  say: 420,
  /** each of “Cleo stop” and “Cleo go” */
  sayPair: 340,
  caretIn: 80,
  caretOut: 140,
  /** the mark starts this long before said */
  markLead: 40,
  mark: 260,
  /** the lift starts this long after said */
  liftAfter: 140,
  lift: 160,
  /** the close starts this long after said */
  closeAfter: 280,
  close: 600,
  rail: 320,
  sealUp: 90,
  sealDown: 200,
  /** the skipped speech: the hatch grows from “Cleo stop” said */
  skip: 540,
  /** “Cleo go” starts this long before the hatch arrives */
  goLead: 20,
  /** “Cleo keep”: the next scene wipes in */
  newIn: 480,
  ringIn: 160,
  ringOut: 600,
  /** the dashed slot fades out from here (after said) */
  ghostAfter: 320,
  ghostOut: 160,
  /** “Cleo keep” hands off this long after said */
  keepHandoff: 440,
};

/** The seal flares at this share of the close; the next row starts at
 *  HANDOFF_P. */
export const SEAL_P = 0.9;
export const HANDOFF_P = 0.92;

/** The voice caret: 4 bars, each through 7 levels (scale "1 y"). */
const LEVELS = [
  [0.3, 0.9, 0.45, 0.75, 0.4, 0.85, 0.5],
  [0.5, 0.6, 1, 0.55, 0.95, 0.5, 0.7],
  [0.35, 1, 0.6, 0.9, 0.5, 0.65, 0.45],
  [0.25, 0.5, 0.8, 0.4, 0.7, 0.35, 0.3],
];
export const CARET_BARS = LEVELS.length;
/** The post rises like a level meter as its command is said. */
const RISE = [0.2, 0.55, 0.35, 0.8, 0.5, 1.15, 1];

/** Step response of a critically damped spring after `s` seconds: starts
 *  at zero velocity, never overshoots. */
export function spring(s: number): number {
  const w = (2 * Math.PI) / SPRING_RESPONSE;
  return 1 - (1 + w * s) * Math.exp(-w * s);
}

/** The spring over `total` ms, normalised to land exactly at 1. */
export function springProgress(ms: number, total = T.close): number {
  if (ms <= 0) return 0;
  if (ms >= total) return 1;
  return spring(ms / 1000) / spring(total / 1000);
}

/** When the spring over `total` ms reaches `p` (ms). */
export function springTime(p: number, total = T.close): number {
  let lo = 0;
  let hi = total;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (springProgress(mid, total) < p) lo = mid;
    else hi = mid;
  }
  return hi;
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

/** The folding piece holds full opacity until the spring is past half way,
 *  then fades out by p = 0.9. */
export function foldOpacity(p: number): number {
  return p < 0.55 ? 1 : Math.max(0, 1 - (p - 0.55) / 0.35);
}

export type CloseSample = { t: number; p: number; theta: number; shift: number; opacity: number };

/** The close, sampled: at each step the movers have travelled `shift` px
 *  and the piece is turned so its far edge stays exactly GAP px from
 *  them (while there is any piece left to show). */
export function closeSamples(w: number, travel: number): CloseSample[] {
  const out: CloseSample[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = (i / SAMPLES) * T.close;
    const p = springProgress(t);
    const shift = travel * p;
    out.push({ t, p, theta: hingeAngle(w, w - shift), shift, opacity: foldOpacity(p) });
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

type Point = [t: number, props: Record<string, string | number>, easing?: Curve];

/** A track through timed points (absolute ms). */
function seq(target: Target, points: Point[]): Track {
  const t0 = points[0][0];
  const d = Math.max(1, points[points.length - 1][0] - t0);
  return {
    target,
    delay: t0,
    duration: d,
    frames: points.map(([t, props, easing]) => ({
      offset: Math.min(1, Math.max(0, (t - t0) / d)),
      ...props,
      ...(easing ? { easing } : {}),
    })),
  };
}

/** A two-keyframe track. */
function tween(
  target: Target,
  from: Record<string, string | number>,
  to: Record<string, string | number>,
  delay: number,
  duration: number,
  easing: Curve,
): Track {
  return { target, delay, duration, frames: [{ offset: 0, ...from, easing }, { offset: 1, ...to }] };
}

const px = (n: number) => `${n.toFixed(3)}px`;
const deg = (rad: number) => `${((rad * 180) / Math.PI).toFixed(3)}deg`;

/**
 * The row's score. `goneWidth`: the removed piece's laid-out width (px),
 * measured when the row is armed (unused for “Cleo keep”).
 */
export function scoreRow(parts: readonly Piece[], goneWidth: number): RowScore {
  const tracks: Track[] = [];
  const postIdx = parts.flatMap((p, i) => (p.k === "post" ? [i] : []));
  const pair = postIdx.length > 1;
  const sayFor = pair ? T.sayPair : T.say;
  /** each post's points: its rise, then (one post) the seal */
  const postPts: Point[][] = postIdx.map(() => []);

  /** Unit `u` is said from t0, its post rising: returns said. */
  const say = (u: number, post: number, t0: number): number => {
    const said = t0 + sayFor;
    tracks.push(
      // The counter-translate wipe: the edge moves, the glyphs never do.
      tween({ el: "ink", unit: u }, { translate: "-100% 0" }, { translate: "0 0" }, t0, sayFor, "linear"),
      tween({ el: "inkIn", unit: u }, { translate: "100% 0" }, { translate: "0 0" }, t0, sayFor, "linear"),
      // The caret rides just ahead of the ink edge.
      tween({ el: "voice", unit: u }, { translate: "-100% 0" }, { translate: "0 0" }, t0, sayFor, "linear"),
      seq({ el: "caret", unit: u }, [
        [t0, { opacity: 0 }, "brand"],
        [t0 + T.caretIn, { opacity: 1 }],
        [said, { opacity: 1 }, "brand"],
        [said + T.caretOut, { opacity: 0 }],
      ]),
    );
    LEVELS.forEach((levels, bar) => {
      const pts: Point[] = levels.map((y, k) => [t0 + (k / (levels.length - 1)) * sayFor, { scale: `1 ${y}` }, "sine"]);
      pts[pts.length - 1][2] = "brand";
      pts.push([said + T.caretOut, { scale: "1 0.15" }]);
      tracks.push(seq({ el: "bar", unit: u, bar }, pts));
    });
    RISE.forEach((y, k) =>
      postPts[post].push([t0 + (k / (RISE.length - 1)) * sayFor, { scale: `1 ${y}`, opacity: k === 0 ? 0 : 1 }, "sine"]),
    );
    return said;
  };

  let handoff: number;
  let travel = 0;
  let rail = 0;
  if (parts.some((p) => p.k === "new")) {
    // “Cleo keep”: the kept take rings, the next scene comes in.
    const said = say(0, 0, 0);
    tracks.push(
      seq({ el: "ring" }, [
        [said - T.markLead, { opacity: 0 }, "brand"],
        [said - T.markLead + T.ringIn, { opacity: 1 }, "ease"],
        [said - T.markLead + T.ringIn + T.ringOut, { opacity: 0 }],
      ]),
      tween({ el: "newClip" }, { translate: "-100% 0" }, { translate: "0 0" }, said, T.newIn, "brand"),
      tween({ el: "newPiece" }, { translate: "100% 0" }, { translate: "0 0" }, said, T.newIn, "brand"),
      tween({ el: "ghost" }, { opacity: 1 }, { opacity: 0 }, said + T.ghostAfter, T.ghostOut, "ease"),
    );
    handoff = said + T.keepHandoff;
  } else {
    const gi = parts.findIndex((p) => p.k === "gone");
    const movers = parts.length - gi - 1;
    const w = goneWidth;
    let said: number;
    if (pair) {
      const stopSaid = say(0, 0, 0);
      // The skipped speech: the hatch grows out of the stop post at the
      // speed of time, rightward; “Cleo go” is said as it arrives.
      tracks.push(
        tween({ el: "hatchClip" }, { translate: "-100% 0" }, { translate: "0 0" }, stopSaid, T.skip, "linear"),
        tween({ el: "hatch" }, { translate: "100% 0" }, { translate: "0 0" }, stopSaid, T.skip, "linear"),
      );
      said = say(1, 1, stopSaid + T.skip - T.goLead);
    } else {
      said = say(0, 0, 0);
      // Out of the post: leftward when the post is after the piece.
      const from = postIdx[0] > gi ? 1 : -1;
      tracks.push(
        tween({ el: "hatchClip" }, { translate: `${from * 100}% 0` }, { translate: "0 0" }, said - T.markLead, T.mark, "brand"),
        tween({ el: "hatch" }, { translate: `${-from * 100}% 0` }, { translate: "0 0" }, said - T.markLead, T.mark, "brand"),
      );
    }
    const liftAt = said + T.liftAfter;
    tracks.push(tween({ el: "gone" }, { translate: "0 0" }, { translate: "0 -2px" }, liftAt, T.lift, "brand"));

    const closeAt = said + T.closeAfter;
    travel = travelFor(w, movers, pair);
    const samples = closeSamples(w, travel);
    tracks.push({
      target: { el: "gone" },
      delay: closeAt,
      duration: T.close,
      frames: samples.map((s, i) => ({
        offset: i / SAMPLES,
        transform: `perspective(${PERSPECTIVE}px) rotateY(${deg(s.theta)})`,
        opacity: Number(s.opacity.toFixed(4)),
      })),
    });
    if (movers) {
      tracks.push({
        target: { el: "movers" },
        delay: closeAt,
        duration: T.close,
        frames: samples.map((s, i) => ({ offset: i / SAMPLES, translate: `${px(-s.shift)} 0` })),
      });
    }
    // Where the strip got shorter: a dashed rail at its end (the strip
    // keeps its length; the empty end reads as a shorter video).
    rail = movers ? travel - GAP : w;
    tracks.push(seq({ el: "rail" }, [[closeAt, { opacity: 0 }, "ease"], [closeAt + T.rail, { opacity: 1 }]]));

    // The landed post is the one marker: it flares once.
    const sealAt = closeAt + springTime(SEAL_P);
    postPts[pair ? 1 : 0].push(
      [sealAt, { scale: "1 1", opacity: 1 }, "brand"],
      [sealAt + T.sealUp, { scale: "1 1.32", opacity: 1 }, "ease"],
      [sealAt + T.sealUp + T.sealDown, { scale: "1 1", opacity: 1 }],
    );
    handoff = closeAt + springTime(HANDOFF_P);
  }
  postPts.forEach((pts, post) => {
    if (pts.length) tracks.push(seq({ el: "post", post }, pts));
  });
  const end = Math.max(...tracks.map((t) => t.delay + t.duration));
  return { tracks, handoff: Math.round(handoff), end, travel, rail };
}
