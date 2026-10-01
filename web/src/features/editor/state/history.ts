/**
 * Undo / redo of the edit document (UX8): snapshots of the immutable
 * doc (structural sharing: an op copies the word array, never the
 * words it didn't touch). Words, style and format share one stack; the
 * timeline keeps its own until UX10 (timeline/history.ts) and the
 * editor interleaves the two by order of the edits.
 *
 * `coalesce`: rapid commits with the same key within `windowMs` are one
 * step (a slider drag; typing is committed per word, not per key).
 */
export type History<T> = {
  past: T[];
  present: T;
  future: T[];
  /** Key and time of the last commit, for coalescing. */
  last: { key: string; t: number } | null;
};

export const HISTORY_LIMIT = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], last: null };
}

export function commit<T>(h: History<T>, next: T, coalesce?: string, now = Date.now(), windowMs = 1000): History<T> {
  if (next === h.present) return h;
  const merge = !!coalesce && h.last?.key === coalesce && now - h.last.t < windowMs && h.past.length > 0;
  return {
    past: merge ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    last: coalesce ? { key: coalesce, t: now } : null,
  };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future].slice(0, HISTORY_LIMIT),
    last: null,
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return {
    past: [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: h.future[0],
    future: h.future.slice(1),
    last: null,
  };
}

/** Replace the present without an undo step (a reload, a server answer). */
export function reset<T>(h: History<T>, present: T): History<T> {
  return { past: [], present, future: [], last: null };
}
