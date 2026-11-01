/**
 * The Vorschau player's logic (PreviewVideo, ExportedVideo): what its
 * <video> is doing, the editor's clips of the stored timeline, and what
 * the preview shows of the export's captions. Pure, but usePlayback,
 * which reads the element.
 */
import { useCallback, useSyncExternalStore, type RefObject } from "react";
import type { Fetched } from "@/features/editor/state/docFetch";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { JobStatus, SavedSeg } from "@/features/jobs/types";

/**
 * The frame of the job's video, in every player of the Vorschau (the
 * preview, the export, a failed video's still, a preview still being
 * built): 16:9 (true) or 9:16. A 16:9 output is wide; "original" keeps
 * the source's frame, whose shape the filmstrip's tiles have (each the
 * source scaled to 90 px high, pipeline.make_filmstrip), so a landscape
 * original is wide from the first answer, without a jump. Without a
 * filmstrip (it failed, or a job from before it) and for a square
 * source: the 9:16 frame, the picture letterboxed.
 */
export function isWide(job: Pick<JobStatus, "output_aspect" | "filmstrip">): boolean {
  if (job.output_aspect === "16:9") return true;
  if (job.output_aspect !== "original") return false;
  const tile = job.filmstrip;
  return !!tile && tile.tileH > 0 && tile.tileW > tile.tileH;
}

// HTMLMediaElement's networkState and readyState values.
const NETWORK_LOADING = 2;
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

/** Bits of playbackOf. PLAYING: play was pressed (not paused). BUSY: the
 *  file is loading and the player waits for it: its start, or (playing)
 *  the next frames. EMPTY: nothing of the file has arrived yet while it
 *  loads (a preview the server still builds). */
export const PLAYING = 1;
export const BUSY = 2;
export const EMPTY = 4;

type MediaState = Pick<HTMLMediaElement, "paused" | "networkState" | "readyState">;

/** The element's state as bits (a primitive: useSyncExternalStore's snapshot). */
export function playbackOf(v: MediaState | null): number {
  if (!v) return 0;
  const playing = !v.paused;
  const loading = v.networkState === NETWORK_LOADING;
  let bits = playing ? PLAYING : 0;
  if (loading && v.readyState < (playing ? HAVE_FUTURE_DATA : HAVE_METADATA)) bits |= BUSY;
  if (loading && v.readyState === HAVE_NOTHING) bits |= EMPTY;
  return bits;
}

const MEDIA_EVENTS = [
  "loadstart",
  "progress",
  "suspend",
  "stalled",
  "abort",
  "error",
  "emptied",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "waiting",
  "pause",
  "ended",
] as const;

export type Playback = { playing: boolean; busy: boolean; empty: boolean };

/** What the <video> behind `videoRef` is doing, kept current by its media events. */
export function usePlayback(videoRef: RefObject<HTMLVideoElement | null>): Playback {
  const subscribe = useCallback(
    (changed: () => void) => {
      const v = videoRef.current;
      if (!v) return () => {};
      for (const e of MEDIA_EVENTS) v.addEventListener(e, changed);
      return () => {
        for (const e of MEDIA_EVENTS) v.removeEventListener(e, changed);
      };
    },
    [videoRef],
  );
  const bits = useSyncExternalStore(
    subscribe,
    () => playbackOf(videoRef.current),
    () => 0,
  );
  return { playing: (bits & PLAYING) !== 0, busy: (bits & BUSY) !== 0, empty: (bits & EMPTY) !== 0 };
}

/** How far the video has played (0..1; 0 while its length is unknown). */
export function progressOf(currentTime: number, duration: number): number {
  return duration > 0 && Number.isFinite(duration) ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
}

/** The stored timeline as the editor's clips (useEditSession's ids). */
export function editSegsOf(saved: readonly SavedSeg[]): EditorSeg[] {
  return saved.map((s, i) => ({
    id: `seg-${i}-${s.start.toFixed(3)}`,
    start: s.start,
    end: s.end,
    speed: s.speed,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
    volume: s.volume,
  }));
}

/**
 * What the preview shows of the export's captions. "live": drawn over
 * it, as the export draws them (the v2 engine, or "optin" with this
 * browser's ?captions=v2: `optIn`). "after": a note that they come with
 * the export (the v1 engine, or no doc to draw them from). null: no
 * captions (style "none", "Ohne Untertitel") — or the doc is still
 * loading (`doc` null; "none": there is none).
 */
export function previewCaptions(
  doc: Fetched | "none" | null,
  optIn: boolean,
  captionsOff: boolean,
): "live" | "after" | null {
  if (doc === null) return null;
  if (doc === "none") return captionsOff ? null : "after";
  if ((doc.renderStyle ?? doc.doc.style).presetId === "none") return null;
  const { engine } = doc.captions;
  return engine === "v2" || (engine === "optin" && optIn) ? "live" : "after";
}
