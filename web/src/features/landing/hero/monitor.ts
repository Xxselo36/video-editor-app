/**
 * The hero's monitor (Monitor.tsx), its timing: the 9:16 frame shows the
 * raw take (scene/clips.ts, clip "heroRaw") wherever the tape is.
 *
 * The tape is the recording. The playhead's run from “Cleo start” to
 * “Cleo finish” is the whole raw take, so in Act 1 the frame plays it in
 * lockstep with the playhead, about 3.7 times as fast; before the run it
 * waits on the take's first frame, after it on the last. In Act 2 each
 * removal that lifts off the tape flashes its removed moment, and the
 * frame jump-cuts to the first frame of the kept take after it. The
 * finished video (hero.mp4) is the same picture graded: most of it is
 * the raw take's start, frame for frame (SHARED), so the seam can drain
 * the grade from the frame on screen and the render head can wipe it
 * back across one held frame.
 *
 * What it needs of the score (hero/score.ts) is handed in (timingOf),
 * never imported: this module is in the monitor's lazy chunk, and a
 * module that both the first load and a lazy chunk import is moved into
 * a shared chunk, which costs the first load about 0.4 KB. Pure, so the
 * tests can hold it to the score.
 */
import type * as ScoreModule from "./score";
import type { PieceId, Step } from "./score";

/** What the monitor reads of the score. */
export type Score = Pick<
  typeof ScoreModule,
  "AT" | "PIECES" | "FINISHED" | "HEAD_FROM" | "HEAD_MS" | "CLOSE_DELAY_MS" | "RENDER_MS"
>;

/** The raw take's length (s). */
export const RAW_S = 16.8;
/** The finished video's length (hero.mp4, s): the Scene loops it. */
export const HERO_S = 6;
/** Where the finished video shows the raw take's own frames, graded (s
 *  on both). It ends where hero.mp4's last 0.4 s fade into its first
 *  frame (so it loops) while the raw take plays on into another pose.
 *  It starts at 0: the raw take's first 0.4 s fade in from its last
 *  moments, which hold the same calm pose, so a seam there shows no
 *  second image (checked on the blended frames). */
export const SHARED: readonly [from: number, to: number] = [0, 5.6];
/** The seam's drain: the raw take fades in over the Scene (ms; the seam
 *  step's length, and Monitor.module.css's transition). */
export const SEAM_MS = 320;
/** A drain may start this much later than cued (s): the take's seek to
 *  the Scene's frame, when the cue missed it. */
const SEAM_LATE = 0.1;

/** Whether the seam drains the grade from a Scene at `t` (s on
 *  hero.mp4): only if the whole drain stays where both takes show the
 *  same frame. Otherwise (the finished video's own loop, or its wrap
 *  back to its start) the Scene plays the seam out graded, under the
 *  scrim, and the take takes over unseen at the snap, from a still of
 *  the Scene's frame. */
export function drains(t: number): boolean {
  return t >= SHARED[0] && t + SEAM_MS / 1000 + SEAM_LATE <= SHARED[1];
}

/** The moment each removal shows as it lifts (s on the raw take), picked
 *  from the footage: the bad take's big two-hand gesture, the filler and
 *  the pause's hands resting, the skipped sentence's glance away, and for
 *  the bit before “Cleo start” the wait itself (the take's first frame).
 *  The bit after “Cleo finish” is the frame already on screen: no flash. */
const FLASH_AT: Partial<Record<PieceId, number>> = { pre: 0, bad: 1.6, um: 6.2, pause: 9.3, skip: 12.8 };

export type Cut = {
  id: PieceId;
  /** The removed moment the frame flashes (s). */
  at: number;
  /** Where the jump cut lands: the next kept take's first frame (s). */
  to: number;
  /** The head trim: it lands on the finished video's first frame and
   *  holds it for the render (the others play the take on at 1x). */
  hold: boolean;
};

export type Cue =
  /** The hold before the seam: the raw take waits where the finished
   *  video will be when the seam starts (`ms` from now). */
  | { kind: "prime"; ms: number }
  /** The seam: the grade drains from the frame while the tape fades out. */
  | { kind: "seam" }
  /** Unseen tape: the take goes back to its first frame, as a dissolve. */
  | { kind: "snap" }
  /** Act 1: the take follows the playhead, fast. */
  | { kind: "follow" }
  /** Cleo reads: the take holds its last frame, the fast-forward goes. */
  | { kind: "read" }
  /** A removal lifts: its moment flashes, then the jump cut. */
  | { kind: "cut"; cut: Cut }
  /** The render head runs: the grade wipes across the held frame. */
  | { kind: "render" }
  /** The finished video takes over. */
  | { kind: "reveal" };

export type Timing = ReturnType<typeof timingOf>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ── Following the playhead ── */

/** Further off than this (s), the take jumps (a resume, a dropped decode);
 *  closer, only its speed is steered, so the motion never stutters. */
const SEEK_OFF = 1.2;
/** A jump lands this far ahead of the playhead (s), which then catches up. */
const SEEK_LEAD = 0.3;
/** In step. The two clocks are read a display frame apart, up to about
 *  ±0.06 s of the take at its speed, so a drift is only corrected once
 *  it is further off than DRIFT (s); a correction keeps its speed until
 *  the take is back within IN_STEP, or has passed the playhead. One
 *  change starts it, one ends it: the clocks' jitter never flutters the
 *  speed (each change costs the decoder a little). */
const DRIFT = 0.12;
const IN_STEP = 0.04;
/** A correction's speed: a share of the base per second off, and its limit. */
const GAIN = 0.8;
const MAX_STEER = 0.5;
/** While correcting, the speed is set again only once it is this far
 *  (a share of the base) from what the error now asks for. */
const RESTEER = 0.15;

/** One step of the raw take following the playhead at `base` speed: the
 *  speed to set and, only when far off, where to jump. Empty when
 *  nothing changes. A `rate` other than `base` is a correction under way. */
export function steer(target: number, at: number, rate: number, base: number): { rate?: number; seek?: number } {
  const err = target - at;
  const correcting = Math.abs(rate - base) > 1e-6;
  if (Math.abs(err) > SEEK_OFF) {
    return { seek: Math.min(target + SEEK_LEAD, RAW_S - 0.1), ...(correcting ? { rate: base } : {}) };
  }
  if (!correcting) {
    if (Math.abs(err) <= DRIFT) return {};
  } else if (Math.abs(err) <= IN_STEP || err * (rate - base) < 0) {
    return { rate: base };
  }
  const want = base * (1 + clamp(err * GAIN, -MAX_STEER, MAX_STEER));
  return !correcting || Math.abs(want - rate) > base * RESTEER ? { rate: want } : {};
}

/** The raw take's running timecode, as m:ss. */
export function timecode(s: number): string {
  const n = Math.max(0, Math.floor(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

/** The monitor's timing on this score. */
export function timingOf(score: Score) {
  const { AT, PIECES, FINISHED, HEAD_FROM, HEAD_MS, CLOSE_DELAY_MS } = score;
  const kept = (id: PieceId) => !FINISHED.gone.includes(id);

  /** Where the raw take is when the playhead is at `x` % of the tape (s). */
  const rawAt = (x: number) => clamp(((x - HEAD_FROM) / (AT.post - HEAD_FROM)) * RAW_S, 0, RAW_S);

  /** Every removal that flashes, in tape order. */
  const cuts: Cut[] = PIECES.filter((p) => FLASH_AT[p.id] !== undefined).map((p) => {
    const next = PIECES.slice(PIECES.indexOf(p) + 1).find((q) => kept(q.id))!;
    return { id: p.id, at: FLASH_AT[p.id]!, to: rawAt(AT[next.id]), hold: AT[p.id] < HEAD_FROM };
  });

  return {
    rawAt,
    /** Where the raw take is `ms` after the playhead set off from “Cleo
     *  start” (its run is one linear animation: rawAt on its clock). */
    rawAtHead: (ms: number) => clamp(ms / HEAD_MS, 0, 1) * RAW_S,
    /** Its speed while the playhead records: the whole take in one run. */
    rate: RAW_S / (HEAD_MS / 1000),
    /** Where the finished video starts on the raw take: its first kept
     *  take. The ends' trim lands here; the render wipes the grade over it. */
    firstKept: rawAt(AT[PIECES.find((p) => kept(p.id))!.id]),
    cuts,
    /** How long a removed moment shows before the jump (ms): until the
     *  tape starts closing behind its piece. */
    jumpMs: CLOSE_DELAY_MS + 40,
    /** The cues for entering step `s` from `prev` (the step machine's
     *  last step; undefined when the monitor has just mounted). */
    cuesAt(prev: Step | undefined, s: Step): Cue[] {
      const out: Cue[] = [];
      if (s.fade === "out" && prev?.fade !== "out") out.push({ kind: "seam" });
      else if (s.fade === "snap") out.push({ kind: "snap" });
      else if (!s.fade && s.scrub === "full") out.push({ kind: "prime", ms: s.ms });
      if (s.head === "run" && prev?.head !== "run") out.push({ kind: "follow" });
      if (s.sweep === "read" && prev?.sweep !== "read") out.push({ kind: "read" });
      if (s.phase === "edit") {
        const was = new Set(prev?.gone ?? s.gone);
        for (const c of cuts) if (s.gone.includes(c.id) && !was.has(c.id)) out.push({ kind: "cut", cut: c });
      }
      if (s.sweep === "render" && s.frame === "raw") out.push({ kind: "render" });
      if (s.reveal && prev && prev.frame === "raw") out.push({ kind: "reveal" });
      return out;
    },
  };
}
