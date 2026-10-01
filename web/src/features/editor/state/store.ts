"use client";
/**
 * The edit document's store (UX8): a tiny external store (the zustand
 * pattern, without the dependency — the playhead store works the same
 * way) holding the doc's undo history. Components read slices with
 * useDocStore(store, selector); the autosave subscribes to it.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { EditDoc } from "./doc";
import { commit, initHistory, redo, reset, undo, type History } from "./history";

export type DocState = History<EditDoc>;

export type DocStore = {
  getState: () => DocState;
  subscribe: (fn: () => void) => () => void;
  /** Apply a pure op to the present doc as one undo step (no step when
   *  the op returned the same doc). True when something changed. */
  apply: (op: (doc: EditDoc) => EditDoc, coalesce?: string) => boolean;
  undo: () => boolean;
  redo: () => boolean;
  /** Replace the doc without undo (reload after a conflict). */
  reset: (doc: EditDoc) => void;
  /** Give words new ids (the autosave's serverIds), without an undo step. */
  rename: (map: ReadonlyMap<string, string>) => void;
  /** Called after every change that came from apply / undo / redo. */
  onEdit: ((doc: EditDoc) => void) | null;
};

export function createDocStore(doc: EditDoc): DocStore {
  let state: DocState = initHistory(doc);
  const listeners = new Set<() => void>();
  const set = (next: DocState, edit: boolean) => {
    if (next === state) return false;
    state = next;
    for (const l of [...listeners]) l();
    if (edit) store.onEdit?.(state.present);
    return true;
  };
  const store: DocStore = {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    apply: (op, coalesce) => {
      const next = op(state.present);
      if (next === state.present) return false;
      return set(commit(state, next, coalesce), true);
    },
    undo: () => set(undo(state), true),
    redo: () => set(redo(state), true),
    reset: (d) => {
      set(reset(state, d), false);
    },
    rename: (map) => {
      if (!map.size) return;
      const words = state.present.words.map((w) => (map.has(w.id) ? { ...w, id: map.get(w.id)! } : w));
      set({ ...state, present: { ...state.present, words } }, false);
    },
    onEdit: null,
  };
  return store;
}

/**
 * A slice of the store; re-renders only when the selected value changes
 * (Object.is). The selector must be stable (module level or memoised)
 * and return existing objects or primitives.
 */
export function useDocStore<T>(store: DocStore, selector: (s: DocState) => T): T {
  const get = useCallback(() => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, get, get);
}
