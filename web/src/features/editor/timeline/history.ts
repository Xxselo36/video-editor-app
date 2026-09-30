"use client";
/**
 * The timeline's undo/redo (moved out of TimelineEditor unchanged, UX7),
 * so the v2 top bar can drive the same history. UX10 replaces it with the
 * one history for text, style and clips (state/history.ts).
 */
import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import type { EditorSeg } from "./mechanics";

export type TimelineHistory = {
  /** Commit a new clip list as one undo step; `coalesce` groups rapid
   *  changes of the same control (a slider drag) into ONE step. */
  commit: (next: EditorSeg[], coalesce?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  history: EditorSeg[][];
  future: EditorSeg[][];
};

export function useTimelineHistory(
  segments: EditorSeg[],
  onCommit: (next: EditorSeg[]) => void,
): TimelineHistory {
  const [history, setHistory] = useState<EditorSeg[][]>([]);
  const [future, setFuture] = useState<EditorSeg[][]>([]);

  // Wrap onCommit to push history state
  // `coalesce` groups rapid changes of the same control (a slider being
  // dragged fires dozens of changes) into ONE undo step.
  const lastCommitRef = useRef<{ key: string; t: number } | null>(null);
  const commit = (next: EditorSeg[], coalesce?: string) => {
    const now = Date.now();
    const last = lastCommitRef.current;
    const merge = coalesce && last && last.key === coalesce && now - last.t < 1000;
    lastCommitRef.current = coalesce ? { key: coalesce, t: now } : null;
    if (!merge) {
      setHistory((h) => [...h, segments].slice(-50));
    }
    setFuture([]);
    onCommit(next);
  };
  const undo = () => {
    if (history.length === 0) return;
    track("undo", { area: "timeline" });
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setFuture((f) => [segments, ...f].slice(0, 30));
    onCommit(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setHistory((h) => [...h, segments].slice(-30));
    onCommit(next);
  };

  return {
    commit,
    undo,
    redo,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
    history,
    future,
  };
}
