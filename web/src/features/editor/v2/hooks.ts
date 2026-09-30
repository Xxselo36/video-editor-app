"use client";
// Small browser hooks of the v2 shell.
import { createContext, useContext, useSyncExternalStore } from "react";

/** A media query's current answer (the shell is client-only). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below 900 px: the phone layout (bottom tabs + sheets). */
export const PHONE_QUERY = "(max-width: 899.98px)";

/** navigator.onLine, following the online/offline events. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** The editor's root element: popovers portal into it (tokens apply). */
export const EditorRootContext = createContext<HTMLElement | null>(null);
export function useEditorRoot(): HTMLElement | null {
  return useContext(EditorRootContext);
}

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘Z" on macOS, "Ctrl+Z" elsewhere. */
export function kbd(combo: string): string {
  return IS_MAC ? combo : combo.replace(/⇧⌘/g, "Ctrl+Shift+").replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+");
}
