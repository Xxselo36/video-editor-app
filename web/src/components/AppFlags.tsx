"use client";
/**
 * Applies the per-browser switches from the URL on every /app page, so
 * opening `/app?editor=v1` once keeps this browser on the v1 editor
 * (`?editor=v2` with NEXT_PUBLIC_EDITOR_V2=optin opts it in) and
 * `?captions=v2` opts it in to the v2 export captions of a
 * CLEO_CAPTION_ENGINE=optin backend (both kept in localStorage, read
 * again where they're used). Renders nothing.
 */
import { useEffect } from "react";
import { readCaptionsV2 } from "@/features/captions-ui/flag";
import { readChoice } from "@/features/editor/v2/flag";

export function AppFlags() {
  useEffect(() => {
    readChoice();
    readCaptionsV2();
  }, []);
  return null;
}
