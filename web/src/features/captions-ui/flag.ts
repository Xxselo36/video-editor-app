"use client";
/**
 * The per-browser opt-in to the v2 export captions for a backend with
 * CLEO_CAPTION_ENGINE=optin (UT4): `?captions=v2` on any /app page
 * switches this browser on, `?captions=v1` off again; the choice is kept
 * in localStorage like the editor flag (editor/v2/flag.ts). While on,
 * the export asks for the v2 captions ({caption_engine: "v2"} in POST
 * /jobs/{id}/render), the editor previews them live (the doc's engine
 * "optin", EditorShell) and shows a small marker.
 * The backend's default (CLEO_CAPTION_ENGINE unset = v2) needs none of
 * this: every eligible job exports v2, and GET /jobs/{id}/doc says "v2",
 * so the editor previews v2 captions without the opt-in; v1/off ignore
 * the request. Off unless opted in, so no build flag and no marker for
 * everyone.
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
