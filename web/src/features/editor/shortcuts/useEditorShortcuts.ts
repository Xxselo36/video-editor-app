"use client";
/**
 * The v2 editor's keyboard shortcuts (editor.md §4.6): one window
 * listener over the key → action map and the target filter of ./keymap.
 *
 * `handlers` may change every render (they are read through a ref, set
 * as the render commits: a key pressed right after a click that changed
 * the edit — Escape after undo — finds this render's handlers, not the
 * ones before it). A handler returns `false` when it did nothing (e.g.
 * Delete without a selection): the key then keeps its default.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { dispatchShortcut, type ShortcutHandlers } from "./keymap";

export type { ShortcutHandlers } from "./keymap";

export function useEditorShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const ref = useRef(handlers);
  useLayoutEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const onPage = !target || target === document.body || target === document.documentElement;
      if (dispatchShortcut(e, target, onPage, ref.current)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
