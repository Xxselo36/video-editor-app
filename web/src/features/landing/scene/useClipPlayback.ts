"use client";
/**
 * When a landing clip (Scene.tsx) loads and when it plays. A clip is
 * motion inside a video frame (video content, brand SKILL.md, Motion),
 * but it is still a loop on the page, so it follows the page's rules:
 *
 * - It loads (src, preload="auto") only after hydration, once the frame
 *   is within a screen of the viewport, or right away for the hero
 *   (`priority`). The server HTML has no src, so nothing downloads that
 *   the visitor's settings would refuse.
 * - It plays only while the consumer lets it (`playing`), the frame is
 *   on screen and the tab is visible; otherwise it pauses on its frame.
 * - Under reduced motion, data saver or a 2G-class connection it never
 *   loads: the poster stays (the clip's first frame, a meaningful still).
 *   Switched on while a clip plays, the clip stops, drops what it loaded
 *   and the poster comes back.
 * - The video is shown only once it has a frame (loadeddata, playing);
 *   until then, and if the browser refuses to play it (iOS Low Power
 *   Mode rejects play() and would draw its own play button), the poster
 *   shows instead.
 *
 * Everything here changes on events (scroll into view, tab switch, the
 * first frame), never per frame.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useDocumentVisible, useReducedMotion } from "../shared";

/** How far ahead of the viewport a clip starts loading: a screen. */
const NEAR_MARGIN = "100% 0px";

/** Nothing to subscribe to: the value only differs between the server
 *  (and hydration) and the client. */
const noSubscription = () => () => {};

/** The Network Information API (Chromium only; elsewhere: unknown). */
type Connection = EventTarget & { saveData?: boolean; effectiveType?: string };

function connection(): Connection | undefined {
  return (navigator as Navigator & { connection?: Connection }).connection;
}

function subscribeConnection(cb: () => void): () => void {
  const c = connection();
  c?.addEventListener("change", cb);
  return () => c?.removeEventListener("change", cb);
}

/** Data saver on, or a "slow-2g" / "2g" connection. */
function lightData(): boolean {
  const c = connection();
  return !!c && (c.saveData === true || /2g$/.test(c.effectiveType ?? ""));
}

/** The visitor asked for less data (false on the server). */
export function useSaveData(): boolean {
  return useSyncExternalStore(subscribeConnection, lightData, () => false);
}

/** Can the landing's clips move here at all (no reduced motion, no data
 *  saver)? For the loops' pause controls: without motion there is
 *  nothing to pause. True on the server, so the control's room is in
 *  the first HTML. */
export function useClipsMove(): boolean {
  const reduced = useReducedMotion();
  const saveData = useSaveData();
  return !reduced && !saveData;
}

/** What Scene renders on its <video> and whether the video (rather than
 *  the poster) is on show. */
export type ClipPlayback = {
  src: string | undefined;
  preload: "auto" | "none";
  /** The video has a frame to show and was not refused. */
  live: boolean;
  onLoadedData: () => void;
  onPlaying: () => void;
};

export function useClipPlayback({
  src,
  playing,
  priority,
  rootRef,
  videoRef,
}: {
  src: string;
  playing: boolean;
  priority: boolean;
  /** The frame (what has to be on screen). */
  rootRef: React.RefObject<HTMLElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
}): ClipPlayback {
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false);
  const moves = useClipsMove();
  const tabVisible = useDocumentVisible();
  const [near, setNear] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  // The clip whose video has a frame (ok) or was refused (not ok). Keyed
  // by src: a new clip starts on its poster again.
  const [frame, setFrame] = useState<{ src: string; ok: boolean } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // Near: once, then the clip stays loaded.
    const ahead = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        ahead.disconnect();
      },
      { rootMargin: NEAR_MARGIN },
    );
    // On screen: the latest entry (several can queue up between two
    // callbacks).
    const seen = new IntersectionObserver((entries) => setOnScreen(entries[entries.length - 1].isIntersecting));
    ahead.observe(el);
    seen.observe(el);
    return () => {
      ahead.disconnect();
      seen.disconnect();
    };
  }, [rootRef]);

  // Without IntersectionObserver every frame counts as near and on screen.
  const noObserver = hydrated && typeof IntersectionObserver === "undefined";
  const load = hydrated && moves && (priority || near || noObserver);
  const run = load && playing && tabVisible && (onScreen || noObserver);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!run) {
      v.pause();
      // Reduced motion or data saver switched on after it loaded: taking
      // the src away does not stop a video, so it is paused (above) and
      // its resource dropped (no more download, the decoder freed); the
      // poster shows again.
      if (!load && v.networkState !== HTMLMediaElement.NETWORK_EMPTY) v.load();
      return;
    }
    // A pause() before play() settles rejects it (AbortError): harmless.
    // NotAllowedError: the browser refuses autoplay; the poster stays.
    v.play()?.catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "NotAllowedError") setFrame({ src, ok: false });
    });
  }, [load, run, src, videoRef]);

  // React attaches media events to the element itself, so none of them
  // can fire before the listener exists.
  const onLoadedData = useCallback(() => setFrame((f) => (f?.src === src && !f.ok ? f : { src, ok: true })), [src]);
  const onPlaying = useCallback(() => setFrame({ src, ok: true }), [src]);

  return {
    src: load ? src : undefined,
    preload: load ? "auto" : "none",
    live: load && frame?.src === src && frame.ok,
    onLoadedData,
    onPlaying,
  };
}
