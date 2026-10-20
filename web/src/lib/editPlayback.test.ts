import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cutRange } from "@/features/editor/state/cuts";
import { buildPlan, clipFrames, EditPlayer, fadeLevel, jumpOnFrame, locate, nextInSource, seekRampLevel, type PlaySeg } from "@/lib/editPlayback";

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

  it("jumps on the clip's last frame — the next one would be cut", () => {
    expect(jumpOnFrame(58, 60)).toBe(false);
    expect(jumpOnFrame(59, 60)).toBe(true);
    // a late frame (a cut one already showing): jump at once
    expect(jumpOnFrame(61, 60)).toBe(true);
    // 2 frames a presentation (high speed): one frame sooner
    expect(jumpOnFrame(58, 60, 2)).toBe(true);
    // callbacks running late: one frame sooner
    expect(jumpOnFrame(58, 60, 1, 1)).toBe(true);
    expect(jumpOnFrame(57, 60, 1, 1)).toBe(false);
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
 */
function framedVideo(
  start: number,
  o: {
    fps?: number;
    phase?: number;
    vsyncMs?: number;
    cbDelay?: number;
    seekLatency?: number;
    landMs?: number;
    rvfc?: boolean;
    volumeReadOnly?: boolean;
    drop?: (k: number) => boolean;
    busy?: (t: number) => boolean;
    drawEvery?: number;
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
  let frozen = false; // the seek reached the decoder: no picks until it lands
  let vol = 1;
  let rate = 1;
  let presented = 0;
  let shown = -1;
  let picked: number | null = null;
  let target = 0;
  const frames: Presented[] = [];
  const seeks: { at: number; to: number; pos: number }[] = [];
  const volumes: { at: number; value: number; pos: number }[] = [];
  const mutes: boolean[] = [];
  type Md = { mediaTime: number; presentedFrames: number; expectedDisplayTime: number };
  let cbs: ((now: number, md: Md) => void)[] = [];
  let rafs = new Map<number, (t: number) => void>();
  let handle = 0;
  const clockAt = (t: number) => (paused || frozen ? pos : pos + ((t - since) / 1000) * rate);
  const clock = () => clockAt(Date.now());
  const frameAt = (t: number) => Math.floor((t - phase) * fps + 1e-9);
  let pendingMd: Md | null = null;
  let updateDue: number | null = null;
  const present = (k: number, at: number) => {
    if (k === shown) return;
    shown = k;
    presented++;
    frames.push({ k, at, seeking });
    pendingMd = { mediaTime: Math.round((k / fps + phase) * 1000) / 1000, presentedFrames: presented, expectedDisplayTime: at };
  };
  // the page's rendering update: frame callbacks, then animation frames
  const update = () => {
    const now = Date.now();
    const md = pendingMd;
    pendingMd = null;
    if (md) {
      const run = cbs;
      cbs = [];
      run.forEach((cb) => cb(now, md));
    }
    const run = rafs;
    rafs = new Map();
    run.forEach((cb) => cb(now));
  };
  let nextVsync = Date.now() + vsync;
  let vsyncs = 0;
  const every = o.drawEvery ?? 1;
  const tick = () => {
    const now = Date.now();
    if (now >= nextVsync) {
      const v0 = nextVsync;
      nextVsync += vsync;
      if (vsyncs++ % every === 0) {
        if (picked !== null) present(picked, v0);
        picked = null;
        if (!paused && !frozen) {
          const k = frameAt(clockAt(v0 + vsync * every));
          if (k !== shown && !o.drop?.(k)) picked = k;
        }
      }
      updateDue = v0 + (o.cbDelay ?? 2);
    }
    if (updateDue !== null && now >= updateDue && !o.busy?.(now)) {
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
      pos = clock();
      since = Date.now();
      rate = r;
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
      return seeking ? target : clock();
    },
    set currentTime(x: number) {
      seeks.push({ at: Date.now(), to: x, pos: clock() });
      target = x;
      seeking = true;
      emit("seeking");
      setTimeout(() => {
        pos = clock();
        frozen = true;
      }, o.seekLatency ?? 3);
      setTimeout(() => {
        pos = x;
        frozen = false;
        seeking = false;
        since = Date.now();
        // the decoded target frame goes up at the next refresh
        picked = frameAt(x);
        emit("seeked");
      }, o.landMs ?? 20);
    },
    play() {
      if (!paused) return Promise.resolve();
      paused = false;
      since = Date.now();
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
  return { v: v as unknown as HTMLVideoElement, frames, seeks, volumes, mutes, fps, phase };
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

  it("frame callbacks: the jump goes on each clip's last frame; no cut frame; the last frames show", async () => {
    const f = framedVideo(0);
    const frames = await playAll(f);
    expect(cutOf(frames, kept)).toEqual([]);
    const ks = new Set(frames.map((x) => x.k));
    expect(ks.has(59) && ks.has(209) && ks.has(119)).toBe(true);
    // landed on each clip's first frame
    expect(ks.has(150) && ks.has(90)).toBe(true);
    // the timeline's end: paused on C's last frame
    expect(f.v.paused).toBe(true);
    expect(Math.floor(f.v.currentTime * 30)).toBe(119);
  });

  it("50+ joins of short clips: no cut frame, at most the last kept frame dropped at a join", async () => {
    const f = framedVideo(0);
    const frames = await playAll(f, 25_000, { plan: many });
    expect(many.length).toBeGreaterThan(50);
    expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    const drops = droppedAtEnds(frames, many);
    expect(Math.max(...drops)).toBeLessThanOrEqual(1);
    // and mostly none
    expect(drops.filter((n) => n === 0).length / drops.length).toBeGreaterThan(0.5);
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

  it("clips at 1.5x and 2x: still no cut frame", async () => {
    for (const speed of [1.5, 2]) {
      const f = framedVideo(0);
      const frames = await playAll(f, 15_000, { plan: many.map((s) => ({ ...s, speed })) });
      expect(cutOf(frames, (k) => keptMany(k))).toEqual([]);
    }
  });

  it("a 60 fps video, and a 120 Hz screen: no cut frame", async () => {
    const f = framedVideo(0, { fps: 60 });
    expect(cutOf(await playAll(f, 25_000, { plan: many, fps: 60 }), (k) => keptMany(k, 60))).toEqual([]);
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
    const f = framedVideo(0);
    await playAll(f, 2600);
    expect(f.mutes.some((m) => m)).toBe(false);
    const jump = f.seeks.find((s) => Math.abs(s.to - 5) < 0.05)!;
    expect(jump).toBeTruthy();
    // the jump while the last frame is up (frame 59: 1.967–2.0 s), or just before it
    expect(jump.pos).toBeGreaterThanOrEqual(58.5 / 30);
    expect(jump.pos).toBeLessThan(2 - 0.02);
    const down = f.volumes.filter((x) => x.at <= jump.at && x.value < 1 && x.value > 0);
    expect(down.length).toBeGreaterThan(0);
    // full volume until just before
    expect(f.volumes.filter((x) => x.at <= jump.at && x.pos < 59 / 30 - 0.03).every((x) => x.value === 1)).toBe(true);
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
