"use client";
/**
 * The edit document's store (UX8): a tiny external store (the zustand
 * pattern, without the dependency — the playhead store works the same
 * way) holding the doc's undo history. Components read slices with
 * useDocStore(store, selector); the autosave subscribes to it.
 */
import { useCallback, useSyncExternalStore } from "react";
import { renameCaptionKeys } from "@/features/captions-ui/adjusted";
import { mergeWords, type DocWord, type EditDoc } from "./doc";
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
  /**
   * Words the server added (a transcribed span, POST /jobs/{id}/
   * transcribe-span): into every state of the history, without an undo
   * step — an undo never takes them out (the autosave would delete them
   * on the server). Words already there are left as they are.
   */
  addWords: (words: readonly DocWord[]) => void;
  /** Listen to renames (selections and open edits hold word ids). */
  onRenamed: (fn: (map: ReadonlyMap<string, string>) => void) => () => void;
  /** Called after every change that came from apply / undo / redo. */
  onEdit: ((doc: EditDoc) => void) | null;
};

export function createDocStore(doc: EditDoc): DocStore {
  let state: DocState = initHistory(doc);
  const listeners = new Set<() => void>();
  const renameListeners = new Set<(map: ReadonlyMap<string, string>) => void>();
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
      // a caption's own position / size follows its first word's new id (UT5)
      const style = renameCaptionKeys(state.present.style, map);
      set({ ...state, present: { ...state.present, words, style } }, false);
      for (const l of [...renameListeners]) l(map);
    },
    addWords: (words) => {
      if (!words.length) return;
      const add = (d: EditDoc): EditDoc => {
        const have = new Set(d.words.map((w) => w.id));
        const fresh = words.filter((w) => !have.has(w.id));
        return fresh.length ? { ...d, words: mergeWords(d.words, fresh, []) } : d;
      };
      const present = add(state.present);
      if (present === state.present) return;
      set({ ...state, past: state.past.map(add), present, future: state.future.map(add) }, false);
    },
    onRenamed: (fn) => {
      renameListeners.add(fn);
      return () => renameListeners.delete(fn);
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
