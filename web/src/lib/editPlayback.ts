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
 * 720p decoders also double memory and battery on phones. So the jump
 * is started about one frame early (≥ one 30 fps frame / 1.5 display
 * frames of wall time, ≤ 50 ms), which hides the seek on Android Chrome
 * and desktop and keeps it short on iOS. The proxy's keyframe interval
 * bounds the seek cost there (≈ 1 s GOP recommended).
 * Clips that continue the same footage (a split) need no seek at all.
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
};

/**
 * Drives one <video> (whose src is the proxy) through the edit plan.
 * Everything runs on the element directly — no React state per frame.
 */
export class EditPlayer {
  private v: HTMLVideoElement;
  private plan: PlaySeg[] = [];
  private idx = -1;
  private curId: string | null = null;
  // Stopped at the end of the timeline: the next play starts over.
  private atEnd = false;
  private raf = 0;
  private lastFrame = 0;
  private frameDt = 1 / 60;
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

  constructor(video: HTMLVideoElement, opts: EditPlayerOptions = {}) {
    this.v = video;
    this.onSegment = opts.onSegment;
    this.fadeEl = opts.fadeEl ?? null;
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
    if (!video.paused) this.startLoop();
  }

  destroy(): void {
    this.off();
    this.stopLoop();
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

  /** New edit list. Keeps playing the same clip when it survived the
   *  edit; otherwise continues where that clip's place now is. */
  setPlan(plan: PlaySeg[]): void {
    const old = this.plan;
    this.plan = plan;
    if (!plan.length) {
      this.idx = -1;
      return;
    }
    const t = this.v.currentTime;
    if (this.curId === null) {
      this.enter(0, Math.abs(t - plan[0].start) > EDGE ? plan[0].start : null);
      return;
    }
    const j = plan.findIndex((s) => s.id === this.curId);
    if (j >= 0) {
      const s = plan[j];
      if (t < s.start - EDGE) this.enter(j, s.start); // trimmed past the playhead
      else if (t < s.end || this.atEnd) this.enter(j, null); // effects changed
      else if (j + 1 < plan.length) this.enter(j + 1, plan[j + 1].start);
      else this.parkAtEnd();
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
        this.enter(m, plan[m].start);
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
    const s = plan[j];
    this.atEnd = false;
    // Not ON the end: that frame is already the first cut-out one.
    this.enter(j, clamp(t, s.start, Math.max(s.start, s.end - 0.001)));
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
    this.enter(j, t);
    return true;
  }

  // ── internals ────────────────────────────────────────────────────

  private enter(j: number, seekTo: number | null): void {
    // A speed picked in the native controls whose ratechange hasn't
    // fired yet: take it before the clip's speed overwrites it.
    if (Math.abs(this.v.playbackRate - this.applied.rate) > 1e-3) this.onRate();
    const seg = this.plan[j];
    this.idx = j;
    if (this.curId !== seg.id) {
      this.curId = seg.id;
      this.onSegment?.(seg.id);
    }
    this.setRate(seg.speed * this.masterRate);
    if (seekTo !== null) {
      this.ourSeek = seekTo;
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
    this.enter(last, Math.max(this.plan[last].start, this.plan[last].end - 0.001));
    this.finish();
  }

  private finish(): void {
    this.atEnd = true;
    if (!this.v.paused) this.v.pause();
    this.setFade(0);
  }

  private tick = (): void => {
    const plan = this.plan;
    if (!plan.length) return;
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
      const next = plan[i + 1];
      // A split: the next clip continues the same footage — no seek.
      const joined = !!next && Math.abs(next.start - seg.end) < EDGE;
      const rate = v.playbackRate > 0 ? v.playbackRate : 1;
      // Jump up to a frame early rather than show a frame of the cut:
      // one video frame (30 fps), more when the display runs slower or
      // frames arrive late (a late tick must not land past the end).
      const lead = Math.min(0.05, Math.max(1 / 30, this.frameDt * 1.5));
      if (joined ? t >= seg.end : (seg.end - t) / rate <= lead) {
        if (next) this.enter(i + 1, joined ? null : next.start);
        else this.finish();
        return;
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
    if (k >= 0) this.enter(k, plan[k].start);
    else this.parkAtEnd();
  }

  private loop = (now: number): void => {
    if (this.lastFrame) {
      const dt = (now - this.lastFrame) / 1000;
      this.frameDt = clamp(this.frameDt * 0.8 + dt * 0.2, 1 / 240, 1 / 15);
    }
    this.lastFrame = now;
    this.tick();
    this.raf = requestAnimationFrame(this.loop);
  };

  private startLoop(): void {
    if (this.raf) return;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private onPlay = (): void => {
    const plan = this.plan;
    if (plan.length) {
      if (this.atEnd) {
        this.atEnd = false;
        this.enter(0, plan[0].start); // play again from the top
      } else {
        this.tick();
      }
    }
    this.startLoop();
  };

  private onPause = (): void => {
    this.stopLoop();
    this.setFade(0);
  };

  private onEnded = (): void => {
    // The source ran out before the tick jumped (a late frame, or a clip
    // reaching past the media's real end): more clips may follow.
    const next = this.plan[this.idx + 1];
    if (this.idx >= 0 && next) {
      this.enter(this.idx + 1, next.start);
      this.v.play().catch(() => {});
      return;
    }
    this.atEnd = true;
    this.stopLoop();
    this.setFade(0);
  };

  private onSeeking = (): void => {
    const t = this.v.currentTime;
    if (this.ourSeek !== null && Math.abs(t - this.ourSeek) < 0.05) return;
    // The native scrubber (source time) or the browser restarting an
    // ended video: map it onto the edit.
    const plan = this.plan;
    if (!plan.length) return;
    if (this.atEnd) {
      this.atEnd = false;
      if (t < 0.1) {
        this.enter(0, plan[0].start);
        return;
      }
    }
    this.resync(t);
  };

  private onSeeked = (): void => {
    this.ourSeek = null;
    const seg = this.plan[this.idx];
    if (seg) this.applyGain(seg, this.v.currentTime);
  };

  private onMeta = (): void => {
    // A seek set before the metadata arrived may have been dropped.
    const seg = this.plan[this.idx];
    if (!seg) return;
    const t = this.v.currentTime;
    if (t < seg.start - EDGE || t >= seg.end) this.enter(this.idx, seg.start);
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
      const want = clamp(this.masterVolume * g, 0, 1);
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

  private setFade(opacity: number): void {
    const o = Math.round(opacity * 100) / 100;
    if (!this.fadeEl || o === this.fadeOpacity) return;
    this.fadeOpacity = o;
    this.fadeEl.style.opacity = String(o);
  }
}
