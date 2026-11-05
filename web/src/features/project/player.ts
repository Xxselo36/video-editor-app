/**
 * The Vorschau player's logic (PreviewVideo, ExportedVideo): what its
 * <video> is doing, the editor's clips of the stored timeline, what the
 * preview shows of the export's captions, and which still the done
 * frame shows. Pure, but usePlayback, which reads the element.
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

/**
 * What the done frame shows before a tap (ExportedVideo; data-still):
 * the export's thumbnail, else the analysis' first-frame poster, else
 * the video's own first frame; "none" until one of those is settled.
 */
export type Still = "thumbnail" | "poster" | "frame" | "none";

export type StillCandidate = { kind: "thumbnail" | "poster"; url: string };

/** The stills to try, in order: the export's thumbnail, then the
 *  analysis' poster (null: the job has none). Each null while media URLs
 *  can't be built yet. */
export function stillCandidates(thumbnail: string | null, poster: string | null): StillCandidate[] {
  const out: StillCandidate[] = [];
  if (thumbnail) out.push({ kind: "thumbnail", url: thumbnail });
  if (poster) out.push({ kind: "poster", url: poster });
  return out;
}

/** A still that loaded but whose decode hasn't settled this long after
 *  counts as one that doesn't decode: Safari 17 and older never settle
 *  decode() for a frame they fail to decode (WebKit 618 drops that
 *  request; from 619, Safari 18, it rejects). */
export const DECODE_WAIT_MS = 2_000;

/** The parts of an <img> decodeStill uses (tests pass their own). */
export type StillImage = Pick<HTMLImageElement, "decode" | "onload" | "onerror" | "src">;

/** Whether the page is in view (document; tests pass their own). */
export type StillPage = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/**
 * Loads `url` in a detached image, then decodes it: rejects on a 404 or
 * a body that isn't an image (the load fails), on a frame the browser
 * can't decode (where a poster would stay empty), and when that decode
 * hasn't settled DECODE_WAIT_MS of the page being in view after the
 * load (Chromium decodes for a hidden page only once it shows: a tab in
 * the background keeps its stills). The load itself has no limit (a
 * slow link): the Vorschau's fetch ahead waits for the frame at most
 * PICTURE_WAIT_MS anyway (PreviewScreen).
 */
export function decodeStill(
  url: string,
  make: () => StillImage = () => new Image(),
  waitMs = DECODE_WAIT_MS,
  page: StillPage | undefined = globalThis.document,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = make();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      page?.removeEventListener("visibilitychange", count);
    };
    // The wait counts while the page is in view, from the start each time it shows.
    function count() {
      clearTimeout(timer);
      if (page?.hidden) return;
      timer = setTimeout(() => {
        settle();
        reject(new Error("still: its decode didn't settle"));
      }, waitMs);
    }
    img.onload = () => {
      page?.addEventListener("visibilitychange", count);
      count();
      img.decode().then(
        () => {
          settle();
          resolve();
        },
        (e: unknown) => {
          settle();
          reject(e);
        },
      );
    };
    img.onerror = () => reject(new Error("still: it didn't load"));
    img.src = url;
  });
}

/**
 * The first of `candidates` that really decodes (`decode`: decodeStill,
 * which rejects on a 404 and on a file the browser can't decode), tried
 * in turn; null when none does. Stops, with null, once `live()` says the
 * frame is gone.
 */
export async function pickStill(
  candidates: readonly StillCandidate[],
  decode: (url: string) => Promise<unknown>,
  live: () => boolean = () => true,
): Promise<StillCandidate | null> {
  for (const c of candidates) {
    if (!live()) return null;
    try {
      await decode(c.url);
      return live() ? c : null;
    } catch {
      // on to the next one
    }
  }
  return null;
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
