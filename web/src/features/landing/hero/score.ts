/**
 * The hero loop's score: the recording's pieces on the tape, its command
 * posts, and the steps that tell the headline in two acts.
 *
 * Act 1, "You talk": a playhead records across the tape; each spoken
 * command flags where it was said. Act 2, "Cleo edits": the bad take,
 * a filler word, a pause and the skipped sentence each get marked, lift
 * off and the tape closes behind them, leaving a thin cut marker; then
 * the bits before “Cleo start” and after “Cleo finish” go. The recording
 * is now visibly shorter; the 9:16 video lights up and its captions play.
 *
 * Widths are in % of the tape (they add up to 100). Every removal is a
 * translate of the pieces after it (never a width change).
 */
import type { CmdId } from "../shared";

export type PieceId = "pre" | "bad" | "a" | "um" | "b" | "pause" | "skip" | "c" | "post";
export type PostId = "start" | "cut" | "stop" | "go" | "finish";
export type LegendId = "take" | "fillers" | "pauses" | "skip" | "captions";
export type FlagId = "start" | "cut" | "stop" | "stopgo" | "finish" | "cutTake" | "um" | "pause" | "skip";

export type Piece = {
  id: PieceId;
  g: number;
  /** How it looks: a take, a filler word, a pause, or removed by a command. */
  kind: "take" | "filler" | "pause" | "cmd";
  /** The command that removes it (its colour). */
  cmd?: CmdId;
};

export const PIECES: Piece[] = [
  { id: "pre", g: 5, kind: "cmd", cmd: "start" },
  { id: "bad", g: 17, kind: "cmd", cmd: "cut" },
  { id: "a", g: 15, kind: "take" },
  { id: "um", g: 6, kind: "filler" },
  { id: "b", g: 12, kind: "take" },
  { id: "pause", g: 8, kind: "pause" },
  { id: "skip", g: 13, kind: "cmd", cmd: "stop" },
  { id: "c", g: 19, kind: "take" },
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

/** Posts sit on the seams; cut, stop and go leave with the piece they end. */
export const POSTS: { id: PostId; at: number; cmd: CmdId; leavesWith?: PieceId }[] = [
  { id: "start", at: AT.bad, cmd: "start" },
  { id: "cut", at: AT.a, cmd: "cut", leavesWith: "bad" },
  { id: "stop", at: AT.skip, cmd: "stop", leavesWith: "skip" },
  { id: "go", at: AT.c, cmd: "go", leavesWith: "skip" },
  { id: "finish", at: AT.post, cmd: "finish" },
];

/** Removals that leave a cut marker (the ends are simply trimmed). */
export const MARKED: { id: PieceId; tone: "cut" | "neutral" | "stopgo" }[] = [
  { id: "bad", tone: "cut" },
  { id: "um", tone: "neutral" },
  { id: "pause", tone: "neutral" },
  { id: "skip", tone: "stopgo" },
];

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
  ms: number;
  phase?: Phase;
  /** Fade the whole tape out, swap it back to raw without transitions, fade it in. */
  fade?: "out" | "snap" | "in";
  /** The recording playhead: runs linearly across the tape during Act 1. */
  head?: "run" | "end";
  flag?: FlagId;
  /** The post that flares this step. */
  flash?: PostId | "ends";
  mark?: PieceId[];
  gone: PieceId[];
  /** The 9:16 video: dimmed raw monitor, or lit with its captions. */
  frame: "raw" | "lit";
  /** Captions play (from their first word) during this step. */
  play?: boolean;
  li?: LegendId;
  done: LegendId[];
};

const ALL_GONE: PieceId[] = ["pre", "bad", "um", "pause", "skip", "post"];
const ALL_DONE: LegendId[] = ["take", "fillers", "pauses", "skip", "captions"];

/** The settled result: the first frame, the reduced-motion still, the loop's last hold. */
export const FINISHED: Step = { ms: 0, phase: "ready", gone: ALL_GONE, frame: "lit", done: ALL_DONE };

/** When the playhead crosses each post, from the start of Act 1 (ms). */
export const HEAD_MS = 3600;
const headAt = (x: number) => Math.round(((x - AT.bad) / (AT.post - AT.bad)) * HEAD_MS);

const talk = (flag: FlagId, flash: PostId, ms: number): Step => ({
  ms,
  phase: "talk",
  head: flag === "finish" ? "end" : "run",
  flag,
  flash,
  gone: [],
  frame: "raw",
  done: [],
});

export const STEPS: Step[] = [
  // The result plays once more, then the loop starts over.
  { ...FINISHED, ms: 600 },
  { ...FINISHED, ms: 3800, play: true, li: "captions" },
  { ...FINISHED, ms: 1200 },
  { ...FINISHED, ms: 260, fade: "out" },
  { ms: 60, fade: "snap", gone: [], frame: "raw", done: [] },
  { ms: 560, fade: "in", phase: "talk", gone: [], frame: "raw", done: [] },
  // Act 1: You talk.
  talk("start", "start", headAt(AT.a) - headAt(AT.bad)),
  talk("cut", "cut", headAt(AT.skip) - headAt(AT.a)),
  talk("stop", "stop", headAt(AT.c) - headAt(AT.skip)),
  talk("stopgo", "go", headAt(AT.post) - headAt(AT.c)),
  talk("finish", "finish", 700),
  // Act 2: Cleo edits. Mark and hold, then lift and close.
  { ms: 620, phase: "edit", flag: "cutTake", mark: ["bad"], gone: [], frame: "raw", li: "take", done: [] },
  { ms: 720, phase: "edit", gone: ["bad"], frame: "raw", li: "take", done: [] },
  { ms: 620, phase: "edit", flag: "um", mark: ["um"], gone: ["bad"], frame: "raw", li: "fillers", done: ["take"] },
  { ms: 720, phase: "edit", gone: ["bad", "um"], frame: "raw", li: "fillers", done: ["take"] },
  { ms: 620, phase: "edit", flag: "pause", mark: ["pause"], gone: ["bad", "um"], frame: "raw", li: "pauses", done: ["take", "fillers"] },
  { ms: 720, phase: "edit", gone: ["bad", "um", "pause"], frame: "raw", li: "pauses", done: ["take", "fillers"] },
  {
    ms: 620,
    phase: "edit",
    flag: "skip",
    mark: ["skip"],
    gone: ["bad", "um", "pause"],
    frame: "raw",
    li: "skip",
    done: ["take", "fillers", "pauses"],
  },
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
  // Ready to post: the video lights up (its captions play in the first step).
  { ...FINISHED, ms: 700, done: ["take", "fillers", "pauses", "skip"], li: "captions" },
];

/** The first step after hydration: the finished frame holds, then its captions play. */
export const FIRST = 0;
