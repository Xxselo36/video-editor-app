"use client";
/**
 * The landing's footage: one creator talking to the camera, in muted
 * looping clips (clips.ts: stock video by MART PRODUCTION on Pexels, free
 * to use; every frame that shows him carries the "Example" tag, so he is
 * never presented as a customer). Every frame on the page that shows him
 * is a <Scene>, so they all read as one creator's videos at different
 * stages of the edit.
 *
 * His movement is the clip's own: motion inside a video frame is video
 * content (brand SKILL.md, Motion). When it loads and plays is
 * useClipPlayback's: lazily, only on screen in a visible tab, never under
 * reduced motion or data saver (the poster, his first frame, stays).
 * Until the video has a frame the poster shows, and under the poster the
 * clip's inline 12 px preview, so a frame is never empty.
 *
 * A loop longer than five seconds needs a way to stop it (WCAG 2.2.2):
 * the section that shows it renders a LoopToggle and passes `playing`.
 */
import { useCallback, useRef } from "react";
import { Pause, Play } from "lucide-react";
import { useT } from "@/i18n";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CLIPS, CLIP_DIR, type ClipId } from "./clips";
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
 */
export function Scene({
  clip,
  crop = "vertical",
  playing = true,
  priority = false,
  className,
  videoRef,
}: {
  clip: ClipId;
  crop?: "vertical" | "wide";
  playing?: boolean;
  priority?: boolean;
  className?: string;
  videoRef?: React.Ref<HTMLVideoElement>;
}) {
  const { file, w, h } = CLIPS[clip];
  const rootRef = useRef<HTMLDivElement>(null);
  const ownVideoRef = useRef<HTMLVideoElement>(null);
  const playback = useClipPlayback({ src: `${CLIP_DIR}/${file}.mp4`, playing, priority, rootRef, videoRef: ownVideoRef });

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

  return (
    <div
      ref={rootRef}
      className={cx(styles.scene, LQIP[clip], className)}
      data-crop={crop}
      data-live={playback.live || undefined}
      aria-hidden="true"
    >
      <div className={styles.camera}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the clip's pre-sized first frame, no optimizer needed */}
        <img
          className={styles.poster}
          src={`${CLIP_DIR}/${file}.webp`}
          width={w}
          height={h}
          alt=""
          draggable={false}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          decoding="async"
        />
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

/**
 * The pause control for the clips a section loops (WCAG 2.2.2), as the
 * hero's: a 44 px round button, "Pause the demo" / "Play the demo".
 * Render it only while clips can move (useClipsMove).
 * - `place="row"`: in its own row under a figure, at the right edge.
 * - `place="beside"`: right of a frame, level with its bottom edge; the
 *   positioned parent is the frame's box.
 * `shown={false}` hides it while the frame it controls is not up yet; it
 * stays in the tab order and shows on keyboard focus, so it is never
 * skipped.
 */
export function LoopToggle({
  paused,
  onToggle,
  place,
  shown = true,
}: {
  paused: boolean;
  onToggle: () => void;
  place: "row" | "beside";
  shown?: boolean;
}) {
  const t = useT();
  const button = (
    <IconButton
      label={paused ? t("site.demo.play") : t("site.demo.pause")}
      className={cx(styles.toggle, place === "beside" && styles.beside)}
      data-shown={shown}
      onClick={onToggle}
    >
      <Icon icon={paused ? Play : Pause} size={16} />
    </IconButton>
  );
  return place === "row" ? <div className={styles.toggleRow}>{button}</div> : button;
}
