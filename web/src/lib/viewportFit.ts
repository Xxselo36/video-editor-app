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
 *
 * Watched while in use: Next renders a page's head anew on every
 * navigation between pages (the shell stays mounted from tab to tab), a
 * new viewport meta without the token; it goes back on before the frame
 * is painted.
 */
import { useEffect } from "react";

let users = 0;
let watcher: MutationObserver | null = null;
const FIT_COVER = /,?\s*viewport-fit\s*=\s*cover/;

function setFitCover(on: boolean) {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="viewport"]')) {
    const c = meta.content;
    if (on && !/viewport-fit\s*=/.test(c)) meta.content = `${c}${c.trim() ? ", " : ""}viewport-fit=cover`;
    // our token only, from the meta as it is now (Next may have re-rendered it)
    else if (!on && FIT_COVER.test(c)) meta.content = c.replace(FIT_COVER, "").trim();
  }
}

export function useViewportFitCover(): void {
  useEffect(() => {
    if (users++ === 0) {
      setFitCover(true);
      // (Its own write comes back here once and changes nothing.)
      watcher = new MutationObserver(() => setFitCover(true));
      watcher.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["content", "name"] });
    }
    return () => {
      if (--users === 0) {
        watcher?.disconnect();
        watcher = null;
        setFitCover(false);
      }
    };
  }, []);
}
