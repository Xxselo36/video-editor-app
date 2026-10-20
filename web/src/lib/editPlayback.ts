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
 * round(end·fps))). Where the browser reports presented frames
 * (requestVideoFrameCallback: Chrome, Safari 15.4+) the jump to the next
 * clip goes on the clip's LAST frame — the moment it is on screen, before
 * the next (cut) frame can be — and a frame or two earlier while the
 * decoder skips frames (a busy device) or above 1.25x. The clock backs
 * that up at every animation frame: the compositor picks a frame one
 * refresh (or, drawing slower, one draw) ahead and a seek takes a few ms
 * to reach the decoder, so a check jumps once the next check — as late as
 * animation frames have been coming — could be too late for the first cut
 * frame. That clock is the element's, or the last shown frame's time plus
 * the time since, when that is further on (a busy device's clock reads
 * behind what it shows). Without frame callbacks the clock jumps one frame
 * early. Round 3: the first frames and the first joins after play go a
 * frame early (the renderer starting up; a probe of how fast seeks reach
 * the decoder), and every join measures that: where frames of the old
 * position still come after a jump (a slow media pipeline), the jumps go
 * as many frames earlier (WARM_FRAMES, PROBE_JOINS, LAG_JOINS). Landings go a little into the next clip's first frame (a seek
 * shows the frame under the target time: exactly on the edge, a container
 * offset of a few ms showed the cut frame before it). Cut footage is never
 * on screen and never heard; at a join at most the last kept frame (≤
 * 1/fps of picture and sound) is skipped. Where the element's volume is
 * writable a short gain ramp (rampMs) runs down into the jump and up after
 * the landing — a ramp, never a mute; iOS Safari (volume read-only) gets
 * the timing only. The proxy's keyframe interval bounds the seek cost
 * (≈ 1 s GOP recommended). Clips that continue the same footage (a split,
 * the same frame) need no seek at all.
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
/**
 * The compositor picks the frame for the screen one display refresh before
 * it shows, and a seek needs a few ms (this, wall) to reach the decoder: a
 * jump later than refresh + SEEK_MS before a frame's time can't stop it.
 */
export const SEEK_MS = 8;
/** The clock fallback (no frame callbacks) jumps this far before the last
 *  kept frame (frames): one frame early, with room for a late timer. */
export const CLOCK_EARLY_FRAMES = 0.25;
/** Animation frames come at least this often (ms; a 60 Hz screen): the
 *  refresh assumed until measured, and the least one assumed. */
const RAF_MS = 16.7;
/** The next check is assumed at most this late (ms): a main thread busier
 *  than that can't be helped by jumping earlier still. */
const MAX_CHECK_MS = 50;
/** Above this speed the element's clock (the time-stretched audio's)
 *  moves in steps of a few frames now and then: one frame more room. */
const FAST_RATE = 1.25;
/** The decoder skipped frames within this long (ms): the jumps go a frame earlier. */
const SKIP_WINDOW_MS = 2000;
/** The clock read from the frames on screen runs at most this far (frames)
 *  ahead of the element's own (a device that paused the clock to catch up). */
const SHOWN_AHEAD_FRAMES = 2;
/** The first frames after play starts come while the renderer starts up:
 *  a busy device presents them late and then leaps a frame, the element's
 *  clock reads behind them, and no cadence is known yet (the e2e run showed
 *  the first join's cut frame then). Until this many have been presented
 *  the jumps go one frame earlier (at most the last kept frame of the clip
 *  playing at the start is skipped). */
const WARM_FRAMES = 4;
/**
 * The frame rule assumes a seek reaches the decoder before the next frame
 * is handed to the compositor (at 1x ~33 ms after a frame's callback).
 * Where it takes longer — a busy device, a slow media pipeline; the e2e
 * runs under load measured 30–60 ms — frames from before a jump are still
 * presented after it. Every join measures that: frames of the old position
 * handed over after the jump was asked for (presentationTime; later than
 * the SEEK_MS a seek may take), counted from the frame on screen then. The frame rule then jumps that many frames
 * earlier (the most any of the latest LAG_JOINS joins needed, at most
 * MAX_LAG_FRAMES). The first PROBE_JOINS joins after play start jump a
 * frame early anyway, so a slow pipeline shows on a kept frame there
 * before it could on a cut one.
 */
const PROBE_JOINS = 2;
const LAG_JOINS = 8;
const MAX_LAG_FRAMES = 2;
/** The frames right after a seek landed come while the clock starts again
 *  (late, then a few at once): on the landing frame and the one after it
 *  the frame rule goes a frame early. Only a clip of 3 frames or less
 *  ends that soon (its last kept frame may go); the full e2e run showed
 *  the cut frame after such a clip. */
const LAND_WARM_FRAMES = 2;

/**
 * A clip's frames on the render's grid (backend captions_v2.clip_plan):
 * [first, end) — frame k shows source [k/fps, (k+1)/fps). A tie falls on
 * the safe side: the clip starts later, ends earlier.
 */
export function clipFrames(seg: { start: number; end: number }, fps: number): [number, number] {
  return [Math.round(seg.start * fps + 1e-6), Math.round(seg.end * fps - 1e-6)];
}

/**
 * wordcuts10: frame k of a clip whose frames end before `end` is on the
 * screen and the next presented frame comes `stride` frames on — jump now,
 * so no frame from `end` on is ever shown? `early` frames sooner (frame
 * callbacks running late).
 */
export function jumpOnFrame(k: number, end: number, stride = 1, early = 0): boolean {
  return k + Math.max(1, stride) + Math.max(0, early) >= end;
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

const keep = (xs: number[], x: number, n: number) => {
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
   *  media time of the jump they are for. */
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
  /** Media-time offset of the frame grid (a container's start offset,
   *  under half a frame), learned from presented frames. */
  private phase: number | null = null;
  /** requestVideoFrameCallback: supported, its pending handle. */
  private rvfc: boolean;
  private frameHandle = 0;
  /** The last presented frame: when its callback ran and when it went on
   *  screen (performance.now), its count, index, time. */
  private lastFrameAt = -Infinity;
  private lastShownAt = -Infinity;
  private lastPresented: number | null = null;
  private lastFrameK: number | null = null;
  private lastFrameM = 0;
  /** Frames presented since play or our last seek. */
  private framesSince = 0;
  /** Frames presented since play started (seeks don't reset it): WARM_FRAMES. */
  private playFrames = 0;
  /** Our jumps at clip ends since play started (PROBE_JOINS). */
  private joinsSincePlay = 0;
  /** How many frames of the old position the latest joins still showed
   *  after their jump was asked for (0: none), newest last. */
  private lags: number[] = [];
  /** The jump at a clip end on its way: when it was asked for (wall), the
   *  frame then on screen, the latest frame of the old position presented
   *  after it (null: none so far). */
  private jump: { at: number; from: number; late: number | null } | null = null;
  /** A seek on its way: from where (media time of the frame then on
   *  screen) to where. Frames nearer `from` are from before it. */
  private landing: { from: number; to: number } | null = null;
  /** Frames presented since the last seek landed (the landing one is 1). */
  private shownRun = 0;
  /** Recent wall gaps (ms) between frames going on screen one after the
   *  other: how often the compositor draws, when that is slower than the
   *  video's frames come (a busy device). */
  private shownGaps: number[] = [];
  /** Recent frame steps between presentations. */
  private strides: number[] = [];
  /** Recent gaps (wall ms) between animation frames while playing: how
   *  soon the next check comes; and when the last one ran. */
  private tickGaps: number[] = [];
  private lastTickAt: number | null = null;
  /** When (performance.now) the decoder lately skipped frames while
   *  playing (decoded too late, a busy device): the next presented frame
   *  may come two or more on, past a clip's last one. */
  private skips: number[] = [];

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
    return this.fpsOpt ?? this.fpsSeen ?? DEFAULT_FPS;
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
    return clipFrames(seg, this.fps());
  }

  /** Where a jump into seg lands: a little into its first frame. */
  private landOf(seg: PlaySeg): number {
    const [a, b] = this.framesOf(seg);
    if (b <= a) return seg.start;
    const into = this.phase === null ? BLIND_FRAMES : LAND_FRAMES;
    return Math.min(this.frameAt(a) + into / this.fps(), this.lastOf(seg));
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

  /** The usual step: a screen shows at most one frame per refresh. */
  private screenStride(): number {
    const usual = this.strides.length ? [...this.strides].sort((a, b) => a - b)[this.strides.length >> 1] : 1;
    return Math.max(1, usual, Math.ceil((this.rate() * this.fps() * this.refreshMs()) / 1000 - 0.01));
  }

  /** Frames to jump early by at a clip's last frame: one while the decoder
   *  has lately been skipping frames (the next one shown may be two on),
   *  two while it keeps doing so, one more above FAST_RATE; else none —
   *  late frame callbacks are the clock's to cover. */
  private earlyFrames(): number {
    const now = performance.now();
    while (this.skips.length && now - this.skips[0] > SKIP_WINDOW_MS) this.skips.shift();
    const n = this.skips.length;
    // (without frame callbacks the clock's own margin covers the start,
    // and nothing tells how late a seek came)
    const warm = this.rvfc && this.playFrames < WARM_FRAMES ? 1 : 0;
    return Math.max(n >= 3 ? 2 : n > 0 ? 1 : 0, warm) + (this.rate() > FAST_RATE ? 1 : 0);
  }

  /** The frame rule's: earlyFrames, a frame on the first joins after play
   *  (PROBE_JOINS: a late seek shows on a kept frame there, not a cut
   *  one) and on a landing's first frames (LAND_WARM_FRAMES), and the
   *  frames late seeks still showed lately. (Not the
   *  clock's: it is the backstop for missed callbacks, with its own
   *  margin; shifted too it would jump a frame before the rule.) */
  private ruleEarly(): number {
    const probe = this.rvfc && (this.joinsSincePlay < PROBE_JOINS || (this.shownRun > 0 && this.shownRun <= LAND_WARM_FRAMES)) ? 1 : 0;
    return Math.max(this.earlyFrames(), probe, ...this.lags);
  }

  /** Media time the jump at seg's end is due by the clock (animation
   *  frames, timers): when the next check could come too late for the
   *  first cut frame; without frame callbacks also CLOCK_EARLY_FRAMES
   *  before the last kept frame. */
  private clockDueOf(seg: PlaySeg): number {
    const byClock = this.dueBy(seg, this.nextCheckMs());
    if (this.framesLive()) return byClock;
    const [, b] = this.framesOf(seg);
    return Math.min(this.frameAt(b - 1 - CLOCK_EARLY_FRAMES), byClock);
  }

  /** Media time the jump at seg's end is expected (the gain ramp's aim):
   *  its last frame's callback (earlier at speed or running late), or the
   *  clock's moment, whichever comes first. */
  private jumpAtOf(seg: PlaySeg): number {
    const due = this.clockDueOf(seg);
    if (!this.framesLive()) return due;
    const [, b] = this.framesOf(seg);
    return Math.min(this.frameAt(b - this.stride() - this.ruleEarly()), due);
  }

  /**
   * The media time by which a check that runs again in `nextMs` (wall)
   * has to jump: after it, the media clock could reach seg's first cut
   * frame before the next check — and the compositor picks a frame one
   * refresh ahead, the seek takes SEEK_MS to reach the decoder (as many
   * frames sooner as the frame rule goes early: a struggling decoder,
   * above FAST_RATE).
   */
  private dueBy(seg: PlaySeg, nextMs: number): number {
    const [, b] = this.framesOf(seg);
    return this.frameAt(b - this.earlyFrames()) - ((nextMs + this.refreshMs() + SEEK_MS) / 1000) * this.rate();
  }

  private tickGap(q: number, lo: number): number {
    if (this.tickGaps.length < 4) return Math.max(lo, RAF_MS);
    const xs = [...this.tickGaps].sort((a, b) => a - b);
    return clamp(xs[Math.floor(xs.length * q)], lo, MAX_CHECK_MS);
  }

  /** The screen's refresh as the animation frames come (ms; ≥ 60 Hz's) —
   *  or how often the compositor draws, when that is slower than the
   *  video's frames come (it picks a frame one draw ahead). */
  private refreshMs(): number {
    const raf = this.tickGap(0.5, RAF_MS);
    if (this.shownGaps.length < 4) return raf;
    const draw = Math.min(...this.shownGaps);
    const content = 1000 / (this.fps() * this.rate());
    return draw > content * 1.15 ? Math.max(raf, Math.min(draw, MAX_CHECK_MS)) : raf;
  }

  /** How long (wall ms) until the next check (an animation frame), as
   *  late as they have been coming lately. */
  private nextCheckMs(): number {
    return this.tickGap(0.9, this.refreshMs());
  }

  /**
   * The media position now: the element's clock, or — when that reads
   * behind the frames being shown (a busy device: the clock catches up in
   * steps) — the last shown frame's time plus the wall time since it went
   * on screen, at most SHOWN_AHEAD_FRAMES ahead of the element's clock.
   * Not from a landing's first frame: the clock often starts a while
   * after it is up.
   */
  private clockNow(): number {
    const t = this.v.currentTime;
    if (this.shownRun < 2 || this.lastPresented === null || !this.framesLive() || !isFinite(this.lastShownAt)) return t;
    const shown = this.lastFrameM + ((performance.now() - this.lastShownAt) / 1000) * this.rate();
    return Math.max(t, Math.min(shown, t + SHOWN_AHEAD_FRAMES / this.fps()));
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
    // A frame from before a seek landed (ours, or the native controls'):
    // nothing to learn from it (its step to the landing is no frame
    // stride), nothing to act on. The first one nearer the target lands.
    const ld = this.landing;
    if (ld) {
      if (Math.abs(m - ld.from) < Math.abs(m - ld.to)) {
        // handed over well after our jump was asked for (more than the
        // SEEK_MS a seek may take): the seek came late (a browser that
        // doesn't say when a frame was presented: unknown)
        const j = this.jump;
        if (j && isFinite(submittedAt) && submittedAt > j.at + SEEK_MS) j.late = Math.max(j.late ?? -Infinity, this.frameOf(m));
        return;
      }
      this.landing = null;
      this.landed();
    }
    const steady = !v.paused && !v.seeking && this.framesSince > 0;
    const consecutive = steady && this.lastPresented !== null && presented - this.lastPresented === 1;
    if (consecutive && this.fpsOpt === null) {
      const gap = (m - this.lastFrameM) / this.rate();
      if (gap > 1 / 121 && gap < 0.2) {
        keep(this.frameGaps, gap, 16);
        if (this.frameGaps.length >= 4) this.fpsSeen = 1 / Math.min(...this.frameGaps);
      }
    }
    const f = this.fps();
    // the frame grid's offset: what this frame's time is off the grid
    this.phase = m - Math.round(m * f) / f;
    const k = this.frameOf(m);
    if (consecutive && this.lastFrameK !== null) {
      const d = k - this.lastFrameK;
      if (this.shownRun >= 2 && isFinite(shownAt) && isFinite(this.lastShownAt) && shownAt > this.lastShownAt) {
        keep(this.shownGaps, shownAt - this.lastShownAt, 12);
      }
      // frames the decoder never presented (decoded too late, a busy
      // device): the next skip may jump past a clip's last frame
      if (d > this.screenStride() && d <= 8) keep(this.skips, wall, 8);
      if (d >= 1 && d <= 8) keep(this.strides, d, 8);
    }
    if (this.lastPresented !== presented) this.shownRun++;
    this.lastPresented = presented;
    this.lastFrameK = k;
    this.lastFrameM = m;
    this.lastFrameAt = wall;
    this.lastShownAt = isFinite(shownAt) ? shownAt : wall;
    if (!this.plan.length || this.scrubbing || v.paused || v.seeking || this.atEnd) return;
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
    // the frame rule, and the clock: a busy page shows frames late (the
    // clock runs ahead of them) — would the next check come too late?
    const t = Math.max(m, this.clockNow());
    if (jumpOnFrame(k, b, this.stride(), this.ruleEarly()) || t >= this.clockDueOf(seg)) this.boundary(i);
    else this.armNear(i, t);
  }

  // ── internals ────────────────────────────────────────────────────

  /** Our jump landed: what its late frames (if any) say about the next ones. */
  private landed(): void {
    const j = this.jump;
    this.jump = null;
    if (!j) return;
    keep(this.lags, j.late === null ? 0 : clamp(j.late - j.from, 0, MAX_LAG_FRAMES), LAG_JOINS);
  }

  /** A seek to `to` starts: frames until it lands are the old position's. */
  private seekStarts(to: number): void {
    this.landing = { from: this.lastPresented === null ? this.v.currentTime : this.lastFrameM, to };
    this.lastPresented = null;
    this.lastFrameK = null;
    this.framesSince = 0;
    this.shownRun = 0;
  }

  private disarm(): void {
    this.boundaryTimers.forEach(clearTimeout);
    this.boundaryTimers = [];
    this.boundaryFor = -1;
    this.boundaryAt = NaN;
  }

  /** Arm clip i's end when its jump is near. */
  private armNear(i: number, t: number): void {
    const seg = this.plan[i];
    if (!seg || this.joined(i) || !this.plan[i + 1]) {
      if (seg && !this.plan[i + 1]) this.armEnd(i, t);
      return;
    }
    const at = this.jumpAtOf(seg);
    const left = (at - t) / this.rate();
    if (left <= BOUNDARY_AHEAD_S) this.arm(i, at, t);
  }

  /** The last clip: its end is a jump to the end (a pause), armed the same way. */
  private armEnd(i: number, t: number): void {
    const seg = this.plan[i];
    const at = this.jumpAtOf(seg);
    if ((at - t) / this.rate() <= BOUNDARY_AHEAD_S) this.arm(i, at, t);
  }

  /**
   * Clip i's jump is due at media time `at` (under BOUNDARY_AHEAD_S away):
   * the gain ramp down into it (volume writable), and a timer for the jump
   * — with frame callbacks a backstop at the last safe moment (they and
   * the animation frames jump on time; a timer between two refreshes
   * jumping at the clock's moment would drop the last frame for nothing),
   * else the clock's moment. Re-checked against the clock when they fire.
   */
  private arm(i: number, at: number, t: number): void {
    if (this.boundaryFor === i && Math.abs(this.boundaryAt - at) < 0.001) return;
    this.disarm();
    this.boundaryFor = i;
    this.boundaryAt = at;
    const rate = this.rate();
    const ms = (x: number) => Math.max(0, x * 1000);
    const left = (at - t) / rate;
    if (this.rampMs > 0 && this.volumeWritable) {
      for (const k of [3, 2, 1]) {
        this.boundaryTimers.push(
          setTimeout(() => {
            const s = this.plan[this.idx];
            if (this.idx === i && s && !this.v.paused) this.applyGain(s, this.v.currentTime);
          }, ms(left - (this.rampMs / 1000) * (k / 3))),
        );
      }
    }
    const fire = () => {
      if (this.idx !== i || this.v.paused || this.v.seeking || this.atEnd || this.scrubbing) return;
      const seg = this.plan[i];
      if (!seg) return;
      const due = this.framesLive() ? this.dueBy(seg, 0) : this.clockDueOf(seg);
      const rest = (due - this.clockNow()) / this.rate();
      // early (the clock lags the timer): wait for the rest
      if (rest > 0.002) {
        this.boundaryTimers.push(setTimeout(fire, ms(rest)));
        return;
      }
      this.boundary(i);
    };
    this.boundaryTimers.push(setTimeout(fire, ms(left)));
  }

  /** Clip i ended: on to the next clip (a seek unless it continues the footage), or the end. */
  private boundary(i: number): void {
    this.disarm();
    const next = this.plan[i + 1];
    if (next && !this.joined(i)) {
      this.joinsSincePlay++;
      const from = this.lastFrameK;
      this.jump = from === null ? null : { at: performance.now(), from, late: null };
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
    this.setRate(seg.speed * this.masterRate);
    if (seekTo !== null) {
      this.seekStarts(seekTo);
      this.ourSeek = seekTo;
      if (this.rampMs > 0 && !this.v.paused) {
        this.dipping = true;
        // never stay silent: a seek that reports no "seeked" ends the dip
        this.rampTimers.push(
          setTimeout(() => {
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
    if (!v.paused && !v.seeking && !this.atEnd) {
      if (this.joined(i)) {
        // A split: the next clip continues the same footage — no seek.
        if (t >= seg.end) {
          this.enter(i + 1, null);
          return;
        }
      } else {
        // Frame callbacks jump on the last frame; the clock jumps when the
        // next animation frame could be too late (frames the decoder
        // skips, late callbacks), or one frame early without callbacks.
        if (this.clockNow() >= this.clockDueOf(seg) - 0.001) {
          this.boundary(i);
          return;
        }
        this.armNear(i, t);
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
    if (this.lastTickAt !== null) keep(this.tickGaps, now - this.lastTickAt, 24);
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
    this.joinsSincePlay = 0;
    // (the clock starts a while after play, like after a landing)
    this.shownRun = 0;
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
        setTimeout(() => {
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
      // a new speed: the old frame steps no longer say anything
      this.strides = [];
      this.shownGaps = [];
    }
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
