"use client";
/**
 * Fullscreen of the preview (review C12): the Element Fullscreen API where
 * it exists (desktop, Android, iPad). iPhone Safari has none, and its
 * native video fullscreen drops the canvas captions, so there the stage
 * gets a CSS pseudo-fullscreen instead (fixed, 100dvh, safe-area insets,
 * captions kept). Escape leaves the pseudo mode too.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };

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

  useEffect(() => {
    if (!pseudo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPseudo(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pseudo]);

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
      setPseudo(false);
      return;
    }
    const d = document as FsDocument;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) void d.exitFullscreen().catch(() => {});
      else d.webkitExitFullscreen?.();
      return;
    }
    if (!fullscreenApi(el)) {
      setPseudo(true);
      return;
    }
    try {
      const r = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch(() => setPseudo(true));
      }
    } catch {
      setPseudo(true);
    }
  }, [ref, pseudo]);

  return { active, real, pseudo, toggle };
}
