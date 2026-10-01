"use client";
/**
 * NEXT_PUBLIC_EDITOR_V2 (UX7): the review phase renders the v2 shell
 * instead of the v1 ReviewScreen.
 *   "off"   off: nothing changes, `?editor=` does nothing.
 *   "1"     v2 for everyone; `?editor=v1` switches this browser back.
 *   unset or "optin"
 *           v1 for everyone; `?editor=v2` switches this browser to v2
 *           (the owner's test on production before it goes live).
 * The per-browser choice is kept in localStorage (PLAN_TECH §0.11).
 */
import { useState } from "react";

// Literal reference: only `process.env.NEXT_PUBLIC_X` gets inlined.
const MODE = process.env.NEXT_PUBLIC_EDITOR_V2;
export const EDITOR_V2 = MODE === "1";
/** v2 only for browsers that opted in with `?editor=v2`. */
export const EDITOR_V2_OPTIN = MODE === "optin" || !MODE;
const KEY = "cleocuts.editor.version.v1";

/** This browser's choice (exported for the unit test). */
export function readChoice(): boolean {
  if (!(EDITOR_V2 || EDITOR_V2_OPTIN) || typeof window === "undefined") return EDITOR_V2;
  try {
    const q = new URLSearchParams(window.location.search).get("editor");
    if (q === "v1" || q === "v2") localStorage.setItem(KEY, q);
    const choice = q ?? localStorage.getItem(KEY);
    return EDITOR_V2 ? choice !== "v1" : choice === "v2";
  } catch {
    return EDITOR_V2;
  }
}

/** Whether this browser uses the v2 editor (read once per mount). */
export function useEditorV2(): boolean {
  const [on] = useState(readChoice);
  return on;
}
