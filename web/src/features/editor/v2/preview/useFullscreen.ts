"use client";
/**
 * Fullscreen of the preview (review C12): the Element Fullscreen API where
 * it exists (desktop, Android, iPad). iPhone Safari has none, and its
 * native video fullscreen drops the canvas captions, so there the stage
 * gets a CSS pseudo-fullscreen instead (fixed, 100dvh, safe-area insets,
 * captions kept). Escape leaves the pseudo mode too, and so does the
 * browser's Back (a history entry while it is on).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };

/** history.state key of the entry the pseudo-fullscreen pushes. */
export const PSEUDO_FS_STATE = "cleoPseudoFs";

/** Is the current history entry the one the pseudo-fullscreen pushed? */
function isOurEntry(): boolean {
  return Boolean((window.history.state as Record<string, unknown> | null)?.[PSEUDO_FS_STATE]);
}

export function fullscreenApi(el: HTMLElement | null): boolean {
  const e = el as FsElement | null;
  return !!e && (typeof e.requestFullscreen === "function" || typeof e.webkitRequestFullscreen === "function");
}

export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [real, setReal] = useState(false);
  const [pseudo, setPseudo] = useState(false);

  useEffect(() => {
    const onChange = () => {
      const d = document as FsDocument;
      const fs = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
      setReal(!!fs && fs === ref.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, [ref]);

  // The browser's Back (iPhone: the edge swipe) closes the pseudo mode
  // instead of leaving the editor (7c audit): entering pushes a history
  // entry of the same URL (Next's patched pushState keeps its own state
  // in it), Back pops it; leaving with the button or Escape takes it off
  // again. Pushed and popped in the handlers, not in an effect (a
  // re-run effect would push twice).
  const enterPseudo = useCallback(() => {
    setPseudo(true);
    try {
      if (!isOurEntry()) window.history.pushState({ [PSEUDO_FS_STATE]: true }, "");
    } catch {
      /* no history: Escape and the exit button still close it */
    }
  }, []);
  const exitPseudo = useCallback(() => {
    setPseudo(false);
    try {
      if (isOurEntry()) window.history.back();
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (!pseudo) return;
    const onPop = () => {
      if (!isOurEntry()) setPseudo(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [pseudo]);

  useEffect(() => {
    if (!pseudo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        exitPseudo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pseudo, exitPseudo]);

  // Focus follows the fullscreen element: into it on enter (a focused
  // Maximize button outside it would take Space and the shortcuts),
  // back to where it was on exit.
  const returnTo = useRef<HTMLElement | null>(null);
  const active = real || pseudo;
  useEffect(() => {
    const el = ref.current;
    if (active) {
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    } else if (returnTo.current) {
      const back = returnTo.current;
      returnTo.current = null;
      if (back.isConnected) back.focus({ preventScroll: true });
    }
  }, [active, ref]);

  const toggle = useCallback(() => {
    const el = ref.current as FsElement | null;
    if (!el) return;
    if (!pseudo && !(document as FsDocument).fullscreenElement && !(document as FsDocument).webkitFullscreenElement) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (pseudo) {
      exitPseudo();
      return;
    }
    const d = document as FsDocument;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) void d.exitFullscreen().catch(() => {});
      else d.webkitExitFullscreen?.();
      return;
    }
    if (!fullscreenApi(el)) {
      enterPseudo();
      return;
    }
    try {
      const r = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => enterPseudo());
      }
    } catch {
      enterPseudo();
    }
  }, [ref, pseudo, enterPseudo, exitPseudo]);

  return { active, real, pseudo, toggle };
}
