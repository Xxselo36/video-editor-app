import { describe, expect, it, vi } from "vitest";
import { activeIndexAt, createPlayheadStore, selectionGetter, type VideoLike } from "./playhead";

/** A <video> stand-in: events, time, and a frame callback queue. */
class FakeVideo implements VideoLike {
  currentTime = 0;
  paused = true;
  ended = false;
  muted = false;
  readyState = 0;
  private listeners = new Map<string, Set<() => void>>();
  frameCbs = new Map<number, (now: number, meta: { mediaTime: number }) => void>();
  private nextHandle = 1;
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;

  constructor(withRvfc: boolean) {
    if (withRvfc) {
      this.requestVideoFrameCallback = (cb) => {
        const h = this.nextHandle++;
        this.frameCbs.set(h, cb);
        return h;
      };
      this.cancelVideoFrameCallback = (h) => {
        this.frameCbs.delete(h);
      };
    }
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string) {
    this.listeners.get(type)?.forEach((fn) => fn());
  }
  listenerCount() {
    let n = 0;
    this.listeners.forEach((s) => (n += s.size));
    return n;
  }
  /** Present a frame: runs (and consumes) the pending frame callbacks. */
  present(mediaTime: number) {
    const cbs = [...this.frameCbs.values()];
    this.frameCbs.clear();
    cbs.forEach((cb) => cb(0, { mediaTime }));
  }
}

/** Manual requestAnimationFrame. */
function manualRaf() {
  const cbs = new Map<number, () => void>();
  let n = 1;
  return {
    raf: (cb: () => void) => {
      const h = n++;
      cbs.set(h, cb);
      return h;
    },
    cancelRaf: (h: number) => {
      cbs.delete(h);
    },
    step() {
      const run = [...cbs.values()];
      cbs.clear();
      run.forEach((cb) => cb());
    },
    pending: () => cbs.size,
  };
}

describe("playhead store", () => {
  it("takes the presented frame's mediaTime, not currentTime", () => {
    const store = createPlayheadStore({}, manualRaf());
    const v = new FakeVideo(true);
    store.attach(v);
    v.paused = false;
    v.emit("play");
    // The element already decodes ahead; the frame on screen is older.
    v.currentTime = 1.25;
    v.present(1.2);
    expect(store.getState().mediaTime).toBe(1.2);
    v.present(1.2333);
    expect(store.getState().mediaTime).toBe(1.2333);
  });

  it("keeps requesting frames and stops on detach", () => {
    const store = createPlayheadStore({}, manualRaf());
    const v = new FakeVideo(true);
    const detach = store.attach(v);
    expect(v.frameCbs.size).toBe(1);
    v.present(0.5);
    expect(v.frameCbs.size).toBe(1);
    detach();
    expect(v.frameCbs.size).toBe(0);
    expect(v.listenerCount()).toBe(0);
    v.present(9);
    expect(store.getState().mediaTime).toBe(0.5);
  });

  it("falls back to polling currentTime with rAF while playing", () => {
    const sched = manualRaf();
    const store = createPlayheadStore({}, sched);
    const v = new FakeVideo(false);
    store.attach(v);
    expect(sched.pending()).toBe(0); // paused: no polling
    v.paused = false;
    v.emit("play");
    expect(store.getState().playing).toBe(true);
    v.currentTime = 0.4;
    sched.step();
    expect(store.getState().mediaTime).toBe(0.4);
    v.currentTime = 0.45;
    sched.step();
    expect(store.getState().mediaTime).toBe(0.45);
    v.paused = true;
    v.emit("pause");
    sched.step(); // the loop sees the pause and ends
    expect(sched.pending()).toBe(0);
    expect(store.getState().playing).toBe(false);
  });

  it("follows seeks while paused, play state, buffering and mute", () => {
    const store = createPlayheadStore({}, manualRaf());
    const v = new FakeVideo(true);
    store.attach(v);
    v.readyState = 1;
    v.emit("loadedmetadata");
    expect(store.getState().ready).toBe(true);
    v.currentTime = 7;
    v.emit("seeked");
    expect(store.getState().mediaTime).toBe(7);
    v.paused = false;
    v.emit("play");
    v.emit("waiting");
    expect(store.getState().buffering).toBe(true);
    v.emit("playing");
    expect(store.getState().buffering).toBe(false);
    v.muted = true;
    v.emit("volumechange");
    expect(store.getState().muted).toBe(true);
    v.paused = true;
    v.ended = true;
    v.emit("ended");
    expect(store.getState().playing).toBe(false);
  });

  it("canplay while paused ends buffering without claiming playback", () => {
    const store = createPlayheadStore({ buffering: true }, manualRaf());
    const v = new FakeVideo(true);
    store.attach(v);
    v.emit("canplay");
    expect(store.getState()).toMatchObject({ buffering: false, playing: false });
  });

  it("notifies only when a value changed", () => {
    const store = createPlayheadStore({}, manualRaf());
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.set({ mediaTime: 0 });
    store.set({ playing: false });
    expect(fn).not.toHaveBeenCalled();
    store.set({ mediaTime: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    const before = store.getState();
    store.set({ mediaTime: 1 });
    expect(store.getState()).toBe(before); // same snapshot object
    off();
    store.set({ mediaTime: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("selectionGetter (usePlayhead's snapshot)", () => {
  it("returns the previous value while the selection is equal", () => {
    const store = createPlayheadStore({}, manualRaf());
    const sel = vi.fn((s: { mediaTime: number }) => Math.floor(s.mediaTime));
    const get = selectionGetter(store.getState, sel);
    expect(get()).toBe(0);
    expect(get()).toBe(0);
    expect(sel).toHaveBeenCalledTimes(1); // same state: selector not re-run
    store.set({ mediaTime: 0.5 });
    expect(get()).toBe(0);
    store.set({ mediaTime: 1.5 });
    expect(get()).toBe(1);
  });

  it("uses the equality function for derived objects", () => {
    const store = createPlayheadStore({}, manualRaf());
    const get = selectionGetter(
      store.getState,
      (s) => ({ sec: Math.floor(s.mediaTime) }),
      (a, b) => a.sec === b.sec,
    );
    const first = get();
    store.set({ mediaTime: 0.9 });
    expect(get()).toBe(first);
    store.set({ mediaTime: 2 });
    expect(get()).not.toBe(first);
    expect(get()).toEqual({ sec: 2 });
  });
});

describe("activeIndexAt", () => {
  const starts = [0, 2, 5, 9];
  const ends = [1.9, 4.8, 8, 12];
  it("finds the entry holding t", () => {
    expect(activeIndexAt(starts, ends, 0)).toBe(0);
    expect(activeIndexAt(starts, ends, 3)).toBe(1);
    expect(activeIndexAt(starts, ends, 8)).toBe(2);
    expect(activeIndexAt(starts, ends, 11.5)).toBe(3);
  });
  it("is -1 in gaps, before the first and after the last", () => {
    expect(activeIndexAt(starts, ends, 1.95)).toBe(-1);
    expect(activeIndexAt(starts, ends, 8.5)).toBe(-1);
    expect(activeIndexAt(starts, ends, -1)).toBe(-1);
    expect(activeIndexAt(starts, ends, 13)).toBe(-1);
    expect(activeIndexAt([], [], 1)).toBe(-1);
  });
  it("prefers the earliest of overlapping entries (like findIndex)", () => {
    expect(activeIndexAt([0, 1, 1.5], [2, 3, 4], 1.8)).toBe(0);
    expect(activeIndexAt([0, 1, 1.5], [2, 3, 4], 2.5)).toBe(1);
  });
  it("matches a linear scan on random sentence-like data", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let run = 0; run < 50; run++) {
      const s: number[] = [];
      const e: number[] = [];
      let t = 0;
      for (let i = 0; i < 30; i++) {
        t += rnd() * 0.6; // gap (sometimes ~0: touching sentences)
        s.push(t);
        t += rnd() * 3;
        e.push(t);
      }
      for (let k = 0; k < 40; k++) {
        const q = rnd() * (t + 2);
        const linear = s.findIndex((a, i) => q >= a && q <= e[i]);
        expect(activeIndexAt(s, e, q)).toBe(linear);
      }
    }
  });
});
