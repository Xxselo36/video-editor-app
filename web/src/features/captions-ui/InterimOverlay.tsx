"use client";
/**
 * Interim preview captions (UT1): the job's captions, styled and animated
 * by the caption engine (lib/captions), over the review screen's <video>
 * — while the export still burns them with the v1 renderer. Behind
 * NEXT_PUBLIC_CAPTIONS_INTERIM=1; UT5's CaptionLayer replaces it.
 *
 * - A <canvas aria-hidden> over the video's content box (object-fit:
 *   contain), backed at × min(devicePixelRatio, 2). The transcript is the
 *   accessible text.
 * - Words: the edited sentences mapped to the job's word units
 *   (phrasesToUnits, what the render gets), on the SOURCE timeline; the
 *   playing frame's source time comes from the review screen's mapping
 *   (proxy: the video's time; preview: back through its segments).
 * - Style: the v1 preset's v2 alias at the export's position.
 * - Nothing is drawn before ensureFonts() has settled. Frames are drawn
 *   imperatively on requestVideoFrameCallback (rAF fallback), and only
 *   when the caption changes: React renders this component when its
 *   inputs change, never per frame.
 * - A "Preview" chip (not for Clipper, whose look is the export's).
 *
 * Test hook (NEXT_PUBLIC_TEST_PAGES=1 builds only): window.__captionsInterim.
 */
import { memo, useEffect, useRef, type RefObject } from "react";
import {
  CaptionRenderer,
  ensureFonts,
  resolveStyle,
  type CaptionStyle,
  type CaptionWord,
  type Ctx2D,
} from "@/lib/captions";
import type { TimedText } from "@/features/editor/legacy/phraseUnits";
import { useT } from "@/i18n";
import {
  canvasPixels,
  contentBox,
  interimStyleRef,
  interimWords,
  pageText,
  sourceBreaks,
  videoToSource,
  type PlaybackMode,
} from "./interim";

type Segments = readonly (readonly [number, number])[];

export type InterimOverlayProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The transcript as edited (review screen sentences). */
  phrases: readonly TimedText[];
  /** The job's word units (GET /subtitles); read when `phrases` change. */
  units: { readonly current: readonly TimedText[] };
  /** The job's v1 caption preset. */
  captionPreset: string;
  mode: PlaybackMode;
  /** Source segments the video plays, in play order. */
  segments: Segments;
  duration: number;
  lang?: string;
};

export type InterimHook = {
  fontsReady: boolean;
  fontsOk: boolean;
  preset: string;
  draws: number;
  /** Time spent in drawFrame (ms, total and worst) and bitmaps rendered. */
  drawMs: number;
  maxDrawMs: number;
  renders: number;
  /** Source time of the last drawn frame. */
  t: number | null;
  /** Text of the drawn page, null when no caption is shown. */
  page: string | null;
  active: string | null;
  activeIndex: number;
  /** Canvas size in device pixels. */
  W: number;
  H: number;
};

declare global {
  interface Window {
    __captionsInterim?: InterimHook;
  }
}

const TEST_HOOK = process.env.NEXT_PUBLIC_TEST_PAGES === "1";

type VideoFrameCallback = (now: number, meta: { mediaTime: number }) => void;
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function InterimOverlay({ videoRef, phrases, units, captionPreset, mode, segments, duration, lang }: InterimOverlayProps) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Everything the frame loop reads; the effects below keep it current.
  const live = useRef({
    mode,
    segments,
    duration,
    words: [] as CaptionWord[],
    breaks: [] as number[],
    W: 0,
    H: 0,
    renderer: null as CaptionRenderer | null,
    ready: false,
    dirty: true,
    lastT: NaN,
    gen: 0,
    draw: () => {},
    prepare: () => {},
  });
  const presetRef = useRef(captionPreset);

  // ── the frame loop and the canvas geometry (mount) ──────────────────
  useEffect(() => {
    const v = videoRef.current as RVFCVideo | null;
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!v || !canvas || !box) return;
    const ctx = canvas.getContext("2d") as unknown as Ctx2D | null;
    if (!ctx) return;
    const L = live.current;
    const hook: InterimHook | null = TEST_HOOK
      ? { fontsReady: false, fontsOk: false, preset: presetRef.current, draws: 0, drawMs: 0, maxDrawMs: 0, renders: 0, t: null, page: null, active: null, activeIndex: -1, W: 0, H: 0 }
      : null;
    if (hook) window.__captionsInterim = hook;

    const draw = (mediaTime?: number) => {
      const r = L.renderer;
      if (!r || !L.ready) return;
      const src = videoToSource(mediaTime ?? v.currentTime, L.mode, L.segments, L.duration);
      if (!L.dirty && src === L.lastT) return;
      const force = L.dirty;
      L.dirty = false;
      L.lastT = src;
      const t0 = hook ? performance.now() : 0;
      const { changed, state } = r.drawFrame(ctx, src, { force });
      if (hook) {
        const ms = performance.now() - t0;
        hook.drawMs += ms;
        hook.maxDrawMs = Math.max(hook.maxDrawMs, ms);
        hook.renders = r.stats.renders;
        const page = state ? r.pages[state.page] : null;
        if (changed) hook.draws++;
        hook.t = src;
        // transcript text (before the style's case mapping)
        hook.page = page ? pageText(page.words.map((w) => ({ text: w.source }))) : null;
        hook.activeIndex = state ? state.active : -1;
        hook.active = page && state && state.active >= 0 ? page.words[state.active].source : null;
      }
      if (changed) schedulePrefetch(r, state ? r.pages[state.page].end : src);
    };
    L.draw = () => draw();

    // The next page's page-in bitmaps are rendered while the browser is
    // idle, so a page change during playback is a blit, not a render
    // (a render costs a few ms: strokes, shadows).
    const idle = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let idleHandle = 0;
    let prefetchedFor = NaN;
    const cancelPrefetch = () => {
      if (idle.cancelIdleCallback) idle.cancelIdleCallback(idleHandle);
      else clearTimeout(idleHandle);
    };
    function schedulePrefetch(r: CaptionRenderer, from: number) {
      if (from === prefetchedFor) return;
      prefetchedFor = from;
      cancelPrefetch();
      const run = () => {
        if (L.renderer === r) r.prefetch(from);
      };
      idleHandle = idle.requestIdleCallback ? idle.requestIdleCallback(run, { timeout: 1000 }) : window.setTimeout(run, 100);
    }

    // Style (per frame size), fonts, renderer: whenever words, preset or size change.
    const prepare = () => {
      if (!L.W || !L.H) return;
      const ref = interimStyleRef(presetRef.current);
      const style: CaptionStyle | null = resolveStyle(ref.presetId, ref.overrides, { W: L.W, H: L.H });
      const gen = ++L.gen;
      if (!style || style.presetId === "none") {
        L.renderer?.dispose();
        L.renderer = null;
        ctx.clearRect(0, 0, L.W, L.H);
        return;
      }
      const words = L.words;
      void ensureFonts(style, { lang, text: words.map((w) => w.text) })
        .then(
          (status) => status.ok,
          () => false,
        )
        .then((ok) => {
          if (gen !== L.gen) return; // superseded
          const input = { words, style, W: L.W, H: L.H, lang, breaks: L.breaks };
          if (L.renderer) L.renderer.update(input);
          else L.renderer = new CaptionRenderer(input);
          L.ready = true;
          L.dirty = true;
          prefetchedFor = NaN;
          if (hook) {
            hook.fontsReady = true;
            hook.fontsOk = ok;
            hook.preset = style.presetId;
            hook.W = L.W;
            hook.H = L.H;
          }
          draw();
        });
    };
    L.prepare = prepare;

    const layout = () => {
      const b = contentBox(v.clientWidth, v.clientHeight, v.videoWidth, v.videoHeight);
      box.style.left = `${v.offsetLeft + b.x}px`;
      box.style.top = `${v.offsetTop + b.y}px`;
      box.style.width = `${b.w}px`;
      box.style.height = `${b.h}px`;
      const { W, H } = canvasPixels(b, window.devicePixelRatio);
      if (W === L.W && H === L.H) return;
      L.W = W;
      L.H = H;
      canvas.width = W; // clears the canvas
      canvas.height = H;
      L.dirty = true;
      prepare();
    };
    layout();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(layout) : null;
    ro?.observe(v);
    v.addEventListener("loadedmetadata", layout);
    v.addEventListener("resize", layout);
    window.addEventListener("resize", layout);
    const onSeeked = () => draw();
    v.addEventListener("seeked", onSeeked);

    let frameHandle = 0;
    let rafHandle = 0;
    const rvfc = typeof v.requestVideoFrameCallback === "function";
    if (rvfc) {
      // Every presented frame, at its own media time: the caption never
      // runs ahead of the picture.
      const onFrame: VideoFrameCallback = (_now, meta) => {
        draw(meta.mediaTime);
        frameHandle = v.requestVideoFrameCallback!(onFrame);
      };
      frameHandle = v.requestVideoFrameCallback!(onFrame);
    } else {
      const tick = () => {
        if (!v.paused) draw();
        rafHandle = requestAnimationFrame(tick);
      };
      rafHandle = requestAnimationFrame(tick);
    }
    return () => {
      if (rvfc) v.cancelVideoFrameCallback?.(frameHandle);
      cancelAnimationFrame(rafHandle);
      cancelPrefetch();
      ro?.disconnect();
      v.removeEventListener("loadedmetadata", layout);
      v.removeEventListener("resize", layout);
      window.removeEventListener("resize", layout);
      v.removeEventListener("seeked", onSeeked);
      L.gen++;
      L.renderer?.dispose();
      L.renderer = null;
      L.ready = false;
      L.draw = () => {};
      L.prepare = () => {};
      if (hook && window.__captionsInterim === hook) delete window.__captionsInterim;
    };
    // lang is fixed for a job (the review screen is keyed by job).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef]);

  // ── inputs ──────────────────────────────────────────────────────────
  useEffect(() => {
    const L = live.current;
    L.words = interimWords(phrases, units.current);
    L.prepare();
  }, [phrases, units]);

  useEffect(() => {
    presetRef.current = captionPreset;
    live.current.prepare();
  }, [captionPreset]);

  useEffect(() => {
    const L = live.current;
    L.mode = mode;
    L.segments = segments;
    L.duration = duration;
    L.breaks = sourceBreaks(segments);
    L.renderer?.update({ breaks: L.breaks });
    L.dirty = true;
    L.draw();
  }, [mode, segments, duration]);

  const chip = captionPreset !== "clipper";
  return (
    <div ref={boxRef} className="pointer-events-none absolute" data-testid="caption-interim">
      <canvas ref={canvasRef} aria-hidden="true" data-testid="caption-canvas" className="absolute inset-0 h-full w-full" />
      {chip && (
        <span
          data-testid="caption-preview-chip"
          title={t("app.review.captionPreviewTip")}
          className="pointer-events-auto absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur-md"
          style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
        >
          {t("app.review.captionPreviewChip")}
        </span>
      )}
    </div>
  );
}

const sameSegments = (a: Segments, b: Segments) =>
  a === b || (a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1]));

/**
 * The review screen re-renders ~12×/s while playing; the overlay only when
 * an input really changes (segments compared by value: the caller builds
 * them inline).
 */
export default memo(
  InterimOverlay,
  (a, b) =>
    a.videoRef === b.videoRef &&
    a.phrases === b.phrases &&
    a.units === b.units &&
    a.captionPreset === b.captionPreset &&
    a.mode === b.mode &&
    a.duration === b.duration &&
    a.lang === b.lang &&
    sameSegments(a.segments, b.segments),
);
