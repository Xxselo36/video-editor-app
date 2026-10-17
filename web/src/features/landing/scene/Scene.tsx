"use client";
/**
 * The landing's footage: one creator talking to the camera, in muted
 * looping clips (clips.ts: stock video by MART PRODUCTION on Pexels, free
 * to use). Every frame on the page that shows him is a <Scene>, so they
 * all read as one creator's videos at different stages of the edit.
 *
 * His movement is the clip's own: motion inside a video frame is video
 * content (brand SKILL.md, Motion). When it loads and plays is
 * useClipPlayback's: lazily, only on screen in a visible tab, never under
 * reduced motion or data saver (the poster, one of his frames, stays).
 * Until the video has a frame the poster shows, and under the poster the
 * clip's inline 12 px preview, so a frame is never empty. A section
 * holds its clip on its frame (`playing`) while the frame is not up.
 */
import { useCallback, useRef } from "react";
import { cx } from "@/components/ui/cx";
import { CLIPS, CLIP_DIR, type ClipId, type ClipStart } from "./clips";
import { useClipPlayback } from "./useClipPlayback";
import styles from "./Scene.module.css";

/** A 9:16 crop's width as a fraction of a 16:9 frame's width. */
export const CROP_W = (9 / 16) * (9 / 16);

const LQIP: Record<ClipId, string> = {
  hero: styles.lqipHero,
  heroRaw: styles.lqipHeroRaw,
  ringCafe: styles.lqipRingCafe,
  ringOffice: styles.lqipRingOffice,
  ringRoom: styles.lqipRingRoom,
  tileCafe: styles.lqipTileCafe,
  tileOffice: styles.lqipTileOffice,
  tileRoom: styles.lqipTileRoom,
  smartcam: styles.lqipSmartcam,
};

/** The class that sets a clip's 12 px preview as --lqip (a url() for a
 *  background-image) on an element and its subtree. */
export function lqipClass(clip: ClipId): string {
  return LQIP[clip];
}

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * One frame of the footage. The Scene fills its (positioned) parent.
 * - `crop="vertical"` (default): a 9:16 frame filled by a 9:16 clip.
 * - `crop="wide"`: a 16:9 frame filled by the 16:9 clip ("smartcam").
 * `playing` (default true) lets the clip play; false pauses it on its
 * frame. `priority` loads it eagerly (the hero). `videoRef` hands out the
 * <video> (currentTime, requestVideoFrameCallback, drawing to a canvas).
 * `start` opens it later than its first frame (the hero's first load,
 * clips.ts HERO_HALF): it loads there (a media fragment, so the first
 * frame it shows is that one; a loop still goes round from 0) over a
 * poster of that frame. Under reduced motion nothing starts, so the
 * first frame's poster stays.
 */
export function Scene({
  clip,
  crop = "vertical",
  playing = true,
  priority = false,
  className,
  videoRef,
  start,
}: {
  clip: ClipId;
  crop?: "vertical" | "wide";
  playing?: boolean;
  priority?: boolean;
  className?: string;
  videoRef?: React.Ref<HTMLVideoElement>;
  start?: ClipStart;
}) {
  const { file, w, h } = CLIPS[clip];
  const rootRef = useRef<HTMLDivElement>(null);
  const ownVideoRef = useRef<HTMLVideoElement>(null);
  const src = `${CLIP_DIR}/${file}.mp4${start ? `#t=${start.at}` : ""}`;
  const playback = useClipPlayback({ src, playing, priority, rootRef, videoRef: ownVideoRef });

  // Muted and inline as attributes too, before any src: iOS plays a
  // video without a tap only then, and React sets `muted` as a property
  // only.
  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      ownVideoRef.current = el;
      if (el) {
        el.defaultMuted = true;
        el.muted = true;
        el.setAttribute("muted", "");
        el.playsInline = true;
        el.setAttribute("playsinline", "");
        el.setAttribute("webkit-playsinline", "");
        el.loop = true;
      }
      setRef(videoRef, el);
    },
    [videoRef],
  );

  const poster = (
    // eslint-disable-next-line @next/next/no-img-element -- the clip's pre-sized frame, no optimizer needed
    <img
      className={styles.poster}
      src={`${CLIP_DIR}/${start ? start.poster : file}.webp`}
      width={w}
      height={h}
      alt=""
      draggable={false}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
    />
  );

  return (
    <div
      ref={rootRef}
      className={cx(styles.scene, LQIP[clip], className)}
      data-crop={crop}
      data-live={playback.live || undefined}
      aria-hidden="true"
    >
      <div className={styles.camera}>
        {start ? (
          <picture>
            {/* reduced motion: nothing starts, the first frame stays */}
            <source media="(prefers-reduced-motion: reduce)" srcSet={`${CLIP_DIR}/${file}.webp`} />
            {poster}
          </picture>
        ) : (
          poster
        )}
        <video
          // A new clip is a new element: it starts on its poster again.
          key={file}
          ref={attachVideo}
          className={styles.video}
          src={playback.src}
          preload={playback.preload}
          muted
          playsInline
          loop
          disablePictureInPicture
          disableRemotePlayback
          onLoadedData={playback.onLoadedData}
          onPlaying={playback.onPlaying}
        />
      </div>
    </div>
  );
}
