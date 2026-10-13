/**
 * The bonus clips' captions (BonusClips.tsx): the style the three tiles
 * share, the clock each caption loops on and how it steps on the
 * section's ticker. No React, so the section and its tests
 * (clipCaptions.test.ts: every line fits on one caption page in every
 * language) use the same choices.
 */
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import { presetSupport } from "@/lib/captions/scripts";
import type { PresetId } from "@/lib/captions/types";
import { FIRST_WORD_AT } from "../captions/words";

/** One caption style for the three clips: Power where the language's
 *  script has it, else the first style that renders it natively. */
export function clipPreset(lang: string): PresetId | null {
  if (presetSupport("power", lang).level !== "unavailable") return "power";
  const native = LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level === "native");
  return native ?? LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? null;
}

/** How long a tile's clip loops (scene/clips.ts: 6 s each), for a
 *  caption whose video does not know its length yet. */
export const CLIP_LOOP_S = 6;
/** Before its video first plays, a caption waits this long for it (s):
 *  the clip is usually about to start as its tile lands. */
export const WAIT_S = 0.5;
/** A video that starts this far behind its caption (s, a frame at
 *  25 fps) jumps to the caption instead. */
export const JOIN_S = 0.04;

/** What a tile's <video> is doing on this frame. */
export type ClipVideo = {
  /** It has a source (it is loading or loaded; none under data saver). */
  src: boolean;
  /** It has a frame on show (readyState >= HAVE_CURRENT_DATA). */
  frame: boolean;
  playing: boolean;
  /** currentTime and duration (s; NaN until its metadata). */
  time: number;
  duration: number;
};

/** A tile caption's clock. */
export type ClipClock = {
  /** The caption's time (s from its lead-in). */
  t: number;
  /** It follows its video (the video has played since the clock started). */
  synced: boolean;
  /** How long it has waited for its video to play (s). */
  waited: number;
  /** It played once and settled while the clips could not move. */
  done: boolean;
};

export function clipClock(): ClipClock {
  return { t: 0, synced: false, waited: 0, done: false };
}

/**
 * One frame of a looping caption's clock (mutates `clock`).
 *
 * A playing video leads: the caption takes its time, so every time the
 * clip loops the line starts again, and a stall or a pause holds both
 * (`held`: a paused video, nothing moves until it plays again). Before
 * the video first plays the caption waits for it a moment (WAIT_S), then
 * goes on without it, on its own clock with the clip's length (data
 * saver, a refused autoplay, a slow load), as it does when its video
 * goes away. A video that only starts then is behind the caption: it
 * jumps to the caption (`seek`), so the words never start over mid-line.
 */
export function tickClipClock(clock: ClipClock, dt: number, video: ClipVideo | null): { seek: number | null; held: boolean } {
  if (video?.frame && video.playing) {
    let seek: number | null = null;
    if (!clock.synced) {
      clock.synced = true;
      if (clock.t - video.time > JOIN_S) seek = clock.t;
    }
    clock.t = seek ?? video.time;
    return { seek, held: false };
  }
  // With its video: paused, or a frame away (seeking at its loop, a
  // stall), it waits for it.
  if (clock.synced && video?.src) return { seek: null, held: video.frame };
  clock.synced = false;
  if (video?.src && clock.waited < WAIT_S) {
    clock.waited += dt;
    return { seek: null, held: false };
  }
  const loop = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : CLIP_LOOP_S;
  clock.t = (clock.t + dt) % loop;
  return { seek: null, held: false };
}

/** Where a paused caption stands: where it stopped, but on the lead-in
 *  before its first word (nothing drawn yet: between two loops, or its
 *  tile came up while paused) it shows the whole sentence (`end`). */
export function pausedAt(t: number, end: number): number {
  return t < FIRST_WORD_AT ? end : t;
}

/** What the section knows about a tile's caption on this frame. */
export type ClipCaptionState = {
  /** The clips can move (no data saver, no 2G-class connection). */
  loops: boolean;
  /** The pause control holds them. */
  paused: boolean;
  video: ClipVideo | null;
  /** The caption's length (s: its last word and hold). */
  end: number;
};

/**
 * One frame of a tile's caption once its tile is up (mutates `clock`):
 * the time it shows (`at`), where its video jumps (`seek`) and whether
 * it still moves (`busy`: the ticker stops once none does).
 *
 * Where the clips cannot move, the line plays once on its own clock and
 * settles on the whole sentence, paused or not: no control is left to
 * resume it, so it must not hold on half a sentence. Once they can move
 * again, a settled line starts over with its clip (which loads again
 * from its first frame) and a line still under way joins it as a late
 * video does. Otherwise the pause control holds it (pausedAt) and its
 * clip leads (tickClipClock).
 */
export function stepClipCaption(
  clock: ClipClock,
  dt: number,
  now: ClipCaptionState,
): { at: number; seek: number | null; busy: boolean } {
  if (!now.loops) {
    // Its clip is unloaded: nothing to follow until it comes back.
    clock.synced = false;
    if (!clock.done) {
      clock.t += dt;
      clock.done = clock.t >= now.end;
    }
    return { at: clock.done ? now.end : clock.t, seek: null, busy: !clock.done };
  }
  if (clock.done) Object.assign(clock, clipClock());
  if (now.paused) return { at: pausedAt(clock.t, now.end), seek: null, busy: false };
  const step = tickClipClock(clock, dt, now.video);
  return { at: clock.t, seek: step.seek, busy: !step.held };
}
