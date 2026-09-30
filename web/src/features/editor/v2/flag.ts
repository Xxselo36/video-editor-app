"use client";
/**
 * NEXT_PUBLIC_EDITOR_V2 (UX7): the review phase renders the v2 shell
 * instead of the v1 ReviewScreen. Off (default): nothing changes.
 *
 * With the flag on, `?editor=v1` switches this browser back to the v1
 * editor and `?editor=v2` to the v2 one; the choice is kept in
 * localStorage (PLAN_TECH §0.11). Without the flag the override does
 * nothing.
 */
import { useState } from "react";

export const EDITOR_V2 = process.env.NEXT_PUBLIC_EDITOR_V2 === "1";
const KEY = "cleocuts.editor.version.v1";

function readChoice(): boolean {
  if (!EDITOR_V2 || typeof window === "undefined") return EDITOR_V2;
  try {
    const q = new URLSearchParams(window.location.search).get("editor");
    if (q === "v1" || q === "v2") localStorage.setItem(KEY, q);
    return (q ?? localStorage.getItem(KEY)) !== "v1";
  } catch {
    return true;
  }
}

/** Whether this browser uses the v2 editor (read once per mount). */
export function useEditorV2(): boolean {
  const [on] = useState(readChoice);
  return on;
}
