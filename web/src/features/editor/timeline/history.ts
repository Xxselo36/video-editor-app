"use client";
/**
 * The timeline's undo/redo (moved out of TimelineEditor unchanged, UX7),
 * so the v2 top bar can drive the same history. UX10 replaces it with the
 * one history for text, style and clips (state/history.ts).
 *
 * The steps are pure functions (tlCommit / tlUndo / tlRedo, unit-tested);
 * the hook keeps their state. A commit of a clip list equal to the one on
 * screen is no edit: no undo step, no save (a trim handle held and
 * released without a move used to add a step and a full preview rebuild).
 */
import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import type { EditorSeg } from "./mechanics";

export type TimelineHistory = {
  /** Commit a new clip list as one undo step; `coalesce` groups rapid
   *  changes of the same control (a slider drag) into ONE step. True
   *  when this commit added an undo step (false: merged into the last,
   *  or nothing changed). */
  commit: (next: EditorSeg[], coalesce?: string) => boolean;
  undo: () => void;
  redo: () => void;
  /** Drop every step (the timeline was replaced by the server's: a conflict reload). */
  reset: () => void;
  canUndo: boolean;
  canRedo: boolean;
  history: EditorSeg[][];
  future: EditorSeg[][];
};

/** Undo steps kept (both ways: a redo never shortens the history). */
export const TL_HISTORY_LIMIT = 50;

/** Whether a commit with `key` at `now` joins the last commit's undo step. */
export function coalesces(last: { key: string; t: number } | null, key: string | undefined, now: number): boolean {
  return !!key && !!last && last.key === key && now - last.t < 1000;
}

/** The same clip list by value (ids, edges, effects, order). */
export function sameSegs(a: readonly EditorSeg[], b: readonly EditorSeg[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.id === y.id &&
      x.start === y.start &&
      x.end === y.end &&
      !!x.disabled === !!y.disabled &&
      (x.speed ?? 1) === (y.speed ?? 1) &&
      (x.volume ?? 1) === (y.volume ?? 1) &&
      (x.fadeIn ?? 0) === (y.fadeIn ?? 0) &&
      (x.fadeOut ?? 0) === (y.fadeOut ?? 0)
    );
  });
}

export type TlHistoryState = {
  history: EditorSeg[][];
  future: EditorSeg[][];
  /** The last commit's coalesce key (a slider drag in progress). */
  last: { key: string; t: number } | null;
};

export const EMPTY_TL_HISTORY: TlHistoryState = { history: [], future: [], last: null };

/**
 * Commit `next` over `present`. `apply`: whether the clip list changes
 * (false: equal to the present, nothing happens); `added`: a new undo step.
 */
export function tlCommit(
  st: TlHistoryState,
  present: EditorSeg[],
  next: EditorSeg[],
  coalesce: string | undefined,
  now: number,
): { st: TlHistoryState; apply: boolean; added: boolean } {
  if (sameSegs(next, present)) return { st, apply: false, added: false };
  const merge = coalesces(st.last, coalesce, now);
  return {
    st: {
      history: merge ? st.history : [...st.history, present].slice(-TL_HISTORY_LIMIT),
      future: [],
      last: coalesce ? { key: coalesce, t: now } : null,
    },
    apply: true,
    added: !merge,
  };
}

/** One step back: the clip list to show, or null when there is none. A
 *  slider moved right after this starts a new step (no merge into it). */
export function tlUndo(st: TlHistoryState, present: EditorSeg[]): { st: TlHistoryState; to: EditorSeg[] } | null {
  if (st.history.length === 0) return null;
  const to = st.history[st.history.length - 1];
  return {
    st: {
      history: st.history.slice(0, -1),
      future: [present, ...st.future].slice(0, TL_HISTORY_LIMIT),
      last: null,
    },
    to,
  };
}

/** One step forward again, or null. */
export function tlRedo(st: TlHistoryState, present: EditorSeg[]): { st: TlHistoryState; to: EditorSeg[] } | null {
  if (st.future.length === 0) return null;
  const to = st.future[0];
  return {
    st: {
      history: [...st.history, present].slice(-TL_HISTORY_LIMIT),
      future: st.future.slice(1),
      last: null,
    },
    to,
  };
}

export function useTimelineHistory(
  segments: EditorSeg[],
  onCommit: (next: EditorSeg[]) => void,
): TimelineHistory {
  const [state, setState] = useState<TlHistoryState>(EMPTY_TL_HISTORY);
  // the latest state for commits made before the next render
  const stRef = useRef(state);
  const put = (st: TlHistoryState) => {
    stRef.current = st;
    setState(st);
  };

  // `coalesce` groups rapid changes of the same control (a slider being
  // dragged fires dozens of changes) into ONE undo step.
  const commit = (next: EditorSeg[], coalesce?: string) => {
    const r = tlCommit(stRef.current, segments, next, coalesce, Date.now());
    if (!r.apply) return false;
    put(r.st);
    onCommit(next);
    return r.added;
  };
  const undo = () => {
    const r = tlUndo(stRef.current, segments);
    if (!r) return;
    track("undo", { area: "timeline" });
    put(r.st);
    onCommit(r.to);
  };
  const redo = () => {
    const r = tlRedo(stRef.current, segments);
    if (!r) return;
    put(r.st);
    onCommit(r.to);
  };

  const reset = () => put(EMPTY_TL_HISTORY);

  return {
    commit,
    undo,
    redo,
    reset,
    canUndo: state.history.length > 0,
    canRedo: state.future.length > 0,
    history: state.history,
    future: state.future,
  };
}
