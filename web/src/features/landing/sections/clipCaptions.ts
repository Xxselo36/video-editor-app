/**
 * The bonus clips' captions (BonusClips.tsx): the style the three tiles
 * share, the clock each caption loops on and how it steps on the
 * section's ticker. No React, so the section and its tests
 * (clipCaptions.test.ts: every line pages into its three phrases, one
 * page each, in every language, and is spoken well before its clip
 * loops) use the same choices.
 */
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import { presetSupport, segmentsWithoutSpaces } from "@/lib/captions/scripts";
import type { PresetId } from "@/lib/captions/types";
import { captionWords, FIRST_WORD_AT, splitPhrases, splitWords, spokenAt } from "../captions/words";

/** One caption style for the three clips: Power where the language's
 *  script has it, else the first style that renders it natively. */
export function clipPreset(lang: string): PresetId | null {
  if (presetSupport("power", lang).level !== "unavailable") return "power";
  const native = LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level === "native");
  return native ?? LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? null;
}

/** A line's first phrase, as its still shows it (the CSS poster, which
 *  draws one [mark]). */
export function firstPhrase(text: string): string {
  return splitPhrases(text)[0] ?? "";
}

/**
 * Where a still of a line stands (s, LiveCaption `still`): its first
 * phrase whole, on its own page, with the [marked] word spoken (karaoke:
 * filled up to it), as the CSS poster draws it. Without a mark, the
 * phrase's last word. Here rather than in words.ts, which is in the
 * hero's first load: only the tiles need it.
 *
 * The word stands at its end, its fill full: a word goes on until the
 * next one starts (an engine page holds after its last word), so only the
 * line's last word must stop short of its end, where LiveCaption stops
 * drawing (spokenAt). A word the engine lights in pieces (firstPiece)
 * stands on its first piece.
 */
export function stillAt(text: string, lang: string): number {
  const words = captionWords(text, lang);
  if (!words.length) return 0;
  const phrase = firstPhrase(text);
  const own = splitWords(phrase, lang);
  const marked = markedIndex(phrase, own);
  const i = marked >= 0 ? marked : Math.max(0, own.length - 1);
  const w = words[i];
  const next = words[i + 1];
  if (!next) return spokenAt(words, i);
  const n = firstPiece(own, i, lang);
  // spoken (lit), until the next piece or word comes up
  const piece = w.start + ((w.end - w.start) * n) / own[i].length;
  const [lit, until] = n < own[i].length ? [piece, piece] : [w.end, next.start];
  // its entrance done
  return Math.min(Math.max(w.start + 0.3, lit), until - 0.02);
}

/**
 * How many of word `i`'s characters the engine lights first. It cuts
 * unspaced text (Japanese, Chinese) into words again (layout.ts
 * segmentChunk): with Intl.Segmenter alone, without the particles and
 * endings words.ts joins to the word before, so a word may light in
 * pieces (試して: 試し, then て), each timed by its characters. The same
 * cuts as there: punctuation sticks to the piece before it, and a leading
 * one to the word after it. A spaced word lights whole. (The poster
 * lights a marked word whole, so the copy marks words the layout keeps
 * whole; the test holds it to that.)
 */
function firstPiece(own: readonly string[], i: number, lang: string): number {
  const length = own[i].length;
  if (!segmentsWithoutSpaces(lang) || typeof Intl === "undefined" || !("Segmenter" in Intl)) return length;
  const from = own.slice(0, i).join("").length;
  let first = true;
  let lead = false;
  for (const s of new Intl.Segmenter(lang, { granularity: "word" }).segment(own.join(""))) {
    if (!s.segment.trim()) continue;
    const word = s.isWordLike !== false;
    if (first) [first, lead] = [false, !word];
    else if (word && lead) lead = false;
    else if (word && s.index > from) return Math.min(length, s.index - from);
  }
  return length;
}

/** Which of a phrase's words holds its "[", or -1: the words are the
 *  phrase's characters without spaces and brackets, in order. */
function markedIndex(phrase: string, words: readonly string[]): number {
  const open = phrase.indexOf("[");
  if (open < 0) return -1;
  let before = phrase.slice(0, open).replace(/[\s[\]]/g, "").length;
  for (let i = 0; i < words.length; i++) {
    before -= words[i].length;
    if (before < 0) return i;
  }
  return -1;
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

/** Where a paused caption stands: where it stopped (whichever phrase is
 *  on screen, as a paused short holds its subtitle), but on the lead-in
 *  before its first word (nothing drawn yet: between two loops, or its
 *  tile came up while paused) it shows its still, the first phrase whole
 *  (`still`). */
export function pausedAt(t: number, still: number): number {
  return t < FIRST_WORD_AT ? still : t;
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
  /** Where it stands frozen (s): its first phrase whole (stillAt). */
  still: number;
};

/**
 * One frame of a tile's caption once its tile is up (mutates `clock`):
 * the time it shows (`at`), where its video jumps (`seek`) and whether
 * it still moves (`busy`: the ticker stops once none does).
 *
 * Where the clips cannot move, the line plays once on its own clock, all
 * three phrases, and settles on its still (the first phrase whole), paused
 * or not: no control is left to resume it, so it must not hold on half a
 * phrase or on a last phrase that makes no sense alone. Once they can
 * move again, a settled line starts over with its clip (which loads again
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
    return { at: clock.done ? now.still : clock.t, seek: null, busy: !clock.done };
  }
  if (clock.done) Object.assign(clock, clipClock());
  if (now.paused) return { at: pausedAt(clock.t, now.still), seek: null, busy: false };
  const step = tickClipClock(clock, dt, now.video);
  return { at: clock.t, seek: step.seek, busy: !step.held };
}
