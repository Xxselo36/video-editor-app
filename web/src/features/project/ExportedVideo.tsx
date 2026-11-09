"use client";
/**
 * The Vorschau's player (PR2, mockup docs/mockups/start/4-vorschau) and
 * the finished video in it (done: GET /watch, captions burned in; before
 * a tap a still that really decodes, ExportedVideo).
 *
 * Player: the frame (9:16, or 16:9 for a landscape output), the video
 * (no native controls; the first tap plays it with sound), a round
 * play / pause button that steps back while it plays (a mouse over the
 * frame or keyboard focus brings it back; Space / Enter on it), a 3 px
 * line of how far it has played, and while it waits for data an arc
 * round the button with aria-busy on the frame — 10 s without any of
 * the file (a preview the server still builds) also says so in words.
 * PreviewVideo draws its captions into the same player.
 *
 * Full screen (the owner, 2026-11): a small round button in the frame's
 * top corner, there while it plays too (a mouse: on hover, as the play
 * button). The frame goes full screen with what is drawn over it
 * (player.ts fullscreenWay; lib/useFullscreen): the Fullscreen API on
 * desktop, Android and iPad; on an iPhone the export opens in the
 * phone's own player, the preview's frame lies over the page (its
 * captions are drawn, that player would drop them). The same button,
 * Escape and (over the page) Back leave it. Full screen and playing, a
 * still mouse hides the controls and the pointer after IDLE_MS.
 *
 * `held`: no file to play yet (a preview that doesn't show the stored
 * edit, PreviewVideo). "building": busy as above, play does nothing;
 * "failed": a note that it couldn't be made, at once. A file loaded
 * before goes off the frame.
 */
import { Maximize, Minimize, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import { fullscreenApi, useFullscreen } from "@/lib/useFullscreen";
import type { JobStatus } from "@/features/jobs/types";
import {
  decodeStill,
  fullscreenWay,
  isWide,
  pickStill,
  progressOf,
  stillCandidates,
  usePlayback,
  type Playback,
  type Still,
} from "./player";
import s from "./player.module.css";

/** No file after this long: "the preview is still being prepared". */
const PREPARING_MS = 10_000;

/** Full screen and playing: the controls and a mouse's pointer go after
 *  this long without the pointer moving or a key (a mouse in a frame that
 *  fills the screen is always over it). */
const IDLE_MS = 2_500;

/** iOS: a video's own full-screen player (supported once its metadata is in). */
type OwnFullscreen = HTMLVideoElement & { webkitSupportsFullscreen?: boolean; webkitEnterFullscreen?: () => void };

/** `on` and nothing moved for IDLE_MS (any pointer, any key). */
function useIdle(on: boolean): boolean {
  const [idle, setIdle] = useState(false);
  if (!on && idle) setIdle(false);
  useEffect(() => {
    if (!on) return;
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const events = ["pointermove", "pointerdown", "keydown"] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [on]);
  return on && idle;
}

export type PlayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The element's state (usePlayback on the same ref). */
  playback: Playback;
  /** null until media URLs can be built (lib/api useMediaUrl). */
  src: string | null;
  poster?: string;
  /** A landscape output (player.ts isWide): a 16:9 frame, else 9:16. */
  wide: boolean;
  /** Which video it is (data-video, for the tests). */
  kind: "preview" | "export";
  /** Over the picture, under the button: the preview's captions. Never takes a tap or focus. */
  overlay?: ReactNode;
  /** A line under the frame. */
  note?: ReactNode;
  /** No file to play yet: "building" (busy), "failed" (it couldn't be made). */
  held?: "building" | "failed";
  /** What the frame shows before a tap (data-still, for the tests): ExportedVideo. */
  still?: Still;
};

export function Player({ videoRef, playback, src, poster, wide, kind, overlay, note, held, still }: PlayerProps) {
  const t = useT();
  const fillRef = useRef<HTMLSpanElement>(null);
  const { playing, busy, empty } = playback;
  const building = held === "building";

  // Nothing of the file for PREPARING_MS (a preview being built, or the
  // request for it waits): the note shows until the file starts coming.
  const waiting = empty || building;
  const [late, setLate] = useState(false);
  if (late && !waiting) setLate(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setLate(true), PREPARING_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  // No file (held): the one loaded before goes, its last frame with it
  // (taking src away alone keeps it).
  useEffect(() => {
    const v = videoRef.current;
    if (!src && v?.currentSrc) v.load();
  }, [src, videoRef]);

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
    if (!v || held) return;
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

  // Full screen: the frame, or on an iPhone the export's own player.
  const frameRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const fsRef = useRef<HTMLButtonElement>(null);
  const fs = useFullscreen(frameRef);
  const idle = useIdle(fs.active && playing);
  // Nothing to show yet: no button (but one to leave it, whatever came).
  const fullscreenable = fs.active || (!!src && !held);
  // The preview's captions are drawn over it (or will be, once its doc is
  // in): the phone's own player would show it without them.
  const drawsOver = kind === "preview" || !!overlay;
  const fullscreen = () => {
    const v = videoRef.current as OwnFullscreen | null;
    const own = !!v?.webkitSupportsFullscreen && typeof v.webkitEnterFullscreen === "function";
    if (!fs.active && v && fullscreenWay(fullscreenApi(frameRef.current), own, drawsOver) === "video") {
      try {
        v.webkitEnterFullscreen!();
        return;
      } catch {
        /* the player can't take it after all: the frame over the page */
      }
    }
    fs.toggle();
  };
  // Full screen: the focus on the frame (a modal dialog then), so no
  // control's ring sits on the picture; Space plays and pauses (on a
  // button, the button), Tab goes round the two buttons that show.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => {
    if (!fs.active) return;
    frameRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        toggleRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [playRef.current, fsRef.current].filter(
        (b): b is HTMLButtonElement => !!b && b.getClientRects().length > 0,
      );
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const n = items.length;
      e.preventDefault();
      items[e.shiftKey ? (i <= 0 ? n - 1 : i - 1) : (i + 1) % n].focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fs.active]);

  return (
    <div className={s.player} data-shape={wide ? "wide" : "tall"}>
      {/* Full screen takes the frame out of the page: its place stays
          (the page under it doesn't move, nor does its scroll). */}
      {fs.active && <div className={`${s.frame} ${s.standIn}`} aria-hidden />}
      <div
        ref={frameRef}
        className={s.frame}
        tabIndex={fs.active ? -1 : undefined}
        role={fs.active ? "dialog" : undefined}
        aria-modal={fs.active || undefined}
        aria-label={fs.active ? t("app.preview.fullscreen") : undefined}
        data-video={kind}
        data-playing={playing || undefined}
        aria-busy={busy || building || undefined}
        data-held={held}
        data-still={still}
        data-fullscreen={fs.real ? "real" : fs.pseudo ? "pseudo" : undefined}
        data-idle={idle || undefined}
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
          ref={playRef}
          type="button"
          className={s.play}
          aria-label={playing ? t("app.preview.pause") : t("app.done.play")}
          aria-disabled={held ? true : undefined}
          onClick={toggle}
          data-testid="preview-play"
        >
          {playing ? <Icon icon={Pause} size={26} /> : <Icon icon={Play} size={26} className={s.nudge} />}
        </button>
        {fullscreenable && (
          <button
            ref={fsRef}
            type="button"
            className={s.fs}
            aria-label={fs.active ? t("app.preview.exitFullscreen") : t("app.preview.fullscreen")}
            title={fs.active ? t("app.preview.exitFullscreen") : t("app.preview.fullscreen")}
            onClick={fullscreen}
            data-testid="preview-fullscreen"
          >
            <span className={s.disc}>
              <Icon icon={fs.active ? Minimize : Maximize} size={16} />
            </span>
          </button>
        )}
        <span className={s.scrub} aria-hidden>
          <span ref={fillRef} className={s.fill} />
        </span>
        <div className={s.status} role="status">
          {waiting && late && (
            <span className={s.chip} data-testid="preview-preparing">
              {t("app.preview.preparing")}
            </span>
          )}
          {held === "failed" && (
            <span className={s.chip} data-testid="preview-unavailable">
              {t("app.preview.unavailable")}
            </span>
          )}
        </div>
      </div>
      {note}
    </div>
  );
}

/** A media fragment: the browser loads the video and seeks there once
 *  its metadata is in, which paints that frame (WebKit's
 *  applyMediaFragmentURI). Without it iOS paints none before play, nor
 *  does Chromium on a phone (an empty frame with the whole file loaded:
 *  the e2e runs, vorschau-done.spec.ts). */
const FIRST_FRAME = "#t=0.001";

/** Played or playing: a new src would reload it. */
const started = (v: HTMLVideoElement | null) => !!v && (!v.paused || v.played.length > 0 || v.currentTime > 0);

/** HTMLMediaElement.readyState: a frame to show. */
const HAVE_CURRENT_DATA = 2;

/**
 * The exported video (done): GET /watch of this export. Before a tap
 * iOS paints only the poster (preload="metadata" draws no frame there),
 * so the poster is the first still that really decodes: the export's
 * thumbnail, else the analysis' poster (the owner's iPhone, 2026-11: an
 * empty frame). Only a still that decoded ever becomes the poster: once
 * a poster failed, WebKit loads no other one (a new poster attribute
 * only clears the failed image while it is in error: Safari 17 to 26),
 * so a failing thumbnail set as the poster would keep the frame empty.
 * None decodes: the video's own first frame, through FIRST_FRAME, and
 * only while the video hasn't played (never reloaded once started: that
 * is decided and committed in one task, flushSync, so a tap can't come
 * in between). `onPicture`: the frame has its picture — a still that
 * decoded, or the video's first frame once it is drawn — the share's
 * fetch ahead waits for it; `onPlaying`: the video plays, or stopped
 * (that fetch holds while it plays). PreviewScreen keys this by the
 * export's generation: a new export starts over.
 */
export default function ExportedVideo({
  job,
  onPicture,
  onPlaying,
}: {
  job: JobStatus;
  onPicture?: () => void;
  onPlaying?: (playing: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = usePlayback(videoRef);
  const v = job.renders_ok ?? 0;
  const src = useMediaUrl(job.id, "watch", { v });
  const thumbnail = useMediaUrl(job.id, "thumbnail", { v });
  const poster = useMediaUrl(job.id, "poster");
  const hasPoster = !!job.has_poster;
  // The still that decoded (`url`: the poster), and whether the src has
  // FIRST_FRAME. Once on that stays: taking it off would reload the video.
  const [chain, setChain] = useState<{ still: Still; url: string | null; firstFrame: boolean }>({
    still: "none",
    url: null,
    firstFrame: false,
  });
  const told = useRef({ onPicture, onPlaying });
  useEffect(() => {
    told.current = { onPicture, onPlaying };
  });

  useEffect(() => {
    if (!src) return;
    let live = true;
    const candidates = stillCandidates(thumbnail, hasPoster ? poster : null);
    void pickStill(candidates, (url) => decodeStill(url), () => live).then((c) => {
      if (!live) return;
      const firstFrame = !c && !started(videoRef.current);
      flushSync(() =>
        setChain((cur) => ({ still: c ? c.kind : "frame", url: c?.url ?? null, firstFrame: cur.firstFrame || firstFrame })),
      );
      // A still is the picture now; the first frame once it is drawn (below).
      if (c) told.current.onPicture?.();
    });
    return () => {
      live = false;
    };
  }, [src, thumbnail, poster, hasPoster]);

  // The video's own first frame: there once drawn (loadeddata, and seeked
  // for FIRST_FRAME's seek), at once for a video that already played; a
  // load error doesn't hold the fetch ahead either.
  const frameStill = chain.still === "frame";
  useEffect(() => {
    const v = videoRef.current;
    if (!frameStill || !v) return;
    if (started(v) || v.readyState >= HAVE_CURRENT_DATA) {
      told.current.onPicture?.();
      return;
    }
    const events = ["loadeddata", "seeked", "error"] as const;
    const drawn = () => {
      for (const e of events) v.removeEventListener(e, drawn);
      told.current.onPicture?.();
    };
    for (const e of events) v.addEventListener(e, drawn);
    return () => {
      for (const e of events) v.removeEventListener(e, drawn);
    };
  }, [frameStill]);

  const { playing } = playback;
  useEffect(() => {
    told.current.onPlaying?.(playing);
  }, [playing]);

  return (
    <Player
      videoRef={videoRef}
      playback={playback}
      src={src && chain.firstFrame ? `${src}${FIRST_FRAME}` : src}
      poster={chain.url ?? undefined}
      wide={isWide(job)}
      kind="export"
      still={src ? chain.still : "none"}
    />
  );
}
