"use client";
/**
 * The editor's playhead (UX7d): one external store per editor, fed by the
 * <video>'s presented frames, so nothing re-renders the whole editor while
 * it plays (tech.md T13, review C16: ≤ 2 React commits/s while playing).
 *
 * Feeding (attach):
 *   - requestVideoFrameCallback: `mediaTime` of the frame the compositor
 *     presented, so the playhead, the clock and the captions never run
 *     ahead of the picture (review C11);
 *   - where rVFC is missing, requestAnimationFrame polls `currentTime`
 *     while the video plays;
 *   - events fill in what frames don't report: seeked (also while
 *     paused), play/pause/ended, waiting (buffering), volumechange.
 *
 * Reading:
 *   - usePlayhead(store, selector, isEqual): useSyncExternalStore with a
 *     memoised selection. A component re-renders only when ITS value
 *     changes — use it for coarse values (playing, the active line, "can
 *     split here").
 *   - usePlayheadEffect(store, fn): per-frame values (the timecode text,
 *     the playhead's x) are written to the DOM in a subscription, without
 *     a React render.
 *
 * `mediaTime` is the video element's own timebase: source seconds in proxy
 * mode, seconds of the cut preview in preview mode. The editor session
 * maps it to source time (useEditSession `toSource`).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

export type PlayheadState = {
  /** Media time of the presented frame (see the header). */
  mediaTime: number;
  /** Playing, or asked to play (between play() and the first frame). */
  playing: boolean;
  /** Waiting for data while playing. */
  buffering: boolean;
  muted: boolean;
  /** The element has metadata (duration, size). */
  ready: boolean;
};

export type Listener = () => void;

/** What attach() needs of a <video> (a fake in the unit tests). */
export type VideoLike = {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  readyState: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type PlayheadStore = {
  getState: () => PlayheadState;
  subscribe: (listener: Listener) => () => void;
  /** Merge a patch; listeners run only when a value changed. */
  set: (patch: Partial<PlayheadState>) => void;
  /** Follow a video element; returns the detach function. */
  attach: (video: VideoLike) => () => void;
};

export const INITIAL_PLAYHEAD: PlayheadState = {
  mediaTime: 0,
  playing: false,
  buffering: false,
  muted: false,
  ready: false,
};

type Scheduler = {
  raf: (cb: () => void) => number;
  cancelRaf: (handle: number) => void;
};

const defaultScheduler = (): Scheduler => ({
  raf: (cb) => requestAnimationFrame(cb),
  cancelRaf: (h) => cancelAnimationFrame(h),
});

export function createPlayheadStore(
  initial: Partial<PlayheadState> = {},
  scheduler: Scheduler = defaultScheduler(),
): PlayheadStore {
  let state: PlayheadState = { ...INITIAL_PLAYHEAD, ...initial };
  const listeners = new Set<Listener>();

  const set = (patch: Partial<PlayheadState>) => {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof PlayheadState)[]) {
      if (patch[k] !== undefined && !Object.is(patch[k], state[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  const attach = (video: VideoLike) => {
    const sync = () =>
      set({
        mediaTime: video.currentTime,
        playing: !video.paused && !video.ended,
        muted: video.muted,
        ready: video.readyState >= 1,
      });
    sync();

    // rAF fallback: poll while playing only.
    const rvfc = typeof video.requestVideoFrameCallback === "function";
    let frameHandle = 0;
    let rafHandle = 0;
    let rafOn = false;
    const tick = () => {
      if (video.paused || video.ended) {
        rafOn = false;
        return;
      }
      set({ mediaTime: video.currentTime });
      rafHandle = scheduler.raf(tick);
    };
    const startPolling = () => {
      if (rvfc || rafOn) return;
      rafOn = true;
      rafHandle = scheduler.raf(tick);
    };
    if (rvfc) {
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        set({ mediaTime: meta.mediaTime });
        frameHandle = video.requestVideoFrameCallback!(onFrame);
      };
      frameHandle = video.requestVideoFrameCallback!(onFrame);
    } else if (!video.paused) {
      startPolling();
    }

    const onPlay = () => {
      set({ playing: true });
      startPolling();
    };
    const onStop = () => set({ playing: false, buffering: false, mediaTime: video.currentTime });
    // Seeks while paused present no frame in every browser (rVFC does in
    // Chromium): take the element's time; a frame callback refines it.
    const onSeeked = () => set({ mediaTime: video.currentTime, buffering: false });
    const onWaiting = () => set({ buffering: !video.paused });
    const onPlaying = () => set({ buffering: false, playing: true });
    // canplay also fires while paused: it ends buffering, not a pause.
    const onCanPlay = () => set({ buffering: false });
    const onVolume = () => set({ muted: video.muted });
    const handlers: [string, () => void][] = [
      ["loadedmetadata", sync],
      ["emptied", sync],
      ["play", onPlay],
      ["pause", onStop],
      ["ended", onStop],
      ["seeked", onSeeked],
      ["waiting", onWaiting],
      ["playing", onPlaying],
      ["canplay", onCanPlay],
      ["volumechange", onVolume],
    ];
    handlers.forEach(([ev, fn]) => video.addEventListener(ev, fn));
    return () => {
      handlers.forEach(([ev, fn]) => video.removeEventListener(ev, fn));
      if (rvfc) video.cancelVideoFrameCallback?.(frameHandle);
      if (rafOn) scheduler.cancelRaf(rafHandle);
      rafOn = false;
    };
  };

  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    set,
    attach,
  };
}

/**
 * A getSnapshot for useSyncExternalStore that returns the previous
 * selection while the selected value is equal (so the component doesn't
 * re-render), like use-sync-external-store/with-selector.
 */
export function selectionGetter<S, T>(
  getState: () => S,
  selector: (s: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): () => T {
  let has = false;
  let lastState: S;
  let lastValue: T;
  return () => {
    const s = getState();
    if (has && Object.is(s, lastState)) return lastValue;
    const next = selector(s);
    lastState = s;
    if (has && isEqual(lastValue, next)) return lastValue;
    has = true;
    lastValue = next;
    return next;
  };
}

/** A value derived from the playhead; re-renders only when it changes. */
export function usePlayhead<T>(
  store: PlayheadStore,
  selector: (s: PlayheadState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const get = useMemo(() => selectionGetter(store.getState, selector, isEqual), [store, selector, isEqual]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * Runs `fn` with every playhead change (and once on mount) — for DOM writes
 * that must not re-render React (timecode text, playhead position).
 */
export function usePlayheadEffect(store: PlayheadStore, fn: (s: PlayheadState) => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const run = () => ref.current(store.getState());
    run();
    return store.subscribe(run);
  }, [store]);
}

/**
 * Index of the entry whose [start, end] holds t: binary search over
 * `starts` (ascending), then the end check. -1 when t is in no entry.
 * Replaces the per-frame linear scans of the v1 editor (tech.md T13).
 */
export function activeIndexAt(starts: readonly number[], ends: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  // Overlapping neighbours: the earliest one that still holds t (the v1
  // editor's findIndex picked the first match).
  let i = found;
  while (i > 0 && starts[i - 1] <= t && ends[i - 1] >= t) i--;
  return t <= ends[i] ? i : -1;
}

export const PlayheadContext = createContext<PlayheadStore | null>(null);

export function usePlayheadStore(): PlayheadStore {
  const s = useContext(PlayheadContext);
  if (!s) throw new Error("usePlayheadStore outside PlayheadContext");
  return s;
}
