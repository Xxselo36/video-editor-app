/**
 * The hero loop's score: the recording's pieces on the tape, its command
 * posts, and the steps that tell the headline in two acts.
 *
 * Act 1, "You talk": a playhead records across the tape at the speed of
 * time; each spoken command flags where it was said and leaves its post
 * there, left to right: “Cleo start”, “Cleo cut” after the bad take,
 * “Cleo keep” at the end of the first good scene, “Cleo stop” … “Cleo go”
 * around the skipped sentence, “Cleo finish”. Act 2, "Cleo edits": the
 * bad take, a filler word, a pause and the skipped sentence each get
 * marked, lift off and the tape closes behind them, leaving a thin cut
 * marker; then the bits before “Cleo start” and after “Cleo finish” go.
 * Keep removes nothing: its post stays as a green seam between the two
 * scenes. The recording is now visibly shorter; the 9:16 video lights up
 * and its captions play.
 *
 * Widths are in % of the tape (they add up to 100). Every removal is a
 * translate of the pieces after it (never a width change).
 */
import type { CmdId } from "../shared";

export type PieceId = "pre" | "bad" | "a" | "um" | "b" | "pause" | "c" | "skip" | "d" | "post";
export type PostId = "start" | "cut" | "keep" | "stop" | "go" | "finish";
export type LegendId = "take" | "fillers" | "pauses" | "skip" | "captions";
export type FlagId = "start" | "cut" | "keep" | "stop" | "stopgo" | "finish" | "cutTake" | "um" | "pause" | "skip";

export type Piece = {
  id: PieceId;
  g: number;
  /** How it looks: a take, a filler word, a pause, or removed by a command. */
  kind: "take" | "filler" | "pause" | "cmd";
  /** The command that removes it (its colour). */
  cmd?: CmdId;
};

/** The recording, left to right. A kept take sits between any two marked
 *  removals, so each leaves its own cut marker on the finished tape. The
 *  first scene is the takes a, the filler and b; c and d the second. */
export const PIECES: Piece[] = [
  { id: "pre", g: 5, kind: "cmd", cmd: "start" },
  { id: "bad", g: 17, kind: "cmd", cmd: "cut" },
  { id: "a", g: 13, kind: "take" },
  { id: "um", g: 6, kind: "filler" },
  { id: "b", g: 10, kind: "take" },
  { id: "pause", g: 8, kind: "pause" },
  { id: "c", g: 10, kind: "take" },
  { id: "skip", g: 13, kind: "cmd", cmd: "stop" },
  { id: "d", g: 13, kind: "take" },
  { id: "post", g: 5, kind: "cmd", cmd: "finish" },
];

/** Where each piece starts on the tape (%). */
export const AT: Record<PieceId, number> = (() => {
  let x = 0;
  const at = {} as Record<PieceId, number>;
  for (const p of PIECES) {
    at[p.id] = x;
    x += p.g;
  }
  return at;
})();

export type Post = { id: PostId; at: number; cmd: CmdId; leavesWith?: PieceId };

/** Posts sit on the seams, left to right, in the order they are said; cut,
 *  stop and go leave with the piece they end. Keep confirms the scene
 *  before it and starts the next (after the take that follows the filler,
 *  before the pause), so it never leaves. */
export const POSTS: Post[] = [
  { id: "start", at: AT.bad, cmd: "start" },
  { id: "cut", at: AT.a, cmd: "cut", leavesWith: "bad" },
  { id: "keep", at: AT.pause, cmd: "keep" },
  { id: "stop", at: AT.skip, cmd: "stop", leavesWith: "skip" },
  { id: "go", at: AT.d, cmd: "go", leavesWith: "skip" },
  { id: "finish", at: AT.post, cmd: "finish" },
];

export type Marked = {
  id: PieceId;
  tone: "cut" | "neutral" | "stopgo";
  /** It shares its seam with a post that stays (start, keep), so it sits
   *  just right of the post, not under it. */
  beside: boolean;
};

/** Removals that leave a cut marker (the ends are simply trimmed). */
export const MARKED: Marked[] = (
  [
    { id: "bad", tone: "cut" },
    { id: "um", tone: "neutral" },
    { id: "pause", tone: "neutral" },
    { id: "skip", tone: "stopgo" },
  ] as const
).map((m) => ({ ...m, beside: POSTS.some((p) => !p.leavesWith && p.at === AT[m.id]) }));

/** How far a point at `x` % moves left once `gone` are removed. */
export function shiftAt(x: number, gone: ReadonlySet<PieceId>): number {
  let s = 0;
  for (const p of PIECES) if (gone.has(p.id) && AT[p.id] < x) s += p.g;
  return s;
}

/** The kept length (% of the tape). */
export function keptLength(gone: ReadonlySet<PieceId>): number {
  return PIECES.reduce((n, p) => (gone.has(p.id) ? n : n + p.g), 0);
}

export type Phase = "talk" | "edit" | "ready";

export type Step = {
  /** How long the step holds. A play step lasts as long as its sentence instead (TakeStrip). */
  ms: number;
  phase?: Phase;
  /** Fade the whole tape out, swap it back to raw without transitions, fade it in. */
  fade?: "out" | "snap" | "in";
  /** The recording playhead: runs linearly across the tape during Act 1. */
  head?: "run" | "end";
  /** Where the playhead is at the end of the step (% of the tape); it
   *  runs there from where the step before left it. Unset: it waits at
   *  HEAD_FROM. */
  to?: number;
  flag?: FlagId;
  /** The post that flares this step. */
  flash?: PostId | "ends";
  mark?: PieceId[];
  gone: PieceId[];
  /** The 9:16 video: dimmed raw monitor, or lit with its captions. */
  frame: "raw" | "lit";
  /** Captions play from their first word during this step. */
  play?: boolean;
  li?: LegendId;
  done: LegendId[];
};

const ALL_GONE: PieceId[] = ["pre", "bad", "um", "pause", "skip", "post"];
const ALL_DONE: LegendId[] = ["take", "fillers", "pauses", "skip", "captions"];

/** The settled result: the first frame, the reduced-motion still, where every loop ends. */
export const FINISHED: Step = { ms: 0, phase: "ready", gone: ALL_GONE, frame: "lit", done: ALL_DONE };

/** Where the playhead waits: the start post, where Act 1 begins. */
export const HEAD_FROM = AT.bad;
/** The playhead's run from “Cleo start” to “Cleo finish” (ms). Linear,
 *  so each post is reached at its seam and a command's chip holds until
 *  the next is said: 50 ms per % of the tape, which keeps the shortest
 *  chip (13 %) readable. */
export const HEAD_MS = 4500;
const headAt = (x: number) => Math.round(((x - HEAD_FROM) / (AT.post - HEAD_FROM)) * HEAD_MS);

/** The finish chip's hold once the playhead has reached the end (ms). */
const FINISH_HOLD = 700;

/** Act 1, one step per post: the playhead reaches it, its post flares and
 *  its chip shows, and the playhead runs on to the next post. */
function talk(flag: FlagId, post: PostId): Step {
  const n = POSTS.findIndex((p) => p.id === post);
  const here = POSTS[n].at;
  const next = POSTS[n + 1]?.at;
  return {
    ms: next === undefined ? FINISH_HOLD : headAt(next) - headAt(here),
    phase: "talk",
    head: next === undefined ? "end" : "run",
    to: next ?? here,
    flag,
    flash: post,
    gone: [],
    frame: "raw",
    done: [],
  };
}

export const STEPS: Step[] = [
  // First load only: the result holds, then its captions play.
  { ...FINISHED, ms: 600 },
  { ...FINISHED, ms: 3800, play: true, li: "captions" },
  // The loop: hold the played result, then start over.
  { ...FINISHED, ms: 600 },
  { ...FINISHED, ms: 260, fade: "out" },
  { ms: 60, fade: "snap", gone: [], frame: "raw", done: [] },
  { ms: 560, fade: "in", phase: "talk", gone: [], frame: "raw", done: [] },
  // Act 1: You talk.
  talk("start", "start"),
  talk("cut", "cut"),
  talk("keep", "keep"),
  talk("stop", "stop"),
  talk("stopgo", "go"),
  talk("finish", "finish"),
  // Act 2: Cleo edits. Mark and hold, then lift and close.
  // The legend item lands with the lift, not with the mark.
  { ms: 620, phase: "edit", flag: "cutTake", mark: ["bad"], gone: [], frame: "raw", done: [] },
  { ms: 720, phase: "edit", gone: ["bad"], frame: "raw", li: "take", done: [] },
  { ms: 620, phase: "edit", flag: "um", mark: ["um"], gone: ["bad"], frame: "raw", done: ["take"] },
  { ms: 720, phase: "edit", gone: ["bad", "um"], frame: "raw", li: "fillers", done: ["take"] },
  // The pause after “Cleo keep” lifts; the post stays and the next scene closes up to it.
  { ms: 620, phase: "edit", flag: "pause", mark: ["pause"], gone: ["bad", "um"], frame: "raw", done: ["take", "fillers"] },
  { ms: 720, phase: "edit", gone: ["bad", "um", "pause"], frame: "raw", li: "pauses", done: ["take", "fillers"] },
  { ms: 620, phase: "edit", flag: "skip", mark: ["skip"], gone: ["bad", "um", "pause"], frame: "raw", done: ["take", "fillers", "pauses"] },
  { ms: 720, phase: "edit", gone: ["bad", "um", "pause", "skip"], frame: "raw", li: "skip", done: ["take", "fillers", "pauses"] },
  {
    ms: 620,
    phase: "edit",
    flash: "ends",
    mark: ["pre", "post"],
    gone: ["bad", "um", "pause", "skip"],
    frame: "raw",
    done: ["take", "fillers", "pauses", "skip"],
  },
  { ms: 720, phase: "edit", gone: ALL_GONE, frame: "raw", done: ["take", "fillers", "pauses", "skip"] },
  // Ready to post: the video lights up and its captions play from the first word.
  { ...FINISHED, ms: 3800, play: true, li: "captions", done: ["take", "fillers", "pauses", "skip"] },
];

/** The first step after hydration: the finished frame holds, then its captions play. */
export const FIRST = 0;

/** Where the loop goes on after its last step: the hold after the captions. */
export const LOOP_FROM = 2;
