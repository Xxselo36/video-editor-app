/**
 * "Preparing video…" between a file chooser closing and its file
 * arriving (iOS prepares a video first: an iCloud download, an export,
 * a conversion). `arm()` as the chooser opens; it shows once the page
 * has focus again (the chooser closed) and goes with `done()` (a file, a
 * cancel). `timeoutMs`: off by itself after that long; null keeps it
 * until `done()` (iOS: ./pickWatch's fallback speaks up instead). `slow`:
 * on for PREPARING_SLOW_MS already (iOS is still at it).
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How long "Preparing video…" shows before it says iOS is still at it. */
export const PREPARING_SLOW_MS = 4000;

export function usePreparing(timeoutMs: number | null): {
  preparing: boolean;
  slow: boolean;
  arm: () => void;
  done: () => void;
} {
  const [preparing, setPreparing] = useState(false);
  const [slow, setSlow] = useState(false);
  // The chooser is open (or closed without an answer yet).
  const choosing = useRef(false);
  const mounted = useRef(true);
  const onFocus = useRef<(() => void) | null>(null);
  const unlisten = useCallback(() => {
    if (onFocus.current) window.removeEventListener("focus", onFocus.current);
    onFocus.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      unlisten();
    };
  }, [unlisten]);

  const arm = useCallback(() => {
    choosing.current = true;
    unlisten();
    // Once the chooser closes the page gets focus back; the file may
    // take a while to arrive.
    const f = () => {
      unlisten();
      setTimeout(() => {
        if (mounted.current && choosing.current) {
          setSlow(false);
          setPreparing(true);
        }
      }, 300);
    };
    onFocus.current = f;
    window.addEventListener("focus", f);
  }, [unlisten]);

  const done = useCallback(() => {
    choosing.current = false;
    unlisten();
    setPreparing(false);
  }, [unlisten]);

  useEffect(() => {
    if (!preparing) return;
    const slowTimer = setTimeout(() => setSlow(true), PREPARING_SLOW_MS);
    const offTimer = timeoutMs === null ? null : setTimeout(() => setPreparing(false), timeoutMs);
    return () => {
      clearTimeout(slowTimer);
      if (offTimer !== null) clearTimeout(offTimer);
    };
  }, [preparing, timeoutMs]);

  return { preparing, slow: preparing && slow, arm, done };
}
