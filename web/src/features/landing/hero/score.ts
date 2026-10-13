/**
 * The hero loop's score: the recording's pieces on the tape, its command
 * posts, and the steps that tell the headline in two acts, played as one
 * continuous film.
 *
 * Act 1, "You talk": a playhead records across the tape at the speed of
 * time; each spoken command flags where it was said and leaves its post
 * there, left to right: “Cleo start”, “Cleo cut” after the bad take,
 * “Cleo keep” at the end of the first good scene, “Cleo stop” … “Cleo go”
 * around the skipped sentence, “Cleo finish”, where the playhead lands.
 * Act 2, "Cleo cuts": Cleo reads the recording once (a scan line runs
 * across it, every post it passes pulses and everything that goes is
 * hatched behind it); then the bad take, a filler word, a pause and the
 * skipped sentence lift off one by one, a little faster each time, and
 * the tape closes behind each, leaving a thin cut marker; then the bits
 * before “Cleo start” and after “Cleo finish” go. Keep removes nothing:
 * its post stays as a green seam, and the scene it starts is sealed as
 * kept once the pause after the post has gone. A render head runs over
 * the kept tape, and as it lands on “Cleo finish” the 9:16 video lights
 * up and its captions play.
 *
 * Widths are in % of the tape (they add up to 100). Every removal is a
 * translate of the pieces after it (never a width change). The *_MS
 * timings the stage's CSS shares are set on it as custom properties
 * (TakeStrip), so the steps below and the motion cannot drift apart.
 */
import type { CmdId } from "../shared";

export type PieceId = "pre" | "bad" | "a" | "um" | "b" | "pause" | "c" | "skip" | "d" | "post";
export type PostId = "start" | "cut" | "keep" | "stop" | "go" | "finish";
export type LegendId = "take" | "fillers" | "pauses" | "skip" | "captions";
export type FlagId =
  | "start"
  | "cut"
  | "keep"
  | "stop"
  | "stopgo"
  | "finish"
  | "cutTake"
  | "um"
  | "pause"
  | "skip"
  | "trimStart"
  | "trimFinish";

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

/* ── Motion the steps rely on (ms; the stage's CSS reads the same values) ── */

/** A removal: the piece lifts off (transform; its opacity fades over the
 *  second half), and the lanes after it close starting while it is half
 *  gone. */
export const LIFT_MS = 480;
export const CLOSE_DELAY_MS = 220;
export const CLOSE_MS = 440;
/** Removals that lift later than their step starts: the tail goes just
 *  after the head of the tape, so the eye can follow both. */
export const LIFT_DELAY: Partial<Record<PieceId, number>> = { post: 120 };
/** “Cleo reads”: the scan line's run across the whole tape (linear, a
 *  playhead), and what it sets off where it passes: a removal's hatch
 *  wipes in, a post pulses. */
export const SCAN_MS = 560;
export const MARK_MS = 200;
export const PULSE_MS = 200;
/** The render head's run over the kept tape (linear) and each kept
 *  piece's glint as it passes. */
export const RENDER_MS = 480;
export const GLINT_MS = 240;
/** The raw tape coming back after the seam: each piece slides in, left
 *  to right. */
export const PIECE_IN_MS = 280;
export const PIECE_STAGGER_MS = 24;

export type Phase = "talk" | "edit" | "ready";

export type Step = {
  /** How long the step holds. A play step lasts as long as its sentence instead (TakeStrip). */
  ms: number;
  phase?: Phase;
  /** The loop's seam, one event in one direction: everything leaves
   *  together ("out"), swaps back to raw while invisible ("snap"), and
   *  the raw pieces slide in ("in"). */
  fade?: "out" | "snap" | "in";
  /** The recording playhead: runs linearly across the tape during Act 1,
   *  then lands on the finish post. */
  head?: "run" | "end";
  /** Where the playhead is at the end of the step (% of the tape); it
   *  runs there from where the step before left it. */
  to?: number;
  /** The violet sweep over the tape: Cleo reading the recording, or the
   *  render head running over the kept tape. */
  sweep?: "read" | "render";
  /** The chip over the tape this step. */
  flag?: FlagId;
  /** The post that flares this step. */
  flash?: PostId;
  /** Removals hatched as about to go. */
  mark?: PieceId[];
  gone: PieceId[];
  /** The 9:16 video: dimmed raw monitor, or lit with its captions. */
  frame: "raw" | "lit";
  /** The payoff: the video lights up because the edit landed. */
  reveal?: boolean;
  /** Captions play from their first word during this step. */
  play?: boolean;
  /** The video's scrub head: filling with the captions, or held full
   *  until it is hidden (it goes back to empty only while invisible). */
  scrub?: "run" | "full";
  li?: LegendId;
  done: LegendId[];
};

const ALL_GONE: PieceId[] = ["pre", "bad", "um", "pause", "skip", "post"];
const ALL_DONE: LegendId[] = ["take", "fillers", "pauses", "skip", "captions"];
const EDITED: LegendId[] = ["take", "fillers", "pauses", "skip"];

/** The settled result: the first frame, the reduced-motion still, where every loop ends. */
export const FINISHED: Step = { ms: 0, phase: "ready", gone: ALL_GONE, frame: "lit", done: ALL_DONE };

/** Where the playhead waits: the start post, where Act 1 begins. */
export const HEAD_FROM = AT.bad;
/** The playhead's run from “Cleo start” to “Cleo finish” (ms). Linear,
 *  so each post is reached at its seam and a command's chip holds until
 *  the next is said: 50 ms per % of the tape, which keeps the shortest
 *  chip (13 %) readable. One clock drives it (TakeStrip); the steps
 *  follow it. */
export const HEAD_MS = 4500;
/** When the playhead reaches `x` % (ms after it set off from HEAD_FROM). */
export function headAt(x: number): number {
  return Math.round(((x - HEAD_FROM) / (AT.post - HEAD_FROM)) * HEAD_MS);
}

/** The playhead's landing on “Cleo finish”: it stretches and fades into
 *  the post as the post flares (ms). Its chip stays through the read. */
const LAND_MS = 320;
/** The read: the scan, then the last wipe and pulse at the far end. */
const READ_MS = SCAN_MS + Math.max(MARK_MS, PULSE_MS);

/** Act 1, one step per post: the playhead reaches it, its post flares and
 *  its chip shows, and the playhead runs on to the next post. */
function talk(flag: FlagId, post: PostId): Step {
  const n = POSTS.findIndex((p) => p.id === post);
  const here = POSTS[n].at;
  const next = POSTS[n + 1]?.at;
  return {
    ms: next === undefined ? LAND_MS : headAt(next) - headAt(here),
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

/** Act 2, one removal per step: everything is already marked by the
 *  read, so each step only lifts, at a rhythm that teaches the first
 *  and then speeds up. */
function lift(ms: number, flag: FlagId, gone: PieceId[], li: LegendId, done: LegendId[]): Step {
  return { ms, phase: "edit", flag, mark: ALL_GONE, gone, frame: "raw", li, done };
}

export const STEPS: Step[] = [
  // First load only: the result holds, then its captions play.
  { ...FINISHED, ms: 600 },
  { ...FINISHED, ms: 3800, play: true, scrub: "run", li: "captions" },
  // The loop: hold the played result, then start over.
  { ...FINISHED, ms: 600, scrub: "full" },
  { ...FINISHED, ms: 320, fade: "out", scrub: "full" },
  { ms: 40, fade: "snap", gone: [], frame: "raw", done: [] },
  { ms: 520, fade: "in", phase: "talk", gone: [], frame: "raw", done: [] },
  // Act 1: You talk.
  talk("start", "start"),
  talk("cut", "cut"),
  talk("keep", "keep"),
  talk("stop", "stop"),
  talk("stopgo", "go"),
  talk("finish", "finish"),
  // Act 2: Cleo cuts. She reads it once and marks what goes…
  { ms: READ_MS, phase: "edit", sweep: "read", flag: "finish", mark: ALL_GONE, gone: [], frame: "raw", done: [] },
  // …then lifts it, faster each time. The legend item lands with the lift.
  lift(620, "cutTake", ["bad"], "take", []),
  lift(520, "um", ["bad", "um"], "fillers", ["take"]),
  // The pause after “Cleo keep” lifts; the post stays and the next scene closes up to it.
  lift(480, "pause", ["bad", "um", "pause"], "pauses", ["take", "fillers"]),
  lift(460, "skip", ["bad", "um", "pause", "skip"], "skip", ["take", "fillers", "pauses"]),
  // The ends: before “Cleo start”, then (LIFT_DELAY) after “Cleo finish”.
  { ms: 600, phase: "edit", flag: "trimStart", flash: "start", mark: ALL_GONE, gone: ALL_GONE, frame: "raw", done: EDITED },
  // The render head runs over the kept tape to “Cleo finish”…
  { ms: RENDER_MS, phase: "edit", sweep: "render", flag: "trimFinish", gone: ALL_GONE, frame: "raw", done: EDITED },
  // …and as it lands the video lights up and its captions play from the first word.
  {
    ...FINISHED,
    ms: 3800,
    sweep: "render",
    flash: "finish",
    reveal: true,
    play: true,
    scrub: "run",
    li: "captions",
    done: EDITED,
  },
];

/** The first step after hydration: the finished frame holds, then its captions play. */
export const FIRST = 0;

/** Where the loop goes on after its last step: the hold after the captions. */
export const LOOP_FROM = 2;

/* ── Chips ── */

/** The flag's target on the tape: a post, or the middle of a piece. */
export const FLAG_TARGET: Record<FlagId, { post: PostId } | { piece: PieceId }> = {
  start: { post: "start" },
  cut: { post: "cut" },
  keep: { post: "keep" },
  stop: { post: "stop" },
  stopgo: { post: "go" },
  finish: { post: "finish" },
  cutTake: { piece: "bad" },
  um: { piece: "um" },
  pause: { piece: "pause" },
  skip: { piece: "skip" },
  trimStart: { piece: "pre" },
  trimFinish: { post: "finish" },
};

/** Act 2's flags; the rest are Act 1's. Each act has one chip. */
const ACT2: ReadonlySet<FlagId> = new Set(["cutTake", "um", "pause", "skip", "trimStart", "trimFinish"]);
export const chipAct = (f: FlagId): 1 | 2 => (ACT2.has(f) ? 2 : 1);

/** Where a flag's chip points (% of the tape): its target once this
 *  step's removals have closed up, so a chip never aims where a moving
 *  lane happens to be. */
export function flagAt(f: FlagId, gone: ReadonlySet<PieceId>): number {
  const t = FLAG_TARGET[f];
  if ("post" in t) {
    const at = POSTS.find((p) => p.id === t.post)!.at;
    return at - shiftAt(at, gone);
  }
  const p = PIECES.find((q) => q.id === t.piece)!;
  return AT[p.id] + p.g / 2 - shiftAt(AT[p.id], gone);
}

export type ChipView = {
  act: 1 | 2;
  /** Two stacked labels the chip crossfades between: the one showing
   *  (`on`) and the one it just left. */
  slots: [FlagId | undefined, FlagId | undefined];
  on: 0 | 1;
  /** The act is over: it fades out where it is. */
  leaving: boolean;
};

/** The chips at step `i`: the act's one chip, travelling from flag to
 *  flag, and the previous act's for the one step it takes to leave. */
export function chipsAt(i: number): ChipView[] {
  const out: ChipView[] = [];
  const actOf = (n: number) => {
    const f = n >= 0 ? STEPS[n].flag : undefined;
    return f ? chipAct(f) : undefined;
  };
  for (const act of [1, 2] as const) {
    const here = actOf(i) === act;
    if (!here && actOf(i - 1) !== act) continue;
    const last = here ? i : i - 1;
    let first = last;
    while (actOf(first - 1) === act) first--;
    const seq: FlagId[] = [];
    for (let n = first; n <= last; n++) {
      const f = STEPS[n].flag!;
      if (seq[seq.length - 1] !== f) seq.push(f);
    }
    const k = seq.length - 1;
    const on: 0 | 1 = k % 2 === 0 ? 0 : 1;
    const slots: [FlagId | undefined, FlagId | undefined] = [undefined, undefined];
    slots[on] = seq[k];
    slots[on === 0 ? 1 : 0] = seq[k - 1];
    out.push({ act, slots, on, leaving: !here });
  }
  return out;
}

/* ── The rest of the stage ── */

/** What the status line names below 1280px: in Act 2 the removal being
 *  made, then the last one made until the next replaces it (never back
 *  to the phase between two); otherwise (undefined) the phase. */
export function statusOf(s: Step): LegendId | undefined {
  return s.phase === "edit" ? (s.li ?? s.done[s.done.length - 1]) : undefined;
}

/** “Cleo keep”'s answer, made visible: once the removal right after its
 *  post (`when`) has lifted and the take after it (`piece`) has closed
 *  up to the post, that take is sealed as kept. */
export const SEAL: { piece: PieceId; when: PieceId } = (() => {
  const keep = POSTS.find((p) => p.id === "keep")!.at;
  return {
    piece: PIECES.find((p) => p.kind === "take" && AT[p.id] > keep)!.id,
    when: PIECES.find((p) => AT[p.id] === keep)!.id,
  };
})();

/** When the render head reaches a kept piece's start, as a share of its
 *  run (0 at “Cleo start”, 1 at “Cleo finish”). */
export function renderAt(id: PieceId): number {
  const gone = new Set<PieceId>(ALL_GONE);
  return (AT[id] - shiftAt(AT[id], gone)) / keptLength(gone);
}
