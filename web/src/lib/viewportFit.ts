"use client";
/**
 * viewport-fit=cover while a screen that pads itself for the safe areas
 * is mounted: the editor (UX7c) and the app shell (its top bar, tab bar,
 * main and toasts). Only then do the env(safe-area-inset-*) values reach
 * the CSS, and the notch sides in landscape are ours instead of
 * letterboxed. The rest of the site keeps its viewport.
 *
 * Counted, and shared by every user: the loading editor and the loaded
 * one, or the shell and the editor during a navigation between them, are
 * separate mounts whose effects interleave; only the last one out takes
 * the token off again. It is set here and not by a `viewport` export:
 * that one would be stripped by the next user's removal on the way back.
 */
import { useEffect } from "react";

let users = 0;
const FIT_COVER = /,?\s*viewport-fit\s*=\s*cover/;

function setFitCover(on: boolean) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const c = meta.content;
  if (on && !/viewport-fit\s*=/.test(c)) meta.content = `${c}${c.trim() ? ", " : ""}viewport-fit=cover`;
  // our token only, from the meta as it is now (Next may have re-rendered it)
  else if (!on && FIT_COVER.test(c)) meta.content = c.replace(FIT_COVER, "").trim();
}

export function useViewportFitCover(): void {
  useEffect(() => {
    if (users++ === 0) setFitCover(true);
    return () => {
      if (--users === 0) setFitCover(false);
    };
  }, []);
}
