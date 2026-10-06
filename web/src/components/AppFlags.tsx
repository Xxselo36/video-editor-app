"use client";
/**
 * Applies the per-browser opt-ins from the URL on every /app page, so
 * opening `/app?editor=v2&captions=v2` once switches this browser to the
 * v2 editor and the v2 export captions (both kept in localStorage, read
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
