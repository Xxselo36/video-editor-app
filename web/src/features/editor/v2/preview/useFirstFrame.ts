"use client";
/**
 * The preview shows the first frame of the cut video before playback
 * instead of black (owner, iPhone test; UT5):
 *
 * - (b) a poster: the analysis' JPEG of the first kept clip's first frame
 *   (GET /jobs/{id}/poster, `has_poster`), shown as the <video poster>
 *   only until the element has a frame of its own — after a cut or a
 *   reorder it may show the old first clip.
 * - (a) a seek: once the metadata is there, the video goes to the start
 *   of the first enabled clip (proxy: its source time; the cut preview:
 *   just after 0, a seek iOS Safari decodes a frame for), and follows a
 *   new first clip while nobody played or seeked. Without a poster the
 *   video preloads ("auto"), so the frame arrives without a gesture.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

/** Where the still sits: the first enabled clip's start (proxy) or just after 0 (the cut preview). */
export function firstFrameTime(mode: string, segs: readonly { start: number; disabled?: boolean }[]): number {
  if (mode !== "proxy") return 0.001;
  const first = segs.find((s) => !s.disabled);
  return Math.max(0.001, first ? first.start : 0);
}

export function useFirstFrame(
  videoRef: RefObject<HTMLVideoElement | null>,
  target: number,
  poster: string | null | undefined,
): { poster: string | undefined; preload: "auto" | "metadata" } {
  const [hasFrame, setHasFrame] = useState(false);
  // the user (or the editor) moved the playhead or played: hands off
  const touched = useRef(false);
  const auto = useRef<number | null>(null);
  const targetRef = useRef(target);
  const placeRef = useRef<() => void>(() => {});

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const place = () => {
      if (touched.current || !v.paused || v.readyState < 1) return;
      const t = targetRef.current;
      if (auto.current === t && Math.abs(v.currentTime - t) < 0.0005) return;
      auto.current = t;
      try {
        v.currentTime = t;
      } catch {
        /* not seekable yet: the next loadedmetadata places it */
      }
    };
    const onFrame = () => {
      if (v.readyState >= 2) setHasFrame(true);
    };
    const onPlay = () => {
      touched.current = true;
    };
    const onSeeking = () => {
      // a seek that isn't ours: the user's (or a restore after a preview swap)
      if (auto.current === null || Math.abs(v.currentTime - auto.current) > 0.01) touched.current = true;
    };
    v.addEventListener("loadedmetadata", place);
    v.addEventListener("loadeddata", onFrame);
    v.addEventListener("seeked", onFrame);
    v.addEventListener("playing", onFrame);
    v.addEventListener("play", onPlay);
    v.addEventListener("seeking", onSeeking);
    placeRef.current = place;
    place();
    onFrame();
    return () => {
      placeRef.current = () => {};
      v.removeEventListener("loadedmetadata", place);
      v.removeEventListener("loadeddata", onFrame);
      v.removeEventListener("seeked", onFrame);
      v.removeEventListener("playing", onFrame);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("seeking", onSeeking);
    };
  }, [videoRef]);

  // a new first clip (a cut, a reorder) while nobody touched the playhead
  useEffect(() => {
    targetRef.current = target;
    placeRef.current();
  }, [target]);

  return { poster: !hasFrame && poster ? poster : undefined, preload: poster ? "metadata" : "auto" };
}
