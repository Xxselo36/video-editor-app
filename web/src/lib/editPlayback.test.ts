import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cutRange } from "@/features/editor/state/cuts";
import { buildPlan, clipFrames, EditPlayer, fadeLevel, jumpNow, locate, nextInSource, rateOfGaps, seekRampLevel, type PlaySeg } from "@/lib/editPlayback";

const seg = (id: string, start: number, end: number, extra: Partial<PlaySeg> = {}): PlaySeg => ({
  id,
  start,
  end,
  speed: 1,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  ...extra,
});

describe("buildPlan", () => {
  it("keeps the timeline order and fills in default effects", () => {
    const plan = buildPlan(
      [
        { id: "b", start: 7, end: 14 },
        { id: "a", start: 0, end: 6, speed: 2 },
      ],
      30,
    );
    expect(plan).toEqual([seg("b", 7, 14), seg("a", 0, 6, { speed: 2 })]);
  });

  it("drops disabled and too-short clips, clamps to the video", () => {
    const plan = buildPlan(
      [
        { id: "off", start: 0, end: 5, disabled: true },
        { id: "tiny", start: 5, end: 5.04 },
        { id: "neg", start: -1, end: 2 },
        { id: "long", start: 28, end: 40 },
      ],
      30,
    );
    expect(plan.map((s) => [s.id, s.start, s.end])).toEqual([
      ["neg", 0, 2],
      ["long", 28, 30],
    ]);
  });

  it("does not clamp the end when the duration is unknown", () => {
    expect(buildPlan([{ id: "x", start: 1, end: 99 }], 0)[0].end).toBe(99);
  });

  it("clamps effects like the backend", () => {
    const [s] = buildPlan(
      [{ id: "x", start: 0, end: 10, speed: 9, volume: 7, fadeIn: -1, fadeOut: 5 }],
      10,
    );
    expect(s).toMatchObject({ speed: 4, volume: 2.5, fadeIn: 0, fadeOut: 2 });
    const [t] = buildPlan([{ id: "y", start: 0, end: 10, speed: 0.1, volume: NaN }], 10);
    expect(t).toMatchObject({ speed: 0.25, volume: 1 });
  });
});

describe("locate", () => {
  const plan = [seg("c2", 7, 14), seg("c1", 0, 6), seg("c3", 15, 22)];

  it("finds the clip showing a source time, in timeline order", () => {
    expect(locate(plan, 8)).toBe(0);
    expect(locate(plan, 3)).toBe(1);
    expect(locate(plan, 21.9)).toBe(2);
  });

  it("returns -1 inside a cut and at a clip's end", () => {
    expect(locate(plan, 6.5)).toBe(-1);
    expect(locate(plan, 14)).toBe(-1);
    expect(locate(plan, 22)).toBe(-1);
  });

  it("accepts a position a hair before the clip (seek targets)", () => {
    expect(locate(plan, 6.985)).toBe(0);
    expect(locate(plan, 6.97)).toBe(-1);
  });

  it("prefers the given clip when two show the same footage", () => {
    const dup = [seg("a", 0, 10), seg("b", 5, 15)];
    expect(locate(dup, 7)).toBe(0);
    expect(locate(dup, 7, "b")).toBe(1);
    // The preferred clip doesn't contain t: first match again.
    expect(locate(dup, 2, "b")).toBe(0);
    expect(locate(dup, 2, "missing")).toBe(0);
  });
});

describe("nextInSource", () => {
  const plan = [seg("c2", 7, 14), seg("c1", 0, 6), seg("c3", 15, 22)];

  it("is the clip with the earliest start at or after t", () => {
    expect(nextInSource(plan, 6.2)).toBe(0);
    expect(nextInSource(plan, 14.5)).toBe(2);
    expect(nextInSource(plan, -5)).toBe(1);
  });

  it("tolerates a position just past a clip start", () => {
    expect(nextInSource(plan, 7.01)).toBe(0);
    expect(nextInSource(plan, 7.05)).toBe(2);
  });

  it("returns -1 when nothing follows", () => {
    expect(nextInSource(plan, 20)).toBe(-1);
    expect(nextInSource([], 0)).toBe(-1);
  });
});

describe("fadeLevel", () => {
  it("is 1 without fades", () => {
    expect(fadeLevel(seg("x", 10, 20), 15)).toBe(1);
  });

  it("ramps in and out linearly", () => {
    const s = seg("x", 10, 20, { fadeIn: 1, fadeOut: 2 });
    expect(fadeLevel(s, 10)).toBe(0);
    expect(fadeLevel(s, 10.5)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 11)).toBe(1);
    expect(fadeLevel(s, 19)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 20)).toBe(0);
  });

  it("measures fades in output time (after speed)", () => {
    // 2x: 4 s of source are 2 s of output; a 1 s fade covers 2 s of source.
    const s = seg("x", 0, 4, { speed: 2, fadeIn: 1 });
    expect(fadeLevel(s, 1)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 2)).toBe(1);
  });

  it("caps each fade at half the clip", () => {
    const s = seg("x", 0, 2, { fadeIn: 2, fadeOut: 2 });
    expect(fadeLevel(s, 0.5)).toBeCloseTo(0.5);
    expect(fadeLevel(s, 1)).toBeCloseTo(1);
    expect(fadeLevel(s, 1.5)).toBeCloseTo(0.5);
  });

  it("clamps times outside the clip", () => {
    const s = seg("x", 10, 20, { fadeIn: 1 });
    expect(fadeLevel(s, 5)).toBe(0);
    expect(fadeLevel(s, 25)).toBe(1);
  });
});

describe("seekRampLevel (UX10, review C9)", () => {
  it("is off without a ramp (the v1 editor)", () => {
    expect(seekRampLevel(0, true, 0, 0)).toBe(1);
  });

  it("holds 0 while the jump is on its way, ramps up over rampMs after it landed", () => {
    expect(seekRampLevel(15, true, null, null)).toBe(0);
    expect(seekRampLevel(15, false, 0, null)).toBe(0);
    expect(seekRampLevel(15, false, 7.5, null)).toBeCloseTo(0.5);
    expect(seekRampLevel(15, false, 15, null)).toBe(1);
    expect(seekRampLevel(15, false, null, null)).toBe(1);
  });

  it("ramps down over the last rampMs before a jump", () => {
    expect(seekRampLevel(15, false, null, 0.1)).toBe(1);
    expect(seekRampLevel(15, false, null, 0.0075)).toBeCloseTo(0.5);
    expect(seekRampLevel(15, false, null, 0)).toBe(0);
    // just landed and the next jump close: the lower one wins
    expect(seekRampLevel(15, false, 12, 0.003)).toBeCloseTo(0.2);
  });
});

describe("EditPlayer.setPlan keeps the playhead through a cut earlier in its clip (UX10, review 4)", () => {
  function fakeVideo(t: number) {
    const seeks: number[] = [];
    let cur = t;
    const v = {
      paused: true,
      ended: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
      readyState: 4,
      get currentTime() {
        return cur;
      },
      set currentTime(x: number) {
        cur = x;
        seeks.push(x);
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return { v: v as unknown as HTMLVideoElement, seeks };
  }

  it("cutting 'äh' (8.0–8.3) with the playhead at 9.5 in the same clip: no seek", () => {
    const { v, seeks } = fakeVideo(0);
    const p = new EditPlayer(v);
    p.setPlan(buildPlan([{ id: "A", start: 0, end: 20 }], 20));
    v.currentTime = 9.5; // played on to 9.5
    seeks.length = 0;
    const after = cutRange([{ id: "A", start: 0, end: 20 }], 7.95, 8.4, 20);
    expect(after.map((s) => s.id)).toEqual(["A", "A~c"]);
    p.setPlan(buildPlan(after, 20));
    expect(seeks).toEqual([]);
    expect(v.currentTime).toBe(9.5);
    p.destroy();
  });

  it("the playhead inside the cut still moves to the cut's end; a trim past it to the next clip", () => {
    const { v, seeks } = fakeVideo(0);
    const p = new EditPlayer(v);
    p.setPlan(buildPlan([{ id: "A", start: 0, end: 20 }], 20));
    v.currentTime = 8.1;
    seeks.length = 0;
    p.setPlan(buildPlan(cutRange([{ id: "A", start: 0, end: 20 }], 7.95, 8.4, 20), 20));
    // into the clip's first frame (8.4 s = frame 252 at 30 fps)
    expect(seeks.length).toBe(1);
    expect(Math.floor(seeks[0] * 30)).toBe(252);
    p.destroy();
    const b = fakeVideo(0);
    const q = new EditPlayer(b.v);
    q.setPlan(
      buildPlan(
        [
          { id: "A", start: 0, end: 6 },
          { id: "B", start: 10, end: 12 },
        ],
        20,
      ),
    );
    b.v.currentTime = 5;
    b.seeks.length = 0;
    q.setPlan(
      buildPlan(
        [
          { id: "A", start: 0, end: 4 },
          { id: "B", start: 10, end: 12 },
        ],
        20,
      ),
    );
    expect(b.seeks.length).toBe(1);
    expect(Math.floor(b.seeks[0] * 30)).toBe(300);
    q.destroy();
  });
});

describe("the frame grid (wordcuts10-flash-frames)", () => {
  it("a clip keeps the render's frames: [round(start·fps), round(end·fps)), ties on the safe side", () => {
    expect(clipFrames({ start: 2, end: 5 }, 30)).toEqual([60, 150]);
    // ms edges (text cuts) round to the nearest frame, like clip_plan
    expect(clipFrames({ start: 5.012, end: 7.49 }, 30)).toEqual([150, 225]);
    // exactly half a frame: starts later, ends earlier
    expect(clipFrames({ start: 0.05, end: 0.15 }, 30)).toEqual([2, 4]);
    // float noise on a frame edge
    expect(clipFrames({ start: 104 / 30, end: 3.4666666666666663 + 1 }, 30)).toEqual([104, 134]);
  });

  it("a job without its frame rate: measured over all the steps between presented frames, not one over the shortest (webm keeps ms: 33 and 34 ms by turns)", () => {
    // presented media times as a webm reports them (ms), 30 fps; one step
    // of 2 frames (a frame the decoder skipped)
    const ms = (k: number, f: number) => Math.round((k / f) * 1000) / 1000;
    const gapsOf = (ks: number[], f: number) => ks.slice(1).map((k, i) => ms(k, f) - ms(ks[i], f));
    const run = [100, 101, 102, 103, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116];
    // round 3/4: 1 / the shortest = 30.3 fps — the 2-frame step then read as 3
    expect(1 / Math.min(...gapsOf(run, 30))).toBeGreaterThan(30.2);
    expect(rateOfGaps(gapsOf(run, 30))).toBe(30);
    expect(rateOfGaps(gapsOf(run, 25))).toBe(25);
    expect(rateOfGaps(gapsOf(run, 24))).toBe(24);
    // (29.97 and 30 are 0.1 % apart: these few steps can't tell them)
    expect(rateOfGaps(gapsOf(run, 30000 / 1001))).toBeCloseTo(29.97, 1);
    expect(rateOfGaps(gapsOf(run, 50))).toBe(50);
    expect(rateOfGaps(gapsOf(run, 60))).toBe(60);
    // a rate no container uses: what was measured, from 16 steps on
    expect(rateOfGaps(gapsOf(run, 27))).toBeNull();
    expect(rateOfGaps(gapsOf([...run, 117, 118], 27))).toBeCloseTo(27, 1);
    expect(rateOfGaps([0.033, 0.034, 0.033])).toBeNull();
  });

  it("the frame rule (round 4): the jump goes on the clip's last kept frame — a frame early only while waiting could be too late", () => {
    // frames end before 60: 59 is the last kept one
    expect(jumpNow(58, 60)).toBe(false);
    expect(jumpNow(59, 60)).toBe(true);
    // a late frame (a cut one already showing): jump at once
    expect(jumpNow(61, 60)).toBe(true);
    // 30 fps (a pick every 33 ms), callbacks up to 17 ms after their
    // frame's pick (Chromium: 1 or 17 ms), a seek's reach of 4 ms: the next
    // frame's callback comes in time — on the last frame, nothing dropped
    const at30 = { slotMs: 33.3, reachMs: 4 };
    expect(jumpNow(58, 60, { ...at30, lagMs: 17 })).toBe(false);
    expect(jumpNow(59, 60, { ...at30, lagMs: 17 })).toBe(true);
    // the next presentation may step 2 (a decoder that skips): still on
    // the last frame — the clock's timer guards the pick in between
    expect(jumpNow(58, 60, { ...at30, lagMs: 17, stride: 2 })).toBe(false);
    // callbacks 30 ms late: the next one (or a timer as late) could come
    // after the cut frame's pick — one early
    expect(jumpNow(58, 60, { ...at30, lagMs: 30 })).toBe(true);
    expect(jumpNow(57, 60, { ...at30, lagMs: 30 })).toBe(false);
    // two slots late: two early — never more (MAX_EARLY), however late
    expect(jumpNow(57, 60, { ...at30, lagMs: 70 })).toBe(true);
    expect(jumpNow(56, 60, { ...at30, lagMs: 500, reachMs: 70 })).toBe(false);
    // a slow pipeline (a frame of the old position picked 25 ms after a jump): one early
    expect(jumpNow(58, 60, { ...at30, lagMs: 10, reachMs: 26 })).toBe(true);
  });
});

type Presented = { k: number; at: number; seeking: boolean };

/**
 * A playing <video> on the fake clock, shown the way a browser composites
 * it: on every display refresh (vsyncMs) the frame picked at the refresh
 * before goes on screen, and the frame for the next refresh is picked from
 * the media clock as it will be then — a seek issued after that pick can't
 * stop that frame any more (the risk this guards). After each refresh the
 * page's rendering update runs `cbDelay` ms later: requestVideoFrameCallback
 * callbacks for the frame just shown, then animation frames. A seek reaches
 * the decoder `seekLatency` ms after it was asked for (no more picks), lands
 * `landMs` later on the frame under the target time. `drop(k)`: frames the
 * decoder never presents (a busy device; the next pick leaps past them).
 * `busy(t)`: the main thread is blocked at wall time t (no rendering
 * update until it is free). `drawEvery`: the compositor draws only every
 * n-th refresh (a busy device), picking the frame for its next draw.
 * `startLag`: for `forMs` after play starts the element's clock reads `ms`
 * behind the frames it shows (a renderer starting up on a busy device).
 * `landStartMs`: after a seek lands the clock stands that long on the
 * landing frame before it runs again (the e2e runs: 50–90 ms).
 * `behind(t)`: at wall time t the decoder is that many frames behind the
 * clock (a CPU-starved device: frames presented late, then a catch-up leap
 * of two or more in one presentation — the owner probe at 4× CPU: 8693 →
 * 8695 within 17 ms, 3037 → 3040 within 33 ms).
 * `earlyCb(n)`: the n-th presented frame's callback runs in the rendering
 * update right after its pick, before it is on screen (Chromium idle: a
 * callback 0–17 ms after its frame's presentationTime, now − presentationTime
 * in the e2e dumps), the others after it is shown as usual.
 * `rafBusy(n)`: after the n-th refresh that brings no new frame the main
 * thread is busy that many ms (animation frames and timers late, the frame
 * callbacks of the refreshes that bring one on time: a parallel run's
 * rendering — round 4's clock read the animation frames' lateness into its
 * moment and went a frame early).
 * `mediaStall(t, clock)`: the media clock stands while true (buffering: no
 * frame comes, the element's clock stands, the wall clock runs on).
 * `rateEvents`: a 'ratechange' event after each playbackRate write (the
 * native speed menu, a browser extension).
 * `playStart`: at play the frame on screen is presented anew (its callback
 * while playing), the media clock starts `leadMs` ahead of it (the
 * renderer catching up with the audio clock) and the callbacks of the next
 * `miss` presented frames never run (coalesced: animation frames on time)
 * — the e2e run's play start: 15, then 16 or 17 without a callback, the
 * cut frame 18, within 50 ms.
 * `seekedLateMs`: 'seeked' comes this long after the new position's frames
 * play (a busy page: the element says seeking, currentTime stands at the
 * target). `missCb(k)`: frame k is presented without a callback.
 */
function framedVideo(
  start: number,
  o: {
    fps?: number;
    phase?: number;
    vsyncMs?: number;
    cbDelay?: number;
    seekLatency?: number | (() => number);
    landMs?: number;
    rvfc?: boolean;
    volumeReadOnly?: boolean;
    drop?: (k: number) => boolean;
    busy?: (t: number) => boolean;
    drawEvery?: number;
    startLag?: { ms: number; forMs: number };
    busyAfterLand?: [fromMs: number, toMs: number];
    landStartMs?: number;
    behind?: (t: number) => number;
    earlyCb?: (n: number) => boolean;
    rafBusy?: (n: number) => number;
    mediaStall?: (t: number, clock: number) => boolean;
    rateEvents?: boolean;
    playStart?: { leadMs: number; miss: number };
    seekedLateMs?: number;
    missCb?: (k: number) => boolean;
  } = {},
) {
  const fps = o.fps ?? 30;
  const phase = o.phase ?? 0;
  const vsync = o.vsyncMs ?? 1000 / 60;
  // the page's timers may be made late later on (lateTimers): not these
  const setTimeout = globalThis.setTimeout;
  const on = new Map<string, Set<() => void>>();
  const emit = (ev: string) => on.get(ev)?.forEach((f) => f());
  let pos = start;
  let since = Date.now();
  let paused = true;
  let seeking = false;
  let seekId = 0;
  let frozen = false; // the seek reached the decoder: no picks until it lands
  let vol = 1;
  // the element's rate, and the media clock's (a rate written while a seek
  // is on its way reaches the clock with it: the media thread takes them in
  // order — Chromium's pipeline — the clock stopped for the seek by then)
  let rate = 1;
  let clockRate = 1;
  let presented = 0;
  let shown = -1;
  let picked: number | null = null;
  let target = 0;
  let playedAt: number | null = null;
  let landedAt: number | null = null;
  // (rafBusy: the main thread busy until then)
  let busyFrom = -Infinity;
  let busyTo = -Infinity;
  const busyNow = (t: number) =>
    !!o.busy?.(t) ||
    (t >= busyFrom && t < busyTo) ||
    (!!o.busyAfterLand && landedAt !== null && t - landedAt >= o.busyAfterLand[0] && t - landedAt < o.busyAfterLand[1]);
  const lag = () => (o.startLag && playedAt !== null && Date.now() - playedAt < o.startLag.forMs ? o.startLag.ms / 1000 : 0);
  const frames: Presented[] = [];
  const seeks: { at: number; to: number; pos: number }[] = [];
  const volumes: { at: number; value: number; pos: number }[] = [];
  const mutes: boolean[] = [];
  type Md = { mediaTime: number; presentedFrames: number; expectedDisplayTime: number; presentationTime: number };
  let cbs: ((now: number, md: Md) => void)[] = [];
  let rafs = new Map<number, (t: number) => void>();
  let handle = 0;
  let mstalled = false;
  const clockAt = (t: number) => (paused || frozen || mstalled ? pos : pos + (Math.max(0, t - since) / 1000) * clockRate);
  const clock = () => clockAt(Date.now());
  const frameAt = (t: number) => Math.floor((t - phase) * fps + 1e-9);
  let pendingMd: Md | null = null;
  let updateDue: number | null = null;
  // (earlyCb: the picked frame whose callback already ran; playStart: the
  // presented frames whose callbacks are yet to be missed)
  let calledBack: number | null = null;
  let missLeft = 0;
  const mdOf = (k: number, n: number, pickedAt: number, shownAt: number): Md => {
    // (times on the page's clock, performance.now, like a browser's)
    const off = Date.now() - performance.now();
    return {
      mediaTime: Math.round((k / fps + phase) * 1000) / 1000,
      presentedFrames: n,
      expectedDisplayTime: shownAt - off,
      presentationTime: pickedAt - off,
    };
  };
  const present = (k: number, at: number) => {
    if (k === shown) return;
    shown = k;
    presented++;
    frames.push({ k, at, seeking });
    // (handed to the compositor at the draw before: when it was picked)
    if (missLeft > 0) missLeft--;
    else if (o.missCb?.(k)) {
      // coalesced: no callback for this frame
    } else if (calledBack !== k) pendingMd = mdOf(k, presented, at - vsync * every, at);
    calledBack = null;
  };
  // the page's rendering update: frame callbacks, then animation frames
  const update = () => {
    const now = Date.now();
    const md = pendingMd;
    pendingMd = null;
    if (md) {
      const run = cbs;
      cbs = [];
      run.forEach((cb) => cb(performance.now(), md));
    }
    const run = rafs;
    rafs = new Map();
    run.forEach((cb) => cb(now));
  };
  let nextVsync = Date.now() + vsync;
  let vsyncs = 0;
  let idle = 0;
  const every = o.drawEvery ?? 1;
  const tick = () => {
    const now = Date.now();
    if (o.mediaStall) {
      const st = !paused && !seeking && o.mediaStall(now, clockAt(now));
      if (st && !mstalled) {
        pos = clockAt(now);
        mstalled = true;
      } else if (!st && mstalled) {
        mstalled = false;
        since = now;
      }
    }
    if (now >= nextVsync) {
      const v0 = nextVsync;
      nextVsync += vsync;
      const before = presented;
      if (vsyncs++ % every === 0) {
        if (picked !== null) present(picked, v0);
        picked = null;
        if (!paused && !frozen) {
          const k0 = frameAt(clockAt(v0 + vsync * every));
          // (a decoder behind never presents a frame older than the one up)
          const k = o.behind ? Math.max(k0 - Math.max(0, Math.round(o.behind(now))), Math.min(k0, shown)) : k0;
          if (k !== shown && !o.drop?.(k)) picked = k;
        }
        if (picked !== null && o.earlyCb?.(presented + 1)) {
          calledBack = picked;
          pendingMd = mdOf(picked, presented + 1, v0, v0 + vsync * every);
        }
      }
      if (presented === before && o.rafBusy) {
        const ms = o.rafBusy(idle++);
        if (ms > 0) [busyFrom, busyTo] = [v0 + 1, v0 + 1 + ms];
      }
      updateDue = v0 + (o.cbDelay ?? 2);
    }
    if (updateDue !== null && now >= updateDue && !busyNow(now)) {
      updateDue = null;
      update();
    }
    setTimeout(tick, 1);
  };
  setTimeout(tick, 1);
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafs.set(++handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => void rafs.delete(h));
  const v = {
    get paused() {
      return paused;
    },
    get seeking() {
      return seeking;
    },
    ended: false,
    readyState: 4,
    get playbackRate() {
      return rate;
    },
    set playbackRate(r: number) {
      rate = r;
      if (!seeking || frozen) {
        pos = clock();
        since = Date.now();
        clockRate = r;
      }
      if (o.rateEvents) emit("ratechange");
    },
    get volume() {
      return vol;
    },
    set volume(x: number) {
      volumes.push({ at: Date.now(), value: x, pos: clock() });
      if (!o.volumeReadOnly) vol = x;
    },
    muted: false,
    // (while a seek is on its way: its target, as browsers report it)
    get currentTime() {
      return seeking ? target : clock() - lag();
    },
    set currentTime(x: number) {
      seeks.push({ at: Date.now(), to: x, pos: clock() });
      target = x;
      seeking = true;
      const id = ++seekId;
      emit("seeking");
      const lat = typeof o.seekLatency === "function" ? o.seekLatency() : (o.seekLatency ?? 3);
      setTimeout(() => {
        pos = clock();
        frozen = true;
        clockRate = rate;
      }, lat);
      setTimeout(() => {
        pos = x;
        frozen = false;
        since = Date.now() + (paused ? 0 : (o.landStartMs ?? 0));
        // the decoded target frame goes up at the next refresh
        picked = frameAt(x);
        landedAt = Date.now();
        const done = () => {
          if (id !== seekId) return;
          seeking = false;
          emit("seeked");
        };
        if (o.seekedLateMs) setTimeout(done, o.seekedLateMs);
        else done();
      }, Math.max(o.landMs ?? 20, lat + 10));
    },
    play() {
      if (!paused) return Promise.resolve();
      paused = false;
      since = Date.now();
      playedAt = Date.now();
      if (o.playStart && shown >= 0) {
        pos += o.playStart.leadMs / 1000;
        presented++;
        frames.push({ k: shown, at: Date.now(), seeking });
        pendingMd = mdOf(shown, presented, Date.now() - vsync, Date.now());
        missLeft = o.playStart.miss;
      }
      emit("play");
      return Promise.resolve();
    },
    pause() {
      pos = clock();
      paused = true;
      emit("pause");
    },
    addEventListener(ev: string, fn: () => void) {
      if (!on.has(ev)) on.set(ev, new Set());
      on.get(ev)!.add(fn);
    },
    removeEventListener(ev: string, fn: () => void) {
      on.get(ev)?.delete(fn);
    },
    ...(o.rvfc === false
      ? {}
      : {
          requestVideoFrameCallback(cb: (typeof cbs)[number]) {
            cbs.push(cb);
            return ++handle;
          },
          cancelVideoFrameCallback() {
            cbs = [];
          },
        }),
  };
  Object.defineProperty(v, "muted", {
    get: () => mutes.at(-1) ?? false,
    set: (x: boolean) => void mutes.push(x),
  });
  return { v: v as unknown as HTMLVideoElement, frames, seeks, volumes, mutes, fps, phase, busy: busyNow };
}

/** A repeatable pseudo-random sequence (no Math.random in tests). */
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

// (tens of simulated seconds at 1 ms steps each: room on a busy machine)
describe("EditPlayer joins: no cut frame, ever (wordcuts10-flash-frames)", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A [0, 2) → B [5, 7) → C [3, 4) (reordered: a jump back): frames
  // [0, 60) [150, 210) [90, 120) at 30 fps.
  const segs = [
    { id: "A", start: 0, end: 2 },
    { id: "B", start: 5, end: 7 },
    { id: "C", start: 3, end: 4 },
  ];
  const kept = (k: number) => (k >= 0 && k < 60) || (k >= 150 && k < 210) || (k >= 90 && k < 120);
  /** Many short clips (the owner's edit is 103): 0.2–0.6 s, 0.1–0.3 s cuts between. */
  const many = (() => {
    const out: { id: string; start: number; end: number }[] = [];
    const r = rng(7);
    let t = 0.3;
    for (let i = 0; t < 33; i++) {
      const len = Math.round((0.2 + 0.4 * r()) * 1000) / 1000;
      out.push({ id: `c${i}`, start: t, end: t + len });
      t = Math.round((t + len + 0.1 + 0.2 * r()) * 1000) / 1000;
    }
    return out;
  })();
  const keptMany = (k: number, fps = 30) => many.some((s) => k >= Math.round(s.start * fps + 1e-6) && k < Math.round(s.end * fps - 1e-6));

  async function playAll(f: ReturnType<typeof framedVideo>, ms = 6000, opts: { seekRampMs?: number; plan?: typeof segs; fps?: number } = {}) {
    const p = new EditPlayer(f.v, { fps: opts.fps ?? 30, seekRampMs: opts.seekRampMs ?? 15 });
    p.setPlan(buildPlan(opts.plan ?? segs, 40));
    await vi.advanceTimersByTimeAsync(50);
    void f.v.play();
    await vi.advanceTimersByTimeAsync(ms);
    p.destroy();
    return f.frames;
  }
  const cutOf = (frames: Presented[], ok: (k: number) => boolean) => frames.filter((x) => !ok(x.k)).map((x) => x.k);
  /** Per clip end (not the timeline's): how many of its last frames never showed. */
  const droppedAtEnds = (frames: Presented[], plan: { start: number; end: number }[], fps = 30) => {
    const ks = new Set(frames.map((x) => x.k));
    return plan.slice(0, -1).map((s) => {
      const [a, b] = clipFrames(s, fps);
      let n = 0;
      for (let k = b - 1; k >= a && !ks.has(k); k--) n++;
      return n;
    });
  };

  it("frame callbacks: the jump goes on each clip's last frame; no cut frame; the last frames show — the first join of a player finds the seek's reach out a frame early, never again", async () => {
    // A → B → C, then D [8, 9) and E [10, 11): frames [240, 270) [300, 330)
    const plan = [...segs, { id: "D", start: 8, end: 9 }, { id: "E", start: 10, end: 11 }];
    const ok = (k: number) => kept(k) || (k >= 240 && k < 270) || (k >= 300 && k < 330);
    const f = framedVideo(0);
    const p = new EditPlayer(f.v, { fps: 30, seekRampMs: 15 });
    p.setPlan(buildPlan(plan, 40));
    await vi.advanceTimersByTimeAsync(50);
    void f.v.play();
    await vi.advanceTimersByTimeAsync(8000);
    const first = f.frames.slice();
    expect(cutOf(first, ok)).toEqual([]);
    const ks = new Set(first.map((x) => x.k));
    // round 5 (the owner: no cut frame, ever): the first join of a player
    // goes a frame early — the seek's reach is unknown until a join showed
    // it, and a slow pipeline picks the old position's next frame after the
    // jump (a kept one then, not a cut one); at most A's last kept frame goes
    expect(ks.has(58)).toBe(true);
    // every later join on its clip's last kept frame
    expect(ks.has(209) && ks.has(119) && ks.has(269)).toBe(true);
    // landed on each clip's first frame
    expect(ks.has(150) && ks.has(90) && ks.has(240) && ks.has(300)).toBe(true);
    // the timeline's end: paused on E's last frame
    expect(f.v.paused).toBe(true);
    expect(Math.floor(f.v.currentTime * 30)).toBe(329);
    // play again from the top: the reach is known — the first join after
    // play shows its last kept frame too (round 3 lost it at every start)
    p.seek(0, "A");
    await vi.advanceTimersByTimeAsync(100);
    const n = f.frames.length;
    void f.v.play();
    await vi.advanceTimersByTimeAsync(8000);
    p.destroy();
    const again = f.frames.slice(n);
    expect(cutOf(again, ok)).toEqual([]);
    const ks2 = new Set(again.map((x) => x.k));
    expect(ks2.has(59) && ks2.has(209) && ks2.has(119) && ks2.has(269)).toBe(true);
  });

  it("50+ joins of short clips: no cut frame, at most the last kept frame dropped at a join", async () => {
    const f = framedVideo(0);
    const frames = await playAll(f, 25_000, { plan: many });
    expect(many.length).toBeGreaterThan(50);
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    const drops = droppedAtEnds(frames, many);
    expect(Math.max(...drops)).toBeLessThanOrEqual(1);
    // and none at all but at the odd join (round 4: every clip's last kept frame shows)
    expect(drops.filter((n) => n === 0).length / drops.length).toBeGreaterThanOrEqual(0.95);
  });

  it("no frame rate from the job (the v1 editor): measured from the media times (ms, like a webm's) — the joins as exact as with it", async () => {
    // (round 4 until now: 1 / the shortest step = 30.3 fps — steps read as
    // 2 frames, taken for a skipping decoder: every join a frame or two
    // early, the e2e playback run's 5.87 before the cut at 6.0)
    const frames = await playAll(framedVideo(0), 25_000, { plan: many, fps: 0 });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    const drops = droppedAtEnds(frames, many);
    expect(Math.max(...drops)).toBeLessThanOrEqual(1);
    expect(drops.filter((n) => n === 0).length / drops.length).toBeGreaterThanOrEqual(0.95);
  });

  it("a decoder that skips a frame now and then (a busy machine): no cut frame, and the skip is counted once — at most the last kept frame goes at a join", async () => {
    // a frame skipped every 9 (never one of a clip's last 3: those would be
    // lost whatever the player did)
    const ends = many.map((s) => clipFrames(s, 30)[1]);
    const nearEnd = (k: number) => ends.some((b) => k >= b - 3 && k < b);
    const f = framedVideo(0, { drop: (k) => k % 9 === 4 && !nearEnd(k) });
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    // (counted twice — a step of 2 seen, then 2 + 1 frames assumed for the
    // next presentation — the jump went two frames early: both lost)
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(1);
  });

  it("play starting on a short clip while the renderer starts up (its clock behind, then a leap past the last kept frame): no cut frame — the e2e run's first join", async () => {
    // A [0.5, 0.6): frames 15–17; the first frames after play: 16, then 18
    // (17 never presented) while the element's clock reads 40 ms behind
    const plan = [
      { id: "A", start: 0.5, end: 0.6 },
      { id: "B", start: 0.9, end: 1.5 },
      { id: "C", start: 2, end: 2.6 },
      { id: "D", start: 3, end: 3.6 },
    ];
    const ok = (k: number) => (k >= 15 && k < 18) || (k >= 27 && k < 45) || (k >= 60 && k < 78) || (k >= 90 && k < 108);
    for (const cbDelay of [2, 12]) {
      const f = framedVideo(0.5, { drop: (k) => k === 17, startLag: { ms: 40, forMs: 300 }, cbDelay });
      const frames = await playAll(f, 2500, { plan });
      expect(cutOf(frames, ok)).toEqual([]);
      // the start skipped A's last frame (the decoder did: 17); B, C and D
      // lose at most their last frame (the clock read 40 ms behind the
      // frames: the pick lead it showed then holds a few frames longer;
      // callbacks 29 ms after their frame's pick, 12 ms into the refresh,
      // could come too late for the seek's reach)
      const ks = new Set(frames.map((x) => x.k));
      expect(ks.has(16)).toBe(true);
      expect(Math.max(...droppedAtEnds(frames, plan).slice(1))).toBeLessThanOrEqual(1);
    }
  });

  it("play starting on a clip of three frames while the renderer catches up (the frame on screen presented anew, the clock 40–60 ms ahead of it, the next frame's callback never run): no cut frame — the e2e run's first join (15, then 16 or 17 without a callback, 18 within 50 ms); the margin's two kept frames at most", async () => {
    const plan = [
      { id: "A", start: 0.5, end: 0.6 },
      { id: "B", start: 0.9, end: 1.5 },
      { id: "C", start: 2, end: 2.6 },
      { id: "D", start: 3, end: 3.6 },
    ];
    const ok = (k: number) => (k >= 15 && k < 18) || (k >= 27 && k < 45) || (k >= 60 && k < 78) || (k >= 90 && k < 108);
    for (const [leadMs, miss] of [
      [40, 1],
      [50, 1],
      [60, 1],
      [50, 2],
    ]) {
      const at = `${leadMs} ms ahead, ${miss} missed`;
      // (the editor opens on the edit's first frame: a seek from 0; the
      // element's clock reads as far behind the frames at the start)
      const f = framedVideo(0, { playStart: { leadMs, miss }, startLag: { ms: leadMs, forMs: 300 } });
      const p = new EditPlayer(f.v, { fps: 30, seekRampMs: 15 });
      p.setPlan(buildPlan(plan, 40));
      await vi.advanceTimersByTimeAsync(150);
      expect(f.frames.map((x) => x.k), at).toEqual([15]);
      void f.v.play();
      await vi.advanceTimersByTimeAsync(2500);
      p.destroy();
      const frames = f.frames;
      // (round 5: the cut frame 18 at every one)
      expect(cutOf(frames, ok), at).toEqual([]);
      // (B, C and D: past the start, at most their last frame)
      expect(Math.max(...droppedAtEnds(frames, plan).slice(1)), at).toBeLessThanOrEqual(1);
    }
  });

  it("paused on a clip's second-to-last frame, play: the start never shows the cut frame after it", async () => {
    const plan = [
      { id: "A", start: 0, end: 1 },
      { id: "B", start: 2, end: 3 },
    ];
    const f = framedVideo(0, { drop: (k) => k === 29, startLag: { ms: 40, forMs: 300 } });
    const p = new EditPlayer(f.v, { fps: 30, seekRampMs: 15 });
    p.setPlan(buildPlan(plan, 10));
    await vi.advanceTimersByTimeAsync(50);
    p.seek(28.2 / 30, "A");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames.at(-1)!.k).toBe(28);
    void f.v.play();
    await vi.advanceTimersByTimeAsync(800);
    p.destroy();
    expect(cutOf(f.frames, (k) => (k >= 0 && k < 30) || (k >= 60 && k < 90))).toEqual([]);
  });

  it("seeks that reach the pipeline late (30–45 ms: a device far slower than any measured): no cut frame — the first join finds it out on a kept frame; at most the last kept frame goes at a join", async () => {
    // (round 3 jumped the first two joins after every play a frame early —
    // the end of a word lost at every start; round 4 asked the first join's
    // jump on its last kept frame — at 45 ms its cut frame showed. Round 5:
    // while the reach is unknown (no join of the player measured it yet)
    // the jump goes a frame early: the old frame picked after it is the
    // last kept one; then the reach as the joins showed it, the seam a
    // frame early while it doesn't fit between two picks)
    for (const lat of [30, 45]) {
      const f = framedVideo(0, { seekLatency: lat });
      const frames = await playAll(f, 25_000, { plan: many });
      expect(cutOf(frames, (k) => keptMany(k)), `${lat} ms`).toEqual([]);
      // the price: the last kept frame at a join, no more
      expect(Math.max(...droppedAtEnds(frames, many)), `${lat} ms`).toBeLessThanOrEqual(1);
    }
  });

  it("seeks that turn slow mid-play (3 → 45 ms): a cut frame at the first join after at most, none after; fast again, the last frames come back", async () => {
    const t0 = Date.now();
    const slow = (t: number) => t - t0 > 4000 && t - t0 < 10_000;
    const f = framedVideo(0, { seekLatency: () => (slow(Date.now()) ? 45 : 3) });
    const frames = await playAll(f, 25_000, { plan: many });
    const cut = frames.filter((x) => !keptMany(x.k));
    expect(cut.length).toBeLessThanOrEqual(1);
    // a few seconds after the slow stretch (LAG_JOINS joins on) the last
    // kept frames show again as often as in a run that never was slow
    const tail = many.filter((s) => s.start > 21 && s.end < 32.5);
    const shownIn = (fr: Presented[]) => {
      const ks = new Set(fr.map((x) => x.k));
      return tail.filter((s) => ks.has(clipFrames(s, 30)[1] - 1)).length / tail.length;
    };
    const baseFrames = await playAll(framedVideo(0), 25_000, { plan: many });
    const base = shownIn(baseFrames);
    expect(shownIn(frames)).toBeGreaterThanOrEqual(base - 0.1);
  });

  it("clips of 3 frames, the page busy right after each landing (the main thread answering the join): no cut frame — the full e2e run's", async () => {
    const tiny = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, start: 0.5 + i * 0.4, end: 0.6 + i * 0.4 }));
    const ok = (k: number) => tiny.some((x) => k >= clipFrames(x, 30)[0] && k < clipFrames(x, 30)[1]);
    for (const busyAfterLand of [[8, 40], [20, 55], [60, 110]] as [number, number][]) {
      const f = framedVideo(0, { busyAfterLand });
      // a busy main thread holds the page's timers too
      const st = globalThis.setTimeout;
      const held = (fn: () => void) => () => (f.busy(Date.now()) ? st(held(fn), 1) : fn());
      vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => st(held(fn), ms)) as typeof setTimeout);
      const frames = await playAll(f, 9000, { plan: tiny });
      vi.stubGlobal("setTimeout", st);
      expect(cutOf(frames, ok), JSON.stringify(busyAfterLand)).toEqual([]);
    }
  });

  it("a container offset (12 ms, a webm's start): the landing is never the frame before the clip", async () => {
    const f = framedVideo(0, { phase: 0.012 });
    const frames = await playAll(f);
    expect(cutOf(frames, kept)).toEqual([]);
    expect(new Set(frames.map((x) => x.k)).has(150)).toBe(true);
  });

  it("callbacks running late (a busy phone, 12 ms into the refresh): still no cut frame", async () => {
    const f = framedVideo(0, { cbDelay: 12 });
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
  });

  it("the page's timers firing late (8 ms, a busy page): no cut frame — round 2 showed one at about half of all joins", async () => {
    const f = framedVideo(0);
    const st = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => st(fn, (ms ?? 0) + 8)) as typeof setTimeout);
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
  });

  it("a device whose decoder skips frames (1 in 5, and leaps past them): no cut frame — the clock covers the frames never shown", async () => {
    const r = rng(3);
    const skip = new Set<number>();
    for (let k = 0; k < 1200; k++) if (r() < 0.2) skip.add(k);
    const f = framedVideo(0, { drop: (k) => skip.has(k) });
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
  });

  it("the decoder skips a clip's last two kept frames (the next presented one is cut): the clock jumps before it — round 3's first try showed it", async () => {
    const ends = new Set(many.flatMap((x) => [clipFrames(x, 30)[1] - 1, clipFrames(x, 30)[1] - 2]));
    const f = framedVideo(0, { drop: (k) => ends.has(k) });
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
  });

  it("a compositor drawing every other refresh (a busy device), at 1x and 1.5x: no cut frame", async () => {
    for (const speed of [1, 1.5]) {
      const f = framedVideo(0, { drawEvery: 2 });
      const frames = await playAll(f, 25_000, { plan: many.map((s) => ({ ...s, speed })) });
      expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    }
  });

  it("a main thread busy 25 ms of every 120 ms (rendering updates late): no cut frame", async () => {
    const f = framedVideo(0, { busy: (t) => t % 120 < 25 });
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
  });

  // ── round 5: the margin follows the load (fast attack, slow release) ──
  /** A main thread stalled `ms(n)` ms at the start of every 60 ms bucket n
   *  from t0 (the page's timers held as long: holdTimers). */
  const stalls = (ms: (n: number) => number, from = 0, to = Infinity) => {
    const t0 = Date.now();
    return (t: number) => {
      const x = t - t0;
      return x >= from && x < to && x % 60 < ms(Math.floor(x / 60));
    };
  };
  const holdTimers = (busy: (t: number) => boolean) => {
    const st = globalThis.setTimeout;
    const held = (fn: () => void) => () => (busy(Date.now()) ? st(held(fn), 1) : fn());
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => st(held(fn), ms)) as typeof setTimeout);
    return () => vi.stubGlobal("setTimeout", st);
  };
  const shownShare = (frames: Presented[], plan: { start: number; end: number }[]) => {
    const d = droppedAtEnds(frames, plan);
    return d.filter((n) => n === 0).length / d.length;
  };

  it("heavy load (the owner probe at 4× CPU: the main thread stalled 15–45 ms of every 60, timers held as long, callbacks up to 60 ms late): no cut frame, at most two kept frames dropped at a join — round 4's cadence timer fired 30 ms late there, after the cut frame's pick", async () => {
    const r = rng(5);
    const len = Array.from({ length: 1000 }, () => 15 + 30 * r());
    const busy = stalls((n) => len[n % 1000]);
    const f = framedVideo(0, { busy });
    const restore = holdTimers(busy);
    const frames = await playAll(f, 25_000, { plan: many });
    restore();
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(2);
  });

  it("a starved device between its stalls (round 4's cut frames at 4× CPU: the clip's last kept frame never presented, the page blocked as the cut frame's slot comes — its timer 30 ms late): no cut frame — the load measured over the latest second holds the margin through the lulls", async () => {
    const ends = many.map((x) => clipFrames(x, 30)[1]);
    let clock: HTMLVideoElement | null = null;
    // the decoder never presents a clip's last kept frame
    const drop = (k: number) => ends.includes(k + 1);
    // stalls of 30 ms every 50 for 200 ms every 700 ms (the load), and the
    // page blocked from late in the frame before the last kept one (after
    // its callback) until the cut frame's slot is past
    const t0 = Date.now();
    const atEnd = () => {
      const k = clock && !clock.seeking ? clock.currentTime * 30 : -99;
      return ends.some((b) => k >= b - 1.3 && k < b + 0.7);
    };
    const busy = (t: number) => {
      const x = (t - t0) % 700;
      return (x < 200 && x % 50 < 30) || atEnd();
    };
    const f = framedVideo(0, { drop, busy });
    clock = f.v;
    const restore = holdTimers(busy);
    const frames = await playAll(f, 25_000, { plan: many });
    restore();
    // (round 4, its 8 frames' most lag low between the stalls: the cut
    // frame at most joins)
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    // the decoder's own skip and the margin's: two at most
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(2);
  });

  it("a decoder that falls a frame behind near each clip's end and catches up in one leap past the last kept frame (round 4's cut frame: 8693 → 8695 within 17 ms), the page busy: no cut frame, at most two kept frames dropped", async () => {
    const ends = many.map((x) => clipFrames(x, 30)[1]);
    let clock: HTMLVideoElement | null = null;
    // behind while the clock is on a clip's last four frames: the last kept
    // one is never presented, the next presentation is the cut frame
    const behind = () => {
      const k = clock && !clock.seeking ? Math.floor(clock.currentTime * 30) : -99;
      return ends.some((b) => k >= b - 4 && k < b) ? 1 : 0;
    };
    const r = rng(8);
    const len = Array.from({ length: 1000 }, () => 10 + 30 * r());
    const busy = stalls((n) => len[n % 1000]);
    const f = framedVideo(0, { behind, busy });
    clock = f.v;
    const restore = holdTimers(busy);
    const frames = await playAll(f, 25_000, { plan: many });
    restore();
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(2);
    // without the busy page the frame clock alone sees it coming: no cut
    // frame, the decoder's own skip the only frame lost
    const g = framedVideo(0, { behind });
    clock = g.v;
    const calm = await playAll(g, 25_000, { plan: many });
    expect(cutOf(calm, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(calm, many))).toBeLessThanOrEqual(1);
  });

  it("ordinary jitter (a frame callback 26–40 ms late now and then, timers on time: the e2e runs on two workers, CI): no margin — the last kept frame at 90 % of joins or more, no cut frame", async () => {
    const r = rng(9);
    const hit = new Set<number>();
    for (let n = 8; n < 600; n += 10 + Math.floor(12 * r())) hit.add(n);
    const len = Array.from({ length: 600 }, () => 12 + 12 * r());
    const busy = stalls((n) => (hit.has(n) ? len[n] : 0));
    const f = framedVideo(0, { busy });
    const frames = await playAll(f, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(1);
    expect(shownShare(frames, many)).toBeGreaterThanOrEqual(0.9);
  });

  it("ordinary jitter between frames (the page busy 6–14 ms after a third of the refreshes that bring no frame: animation frames and timers late, the frame callbacks on time — a parallel run, CI's two workers): no margin — the last kept frame at 90 % of joins or more — round 4 took the animation frames' lateness into its clock's moment and went a frame early at a quarter to a third of the joins (CI: .50–.64)", async () => {
    const r = rng(11);
    const f = framedVideo(0, { rafBusy: () => (r() < 1 / 3 ? 10 * (0.6 + 0.8 * r()) : 0) });
    const restore = holdTimers(f.busy);
    const frames = await playAll(f, 25_000, { plan: many });
    restore();
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(1);
    expect(shownShare(frames, many)).toBeGreaterThanOrEqual(0.9);
  });

  it("load that comes and goes: the margin at once when the main thread stalls (no cut frame in the busy stretch), the last kept frames back a few seconds after it (slow release)", async () => {
    const r = rng(13);
    const len = Array.from({ length: 1000 }, () => 15 + 30 * r());
    // busy from 3 s to 8 s of play (the clips' footage then: up to ~13 s)
    const busy = stalls((n) => len[n % 1000], 3000, 8000);
    const f = framedVideo(0, { busy });
    const restore = holdTimers(busy);
    const frames = await playAll(f, 25_000, { plan: many });
    restore();
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(2);
    // clips well after the stretch (its end + HEAVY_HOLD_MS + the 32 frames
    // that showed it, ~12.5 s of play: footage from ~20 s on): as many last
    // kept frames as a run without load
    const tail = many.filter((x) => x.start > 21.5 && x.end < 32.5);
    const base = await playAll(framedVideo(0), 25_000, { plan: many });
    expect(shownShare(frames, tail)).toBeGreaterThanOrEqual(shownShare(base, tail) - 0.1);
  });

  it("no frame callbacks (older browsers): the clock jumps one frame early, no cut frame", async () => {
    const f = framedVideo(0, { rvfc: false });
    const frames = await playAll(f);
    expect(cutOf(frames, kept)).toEqual([]);
    const ks = new Set(frames.map((x) => x.k));
    // at most the last frame dropped
    expect(ks.has(58) && ks.has(208)).toBe(true);
    const g = framedVideo(0, { rvfc: false });
    expect(cutOf(await playAll(g, 25_000, { plan: many }), (k) => keptMany(k))).toEqual([]);
  });

  /** Above FAST_RATE (round 6): the jump the owner's allowance early
   *  (MAX_EARLY frames of output: the time-stretched clock races after a
   *  landing) — the source frames a join drops at most. */
  const atSpeed = (speed: number) => Math.ceil(2 * speed - 1e-6);

  it("clips at 1.5x and 2x: still no cut frame; a join drops two frames of output at most", async () => {
    for (const speed of [1.5, 2]) {
      const plan = many.map((s) => ({ ...s, speed }));
      const f = framedVideo(0);
      const frames = await playAll(f, 15_000, { plan });
      expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
      expect(Math.max(...droppedAtEnds(frames, plan)), `${speed}x`).toBeLessThanOrEqual(atSpeed(speed));
    }
  });

  /** Chromium's frame callbacks on an idle machine: now and then in the
   *  rendering update right after the frame's pick (the e2e dumps: now −
   *  presentationTime 0–17 ms), else a refresh later. */
  const chromium = (n: number) => n % 3 === 0;
  const speeds = (i: number) => [1, 1.5, 2][i % 3];

  it("clips at 1.5x and 2x between 1x ones, the frame callbacks as Chromium runs them: no cut frame; the 1x clips drop at most their last kept frame, mostly none — round 5 took those callbacks (a refresh after their pick: more than a presentation at 2x) for two frames' load and held it into the 1x clips after (two kept frames at nearly every one)", async () => {
    const plan = many.map((s, i) => ({ ...s, speed: speeds(i) }));
    for (const o of [{ earlyCb: chromium }, {}]) {
      const at = JSON.stringify(Object.keys(o));
      const f = framedVideo(0, o);
      const frames = await playAll(f, 25_000, { plan });
      // (with the next clip's speed set before the jump's seek the old
      // position ran 1.5x while the seek was on its way: a 1x clip's next
      // frame — a cut one — picked within the seek's reach)
      expect(cutOf(frames, (k) => keptMany(k)), at).toEqual([]);
      const d = droppedAtEnds(frames, plan);
      const at1x = d.filter((_, i) => plan[i].speed === 1 && clipFrames(plan[i], 30)[1] - clipFrames(plan[i], 30)[0] > 3);
      expect(Math.max(...at1x), at).toBeLessThanOrEqual(1);
      expect(at1x.filter((n) => n === 0).length / at1x.length, at).toBeGreaterThanOrEqual(0.9);
      // (the sped-up ones: two frames of output at most)
      d.forEach((n, i) => plan[i].speed > 1 && expect(n, `${at} clip ${i}`).toBeLessThanOrEqual(atSpeed(plan[i].speed)));
    }
  });

  it("a 60 fps video (phone footage: 50/59.94/60 fps proxies), the frame callbacks as Chromium runs them: no cut frame, at most the last kept frame at a join, mostly none — round 5 read callbacks a refresh after their pick as two frames' load (two kept frames at every join)", async () => {
    // (the harness' clock is ms-grained: at 60 Hz it reads the refresh as
    // 17 ms — round 5 read 60 fps as two frames a refresh then; 61 Hz
    // reads 16)
    for (const hz of [60, 61]) {
      const f = framedVideo(0, { fps: 60, earlyCb: chromium, vsyncMs: 1000 / hz });
      const frames = await playAll(f, 25_000, { plan: many, fps: 60 });
      expect(cutOf(frames, (k) => keptMany(k, 60)), `${hz} Hz`).toEqual([]);
      const d = droppedAtEnds(frames, many, 60);
      expect(Math.max(...d), `${hz} Hz`).toBeLessThanOrEqual(1);
      expect(d.filter((n) => n === 0).length / d.length, `${hz} Hz`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("the media clock stands (buffering) on one of a clip's last frames: no cut frame, at most the last kept frame dropped — round 5's seam fired by the wall clock meanwhile, up to six kept frames early", async () => {
    // A [0, 4) ends at frame 120, after a first join (the seek's reach known)
    for (const ms of [150, 400]) {
      for (const at of [3.75, 3.8, 3.84, 3.87, 3.9, 3.92, 3.94, 3.96]) {
        let t0: number | null = null;
        const f = framedVideo(0, {
          mediaStall: (t, clock) => {
            if (t0 === null && clock >= at && clock < 4) t0 = t;
            return t0 !== null && t - t0 < ms;
          },
        });
        const plan = [
          { id: "Z", start: 20, end: 21 },
          { id: "A", start: 0, end: 4 },
          { id: "B", start: 6, end: 10 },
        ];
        const frames = await playAll(f, 6500, { plan });
        const ok = (k: number) => (k >= 600 && k < 630) || (k >= 0 && k < 120) || (k >= 180 && k < 300);
        expect(cutOf(frames, ok), `${ms} ms at ${at}`).toEqual([]);
        expect(droppedAtEnds(frames, plan)[1], `${ms} ms at ${at}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("'seeked' late (a busy page: the new clip's frames play while the element still says seeking, currentTime at the target) and a short clip's last kept frame without a callback: no cut frame — round 6's buffering check read the standing clock as a stall and held the seam", async () => {
    // long, short (4–6 frames), long, short …, after a first join elsewhere
    const plan: { id: string; start: number; end: number }[] = [{ id: "Z", start: 30, end: 31 }];
    let t = 0;
    for (let i = 0; i < 12; i++) {
      plan.push({ id: `L${i}`, start: t, end: t + 0.8 });
      t += 1;
      plan.push({ id: `S${i}`, start: t, end: t + (4 + (i % 3)) / 30 });
      t += 0.5;
    }
    const ranges = plan.map((s) => clipFrames(s, 30));
    const ok = (k: number) => ranges.some(([a, b]) => k >= a && k < b);
    const lastOfShort = new Set(ranges.filter((_, i) => plan[i].id.startsWith("S")).map(([, b]) => b - 1));
    for (const late of [0, 120, 200, 300])
      for (const miss of [false, true]) {
        const f = framedVideo(30, { seekedLateMs: late, missCb: miss ? (k) => lastOfShort.has(k) : undefined });
        const frames = await playAll(f, 22_000, { plan });
        expect(cutOf(frames, ok), `seeked ${late} ms late, missed callbacks ${miss}`).toEqual([]);
      }
  });

  it("a speed picked in the native controls mid-clip (1x → 2x, 1x → 4x): the clip plays on to its last frames (the new speed's margin) — round 5 kept the old speed's frame clock (its slots twice as far apart): the seam fired at once, the rest of the clip skipped", async () => {
    for (const [to, afterMs] of [
      [2, 2600],
      [2, 4000],
      [4, 2600],
    ] as const) {
      const at = `${to}x after ${afterMs} ms`;
      const f = framedVideo(0, { rateEvents: true });
      const p = new EditPlayer(f.v, { fps: 30, seekRampMs: 15 });
      // (a first join elsewhere: the seek's reach known)
      p.setPlan(buildPlan([{ id: "Z", start: 20, end: 21 }, { id: "A", start: 0, end: 4 }, { id: "B", start: 6, end: 10 }], 40));
      await vi.advanceTimersByTimeAsync(50);
      void f.v.play();
      await vi.advanceTimersByTimeAsync(afterMs);
      expect(f.frames.at(-1)!.k, at).toBeLessThan(110);
      f.v.playbackRate = to;
      await vi.advanceTimersByTimeAsync(4000);
      p.destroy();
      expect(cutOf(f.frames, (k) => (k >= 0 && k < 120) || (k >= 180 && k < 300) || (k >= 600 && k < 630)), at).toEqual([]);
      // (at the new speed's own margin: atSpeed)
      expect(f.frames.filter((x) => x.k < 120).at(-1)!.k, at).toBeGreaterThanOrEqual(119 - atSpeed(to));
    }
  });

  it("no frame rate from the job, clips sped up: the frames' media-time steps tell it (30 fps at 2x and 1.5x, 24 fps between 1x and 1.5x) — rounds 3–5 divided them by the speed (2x read as 60 fps: its clips' edges a frame off, cut frames at its joins)", async () => {
    for (const [fps, sp] of [
      [30, [2]],
      [30, [1.5]],
      [24, [1, 1.5]],
    ] as const) {
      const at = `${fps} fps at ${sp.join("/")}x`;
      const plan = many.map((s, i) => ({ ...s, speed: sp[i % sp.length] }));
      const frames = await playAll(framedVideo(0, { fps }), 20_000, { plan, fps: 0 });
      expect(cutOf(frames, (k) => keptMany(k, fps)), at).toEqual([]);
    }
  });

  it("a busy machine (the compositor drawing at 20 Hz, animation frames 30 ms late now and then): the jump comes on the last frames — round 3's clock jumped 3–4 frames early (CI: currentTime 5.864 before the cut at 6.0)", async () => {
    // the e2e playback suite's shape: [0, 6) [7, 14), play from 5.5 and
    // sample the element's clock every animation frame; the busy stretch
    // at every phase of the join
    for (const ph of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
      const t0 = Date.now();
      const busy = (t: number) => (t - t0 + ph) % 100 < 30;
      for (const o of [{ drawEvery: 3 }, { drawEvery: 3, busy }, { busy }]) {
        const f = framedVideo(5.5, o);
        const p = new EditPlayer(f.v, { fps: 30 });
        p.setPlan(buildPlan([{ id: "A", start: 0, end: 6 }, { id: "B", start: 7, end: 14 }], 30));
        await vi.advanceTimersByTimeAsync(50);
        p.seek(5.5, "A");
        await vi.advanceTimersByTimeAsync(100);
        const samples: number[] = [];
        const tick = () => {
          samples.push(f.v.currentTime);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        void f.v.play();
        await vi.advanceTimersByTimeAsync(1500);
        p.destroy();
        const at = `${ph} ${JSON.stringify(Object.keys(o))}`;
        expect(cutOf(f.frames, (k) => k < 180 || k >= 210), at).toEqual([]);
        // the element's clock when the jump was asked: in frame 177 at the
        // earliest, and the last frame of A on screen 177 or later (two
        // frames early: the 20 Hz compositor shows every other frame — the
        // owner's allowance under load). Round 4 asked the clock > 5.91 (0.3
        // frame into 177) and the last animation-frame sample of the clock
        // before the jump > 5.88; round 5's first join (the seek's reach
        // unknown: the jump before 179 could be picked) asks at the last
        // safe moment for it — 5.907 at one phase, 177 on screen, the same
        // frames — and with the main thread busy 30 ms the last sample
        // before that is up to a busy stretch old (5.869: the e2e playback
        // spec's stale sample, F1). Measured on the frames shown instead:
        // the same bound (177, at most two frames dropped), exact.
        const jumpAt = f.seeks.find((x) => x.to >= 7)!.pos;
        expect(jumpAt, at).toBeGreaterThanOrEqual(177 / 30);
        expect(f.frames.filter((x) => x.k < 180).at(-1)!.k, at).toBeGreaterThanOrEqual(177);
        expect(samples.length, at).toBeGreaterThan(10);
      }
    }
  });

  it("a 60 fps video, and a 120 Hz screen: no cut frame, at most the last kept frame at a join", async () => {
    const f = framedVideo(0, { fps: 60 });
    const at60 = await playAll(f, 25_000, { plan: many, fps: 60 });
    expect(cutOf(at60, (k) => keptMany(k, 60))).toEqual([]);
    expect(Math.max(...droppedAtEnds(at60, many, 60))).toBeLessThanOrEqual(1);
    const g = framedVideo(0, { vsyncMs: 1000 / 120 });
    const frames = await playAll(g, 25_000, { plan: many });
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    expect(Math.max(...droppedAtEnds(frames, many))).toBeLessThanOrEqual(1);
  });

  it("a split (the next clip starts on the frame the last one ends): no seek", async () => {
    const f = framedVideo(0);
    const p = new EditPlayer(f.v, { fps: 30 });
    p.setPlan(
      buildPlan(
        [
          { id: "A", start: 0, end: 1.5 },
          { id: "A~2", start: 1.5, end: 3 },
        ],
        10,
      ),
    );
    await vi.advanceTimersByTimeAsync(50);
    const before = f.seeks.length;
    void f.v.play();
    await vi.advanceTimersByTimeAsync(2000);
    p.destroy();
    expect(f.seeks.length).toBe(before);
    const ks = f.frames.map((x) => x.k);
    expect(ks).toContain(44);
    expect(ks).toContain(45);
  });

  it("desktop: a short gain ramp into the jump and out of the landing — never a mute", async () => {
    // two short clips first, then A's end [1.2, 2) → B at 5
    const plan = [{ id: "P", start: 0, end: 0.5 }, { id: "Q", start: 0.6, end: 1 }, { id: "A", start: 1.2, end: 2 }, ...segs.slice(1)];
    const f = framedVideo(0);
    const frames = await playAll(f, 2600, { plan });
    expect(f.mutes.some((m) => m)).toBe(false);
    const jump = f.seeks.find((s) => Math.abs(s.to - 5) < 0.05)!;
    expect(jump).toBeTruthy();
    // the jump while the last kept frame is up (frame 59: 1.967–2.0 s),
    // before the compositor picks the next one (a refresh before it is due)
    expect(frames.some((x) => x.k === 59)).toBe(true);
    expect(jump.pos).toBeGreaterThanOrEqual(59 / 30);
    expect(jump.pos).toBeLessThan(2 - 1 / 60);
    const down = f.volumes.filter((x) => x.at <= jump.at && x.value < 1 && x.value > 0);
    expect(down.length).toBeGreaterThan(0);
    // full volume in A (once its landing's ramp is up) until just before
    expect(f.volumes.filter((x) => x.at <= jump.at && x.pos > 1.3 && x.pos < 59 / 30 - 0.03).every((x) => x.value === 1)).toBe(true);
    expect(f.volumes.filter((x) => x.at > jump.at).at(-1)?.value).toBe(1);
  });

  it("iOS (volume read-only): never muted at a join", async () => {
    const f = framedVideo(0, { volumeReadOnly: true });
    const frames = await playAll(f);
    expect(f.mutes.some((m) => m)).toBe(false);
    expect(cutOf(frames, kept)).toEqual([]);
  });

  it("a seek onto a clip's first moment shows its first frame, not the cut one before it", async () => {
    const f = framedVideo(0, { phase: 0.012 });
    const p = new EditPlayer(f.v, { fps: 30 });
    p.setPlan(buildPlan(segs, 10));
    await vi.advanceTimersByTimeAsync(50);
    void f.v.play();
    await vi.advanceTimersByTimeAsync(300); // frames seen: the grid's offset known
    f.v.pause();
    p.seek(5, "B");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames.at(-1)!.k).toBe(150);
    p.destroy();
  });
});

describe("EditPlayer scrub (drag-9)", () => {
  /** A playing <video> on the fake clock: time runs while not paused or seeking; a seek lands 20 ms later. */
  function clockVideo(start: number) {
    const on = new Map<string, Set<() => void>>();
    const emit = (ev: string) => on.get(ev)?.forEach((f) => f());
    let pos = start;
    let since = Date.now();
    let paused = false;
    let seeking = false;
    const log: { at: number; type: "seek"; value: number }[] = [];
    const now = () => (paused || seeking ? pos : pos + (Date.now() - since) / 1000);
    const v = {
      get paused() {
        return paused;
      },
      get seeking() {
        return seeking;
      },
      ended: false,
      readyState: 4,
      playbackRate: 1,
      volume: 1,
      muted: false,
      get currentTime() {
        return now();
      },
      set currentTime(x: number) {
        log.push({ at: Date.now(), type: "seek", value: x });
        pos = x;
        seeking = true;
        emit("seeking");
        setTimeout(() => {
          seeking = false;
          since = Date.now();
          emit("seeked");
        }, 20);
      },
      pause() {
        pos = now();
        paused = true;
        emit("pause");
      },
      addEventListener(ev: string, fn: () => void) {
        if (!on.has(ev)) on.set(ev, new Set());
        on.get(ev)!.add(fn);
      },
      removeEventListener(ev: string, fn: () => void) {
        on.get(ev)?.delete(fn);
      },
    };
    return { v: v as unknown as HTMLVideoElement, log };
  }

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const plan = () =>
    buildPlan(
      [
        { id: "A", start: 0, end: 2 },
        { id: "B", start: 5, end: 7 },
      ],
      10,
    );

  it("scrub shows a source time the plan cuts and leaves it there until let go", async () => {
    const { v, log } = clockVideo(1.5);
    const p = new EditPlayer(v, { seekRampMs: 15 });
    p.setPlan(plan());
    p.scrub(3.2); // inside the cut 2–5: the frame at a trim edge being dragged
    expect(v.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(v.currentTime).toBeCloseTo(3.2, 6);
    log.length = 0;
    p.scrub(3.4);
    p.scrub(3.5); // while a seek runs: only the newest goes after it
    p.scrub(3.6);
    await vi.advanceTimersByTimeAsync(100);
    expect(v.currentTime).toBeCloseTo(3.6, 6);
    expect(log.filter((e) => e.type === "seek").map((e) => e.value)).toEqual([3.4, 3.6]);
    p.scrub(null);
    p.destroy();
  });
});
