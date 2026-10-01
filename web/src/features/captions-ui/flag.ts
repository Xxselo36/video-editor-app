"use client";
/**
 * The owner's opt-in to the v2 export captions (UT4,
 * CLEO_CAPTION_ENGINE unset or optin on the backend): `?captions=v2` on any /app
 * page switches this browser on, `?captions=v1` off; the choice is kept
 * in localStorage like the editor flag (editor/v2/flag.ts). While on,
 * the export asks for the v2 captions ({caption_engine: "v2"} in POST
 * /jobs/{id}/render) and the editor shows a small marker. The backend
 * ignores the request when set to v1/off (and v2 doesn't need it), so this needs no
 * build flag.
 */
import { useState } from "react";

const KEY = "cleocuts.captions.engine.v1";

/** This browser's choice, after applying `?captions=` (exported for tests). */
export function readCaptionsV2(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("captions");
    if (q === "v1" || q === "v2") localStorage.setItem(KEY, q);
    return (q ?? localStorage.getItem(KEY)) === "v2";
  } catch {
    return false;
  }
}

/** Whether this browser asks for the v2 export captions (read once per mount). */
export function useCaptionsV2(): boolean {
  const [on] = useState(readCaptionsV2);
  return on;
}
