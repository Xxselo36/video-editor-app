"use client";
/**
 * The Vorschau's player (PR2, mockup docs/mockups/start/4-vorschau) and
 * the finished video in it (done: GET /watch, captions burned in).
 *
 * Player: the frame (9:16, or 16:9 for a landscape output), the video
 * (no native controls; the first tap plays it with sound), a round
 * play / pause button that steps back while it plays (a mouse over the
 * frame or keyboard focus brings it back; Space / Enter on it), a 3 px
 * line of how far it has played, and while it waits for data an arc
 * round the button with aria-busy on the frame — 10 s without any of
 * the file (a preview the server still builds) also says so in words.
 * PreviewVideo draws its captions into the same player.
 */
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import type { JobStatus } from "@/features/jobs/types";
import { progressOf, usePlayback, type Playback } from "./player";
import s from "./player.module.css";

/** No file after this long: "the preview is still being prepared". */
const PREPARING_MS = 10_000;

export type PlayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The element's state (usePlayback on the same ref). */
  playback: Playback;
  /** null until media URLs can be built (lib/api useMediaUrl). */
  src: string | null;
  poster?: string;
  /** A 16:9 output: a landscape frame (else 9:16). */
  wide: boolean;
  /** Which video it is (data-video, for the tests). */
  kind: "preview" | "export";
  /** Over the picture, under the button: the preview's captions. Never takes a tap or focus. */
  overlay?: ReactNode;
  /** A line under the frame. */
  note?: ReactNode;
};

export function Player({ videoRef, playback, src, poster, wide, kind, overlay, note }: PlayerProps) {
  const t = useT();
  const fillRef = useRef<HTMLSpanElement>(null);
  const { playing, busy, empty } = playback;

  // Nothing of the file for PREPARING_MS (the request waits for a
  // preview being built): the note shows until the file starts coming.
  const [late, setLate] = useState(false);
  if (late && !empty) setLate(false);
  useEffect(() => {
    if (!empty) return;
    const timer = window.setTimeout(() => setLate(true), PREPARING_MS);
    return () => window.clearTimeout(timer);
  }, [empty]);

  // The scrub line follows the playhead every frame, linear (no transition).
  useEffect(() => {
    const v = videoRef.current;
    const fill = fillRef.current;
    if (!playing || !v || !fill) return;
    let raf = 0;
    const step = () => {
      fill.style.transform = `scaleX(${progressOf(v.currentTime, v.duration)})`;
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [playing, videoRef]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    // A load that failed (offline, a preview not stored yet): try again.
    if (v.error) v.load();
    v.play().catch(() => {
      /* interrupted by a pause or a new source */
    });
  };

  return (
    <div className={s.player} data-shape={wide ? "wide" : "tall"}>
      <div
        className={s.frame}
        data-video={kind}
        data-playing={playing || undefined}
        aria-busy={busy || undefined}
        data-testid="preview-frame"
      >
        <video
          ref={videoRef}
          src={src ?? undefined}
          poster={poster}
          preload="metadata"
          playsInline
          className={s.video}
          onClick={toggle}
          data-testid="preview-video"
        />
        {overlay && (
          <div className={s.captions} inert>
            {overlay}
          </div>
        )}
        <button
          type="button"
          className={s.play}
          aria-label={playing ? t("app.preview.pause") : t("app.done.play")}
          onClick={toggle}
          data-testid="preview-play"
        >
          {playing ? <Icon icon={Pause} size={26} /> : <Icon icon={Play} size={26} className={s.nudge} />}
        </button>
        <span className={s.scrub} aria-hidden>
          <span ref={fillRef} className={s.fill} />
        </span>
        <div className={s.status} role="status">
          {empty && late && (
            <span className={s.chip} data-testid="preview-preparing">
              {t("app.preview.preparing")}
            </span>
          )}
        </div>
      </div>
      {note}
    </div>
  );
}

/** The exported video (done): GET /watch of this export, its thumbnail as the poster. */
export default function ExportedVideo({ job }: { job: JobStatus }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = usePlayback(videoRef);
  const v = job.renders_ok ?? 0;
  const src = useMediaUrl(job.id, "watch", { v });
  const poster = useMediaUrl(job.id, "thumbnail", { v });
  return (
    <Player
      videoRef={videoRef}
      playback={playback}
      src={src}
      poster={poster ?? undefined}
      wide={job.output_aspect === "16:9"}
      kind="export"
    />
  );
}
