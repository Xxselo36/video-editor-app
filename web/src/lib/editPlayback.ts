/**
 * Client-side edit playback for the editor.
 *
 * With a proxy (GET /jobs/{id}/proxy-video: the whole normalized source
 * at ≤720p, seconds = source seconds) the editor no longer needs a
 * server-built preview per edit: EditPlayer plays the proxy and follows
 * the edit list itself.
 *   - cuts:      at the end of a clip it seeks to the next clip's start
 *   - reordering: the same seek, backwards or forwards
 *   - speed:     element.playbackRate per clip (pitch preserved)
 *   - volume:    element.volume per clip, fades as linear ramps each
 *                frame (the element can't go above 100 %; iOS Safari
 *                ignores element volume, so there only "mute" works)
 *   - fades:     also shown as a black overlay while playing
 *
 * Why one <video> and seek-ahead instead of a second hidden <video> for
 * the next clip: iOS Safari only lets a media element start unmuted
 * playback from a user gesture (the swap happens mid-playback, without
 * one) and pauses other elements when one starts playing audio; two
 * 720p decoders also double memory and battery on phones.
 *
 * Joins are frame-exact (wordcuts10-flash-frames): a clip plays the frames
 * the render keeps (the backend's clip_plan grid: frames [round(start·fps),
 * round(end·fps))), its last kept frame included. The owner's rule: cut
 * footage is never on screen; at a join at most one kept frame goes in
 * normal conditions, two under heavy load. Where the browser reports
 * presented frames (requestVideoFrameCallback: Chrome, Safari 15.4+) the
 * jump to the next clip is asked on the clip's LAST kept frame, the moment
 * it is presented (round 4): the compositor holds that frame while the seek
 * lands, and the cut frame it would pick next is never picked — measured in
 * Chromium, a seek asked up to ~30 ms after the last kept frame's pick
 * stops the next pick (30 fps). Between frames the seam timer guards (a
 * callback that comes late, a frame the decoder never presents): due by the
 * frame clock (frames are picked on the media clock's slots — measured from
 * the presented frames' presentationTime) just before the first cut frame's
 * slot, its reach and the timers' measured lateness (SEAM_LEAD_MS at
 * least) before it, never before the last kept frame's slot; the element's
 * clock backs it up (just before
 * the compositor could pick the first cut frame, never before the last kept
 * frame's time). Round 5: the margin follows the load (margin(), fast
 * attack, slow release) — up to MAX_EARLY frames early, the owner's
 * allowance, only while measured that waiting could show a cut frame:
 * frame callbacks late after their pick again and again, past their
 * cadence (a CPU-starved main thread: the owner probe at 4× CPU, 30–60
 * ms), a stall in the latest frames, frames leapt past again and again
 * (two at once: two frames early), a seek's reach that doesn't fit between
 * two picks, a cut frame at one of the latest joins, and the first join of
 * a player (the reach unknown: found out on a kept frame). Ordinary jitter — a callback
 * 26–40 ms late now and then, timers 20–37 ms late while a frame renders on
 * two busy workers (CI) — is the seam timer's, not a margin: round 4's
 * frame rule took the latest 8 callbacks' most lag (and its clock the
 * animation frames' lateness), a frame early at a third to half of the
 * joins there. Round 6: no load read from the time-stretched clock above
 * FAST_RATE (its uneven steps, its callbacks a presentation late) and none
 * held into the 1x clips after; above FAST_RATE the most, always (the
 * clock races after a landing there); a main thread that stood still
 * (an animation frame 40 ms late, a callback that never ran) a frame for
 * a few frames; on the first frames after play the margin's two (the
 * renderer catching up); the seam waits while the media clock stands
 * (buffering), and a jump seeks before it sets the next clip's speed.
 * Round 7: a missed callback a load sign only where a frame lasts two
 * refreshes (the UI's 1.25x preset); the lags judged against the rendering
 * cadence (a 30 Hz one: iOS Low Power Mode); the seam never before the
 * last kept frame's pick (50/48 fps); a frame rate the steps can't tell
 * (60 fps at 2x) the frames both candidates keep.
 * Without frame callbacks the clock is all there is,
 * CLOCK_EARLY_FRAMES before the last kept frame (round 3's clock jumped 3–5
 * frames early on a busy machine: the end of a word lost at every join).
 * Landings go a little into the next
 * clip's first frame (a seek shows the frame under the target time:
 * exactly on the edge, a container offset of a few ms showed the cut frame
 * before it). Cut footage is never on screen and never heard. Where the
 * element's volume is writable a short gain ramp (rampMs) runs down into
 * the jump and up after the landing — a ramp, never a mute; iOS Safari
 * (volume read-only) gets the timing only. The proxy's keyframe interval
 * bounds the seek cost (≈ 1 s GOP recommended). Clips that continue the
 * same footage (a split, the same frame) need no seek at all.
 *
 * Times are source seconds throughout; "timeline" order is the order of
 * the plan (the user's clip order).
 */

export type PlaySeg = {
  id: string;
  start: number;
  end: number;
  speed: number; // 0.25 – 4
  volume: number; // 0 – 2.5
  fadeIn: number; // seconds of output (after speed), like the render
  fadeOut: number;
};

type SegLike = {
  id: string;
  start: number;
  end: number;
  disabled?: boolean;
  speed?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) =>
  typeof v === "number" && isFinite(v) ? v : fallback;

// A reported position this close before a clip still counts as in it
// (browsers may report a seek target a hair early).
const EDGE = 0.02;
/** A jump this close (output s) arms the boundary timers. */
export const BOUNDARY_AHEAD_S = 0.25;
/** The frame rate when the job doesn't say and no frames were seen yet. */
const DEFAULT_FPS = 30;
/** How far into a clip's first frame a jump lands (frames, past the grid's
 *  known offset); before the offset is known, the middle of the grid cell
 *  (right for any offset under half a frame). */
const LAND_FRAMES = 0.15;
const BLIND_FRAMES = 0.5;
/** Before any frame told the rate: how far into a clip's first frame at
 *  every common rate (COMMON_FPS) a landing goes at least (s). */
const BLIND_IN_S = 0.002;
/**
 * A jump asked this long (ms) before the compositor's next pick still stops
 * that pick: the seek's way to the media pipeline (Chromium, idle and under
 * load: a few ms). Joins that show a frame of the old position picked after
 * the jump was asked raise it to what they show it takes — less than the
 * old position's next pick they stopped (REACH_JOINS joins, at most
 * MAX_REACH_MS; reachMs).
 */
export const REACH_MS = 4;
const MAX_REACH_MS = 70;
const REACH_JOINS = 8;
/** Joins this soon after play started (frames): seeks take up to
 *  REACH_WARM_MS longer while the renderer starts up (the e2e run: 16 ms
 *  at the first join, a few ms at most after it) — only what they show
 *  beyond that says something about the joins after them. */
const REACH_WARM_FRAMES = 15;
const REACH_WARM_MS = 12;
/**
 * The jump goes at most this many frames of output before the clip's last
 * kept frame (above 1x as many more source frames as the speed plays): the
 * owner's allowance under heavy load — late callbacks, a slow pipeline and
 * skipping decoders together cost two kept frames at most.
 */
export const MAX_EARLY = 2;
/**
 * The clock — a timer at the moment, every animation frame and frame
 * callback; with the seam timer the backstop for frames the pipeline skips
 * (seen in the e2e runs: 30 → 32 at a clip's end) and all there is without
 * frame callbacks — jumps just before the compositor could pick the first
 * cut frame: it picks a frame up to its pick lead ahead of the element's
 * clock (measured per frame: 4–27 ms in the e2e runs, a refresh and a half
 * until then), less the reach and the timers' slack. With frame callbacks
 * never before the last kept frame's time (round 4 took off how late
 * animation frames came too: then before the last kept frame was picked
 * at a quarter of the joins on two workers); without them, and above
 * FAST_RATE (round 4's clock there), never while the clock is more than
 * CLOCK_EARLY_FRAMES before it: at most that frame is skipped (round 3's
 * clock had no bound: 3–5 frames early on a busy CI machine, the end of a
 * word lost at every join).
 */
export const CLOCK_EARLY_FRAMES = 0.25;
/** Pick leads kept (ms; the latest frames'); the most assumed. */
const LEAD_FRAMES = 16;
const MAX_LEAD_MS = 50;
/** Animation frames come at least this often (ms; a 60 Hz screen): the
 *  refresh assumed until measured, and the least one assumed. */
const RAF_MS = 16.7;
/** Above this speed the time-stretched clock moves in uneven steps (the
 *  e2e run at 1.5x and 2x: a presentation two frames on after one, the
 *  next 12 ms later): the next presentation is assumed a frame further. */
const FAST_RATE = 1.25;
/** The refresh is assumed at most this slow, and the next check at most
 *  this late (ms). */
const MAX_REFRESH_MS = 50;
/**
 * Load (round 5): the jump goes up to MAX_EARLY frames early only under
 * heavy load — a CPU-starved device, where waiting for the last kept frame
 * shows a cut one (the owner probe at 4× CPU: frame callbacks 30–60 ms
 * after their frame's pick, the decoder leaping 2–4 frames in one
 * presentation, timers 30 ms late). Measured in the player, fast attack and
 * slow release (each sign holds the margin for HEAVY_HOLD_MS):
 *   - frame callbacks later than HEAVY_LAG_MS after their frame's pick —
 *     and HEAVY_LAG_OVER_MS past the latest frames' least: one always that
 *     late is a cadence the seam covers — for HEAVY_LAG_COUNT of the latest
 *     LOAD_FRAMES frames (a free main thread runs them within a refresh:
 *     0–20 ms; the e2e runs on two workers: now and then 26–40 ms, rarely
 *     4 in 32);
 *   - frames a callback came too late for (the decoder leapt past them, or
 *     their callbacks never ran) HEAVY_LEAPS times within LEAP_WINDOW_MS or
 *     HEAVY_LEAPS_LONG within LEAP_WINDOW_LONG_MS (per 10 s: idle 0.1–0.4,
 *     the e2e runs on two workers and at 2× CPU 0.7–2.5, the owner probe at
 *     4× CPU 8–15 on the desktop, 1.4–3.3 as an iPhone).
 * Two frames (level 2) while callbacks come as often more than a
 * presentation late (less a seek's reach) and HEAVY_LAG_MS at least (round
 * 5 took the presentation alone: at 2x and at 60 fps 12.7 ms, a callback a
 * refresh after its pick on an idle machine — two kept frames at every
 * join, held into the 1x clips after; round 6 tried two presentations: at
 * 4× CPU the margin of one then let a cut frame through, a decoder whose
 * frames all came a refresh late catching up early) — or under heavy load
 * once frames came late two or more at once within BIG_LEAP_MS (past a
 * margin of one: the owner probe at 4× CPU, 3–4 frames 1–2 times per 10 s
 * on the desktop, out of the blue; never in the e2e runs). One frame (no
 * hold) while one of the latest STALL_FRAMES
 * callbacks came that late: a stall starting, the load's own sign a few
 * frames away (the seam timer may be held as long). Not a sign by itself:
 * timers firing late — on two busy workers the timers due while a frame
 * renders fire 20–37 ms late at half the joins, the callbacks on time (the
 * seam timer is led by it instead).
 */
const HEAVY_LAG_MS = 28;
const HEAVY_LAG_OVER_MS = 8;
const HEAVY_LAG_COUNT = 4;
const STALL_FRAMES = 4;
const LOAD_FRAMES = 32;
const HEAVY_LEAPS = 5;
const LEAP_WINDOW_MS = 8000;
const HEAVY_LEAPS_LONG = 10;
const LEAP_WINDOW_LONG_MS = 20_000;
const HEAVY_HOLD_MS = 3000;
const BIG_LEAP_MS = 30_000;
/** The main thread stood still (round 6): an animation frame this long (ms)
 *  after the one before while playing (the e2e spec's stall), or a frame
 *  whose callback never ran where a frame lasts two refreshes or more
 *  (LONG_FRAME_MS) — a frame early (no hold) for the next STALL_FRAMES
 *  frames' time: the e2e run at 1.5x, after a 50 ms stall the decoder a
 *  refresh late,
 *  the last kept frame presented without a callback, the cut frame on its
 *  slot 17 ms later. */
const STALL_GAP_MS = 40;
/** A frame this long (ms) or longer lasts two refreshes of a 60 Hz screen
 *  (30 fps: 33.3 ms; a hair under 2 × RAF_MS for the ms-grained clocks). */
const LONG_FRAME_MS = 1.95 * RAF_MS;
/** Pick gaps kept (the cadence frames are picked at). */
const SLOT_HISTORY = 16;
/** Timers fire a little late: they run at least this much (ms) before the
 *  last safe moment — more when the player's timers have lately fired later
 *  than that (the latest TIMER_HISTORY: the seam is led by it). */
const TIMER_SLACK_MS = 6;
const TIMER_HISTORY = 8;
/**
 * The frame clock (round 5): frames are picked on the media clock's grid —
 * frame j at `anchor + j·frameMs` (the earliest of the latest ANCHOR_FRAMES
 * presented since a landing, its first frame left out: the clock stands on
 * it a while; measured on two workers: within a ms of that, late now and
 * then, and a decoder that falls behind catches up on the slot of the
 * frame it leaps to). The seam timer is due by it: the last safe moment
 * before the first cut frame's slot, never sooner than SEAM_AFTER_MS after
 * the last kept frame's slot (it is on screen then).
 */
const ANCHOR_FRAMES = 8;
const SEAM_AFTER_MS = 4;
/** …and at least this long (ms) before the first cut frame's slot: a seek
 *  now and then takes longer than REACH_MS to stop a pick (the e2e runs: a
 *  frame of the old position picked 16 ms after a jump at 1 of ~700 joins;
 *  the owner probe on a Pixel 7: the cut frame picked 6 ms after a jump
 *  asked 26 ms after the last kept frame's pick, its callback late) — the
 *  last kept frame is on screen by then, so it costs nothing. */
const SEAM_LEAD_MS = 16;
/** The first frames after play start come while the renderer starts up:
 *  a busy device presents them late and then leaps a frame (the e2e run
 *  showed the first join's cut frame then). Until this many have been
 *  presented the next presentation is assumed to leap one frame further —
 *  on a frame presented since play the margin's frames (MAX_EARLY): the
 *  renderer catching up presents the next ones a refresh apart, their
 *  callbacks coalesced (round 6: the e2e run's start, 15, then 16 or 17
 *  without a callback and the cut frame 18 within 50 ms). At most the last
 *  two kept frames of a clip ending that soon are skipped. */
const WARM_FRAMES = 4;
/** The frames right after a seek landed come while the clock starts again
 *  (late, then a few at once): on the landing frame and the one after it
 *  the next presentation is assumed to leap one frame further. Only a clip
 *  of 3 frames or less ends that soon (its last kept frame may go); the
 *  full e2e run showed the cut frame after such a clip. */
const LAND_WARM_FRAMES = 2;

/**
 * A clip's frames on the render's grid (backend captions_v2.clip_plan):
 * [first, end) — frame k shows source [k/fps, (k+1)/fps). A tie falls on
 * the safe side: the clip starts later, ends earlier.
 */
export function clipFrames(seg: { start: number; end: number }, fps: number): [number, number] {
  return [Math.round(seg.start * fps + 1e-6), Math.round(seg.end * fps - 1e-6)];
}

/** Frame rates media comes in, the whole ones first: a measured rate this
 *  close (0.2 %; else the nearest within 0.5 %) is one — a few hundred ms
 *  of ms-rounded times can't tell 29.97 from 30 (0.1 % apart; a frame
 *  every 33 s), the mezzanine is 30 then. */
const COMMON_FPS = [24, 25, 30, 48, 50, 60, 90, 100, 120, 23.976, 29.97, 47.952, 59.94, 119.88];

/**
 * The frame rate from the media-time steps (s) between presented frames,
 * for a job that doesn't say (the v1 editor; jobs from before UT3): the
 * shortest step is one frame, the others whole multiples of it (frames a
 * busy pipeline skipped) — the rate is the frames per second over all of
 * them, not one over the shortest: containers keep times in ms (webm at 30
 * fps: steps of 33 and 34 ms by turns, the shortest said 30.3 fps — a
 * step of 2 frames then read as 3, a clip's end a frame off). Snapped to a
 * common rate (COMMON_FPS); one that isn't only from 16 steps on (fewer
 * ms-rounded steps are a few tenths of a percent off). Null: none yet.
 */
export function rateOfGaps(gaps: readonly number[]): number | null {
  if (gaps.length < 4) return null;
  const g0 = Math.min(...gaps);
  if (!(g0 > 0)) return null;
  let frames = 0;
  let secs = 0;
  for (const g of gaps) {
    const n = Math.round(g / g0);
    if (n < 1 || n > 8 || Math.abs(g - n * g0) > 0.3 * g0) continue;
    frames += n;
    secs += g;
  }
  if (!frames) return null;
  const rate = frames / secs;
  const off = (r: number) => Math.abs(rate - r) / r;
  const near = COMMON_FPS.reduce((a, r) => (off(r) < off(a) ? r : a));
  return COMMON_FPS.find((r) => off(r) <= 0.002) ?? (off(near) <= 0.005 ? near : gaps.length >= 16 ? rate : null);
}

/**
 * The frame rule (round 4): frame k is on screen, the clip's kept frames end
 * before `end` — is the jump asked now?
 *   - on the clip's last kept frame (k + 1 ≥ end, or a cut one already is):
 *     it is held while the seek lands, nothing after it is picked;
 *   - `leap` frames earlier while the next presentation may leap that far
 *     past its step and the clock can't be trusted to see it coming (the
 *     renderer starting up after play, the clock starting again after a
 *     landing, the time-stretched clock above FAST_RATE, a decoder that
 *     lately skipped frames, a cut frame seen at one of the latest joins);
 *   - a frame early (or two, never more than `maxEarly`) only while waiting
 *     could be too late: each presentation steps `stride` frames (before
 *     that leap: a step seen that was itself one is not counted twice),
 *     comes `slotMs` (wall) after the one before at the soonest; a frame's
 *     callback runs up to `lagMs` after its pick, and a jump has to be asked
 *     `reachMs` before a pick to stop it — the next callback, or a timer
 *     due as late, would come after the pick of the first cut frame.
 * Else the clock's timer (just before the compositor could pick the first
 * cut frame) guards the frames in between.
 */
export function jumpNow(
  k: number,
  end: number,
  o: { leap?: number; stride?: number; slotMs?: number; lagMs?: number; reachMs?: number; maxEarly?: number } = {},
): boolean {
  const leap = Math.min(Math.max(0, o.leap ?? 0), Math.max(0, o.maxEarly ?? MAX_EARLY));
  if (k + 1 + leap >= end) return true;
  if (k + 1 + Math.max(0, o.maxEarly ?? MAX_EARLY) < end) return false;
  // presentations until the first cut frame could be picked
  const n = Math.ceil((end - k) / (Math.max(1, o.stride ?? 1) + leap));
  return (o.lagMs ?? 0) + (o.reachMs ?? 0) >= Math.max(1, n - 1) * (o.slotMs ?? Infinity);
}

/** The clips that play, in timeline order, with effects clamped like
 *  the backend does (only clips the save would keep). */
export function buildPlan(segs: SegLike[], duration: number): PlaySeg[] {
  const out: PlaySeg[] = [];
  for (const s of segs) {
    if (s.disabled) continue;
    const start = Math.max(0, s.start);
    const end = duration > 0 ? Math.min(s.end, duration) : s.end;
    if (!(end - start > 0.05)) continue;
    out.push({
      id: s.id,
      start,
      end,
      speed: clamp(num(s.speed, 1), 0.25, 4),
      volume: clamp(num(s.volume, 1), 0, 2.5),
      fadeIn: clamp(num(s.fadeIn, 0), 0, 2),
      fadeOut: clamp(num(s.fadeOut, 0), 0, 2),
    });
  }
  return out;
}

/** Fade level 0..1 at source time t. Like the render: in output time,
 *  each fade at most half the clip. */
export function fadeLevel(seg: PlaySeg, t: number): number {
  const outDur = (seg.end - seg.start) / seg.speed;
  const pos = clamp((t - seg.start) / seg.speed, 0, outDur);
  let f = 1;
  const fi = Math.min(seg.fadeIn, outDur / 2);
  if (fi > 0) f *= clamp(pos / fi, 0, 1);
  const fo = Math.min(seg.fadeOut, outDur / 2);
  if (fo > 0) f *= clamp((outDur - pos) / fo, 0, 1);
  return f;
}

/**
 * The seek dip (UX10, review C9): the element's gain around a cut's jump,
 * so the seam doesn't click. 0 while our seek is on its way; ramps up
 * over `rampMs` after it landed (`sinceSeekMs`); ramps down over the last
 * `rampMs` before a clip end that jumps (`toJumpSec`: output seconds left
 * until the jump, null when the next clip continues the footage or there
 * is none). 1 when off (rampMs 0).
 */
export function seekRampLevel(rampMs: number, seeking: boolean, sinceSeekMs: number | null, toJumpSec: number | null): number {
  if (!(rampMs > 0)) return 1;
  if (seeking) return 0;
  const up = sinceSeekMs === null ? 1 : clamp(sinceSeekMs / rampMs, 0, 1);
  const down = toJumpSec === null ? 1 : clamp((toJumpSec * 1000) / rampMs, 0, 1);
  return Math.min(up, down);
}

/** The clip showing source time t: `prefer` when it contains t, else the
 *  first in timeline order. -1 when t is cut out. */
export function locate(plan: PlaySeg[], t: number, prefer?: string | null): number {
  if (prefer) {
    const i = plan.findIndex((s) => s.id === prefer);
    if (i >= 0 && t >= plan[i].start - EDGE && t < plan[i].end) return i;
  }
  return plan.findIndex((s) => t >= s.start - EDGE && t < s.end);
}

/** The clip whose footage comes next after source time t (the earliest
 *  start at or after t). -1 when nothing follows. */
export function nextInSource(plan: PlaySeg[], t: number): number {
  let best = -1;
  plan.forEach((s, i) => {
    if (s.start >= t - EDGE && (best < 0 || s.start < plan[best].start)) best = i;
  });
  return best;
}

const probing = new Map<string, Promise<boolean>>();

/**
 * Does the backend have a proxy for this job? One tiny range GET (HEAD
 * isn't routed for FastAPI GET endpoints); the body is never read. A
 * redirect (to object storage) counts as yes — it isn't followed, so it
 * needs no CORS there. Anything else — 404 from a backend without
 * proxies, an error, a timeout — means no.
 */
export function probeProxy(url: string, timeoutMs = 5000): Promise<boolean> {
  // One request per job even when the editor mounts twice at once (React
  // strict mode); a later mount asks again — the proxy may exist by then.
  let p = probing.get(url);
  if (!p) {
    p = probeOnce(url, timeoutMs);
    probing.set(url, p);
    void p.finally(() => probing.delete(url));
  }
  return p;
}

async function probeOnce(url: string, timeoutMs: number): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Range: "bytes=0-1" },
      cache: "no-store",
      redirect: "manual",
      signal: ctl.signal,
    });
    if (r.type === "opaqueredirect") return true;
    if (r.status !== 200 && r.status !== 206) return false;
    const type = (r.headers.get("content-type") || "").toLowerCase();
    return !/json|html|text\//.test(type);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ctl.abort(); // don't download the rest
  }
}

export type EditPlayerOptions = {
  /** The clip now playing (by id), when it changes. */
  onSegment?: (id: string | null) => void;
  /** Black overlay whose opacity shows fades while playing. */
  fadeEl?: HTMLElement | null;
  /** UX10 (v2 editor): a gain ramp of this many ms down before and up
   *  after each jump at a cut, where the element's volume is writable
   *  (not iOS). 0 / unset: no ramp (the v1 editor). */
  seekRampMs?: number;
  /** The video's frame rate (GET /jobs/{id} fps): the frame grid clip
   *  edges snap to, as in the render. Unset: measured from the frames. */
  fps?: number | null;
};

type FrameMeta = { mediaTime: number; presentedFrames: number; expectedDisplayTime: number; presentationTime?: number };
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: FrameMeta) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

const keep = <T,>(xs: T[], x: T, n: number) => {
  xs.push(x);
  if (xs.length > n) xs.shift();
};

/**
 * Drives one <video> (whose src is the proxy) through the edit plan.
 * Everything runs on the element directly — no React state per frame.
 */
export class EditPlayer {
  private v: FrameVideo;
  private plan: PlaySeg[] = [];
  private idx = -1;
  private curId: string | null = null;
  // Stopped at the end of the timeline: the next play starts over.
  private atEnd = false;
  private raf = 0;
  private ourSeek: number | null = null;
  // What the user set in the native controls, kept apart from what the
  // clip effects set on the element.
  private masterVolume: number;
  private userMuted: boolean;
  private masterRate = 1;
  private gain = 1;
  private volumeWritable = true;
  private applied: { volume: number; muted: boolean; rate: number };
  private fadeOpacity = 0;
  private onSegment?: (id: string | null) => void;
  private fadeEl: HTMLElement | null;
  private off: () => void;
  private rampMs: number;
  /** Our jump at a cut is on its way (the seek dip holds the gain at 0). */
  private dipping = false;
  /** When that jump landed (performance.now), while the gain ramps up. */
  private landedAt: number | null = null;
  private rampTimers: ReturnType<typeof setTimeout>[] = [];
  /** The boundary timers of the playing clip's end: the clip index and the
   *  wall time (performance.now) the backstop fires at. */
  private boundaryFor = -1;
  private boundaryAt = NaN;
  private boundaryTimers: ReturnType<typeof setTimeout>[] = [];
  /** A trim edge is shown (drag-9): the plan doesn't move the element. */
  private scrubbing = false;
  private scrubWant: number | null = null;
  // ── the frame grid (wordcuts10-flash-frames) ──
  /** The job's frame rate; else measured from presented frames. */
  private fpsOpt: number | null;
  private fpsSeen: number | null = null;
  private frameGaps: number[] = [];
  /** …and above FAST_RATE (fpsSeen from them only while there are none at or below it). */
  private fastGaps: number[] = [];
  /** The rate those steps tell where the screen can't show every frame at
   *  the speed playing (the frame rate is it or twice it: 60 fps at 2x on
   *  60 Hz steps two frames, like 30 fps one): until known, the clips keep
   *  the frames both grids keep (fpsBoth). */
  private fpsLeast: number | null = null;
  /** Media-time offset of the frame grid (a container's start offset,
   *  under half a frame), learned from presented frames. */
  private phase: number | null = null;
  /** requestVideoFrameCallback: supported, its pending handle. */
  private rvfc: boolean;
  private frameHandle = 0;
  /** The last presented frame: when its callback ran and when the
   *  compositor picked it (performance.now), its count, index, time. */
  private lastFrameAt = -Infinity;
  private lastPickAt = -Infinity;
  private lastPresented: number | null = null;
  private lastFrameK: number | null = null;
  private lastFrameM = 0;
  /** Frames presented since play or our last seek. */
  private framesSince = 0;
  /** Frames presented since play started (seeks don't reset it): WARM_FRAMES. */
  private playFrames = 0;
  /** The jump at a clip end on its way: when it was asked for (wall), and
   *  how long after that a frame of the old position was still picked
   *  (ms; null: none so far). */
  private jump: { at: number; late: number | null; warm: boolean; end: number; cut: boolean; next: number } | null = null;
  /** Per join, newest last: how long after the jump was asked a frame of
   *  the old position was still picked (ms; 0: none) — the seek's reach;
   *  and whether that frame was a cut one (1). */
  private reaches: number[] = [];
  /** Per join, newest last: how long after the jump was asked the next
   *  pick of the old position was due by the frame clock — the one the
   *  seek stopped: the reach is less than that (Infinity: unknown). */
  private stops: number[] = [];
  private cutJoins: number[] = [];
  /** The latest join was in the first frames after play (its seek slower
   *  by up to REACH_WARM_MS) and showed a frame of the old position after
   *  its jump: the reach afterwards is still unknown. */
  private reachUnsure = false;
  /** A seek on its way: from where (media time of the frame then on
   *  screen) to where. Frames nearer `from` are from before it. */
  private landing: { from: number; to: number } | null = null;
  /** Our seek's frames are on screen though the element still says
   *  seeking (its 'seeked' comes a while after the clock runs again on a
   *  busy page: a 4-frame clip played through meanwhile, its cut frame on
   *  screen). */
  private landedEarly = false;
  /** Frames presented since the last seek landed (the landing one is 1). */
  private shownRun = 0;
  /** Recent wall gaps (ms) between the picks of frames presented one after
   *  the other: the cadence the next ones come at. */
  private slots: number[] = [];
  /** Recent callback lags (ms): how long after its pick a frame's callback
   *  ran (a busy main thread runs them late). */
  private lags: number[] = [];
  /** Recent pick leads (ms): how far ahead of the element's clock frames
   *  were picked. */
  private leads: number[] = [];
  /** Recent frame steps between presentations. */
  private strides: number[] = [];
  /** When (performance.now) the decoder lately skipped frames while playing,
   *  and how many at once. */
  private skips: { at: number; n: number }[] = [];
  /** The frame clock: `pickAt − k·frameMs` of the latest frames presented
   *  since the last landing (its first frame left out). */
  private anchors: number[] = [];
  /** How late (ms) the player's latest timers fired. */
  private timerLates: number[] = [];
  /** Heavy load: until when (performance.now) the margin holds at level 1
   *  and at level 2 (HEAVY_HOLD_MS after the latest sign). */
  private heavyUntil: [number, number] = [-Infinity, -Infinity];
  /** When (performance.now) frames last came late two or more at once. */
  private bigLeapAt = -Infinity;
  /** When (performance.now) the main thread last stood still while playing (STALL_GAP_MS). */
  private stallAt = -Infinity;
  /** Recent gaps (wall ms) between animation frames while playing (the
   *  screen's refresh); and when the last one ran. */
  private tickGaps: number[] = [];
  private lastTickAt: number | null = null;

  constructor(video: HTMLVideoElement, opts: EditPlayerOptions = {}) {
    this.v = video as FrameVideo;
    this.onSegment = opts.onSegment;
    this.fadeEl = opts.fadeEl ?? null;
    this.rampMs = opts.seekRampMs ?? 0;
    this.fpsOpt = opts.fps && opts.fps > 0 && isFinite(opts.fps) ? opts.fps : null;
    this.rvfc = typeof this.v.requestVideoFrameCallback === "function";
    this.masterVolume = video.volume;
    this.userMuted = video.muted;
    this.applied = { volume: video.volume, muted: video.muted, rate: video.playbackRate };
    const handlers: [string, EventListener][] = [
      ["play", this.onPlay],
      ["pause", this.onPause],
      ["ended", this.onEnded],
      ["seeking", this.onSeeking],
      ["seeked", this.onSeeked],
      ["timeupdate", this.tick],
      ["loadedmetadata", this.onMeta],
      ["volumechange", this.onVolume],
      ["ratechange", this.onRate],
    ];
    handlers.forEach(([ev, fn]) => video.addEventListener(ev, fn));
    this.off = () => handlers.forEach(([ev, fn]) => video.removeEventListener(ev, fn));
    this.watchFrames();
    if (!video.paused) this.startLoop();
  }

  destroy(): void {
    this.off();
    this.stopLoop();
    if (this.frameHandle) {
      try {
        this.v.cancelVideoFrameCallback?.(this.frameHandle);
      } catch {
        /* element gone */
      }
    }
    this.frameHandle = 0;
    this.rvfc = false;
    this.rampTimers.forEach(clearTimeout);
    this.disarm();
    this.setFade(0);
    const v = this.v;
    try {
      v.playbackRate = 1;
      v.muted = this.userMuted;
      if (this.volumeWritable) v.volume = this.masterVolume;
    } catch {
      /* element gone */
    }
  }

  /** The job's frame rate arrived (or changed). */
  setFps(fps: number | null | undefined): void {
    this.fpsOpt = fps && fps > 0 && isFinite(fps) ? fps : null;
    this.disarm();
  }

  /** New edit list. Keeps playing the same clip when it survived the
   *  edit; otherwise continues where that clip's place now is. */
  setPlan(plan: PlaySeg[]): void {
    const old = this.plan;
    this.plan = plan;
    this.disarm();
    this.jump = null;
    if (!plan.length) {
      this.idx = -1;
      return;
    }
    const t = this.v.currentTime;
    if (this.curId === null) {
      this.enter(0, Math.abs(t - plan[0].start) > EDGE || !this.showsClip(plan[0], t) ? this.landOf(plan[0]) : null);
      return;
    }
    const j = plan.findIndex((s) => s.id === this.curId);
    if (j >= 0) {
      const s = plan[j];
      if (t < s.start - EDGE) this.enter(j, this.landOf(s)); // trimmed past the playhead
      else if (t < s.end || this.atEnd) this.enter(j, null); // effects changed
      else if (j + 1 < plan.length) {
        // The clip now ends before the playhead. Cut further back in it
        // (UX10: words cut in the text) the rest of it is the next clip,
        // which still shows this frame: stay, don't jump to its start.
        const nx = plan[j + 1];
        this.enter(j + 1, t >= nx.start - EDGE && t < nx.end ? null : this.landOf(nx));
      } else this.parkAtEnd();
      return;
    }
    // The clip is gone (deleted or split): the clip now showing this
    // frame, else the next clip that followed it and still exists.
    const k = locate(plan, t, null);
    if (k >= 0) {
      this.enter(k, null);
      return;
    }
    const oi = old.findIndex((s) => s.id === this.curId);
    for (let n = oi + 1; oi >= 0 && n < old.length; n++) {
      const m = plan.findIndex((s) => s.id === old[n].id);
      if (m >= 0) {
        this.enter(m, this.landOf(plan[m]));
        return;
      }
    }
    this.parkAtEnd();
  }

  /** Seek to source time t, in clip `segId` when given (the timeline
   *  knows which clip was clicked; a split point belongs to two). Times
   *  that are cut out go to the next footage that plays. */
  seek(t: number, segId?: string | null): void {
    const plan = this.plan;
    if (!plan.length) return;
    let j = segId ? plan.findIndex((s) => s.id === segId) : -1;
    if (j >= 0 && (t < plan[j].start - EDGE || t > plan[j].end + EDGE)) j = -1;
    if (j < 0) j = locate(plan, t, this.curId);
    if (j < 0) {
      j = nextInSource(plan, t);
      if (j < 0) return;
      t = plan[j].start;
    }
    this.atEnd = false;
    this.jump = null;
    // On the clip's own frames: not the frame before its first one, not
    // the first cut-out one after its end.
    this.enter(j, this.within(plan[j], t));
  }

  /** Jump to a transcript line: where it starts, or — when its start
   *  is cut — the first clip that starts inside it. */
  seekRange(from: number, to: number): boolean {
    const plan = this.plan;
    let j = locate(plan, from, this.curId);
    let t = from;
    if (j < 0) {
      j = plan.findIndex((s) => s.start >= from && s.start <= to);
      if (j < 0) return false;
      t = plan[j].start;
    }
    this.atEnd = false;
    this.jump = null;
    this.enter(j, this.within(plan[j], t));
    return true;
  }

  /**
   * Show source time t as it is, edit or not (drag-9: the frame at a trim
   * edge while it is dragged, also footage the edit cuts): pauses, seeks
   * there — one seek at a time, the newest wins — and the plan leaves the
   * element alone until `scrub(null)`.
   */
  scrub(t: number | null): void {
    if (t === null) {
      this.scrubbing = false;
      this.scrubWant = null;
      return;
    }
    this.scrubbing = true;
    this.disarm();
    this.jump = null;
    if (!this.v.paused) this.v.pause();
    if (this.v.seeking) {
      this.scrubWant = t;
      return;
    }
    this.ourSeek = t;
    try {
      this.v.currentTime = t;
    } catch {
      /* no media yet */
    }
  }

  // ── the frame grid ───────────────────────────────────────────────

  private fps(): number {
    return this.fpsOpt ?? this.fpsSeen ?? (this.fpsLeast ? 2 * this.fpsLeast : DEFAULT_FPS);
  }

  /** The frame rate is only known to be fpsLeast or twice it: the grid is
   *  twice its (the other's frames are pairs of it), a clip's frames those
   *  both keep (round 6 took the default, 30: 60 fps at 2x read as 30 —
   *  a 60 fps frame past a clip's end inside its last 30 fps one, cut
   *  frames at a third of the joins). */
  private fpsBoth(): boolean {
    return this.fpsOpt === null && this.fpsSeen === null && this.fpsLeast !== null;
  }

  /** The grid frame a media time shows. */
  private frameOf(m: number): number {
    return Math.round((m - (this.phase ?? 0)) * this.fps());
  }

  /** Media time frame k starts at. */
  private frameAt(k: number): number {
    return k / this.fps() + (this.phase ?? 0);
  }

  private framesOf(seg: PlaySeg): [number, number] {
    const [a, b] = clipFrames(seg, this.fps());
    if (!this.fpsBoth()) return [a, b];
    const [a1, b1] = clipFrames(seg, this.fpsLeast!);
    return [Math.max(a, 2 * a1), Math.min(b, 2 * b1)];
  }

  /** Where a jump into seg lands: a little into its first frame — before
   *  any frame told the rate (DEFAULT_FPS assumed), past where the clip's
   *  first frame starts at every common one (a 25 fps clip from 0.3 s
   *  starts at 0.32: the middle of 30 fps' first frame, 0.317, showed the
   *  cut frame before it). */
  private landOf(seg: PlaySeg): number {
    const [a, b] = this.framesOf(seg);
    if (b <= a) return seg.start;
    const into = this.phase === null ? BLIND_FRAMES : LAND_FRAMES;
    let t = this.frameAt(a) + into / this.fps();
    if (this.fpsOpt === null && this.fpsSeen === null && this.fpsLeast === null) {
      // (every common rate: round 7 left out 23.976, 29.97, 48 and 59.94 —
      // a first landing showed the cut frame before the clip at 6–9 % of
      // clip starts at the NTSC rates)
      for (const f of COMMON_FPS) t = Math.max(t, clipFrames(seg, f)[0] / f + BLIND_IN_S);
    }
    return Math.min(t, this.lastOf(seg));
  }

  /** The latest seek target inside seg's last frame. */
  private lastOf(seg: PlaySeg): number {
    const [a, b] = this.framesOf(seg);
    if (b <= a) return seg.start;
    const back = this.phase === null ? BLIND_FRAMES : 0.3;
    return Math.max(this.frameAt(a), this.frameAt(b) - back / this.fps());
  }

  /** t, kept on seg's own frames. */
  private within(seg: PlaySeg, t: number): number {
    return clamp(t, this.landOf(seg), Math.max(this.landOf(seg), this.lastOf(seg)));
  }

  /** Does the element at t show one of seg's frames? */
  private showsClip(seg: PlaySeg, t: number): boolean {
    const [a, b] = this.framesOf(seg);
    const k = this.frameOf(t - 0.5 / this.fps());
    return k >= a && k < b;
  }

  /** The next clip continues seg's footage on the very next frame (a split): no seek. */
  private joined(i: number): boolean {
    const seg = this.plan[i];
    const next = this.plan[i + 1];
    if (!seg || !next) return false;
    return this.framesOf(next)[0] === this.framesOf(seg)[1] || Math.abs(next.start - seg.end) < 1e-6;
  }

  private rate(): number {
    const r = this.v.playbackRate;
    return r > 0 ? r : 1;
  }

  /** Frame callbacks are arriving (the element is on screen and playing). */
  private framesLive(): boolean {
    if (!this.rvfc || this.framesSince < 1) return false;
    const frameMs = 1000 / (this.fps() * this.rate());
    return performance.now() - this.lastFrameAt < Math.max(150, 4 * frameMs);
  }

  /** Frames from one presented frame to the next, at most (2+ at high
   *  speeds, or when the decoder skips some). */
  private stride(): number {
    const seen = this.strides.length ? Math.max(...this.strides) : 1;
    return Math.min(8, Math.max(1, seen, this.screenStride()));
  }

  /** A presentation's step before the leap the next one may take: the
   *  steps seen lately less that leap — a step seen that was itself a leap
   *  (a skipped frame, an uneven step at speed) is the evidence for it, not
   *  a step to leap further from (counted twice, a frame the decoder
   *  skipped had the next presentation assumed 2 + 1 frames on: the e2e
   *  playback run on a busy machine lost two kept frames at the join). */
  private stepOf(leap: number): number {
    return Math.max(this.screenStride(), this.stride() - leap);
  }

  /** The usual step: a screen shows at most one frame per refresh. */
  private screenStride(): number {
    const usual = this.strides.length ? [...this.strides].sort((a, b) => a - b)[this.strides.length >> 1] : 1;
    // (the refresh as measured: a 60 fps video on a 60 Hz screen reads 1.02
    // frames a refresh with animation frames 17 ms apart — still one)
    return Math.max(1, usual, Math.ceil((this.rate() * this.fps() * this.refreshMs()) / 1000 - 0.05));
  }

  /**
   * Output frames the jump goes early by at the moment (0: on the last kept
   * frame — normal conditions): the load level (heavyUntil: a CPU-starved
   * device), one while the seek's reach is unknown (no join measured yet:
   * the first join of a player finds it out on a kept frame — at a slow
   * pipeline the old frame picked after the jump is the last kept one, not a
   * cut one; a join in the first frames after play that saw such a frame
   * says too little: the next one too) or one of the latest joins showed a
   * cut frame; one when one of
   * the latest STALL_FRAMES frames' callbacks came as late as heavy load's
   * (a stall: load starting — the seam timer may be held as long; the
   * load's own sign takes a few more frames), or the main thread stood
   * still in their time (STALL_GAP_MS); MAX_EARLY above FAST_RATE. At most
   * MAX_EARLY. (A slow pipeline: leap().)
   */
  private margin(): number {
    if (!this.rvfc) return 0;
    const now = performance.now();
    // (level 2 while heavy if the frames came late two or more at once in
    // the latest BIG_LEAP_MS: at 4× CPU a leap of three comes out of the
    // blue, 17–40 % of the time with none in the 8 s before)
    const leapt = now - this.bigLeapAt < BIG_LEAP_MS;
    const heavy = now < this.heavyUntil[1] ? 2 : now < this.heavyUntil[0] ? (leapt ? 2 : 1) : 0;
    const probe = this.reaches.length === 0 || this.reachUnsure || this.cutJoins.includes(1) ? 1 : 0;
    const late = this.lateLagMs(HEAVY_LAG_MS);
    const stall = this.lags.slice(-STALL_FRAMES).some((x) => x > late) || now - this.stallAt < STALL_FRAMES * this.presMs() ? 1 : 0;
    // (above FAST_RATE the most, always: the time-stretched clock races
    // after a landing and steps unevenly — 43 → 48 in 50 ms, 458 → 462 →
    // 463 within 34 ms at 2x in the e2e runs, callbacks never run; round 5
    // had it there from the 2x callbacks taken for load, held into the 1x
    // clips after — round 6 holds nothing; one frame of output let 463 in.
    // Round 7 tried the most only right after a landing or once the clock
    // leapt, a frame otherwise: the e2e runs showed cut frames mid-clip —
    // at 1.5x a frame picked 16 ms before its frame-clock slot, at 2x the
    // last kept frame's callback after the cut frame's pick)
    const fast = this.rate() > FAST_RATE ? MAX_EARLY : 0;
    return Math.min(MAX_EARLY, Math.max(heavy, probe, stall, fast));
  }

  /** A frame callback lag (ms) that is a stall's, not the cadence: over
   *  `t` and HEAVY_LAG_OVER_MS over the least of the latest frames' (a
   *  callback always that late — a phone rendering 12 ms into the refresh
   *  — is a cadence the seam timer covers; a starved main thread runs some
   *  at once, others 30–60 ms late). */
  private lateLagMs(t: number): number {
    const at = t + this.cadenceMs();
    if (!this.lags.length) return at;
    return Math.max(at, Math.min(...this.lags) + HEAVY_LAG_OVER_MS);
  }

  /** How much later than a 60 Hz screen's the page's rendering updates
   *  come at their steadiest (ms: the animation frames' lower quartile
   *  gap less RAF_MS) — a callback runs in the first one after its frame
   *  is shown. A 30 Hz cadence (iOS Low Power Mode, Chrome's Energy Saver:
   *  updates at every other refresh, the timers on time) runs callbacks up
   *  to a refresh later on an idle device, at a third to a half of the
   *  joins (by the clip's phase): rounds 5 and 6 took that for load — two
   *  kept frames at most joins. Only while the player's timers fire on
   *  time (TIMER_SLACK_MS: an idle main thread): a starved one renders at
   *  30 Hz too (the owner probe at 4× CPU as an iPhone 13), its timers
   *  20–30 ms late — its lags stay a load sign (taken as the cadence,
   *  they let decoder leaps of three at a clip's end through). */
  private cadenceMs(): number {
    if (!this.timerLates.length || Math.max(...this.timerLates) > TIMER_SLACK_MS) return 0;
    return this.tickGap(0.25, RAF_MS) - RAF_MS;
  }

  /** Heavy load at the moment (level 1 or 2). */
  private heavy(): boolean {
    return performance.now() < this.heavyUntil[0] || performance.now() < this.heavyUntil[1];
  }

  /** A sign of heavy load (level 1 or 2): the margin holds HEAVY_HOLD_MS. */
  private loaded(level: 1 | 2, now = performance.now()): void {
    this.heavyUntil[level - 1] = Math.max(this.heavyUntil[level - 1], now + HEAVY_HOLD_MS);
  }

  /** Frames (source) the jump goes before the clip's last kept frame: the
   *  margin (in source frames at the speed playing); as many as the seam
   *  needs when the seek's reach leaves no room between two frames' picks
   *  (a slow pipeline; late timers lead the seam timer instead, at most to
   *  the last kept frame's slot); one while the renderer starts up
   *  (play: WARM_FRAMES — on a frame presented since play the margin's
   *  two) or the clock starts again after a landing (LAND_WARM_FRAMES: the
   *  next presentation may leap a frame); one more above FAST_RATE. At most
   *  MAX_EARLY output frames. */
  private leap(): number {
    if (!this.rvfc) return 0;
    // (on a frame presented since play, the margin's frames: the next ones
    // may come a refresh apart and without a callback — the e2e run: 15,
    // then 16 or 17 with none, the cut frame 18, within 50 ms)
    const u = this.gridUnit();
    const playWarm = this.playFrames < WARM_FRAMES ? (this.framesSince >= 1 ? this.maxEarly() : u) : 0;
    const warm = Math.max(playWarm, this.shownRun > 0 && this.shownRun <= LAND_WARM_FRAMES ? u : 0);
    const m = this.margin();
    const early = m > 0 ? Math.ceil(m * Math.max(1, this.rate()) * u - 1e-6) : 0;
    const fm = 1000 / (this.fps() * this.rate());
    // (frames shorter than two refreshes: the timers' slack as they lately
    // fired, like the seam's — round 7 took TIMER_SLACK_MS, and at 60 fps
    // with the timers 15 ms late the seam fired after the cut frame's pick
    // at most joins, the frame rule on the last kept frame's callback too
    // late for it. Longer frames leave the frame rule a refresh to spare
    // there: TIMER_SLACK_MS — the slack took a kept frame at every join at
    // 30 fps with the timers 30 ms late, for no cut frame less)
    const slack = this.longFrames() ? TIMER_SLACK_MS : this.slackMs();
    const seam = Math.max(0, Math.ceil((this.reachMs() + slack + SEAM_AFTER_MS) / fm - 1e-6) - 1);
    return Math.min(this.maxEarly(), Math.max(warm, early, seam) + (this.rate() > FAST_RATE ? u : 0));
  }

  /** A frame lasts two refreshes of a 60 Hz screen (LONG_FRAME_MS: 30 fps
   *  at 1x, 24 fps at 1.25x) or more, at the speed playing — its own
   *  duration, not the presentations' (a screen refreshing slower, or
   *  animation frames slowed down with the main thread — at 4× CPU to 30
   *  Hz — make no frame longer). Only then is a callback that never ran a
   *  sign the main thread stood still: frames shorter than that come one
   *  and two refreshes apart by turns, two in one rendering update now and
   *  then on an idle machine (round 6 took the presentations' time, a
   *  refresh and a half: at the UI's 1.25x preset 30 fps' 26.7 ms and 25
   *  fps' 32 ms frames counted, those callbacks read as skips and stalls —
   *  the heavy margin held 3 s into the 1x clips after). */
  private longFrames(): boolean {
    return 1000 / (this.fps() * this.rate()) >= LONG_FRAME_MS;
  }

  /** Wall ms from one presentation to the next at the speed playing. */
  private presMs(): number {
    return (1000 / (this.fps() * this.rate())) * this.screenStride();
  }

  /** The soonest wall gap (ms) between two presentations: the second
   *  shortest lately (one odd gap is no cadence); until measured a frame's
   *  time (a refresh when frames come faster), less half a refresh (24 fps
   *  on 60 Hz: 33 and 50 ms by turns). */
  private slotMs(): number {
    const refresh = this.refreshMs();
    const frameMs = (1000 / (this.fps() * this.rate())) * this.screenStride();
    const prior = Math.max(refresh, frameMs - refresh / 2);
    if (this.slots.length < 4) return prior;
    const xs = [...this.slots].sort((a, b) => a - b);
    return clamp(xs[1], 4, Math.max(prior, MAX_REFRESH_MS) * 2);
  }

  /** How late after their pick the next frame callbacks may run (ms), for
   *  the frame rule: under heavy load the latest frames' 90th percentile,
   *  or the latest one's if later (a check that late: the next one may be
   *  too — the owner probe at 4× CPU: a callback 63 ms after its frame's
   *  pick, two frames shown meanwhile, the cut one picked 4 ms later); in a
   *  stall (margin()) the latest one's; else none — the seam timer covers
   *  a callback that comes late (round 4 took the latest 8 frames' most: a
   *  lag spike now and then, on two busy workers, went a frame early at a
   *  third of the joins). */
  private lagMs(): number {
    if (!this.lags.length) return 0;
    const last = this.lags[this.lags.length - 1];
    if (this.heavy()) {
      const xs = [...this.lags].sort((a, b) => a - b);
      return Math.max(xs[Math.floor(xs.length * 0.9)], last);
    }
    const late = this.lateLagMs(HEAVY_LAG_MS);
    return this.lags.slice(-STALL_FRAMES).some((x) => x > late) ? last : 0;
  }

  /**
   * How long before a pick a jump has to be asked to stop it (ms): REACH_MS
   * — or, where one of the latest joins picked a frame of the old position
   * after its jump was asked (the seek took longer than that: `reaches`),
   * the least of what the latest joins showed it takes less than (`stops`:
   * the old position's next pick the seek did stop) that is still more
   * than that; a frame more where they disagree. REACH_WARM_MS more in the
   * first frames after play (the e2e runs: the second join after play
   * still picked the cut frame 16 ms after the jump).
   */
  private reachMs(): number {
    const warm = this.playFrames < REACH_WARM_FRAMES ? REACH_WARM_MS : 0;
    const lo = this.reaches.length ? Math.max(...this.reaches) : 0;
    // (a frame picked within REACH_MS of the jump says nothing new)
    if (lo <= REACH_MS) return REACH_MS + warm;
    const hi = Math.min(...this.stops.filter((y) => y > lo));
    return clamp(isFinite(hi) ? hi : lo + this.presMs(), lo + 1, MAX_REACH_MS) + warm;
  }

  /** How long before the last safe moment the player's timers are due
   *  (ms): TIMER_SLACK_MS, more when they lately fired later than that. */
  private slackMs(): number {
    const late = this.timerLates.length ? Math.max(...this.timerLates) : 0;
    return clamp(late + 2, TIMER_SLACK_MS, MAX_REACH_MS);
  }

  /** MAX_EARLY in source frames (output frames at the speed playing). */
  private maxEarly(): number {
    return Math.ceil(MAX_EARLY * Math.max(1, this.rate()) * this.gridUnit() - 1e-6);
  }

  /** Grid frames to a frame of the video: two while the rate is only known
   *  to be fpsLeast or twice it (fpsBoth: the margins count the longer
   *  frames — a 30 fps video's on the 60 fps grid). */
  private gridUnit(): number {
    return this.fpsBoth() ? 2 : 1;
  }

  /** The frame rule for frame k against frames ending before b: the
   *  presentations a frame clock's slot apart (a pick sooner than that is a
   *  catch-up after a late one: the cut frame's slot doesn't move) — under
   *  heavy load as soon as they lately came. */
  private ruleNow(k: number, b: number): boolean {
    const leap = this.leap();
    const slotMs = this.heavy() ? this.slotMs() : this.presMs();
    return jumpNow(k, b, { leap, stride: this.stepOf(leap), slotMs, lagMs: this.lagMs(), reachMs: this.reachMs(), maxEarly: this.maxEarly() });
  }

  /** How far ahead of the element's clock the compositor picks a frame
   *  (ms): the most of the latest frames', a refresh and a half until then;
   *  two frames at least while the renderer starts up (WARM_FRAMES: the e2e
   *  runs showed the first frames after play picked 60 ms ahead, then a
   *  leap 15 → 19) — the clock's bound then. */
  private leadMs(): number {
    const lead = this.leads.length ? Math.max(...this.leads) : this.refreshMs() * 1.5;
    return this.rvfc && this.playFrames < WARM_FRAMES ? Math.max(lead, 2000 / (this.fps() * this.rate())) : lead;
  }

  /** The clock's bound: never jump while the element's clock is before
   *  seg's last kept frame — without frame callbacks, or above FAST_RATE
   *  (the time-stretched clock catches up in leaps, a frame lasts a refresh
   *  or less: the e2e run at 2x, 457 → 463 in one presentation after a
   *  landing), CLOCK_EARLY_FRAMES before it (one presentation's step at
   *  speed: round 4's bound). */
  private clockFloorOf(seg: PlaySeg): number {
    const [, b] = this.framesOf(seg);
    const exact = this.framesLive() && this.rate() <= FAST_RATE;
    return this.frameAt(b - (exact ? 1 : this.screenStride() + CLOCK_EARLY_FRAMES));
  }

  /** Media time the clock jumps at seg's end: just before the compositor
   *  could pick the first cut frame (the pick lead ahead of the clock),
   *  less the reach and the timers' slack — never before the clock's bound.
   *  (Round 4 also took off how late animation frames came: the bound then,
   *  before the last kept frame was picked at a quarter of all joins on two
   *  workers.) */
  private clockDueOf(seg: PlaySeg): number {
    const [, b] = this.framesOf(seg);
    // (above FAST_RATE as late as animation frames come too: round 4's)
    const next = this.rate() > FAST_RATE ? Math.max(this.slackMs(), this.nextCheckMs()) : this.slackMs();
    const lead = (this.leadMs() + this.reachMs() + next) / 1000;
    return Math.max(this.clockFloorOf(seg), this.frameAt(b) - lead * this.rate());
  }

  /**
   * Wall time (performance.now) the seam timer is due at seg's end, by the
   * frame clock: the last safe moment before the clip's first cut frame
   * could be picked — its reach and the timers' slack before its slot —
   * and never sooner than SEAM_AFTER_MS after the last kept frame's slot
   * (it is on screen then, held while the seek lands). A starved decoder
   * runs behind and catches up in a leap, but on the clock's slot of the
   * frame it leaps to (the owner probe at 4× CPU), never ahead of it: the
   * cut frame comes no sooner; the margin (leap) is the frame rule's — the
   * callbacks that might come too late. It covers a frame callback that
   * comes late, a frame the decoder never presents. Infinity: no frame
   * clock (no frame since the landing yet but its first); neither the
   * frames nor the element's clock within the margin's frames of the end
   * (round 4's guard; round 5 had none); the media clock stood since the
   * frame clock's latest frames (buffering: the element's clock stands, no
   * frame comes, the wall clock runs on — round 5's seam fired on the wall
   * clock then, up to four kept frames early) — the frame rule and the
   * clock take the join then.
   */
  private seamAt(seg: PlaySeg): number {
    if (!this.framesLive() || !this.anchors.length) return Infinity;
    const [, b] = this.framesOf(seg);
    const t = this.v.currentTime;
    const from = b - 1 - this.maxEarly();
    if ((this.lastFrameK === null || this.lastFrameK < from) && t < this.frameAt(from)) return Infinity;
    const fm = 1000 / (this.fps() * this.rate());
    const anchor = Math.min(...this.anchors);
    // (by the frame clock the element's clock is past this now: frame b's
    // slot ahead, less how far ahead of the clock frames are picked and a
    // frame and a half — a clock behind that stood; a busy page reads the
    // clock up to ~40 ms stale, at 4× CPU; not while a seek that already
    // landed still says seeking: the clock stands at its target then, the
    // new clip's frames play)
    const ahead = anchor + b * fm - performance.now() + this.leadMs() + fm * 1.5;
    if (!this.landedEarly && t < this.frameAt(b) - (ahead / 1000) * this.rate()) return Infinity;
    const reach = this.reachMs() + this.slackMs();
    const lead = Math.max(reach, SEAM_LEAD_MS);
    let after = anchor + (b - 1) * fm + SEAM_AFTER_MS;
    // (not before the last kept frame is picked where the lead leaves less
    // than a 60 Hz refresh after its slot — at 50 or 48 fps it is picked up
    // to a refresh after it, the cut frame on the next one: round 6's seam
    // came before that pick at half the joins — on the screen's first
    // refresh at or after its slot, while the seek still has its reach and
    // the timers' slack before the first cut frame's pick (12.7 ms; the
    // frame rule's on the last kept frame's callback at 30 fps: 14–15), and
    // never more than a 60 Hz refresh after the slot: a refresh read wrong
    // — 30 Hz animation frames at 4× CPU — never moves it past the cut
    // frame's slot; only where its refresh is measured: floorApplies)
    if (fm - lead < RAF_MS && this.floorApplies()) {
      const last = Math.min(this.pickOn(anchor + (b - 1) * fm), anchor + (b - 1) * fm + RAF_MS) + SEAM_AFTER_MS;
      if (last <= this.pickOn(anchor + b * fm) - reach) after = Math.max(after, last);
    }
    return Math.max(anchor + b * fm - lead, after);
  }

  /** The seam's floor (seamAt) only where its refresh is measured: a
   *  screen both the frames' picks and the animation frames say is 60 Hz,
   *  frames no faster than it at the speed playing. Round 7 had it
   *  wherever the lead left less than a refresh after the slot: on a 90 Hz
   *  screen it read a refresh of 22 ms (picks 11 and 22 ms apart, the
   *  animation frames' refresh taken as 60 Hz's) and held the seam past
   *  the cut frame's pick — cut frames at 60 fps with the timers 5 ms late;
   *  at 50 fps × 1.25 (62.5 frames a second: the compositor skips some)
   *  and with 30 Hz updates (no picks a refresh apart: the refresh taken
   *  for the pick gap) cut frames too. On 60 Hz it stays: without it the
   *  e2e runs showed more cut frames at 1.25x on a 30 fps proxy (7 of 12
   *  runs against 3 of 12, round 8's A/B). Up to 31 frames a second (proxy
   *  mode plays at most 30 fps) it applies as in round 7: gated there, it
   *  was off at jittery desktop picks and the jump came a refresh early —
   *  the last kept frame dropped at 3× round 7's joins in the owner-shaped
   *  runs (round 9 verify). */
  private floorApplies(): boolean {
    if (this.fps() * this.rate() <= 31) return true;
    if (this.fps() * this.rate() > 61 || this.slots.length < 4 || this.tickGaps.length < 4) return false;
    return Math.abs(this.tickGap(0.5, 0) - RAF_MS) < 2 && Math.abs(this.vsyncMs() - RAF_MS) < 2;
  }

  /** When (performance.now) the compositor picks the frame due at `t`: the
   *  first of the screen's refreshes at or after it (on the latest frame's
   *  pick, a refresh apart: vsyncMs). */
  private pickOn(t: number): number {
    const r = this.vsyncMs();
    if (!isFinite(this.lastPickAt)) return t;
    return this.lastPickAt + Math.ceil((t - this.lastPickAt) / r - 0.05) * r;
  }

  /** The screen's refresh as the frames are picked (ms): the picks' usual
   *  gap over the refreshes it spans (a 30 fps video on 60 Hz: 33.3 / 2) —
   *  the animation frames' only until measured (ms-grained, or throttled:
   *  a 30 Hz cadence). */
  private vsyncMs(): number {
    const refresh = this.refreshMs();
    if (this.slots.length < 4) return refresh;
    const med = [...this.slots].sort((x, y) => x - y)[this.slots.length >> 1];
    return med / Math.max(1, Math.round(med / refresh));
  }

  /** The jump at seg's end is due now (animation frames, timers, frame
   *  callbacks): the frame rule for the frame on screen (play starting on
   *  a clip's last frame: no new frame has come yet), the seam (by the
   *  frame clock), or the element's clock. */
  private dueNow(seg: PlaySeg): boolean {
    const [a, b] = this.framesOf(seg);
    const k = this.lastFrameK;
    if (this.rvfc && k !== null && k >= a - 1 && this.ruleNow(k, b)) return true;
    if (performance.now() >= this.seamAt(seg)) return true;
    return this.v.currentTime >= this.clockDueOf(seg) - 0.0005;
  }

  /** Media time the jump at seg's end is expected (the gain ramp's aim):
   *  the first frame the rule jumps on as things are, or the seam's or the
   *  clock's moment. */
  private jumpAtOf(seg: PlaySeg): number {
    let due = this.clockDueOf(seg);
    if (!this.framesLive()) return due;
    const seam = this.seamAt(seg);
    if (isFinite(seam)) due = Math.min(due, this.v.currentTime + ((seam - performance.now()) / 1000) * this.rate());
    const [a, b] = this.framesOf(seg);
    for (let k = Math.max(a, b - 1 - this.maxEarly()); k < b - 1; k++) if (this.ruleNow(k, b)) return Math.min(due, this.frameAt(k));
    return due;
  }

  private tickGap(q: number, lo: number): number {
    if (this.tickGaps.length < 4) return Math.max(lo, RAF_MS);
    const xs = [...this.tickGaps].sort((a, b) => a - b);
    return clamp(xs[Math.floor(xs.length * q)], lo, MAX_REFRESH_MS);
  }

  /** The screen's refresh as the animation frames come (ms; ≥ 60 Hz's). */
  private refreshMs(): number {
    return this.tickGap(0.5, RAF_MS);
  }

  /** How long (wall ms) until the next check (an animation frame), as
   *  late as they have been coming lately. */
  private nextCheckMs(): number {
    return this.tickGap(0.9, this.refreshMs());
  }

  private watchFrames(): void {
    if (!this.rvfc || this.frameHandle) return;
    try {
      this.frameHandle = this.v.requestVideoFrameCallback!(this.onFrame);
    } catch {
      this.rvfc = false;
    }
  }

  /** A frame was presented (requestVideoFrameCallback). */
  private onFrame = (_now: number, md: FrameMeta): void => {
    this.frameHandle = 0;
    this.watchFrames();
    this.frame(md.mediaTime, md.presentedFrames, md.expectedDisplayTime, md.presentationTime ?? NaN);
  };

  private frame(m: number, presented: number, shownAt: number, submittedAt = NaN): void {
    const v = this.v;
    const wall = performance.now();
    // when the compositor picked it: its presentationTime, else a refresh
    // before it is expected on screen
    const pickAt = isFinite(submittedAt) ? submittedAt : isFinite(shownAt) ? shownAt - this.refreshMs() : wall;
    // A frame from before a seek landed (ours, or the native controls'):
    // nothing to learn from it (its step to the landing is no frame
    // stride), nothing to act on. The first one nearer the target lands.
    const ld = this.landing;
    if (ld) {
      if (Math.abs(m - ld.from) < Math.abs(m - ld.to)) {
        // picked after our jump was asked for: the seek took longer than
        // that to reach the pipeline (a browser that doesn't say when a
        // frame was picked: unknown)
        const j = this.jump;
        if (j && isFinite(submittedAt) && submittedAt > j.at) {
          j.late = Math.max(j.late ?? 0, submittedAt - j.at);
          if (this.frameOf(m) >= j.end) j.cut = true;
          // (picked after the jump: the one the seek stopped comes after it)
          j.next = Math.max(j.next, submittedAt + 1000 / (this.fps() * this.rate()));
        }
        return;
      }
      this.landing = null;
      this.landedEarly = v.seeking && this.ourSeek !== null;
      // (the new position on screen: the seek had reached the pipeline)
      if (this.jump && isFinite(submittedAt)) this.jump.next = Math.min(this.jump.next, Math.max(this.jump.at, submittedAt));
      this.landed();
    }
    const playing = !v.paused && !this.seekPending();
    const steady = playing && this.framesSince > 0;
    // presentations since the last one this callback saw (a busy page
    // may run one callback for two)
    const pd = this.lastPresented === null ? 0 : presented - this.lastPresented;
    const consecutive = steady && pd === 1;
    // (a callback that never ran: the main thread stood still)
    if (steady && pd >= 2 && this.longFrames()) this.stallAt = wall;
    // (media time: a frame's step at any speed — rounds 3–5 divided it by
    // the speed: a 2x clip read a 30 fps video as 60, its clips' edges a
    // frame off, cut frames at its joins. Above FAST_RATE a screen that
    // can't show every frame shows every other one — 2x at 60 fps on 60
    // Hz steps two frames each time, like 2x at 30 fps on 60 Hz steps one:
    // there the steps tell the rate only while it comes slower than the
    // screen refreshes, and only until a clip at 1x has told it.)
    if (consecutive && this.fpsOpt === null) {
      const gap = m - this.lastFrameM;
      if (gap > 1 / 121 && gap < 0.2) {
        if (this.rate() <= FAST_RATE) {
          keep(this.frameGaps, gap, 32);
          this.fpsSeen = rateOfGaps(this.frameGaps) ?? this.fpsSeen;
        } else if (rateOfGaps(this.frameGaps) === null) {
          keep(this.fastGaps, gap, 32);
          const r = rateOfGaps(this.fastGaps);
          const was = this.fps();
          if (r && (r * this.rate() * this.refreshMs()) / 1000 <= 0.9) this.fpsSeen = r;
          else if (r) this.fpsLeast = r;
          // (the frame clock and the steps were the old grid's)
          if (this.fps() !== was) this.newSpeed();
        }
      }
    }
    const f = this.fps();
    // the frame grid's offset: what this frame's time is off the grid
    this.phase = m - Math.round(m * f) / f;
    const k = this.frameOf(m);
    if (steady && pd >= 1 && pd <= 3 && this.lastFrameK !== null) {
      // (the step from the media times: the grid's offset is taken anew
      // from every frame)
      const d = Math.round((m - this.lastFrameM) * f);
      // frame steps per presentation (2+ at speed, or where the decoder
      // skipped frames — the next presented one may then be past a clip's
      // last frame)
      if (d >= 1 && d <= 8 * pd) keep(this.strides, Math.ceil(d / pd), 8);
      // frames this callback came too late for (the decoder never
      // presented them, or their callbacks never ran: a busy device):
      // heavy load when that keeps happening (one now and then is no sign
      // of the next), level 2 when it leapt two or more at once meanwhile
      // (the owner probe at 4× CPU: 3–4 frames at once now and then — past
      // a margin of one). Not above FAST_RATE: the time-stretched clock
      // steps unevenly there (2–3 frames after a step of none, idle — round
      // 5 took them for skips, then for two at once, and held two frames'
      // margin into the 1x clips after). A callback that never ran is a
      // sign only where a frame lasts two refreshes (longFrames): at 60
      // fps on 60 Hz one lands either side of a refresh, one for two now
      // and then on an idle machine. Not the first step after a landing
      // either (shownRun 1: the clock starts again there, its first
      // presentation a refresh or two after the landed frame's — at a 30
      // Hz compositor, Chrome's Energy Saver, a step of two at most
      // landings: round 7 counted them, heavy load at every join, two kept
      // frames dropped at ~80 % of them).
      const n = this.longFrames() ? d - this.screenStride() : d - pd * this.screenStride();
      if (n > 0 && d <= 8 * pd && this.rate() <= FAST_RATE && this.shownRun >= 2) {
        keep(this.skips, { at: wall, n }, 32);
        const recent = this.skips.filter((x) => wall - x.at < LEAP_WINDOW_MS);
        // (and over a longer stretch: at 4× CPU a lull of 8 s now and then)
        const long = this.skips.filter((x) => wall - x.at < LEAP_WINDOW_LONG_MS);
        if (recent.length >= HEAVY_LEAPS || long.length >= HEAVY_LEAPS_LONG) this.loaded(1, wall);
        if (n >= 2) this.bigLeapAt = wall;
      }
      // the cadence of picks (not from a landing's first frames: the
      // clock starts again then)
      if (pd === 1 && d >= 1 && this.shownRun >= 2 && pickAt > this.lastPickAt) keep(this.slots, pickAt - this.lastPickAt, SLOT_HISTORY);
    }
    if (playing) {
      keep(this.lags, Math.max(0, wall - pickAt), LOAD_FRAMES);
      // callbacks running late after their frame's pick, again and again,
      // past their cadence: a starved main thread — level 2 when more than
      // a presentation late
      const over = (t: number) => {
        const late = this.lateLagMs(t);
        return this.lags.filter((x) => x > late).length >= HEAVY_LAG_COUNT;
      };
      if (over(HEAVY_LAG_MS)) this.loaded(1, wall);
      if (over(Math.max(this.presMs() - REACH_MS, HEAVY_LAG_MS))) this.loaded(2, wall);
    }
    // how far ahead of the element's clock this frame was picked (not from
    // a landing's first frames: the clock starts again then)
    if (steady && this.shownRun >= 2 && isFinite(submittedAt)) {
      const atPick = v.currentTime - ((wall - pickAt) / 1000) * this.rate();
      const lead = ((m - atPick) / this.rate()) * 1000;
      if (lead > -50 && lead < 200) keep(this.leads, clamp(lead, 0, MAX_LEAD_MS), LEAD_FRAMES);
    }
    if (this.lastPresented !== presented) this.shownRun++;
    // the frame clock (not from a landing's first frame: the clock stands
    // on it a while)
    if (playing && this.shownRun >= 2 && isFinite(pickAt)) keep(this.anchors, pickAt - (k * 1000) / (f * this.rate()), ANCHOR_FRAMES);
    this.lastPresented = presented;
    this.lastFrameK = k;
    this.lastFrameM = m;
    this.lastFrameAt = wall;
    this.lastPickAt = pickAt;
    if (!this.plan.length || this.scrubbing || v.paused || this.seekPending() || this.atEnd) return;
    this.framesSince++;
    this.playFrames++;
    const i = this.idx;
    const seg = this.plan[i];
    if (!seg || seg.id !== this.curId) return;
    const [a, b] = this.framesOf(seg);
    if (k < a - 1) return; // not this clip's footage: tick() finds the place
    if (this.joined(i)) {
      if (k >= b) this.enter(i + 1, null);
      return;
    }
    // the frame rule: on the last kept frame (under load the margin's
    // frames before it); the seam or the clock (a callback come late, a
    // frame the decoder never presented) — or a timer for their moment
    if (this.ruleNow(k, b) || this.dueNow(seg)) this.boundary(i);
    else this.armNear(i);
  }

  // ── internals ────────────────────────────────────────────────────

  /** Our jump landed: how late its old frames came (the seek's reach, at least). */
  private landed(): void {
    const j = this.jump;
    this.jump = null;
    if (!j) return;
    // (a cut frame picked after the jump: the next joins go a frame early
    // whatever it measured — it is only a bound: the pick came then, the
    // seek later still)
    const late = j.late ?? 0;
    const warmBy = j.warm && !j.cut ? REACH_WARM_MS : 0;
    keep(this.reaches, Math.max(0, late - warmBy), REACH_JOINS);
    keep(this.stops, isFinite(j.next) ? Math.max(0, j.next - j.at - warmBy) : Infinity, REACH_JOINS);
    this.reachUnsure = j.warm && late > REACH_MS;
    keep(this.cutJoins, j.cut ? 1 : 0, REACH_JOINS);
  }

  /** A seek is on its way (the element seeking, our seek's frames not yet
   *  on screen). */
  private seekPending(): boolean {
    return this.v.seeking && !this.landedEarly;
  }

  /** A seek to `to` starts: frames until it lands are the old position's. */
  private seekStarts(to: number): void {
    this.landedEarly = false;
    this.landing = { from: this.lastPresented === null ? this.v.currentTime : this.lastFrameM, to };
    this.lastPresented = null;
    this.lastFrameK = null;
    this.framesSince = 0;
    this.shownRun = 0;
    this.anchors = [];
  }

  private disarm(): void {
    this.boundaryTimers.forEach(clearTimeout);
    this.boundaryTimers = [];
    this.boundaryFor = -1;
    this.boundaryAt = NaN;
  }

  /** Wall ms until the seam's or the clock's moment at seg's end. */
  private dueInMs(seg: PlaySeg): number {
    const byClock = ((this.clockDueOf(seg) - this.v.currentTime) / this.rate()) * 1000;
    return Math.max(0, Math.min(byClock, this.seamAt(seg) - performance.now()));
  }

  /** setTimeout, measuring how late it fires (timerFired). */
  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const wait = Math.max(0, ms);
    const due = performance.now() + wait;
    return setTimeout(() => {
      this.timerFired(due);
      fn();
    }, wait);
  }

  /** A player timer due at `due` (performance.now) fired: how late (the
   *  seam's slack). Not a sign of heavy load by itself: on two busy
   *  workers the timers due while a frame is rendered fire 20–37 ms late at
   *  half the joins, the frame callbacks on time. */
  private timerFired(due: number): void {
    keep(this.timerLates, Math.max(0, performance.now() - due), TIMER_HISTORY);
  }

  /** Arm clip i's end (a jump; the last clip's: a pause) when it is near. */
  private armNear(i: number): void {
    const seg = this.plan[i];
    if (!seg || this.joined(i)) return;
    const jumpIn = Math.max(0, ((this.jumpAtOf(seg) - this.v.currentTime) / this.rate()) * 1000);
    const fireIn = this.dueInMs(seg);
    if (Math.min(fireIn, jumpIn) <= BOUNDARY_AHEAD_S * 1000) this.arm(i, fireIn, jumpIn);
  }

  /**
   * Clip i's jump is near: the gain ramp down into it (`jumpIn` ms: the
   * moment it is expected; volume writable), and a timer `fireIn` ms on —
   * the clock's moment (frame callbacks jump on the last kept frame before
   * it, if it is on screen by then). Re-checked when it fires.
   */
  private arm(i: number, fireIn: number, jumpIn: number): void {
    const at = performance.now() + fireIn;
    if (this.boundaryFor === i && Math.abs(this.boundaryAt - at) < 1) return;
    this.disarm();
    this.boundaryFor = i;
    this.boundaryAt = at;
    if (this.rampMs > 0 && this.volumeWritable && this.plan[i + 1]) {
      for (const k of [3, 2, 1]) {
        this.boundaryTimers.push(
          this.later(
            () => {
              const s = this.plan[this.idx];
              if (this.idx === i && s && !this.v.paused) this.applyGain(s, this.v.currentTime);
            },
            jumpIn - this.rampMs * (k / 3),
          ),
        );
      }
    }
    const fire = () => {
      if (this.idx !== i || this.v.paused || this.seekPending() || this.atEnd || this.scrubbing) return;
      const seg = this.plan[i];
      if (!seg) return;
      if (this.dueNow(seg)) {
        this.boundary(i);
        return;
      }
      // early (the clock lags the timer, a newer frame moved the moment): again for the rest
      this.boundaryTimers.push(this.later(fire, clamp(this.dueInMs(seg), 1, BOUNDARY_AHEAD_S * 1000)));
    };
    this.boundaryTimers.push(this.later(fire, fireIn));
  }

  /** Clip i ended: on to the next clip (a seek unless it continues the footage), or the end. */
  private boundary(i: number): void {
    this.disarm();
    const next = this.plan[i + 1];
    if (next && !this.joined(i)) {
      const end = this.framesOf(this.plan[i])[1];
      // the old position's next pick by the frame clock (after the frame on
      // screen): if the seek stops it, the reach is less than the time to it
      const at = performance.now();
      const fm = 1000 / (this.fps() * this.rate());
      const k = this.lastFrameK;
      let next = this.anchors.length && k !== null ? Math.min(...this.anchors) + (k + 1) * fm : Infinity;
      while (next <= at) next += fm;
      this.jump = { at, late: null, warm: this.playFrames < REACH_WARM_FRAMES, end, cut: false, next };
    }
    if (next) this.enter(i + 1, this.joined(i) ? null : this.landOf(next));
    else this.finish();
  }

  private enter(j: number, seekTo: number | null): void {
    // A speed picked in the native controls whose ratechange hasn't
    // fired yet: take it before the clip's speed overwrites it.
    if (Math.abs(this.v.playbackRate - this.applied.rate) > 1e-3) this.onRate();
    const seg = this.plan[j];
    if (j !== this.boundaryFor || seekTo !== null) this.disarm();
    this.idx = j;
    if (this.curId !== seg.id) {
      this.curId = seg.id;
      this.onSegment?.(seg.id);
    }
    // (a jump: the seek first, then the clip's speed — the media thread
    // takes them in that order, the old position's clock stopped for the
    // seek by the time the speed comes. The speed first ran the old
    // position faster while the seek was on its way: at a 1x clip's end
    // before a 1.5x one its next frame — a cut one — was picked within the
    // seek's reach.)
    if (seekTo === null) this.setRate(seg.speed * this.masterRate);
    else {
      this.seekStarts(seekTo);
      this.ourSeek = seekTo;
      if (this.rampMs > 0 && !this.v.paused) {
        this.dipping = true;
        // never stay silent: a seek that reports no "seeked" ends the dip
        this.rampTimers.push(
          this.later(() => {
            if (!this.dipping) return;
            this.dipping = false;
            const s = this.plan[this.idx];
            if (s) this.applyGain(s, this.v.currentTime);
          }, 400),
        );
      }
      try {
        this.v.currentTime = seekTo;
      } catch {
        /* no media yet: the next play re-checks */
      }
      this.setRate(seg.speed * this.masterRate);
    }
    this.applyGain(seg, seekTo ?? this.v.currentTime);
  }

  private parkAtEnd(): void {
    const last = this.plan.length - 1;
    this.enter(last, this.lastOf(this.plan[last]));
    this.finish();
  }

  private finish(): void {
    this.atEnd = true;
    if (!this.v.paused) this.v.pause();
    this.setFade(0);
    // stopped by the clock a little before the last frame (the jump's
    // margin): that frame is what the end shows
    const seg = this.plan[this.idx];
    if (!seg) return;
    const last = this.lastOf(seg);
    if (this.v.currentTime < last - 0.5 / this.fps()) {
      this.seekStarts(last);
      this.ourSeek = last;
      try {
        this.v.currentTime = last;
      } catch {
        /* no media */
      }
    }
  }

  private tick = (): void => {
    const plan = this.plan;
    // a trim edge is on screen: the plan doesn't move the element
    if (!plan.length || this.scrubbing) return;
    const v = this.v;
    const t = v.currentTime;
    const i = this.idx;
    if (i < 0 || i >= plan.length || plan[i].id !== this.curId) {
      this.resync(t);
      return;
    }
    const seg = plan[i];
    if (t < seg.start - 0.25 && !v.seeking) {
      this.resync(t);
      return;
    }
    if (!v.paused && !this.seekPending() && !this.atEnd) {
      if (this.joined(i)) {
        // A split: the next clip continues the same footage — no seek.
        if (t >= seg.end) {
          this.enter(i + 1, null);
          return;
        }
      } else {
        // Frame callbacks jump on the last kept frame; this is the
        // backstop at the last safe moment (a frame never presented), or
        // the clock one frame early without callbacks.
        if (this.dueNow(seg)) {
          this.boundary(i);
          return;
        }
        this.armNear(i);
      }
    }
    this.applyGain(seg, t);
  };

  /** Find our place again from the element's position. */
  private resync(t: number): void {
    const plan = this.plan;
    if (!plan.length) return;
    const j = locate(plan, t, this.curId);
    if (j >= 0) {
      this.enter(j, null);
      return;
    }
    const k = nextInSource(plan, t);
    if (k >= 0) this.enter(k, this.landOf(plan[k]));
    else this.parkAtEnd();
  }

  private loop = (): void => {
    const now = performance.now();
    if (this.lastTickAt !== null) {
      keep(this.tickGaps, now - this.lastTickAt, 24);
      if (now - this.lastTickAt > STALL_GAP_MS && !this.v.paused) this.stallAt = now;
    }
    this.lastTickAt = now;
    this.tick();
    this.raf = requestAnimationFrame(this.loop);
  };

  private startLoop(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastTickAt = null;
  }

  private onPlay = (): void => {
    // play ends a scrub (the trim was let go, or the user pressed play)
    this.scrubbing = false;
    this.scrubWant = null;
    this.framesSince = 0;
    this.playFrames = 0;
    // (the clock starts a while after play, like after a landing)
    this.shownRun = 0;
    this.anchors = [];
    this.watchFrames();
    const plan = this.plan;
    if (plan.length) {
      if (this.atEnd) {
        this.atEnd = false;
        this.enter(0, this.landOf(plan[0])); // play again from the top
      } else {
        this.tick();
      }
    }
    this.startLoop();
  };

  private onPause = (): void => {
    this.stopLoop();
    this.disarm();
    this.framesSince = 0;
    this.anchors = [];
    this.setFade(0);
  };

  private onEnded = (): void => {
    // a trim edge shown at the media's end: not playback reaching it
    if (this.scrubbing) return;
    // The source ran out before the tick jumped (a late frame, or a clip
    // reaching past the media's real end): more clips may follow.
    const next = this.plan[this.idx + 1];
    if (this.idx >= 0 && next) {
      this.enter(this.idx + 1, this.landOf(next));
      this.v.play().catch(() => {});
      return;
    }
    this.atEnd = true;
    this.stopLoop();
    this.setFade(0);
  };

  private onSeeking = (): void => {
    const t = this.v.currentTime;
    this.framesSince = 0;
    const ours = this.ourSeek !== null && Math.abs(t - this.ourSeek) < 0.05;
    if (!ours) {
      this.jump = null;
      this.seekStarts(t);
    }
    if (this.scrubbing) return;
    this.disarm();
    if (ours) return;
    // The native scrubber (source time) or the browser restarting an
    // ended video: map it onto the edit.
    const plan = this.plan;
    if (!plan.length) return;
    if (this.atEnd) {
      this.atEnd = false;
      if (t < 0.1) {
        this.enter(0, this.landOf(plan[0]));
        return;
      }
    }
    this.resync(t);
  };

  private onSeeked = (): void => {
    this.ourSeek = null;
    this.landedEarly = false;
    this.watchFrames();
    if (this.scrubbing) {
      // the newest edge position asked for meanwhile
      const w = this.scrubWant;
      this.scrubWant = null;
      if (w !== null && Math.abs(w - this.v.currentTime) > 1e-4) {
        this.ourSeek = w;
        this.v.currentTime = w;
      }
      return;
    }
    if (this.dipping) {
      // landed: the gain comes back over rampMs (a few steps, not per frame)
      this.dipping = false;
      this.landedAt = performance.now();
      this.rampTimers.forEach(clearTimeout);
      this.rampTimers = [1, 2, 3].map((k) =>
        this.later(() => {
          const s = this.plan[this.idx];
          if (s) this.applyGain(s, this.v.currentTime);
        }, (this.rampMs * k) / 3),
      );
    }
    const seg = this.plan[this.idx];
    if (seg) this.applyGain(seg, this.v.currentTime);
  };

  private onMeta = (): void => {
    // A seek set before the metadata arrived may have been dropped.
    const seg = this.plan[this.idx];
    if (!seg) return;
    const t = this.v.currentTime;
    if (t < seg.start - EDGE || t >= seg.end) this.enter(this.idx, this.landOf(seg));
    else this.setRate(seg.speed * this.masterRate);
  };

  private onVolume = (): void => {
    const v = this.v;
    if (v.muted !== this.applied.muted) this.userMuted = v.muted;
    if (Math.abs(v.volume - this.applied.volume) > 0.01) {
      this.masterVolume = this.gain > 0.01 ? clamp(v.volume / this.gain, 0, 1) : v.volume;
    }
    this.applied.volume = v.volume;
    this.applied.muted = v.muted;
  };

  private onRate = (): void => {
    const r = this.v.playbackRate;
    if (this.v.readyState === 0) {
      // A (re)load resetting the rate — not the user. onMeta re-applies.
      this.applied.rate = r;
      return;
    }
    if (Math.abs(r - this.applied.rate) > 1e-3) {
      // Speed picked in the native controls (browsers that ignore
      // controlsList="noplaybackrate"): the menu shows and sets the
      // element's absolute rate, so take it as the master speed ("Normal"
      // = 1x master). It holds for the rest of this clip; later clips
      // play at their own speed x this.
      this.masterRate = clamp(r, 0.25, 4);
      this.applied.rate = r;
      // (the frame clock and the steps were the old speed's: round 5 kept
      // them — the seam at the old speed's slots, a clip's last two
      // seconds skipped at a change from 1x to 2x)
      this.newSpeed();
    }
  };

  private setRate(r: number): void {
    r = clamp(r, 0.0625, 16);
    this.applied.rate = r;
    if (Math.abs(this.v.playbackRate - r) > 1e-3) {
      try {
        this.v.playbackRate = r;
      } catch {
        /* unsupported rate */
      }
      this.newSpeed();
    }
  }

  /** A new speed: the old frame steps, their cadence and the frame clock
   *  (its slots a frame at the old speed apart) no longer say anything. */
  private newSpeed(): void {
    this.strides = [];
    this.slots = [];
    this.leads = [];
    this.anchors = [];
  }

  private applyGain(seg: PlaySeg, t: number): void {
    const v = this.v;
    // A change from the native controls whose volumechange hasn't fired
    // yet (a frame can run first): take it before overwriting it.
    if (v.muted !== this.applied.muted || Math.abs(v.volume - this.applied.volume) > 0.01) {
      this.onVolume();
    }
    const fade = fadeLevel(seg, t);
    const g = seg.volume * fade;
    this.gain = g;
    const muted = this.userMuted || g <= 0.001;
    if (v.muted !== muted) v.muted = muted;
    if (!muted && this.volumeWritable) {
      const want = clamp(this.masterVolume * g * this.rampLevel(seg, t), 0, 1);
      if (Math.abs(v.volume - want) > 0.004) {
        try {
          v.volume = want;
        } catch {
          /* ignore */
        }
        // iOS: volume is read-only (always 1).
        if (Math.abs(v.volume - want) > 0.004) this.volumeWritable = false;
      }
    }
    this.applied.volume = v.volume;
    this.applied.muted = v.muted;
    this.setFade(v.paused ? 0 : 1 - fade);
  }

  /** The seek dip at this moment (seekRampLevel; 1 without a ramp). */
  private rampLevel(seg: PlaySeg, t: number): number {
    if (!(this.rampMs > 0)) return 1;
    const since = this.landedAt === null ? null : performance.now() - this.landedAt;
    if (since !== null && since >= this.rampMs) this.landedAt = null;
    const i = this.idx;
    const jumps = !!this.plan[i + 1] && this.plan[i] === seg && !this.joined(i) && !this.v.paused;
    // down into the moment the jump is due (jumpAtOf)
    const toJump = jumps ? Math.max(0, (this.jumpAtOf(seg) - t) / this.rate()) : null;
    return seekRampLevel(this.rampMs, this.dipping, this.landedAt === null ? null : since, toJump);
  }

  private setFade(opacity: number): void {
    const o = Math.round(opacity * 100) / 100;
    if (!this.fadeEl || o === this.fadeOpacity) return;
    this.fadeOpacity = o;
    this.fadeEl.style.opacity = String(o);
  }
}
