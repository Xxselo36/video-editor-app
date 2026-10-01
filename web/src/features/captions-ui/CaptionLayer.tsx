"use client";
/**
 * Live captions over the v2 editor's preview (UT5; PLAN_TECH UT5
 * CaptionLayer, DF mock Desktop-/Handy-Untertitel). Shown when the job's
 * export draws v2 captions (GET /jobs/{id}/doc caption_engine, or this
 * browser's ?captions=v2 opt-in), so the preview is what the export draws.
 *
 * - A <canvas aria-hidden> over the video's content box, backed at
 *   × min(DPR, 2); the Text tab is the accessible text.
 * - Words: the doc's shown words mapped through the edit's clips onto the
 *   OUTPUT timeline (live.ts, like backend/captions_v2.py) with the
 *   style's sync offset; the style is the doc's (presets + overrides,
 *   per-caption position and size included).
 * - Drawn on requestVideoFrameCallback at the presented frame's
 *   mediaTime (never ahead of the picture), mapped to output time through
 *   the clip the player is in. React renders only when inputs change.
 * - Fonts: the renderer is swapped only after ensureFonts() settled, so a
 *   style switch never shows a fallback-font frame; a chip says the font
 *   is loading when that takes a moment.
 * - Adjusting: a click on the caption selects it (and pauses). Drag it to
 *   move (snap lines 56 / 70 / 79 % and the style's own y, button-zone
 *   silhouettes while selected), drag the corner (or pinch) to resize; a
 *   click on the top handle steps through the snap lines, on the corner
 *   through 90 / 100 / 115 %; arrows on a focused handle nudge. The bar
 *   above: "Nur hier | Überall" and "Zurücksetzen" (lib/captions
 *   adjust.ts). Every change is one doc step (undo, autosave).
 *
 * Test hook (NEXT_PUBLIC_TEST_PAGES=1 builds): window.__captionLayer.
 */
import { RotateCcw } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/i18n";
import {
  CaptionRenderer,
  captionIdOf,
  effectiveAdjust,
  ensureFonts,
  mapToOutput,
  resetAdjust,
  resolveStyle,
  setCaptionAdjust,
  setStyleAdjust,
  type CaptionAdjust,
  type CaptionStyle,
  type Ctx2D,
  type Page,
  type StyleOverrides,
} from "@/lib/captions";
import { setStyle, type EditDoc } from "@/features/editor/state/doc";
import { useDocStore, type DocState, type DocStore } from "@/features/editor/state/store";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { canvasPixels, contentBox, pageText } from "./interim";
import { clipsOf, nextLine, nextSize, outputTime, shownWords, snapLines, snapY } from "./live";
import c from "./captions.module.css";

export type CaptionLayerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  doc: DocStore;
  /** One undo step (the shell orders it with the timeline's). */
  apply: (op: (d: EditDoc) => EditDoc) => boolean;
  editSegs: EditorSeg[];
  /** Source time of the playing frame (session.toSource). */
  toSource: (mediaTime: number) => number;
  /** The clip the player is in (proxy mode), for a source moment in two clips. */
  playingSegId: string | null;
  phone: boolean;
  /** Show the button-zone silhouettes all the time (Style panel toggle). */
  zones?: boolean;
  readOnly?: boolean;
};

export type CaptionLayerHook = {
  ready: boolean;
  preset: string | null;
  draws: number;
  /** Fonts the last swap waited for (ms). */
  fontMs: number;
  pages: number;
  /** Output time of the last drawn frame. */
  t: number | null;
  page: string | null;
  pageId: string | null;
  /** Position / size of the drawn page (0..1 / scale) and whether they are its own. */
  adjust: { y: number; sizeScale: number; own: boolean } | null;
  selected: string | null;
};

declare global {
  interface Window {
    __captionLayer?: CaptionLayerHook;
  }
}

const TEST_HOOK = process.env.NEXT_PUBLIC_TEST_PAGES === "1";

type VideoFrameCallback = (now: number, meta: { mediaTime: number }) => void;
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const selStyle = (st: DocState) => st.present.style;
const selWords = (st: DocState) => st.present.words;
const selLang = (st: DocState) => st.present.language;

/** Caption box in CSS px of the layer (+ the bar's room above). */
type Geo = {
  left: number;
  top: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** The selected caption's position / size and the style's own y (snap lines). */
  eff: { y: number; sizeScale: number; own: boolean };
  styleY: number;
};
type Sel = { id: string; scope: "here" | "all"; before: { y?: number; sizeScale?: number } | null };
type Drag = {
  kind: "move" | "size" | "pinch";
  pointer: number;
  x0: number;
  y0: number;
  start: { y: number; sizeScale: number };
  now: { y: number; sizeScale: number };
  line: number | null;
  moved: boolean;
  pinch0?: number;
  pointers: Map<number, { x: number; y: number }>;
};

/** A caption's own values: only where they differ from the style's (null: it follows the style). */
function ownOf(v: { y: number; sizeScale: number }, s: CaptionStyle): CaptionAdjust | null {
  const a: CaptionAdjust = {};
  if (Math.abs(v.y - s.layout.y) >= 5e-4) a.y = v.y;
  if (Math.abs(v.sizeScale - (s.sizeScale ?? 1)) >= 5e-3) a.sizeScale = v.sizeScale;
  return a.y === undefined && a.sizeScale === undefined ? null : a;
}

/** The button zones of TikTok / Reels / Shorts, without logos (DF mock): a right rail and a bottom bar. */
const ZONES: React.CSSProperties[] = [
  { right: "3.5%", top: "47%", width: "9%", aspectRatio: "1", borderRadius: "50%" },
  { right: "3.5%", top: "55%", width: "9%", aspectRatio: "1", borderRadius: "50%" },
  { right: "3.5%", top: "63%", width: "9%", aspectRatio: "1", borderRadius: "50%" },
  { right: "3.5%", top: "71%", width: "9%", aspectRatio: "1", borderRadius: "50%" },
  { left: "4%", bottom: "3%", width: "68%", height: "7%", borderRadius: 6 },
];

function CaptionLayer(props: CaptionLayerProps) {
  const t = useT();
  const { videoRef, doc, apply, editSegs, phone } = props;
  const style = useDocStore(doc, selStyle);
  const words = useDocStore(doc, selWords);
  const lang = useDocStore(doc, selLang) ?? undefined;
  const clips = useMemo(() => clipsOf(editSegs), [editSegs]);
  const source = useMemo(() => shownWords(words), [words]);
  const overrides = (style.overrides ?? {}) as StyleOverrides;
  const offsetMs = typeof overrides.offsetMs === "number" ? overrides.offsetMs : 0;
  const timeline = useMemo(() => mapToOutput(clips, source, { offsetMs }), [clips, source, offsetMs]);

  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLButtonElement>(null);
  const selBoxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  // where the adjust bar goes: the stage's fullscreen wrapper (not clipped by the frame)
  const [barHost, setBarHost] = useState<HTMLElement | null>(null);
  const toSourceRef = useRef(props.toSource);
  const segIdRef = useRef(props.playingSegId);
  const [fontLoading, setFontLoading] = useState(false);
  const [sel, setSelState] = useState<Sel | null>(null);
  // the selection for callbacks that run outside a render (the frame loop's refresh)
  const selRef = useRef<Sel | null>(null);
  const setSel = useCallback((next: Sel | null) => {
    selRef.current = next;
    setSelState(next);
  }, []);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cssH, setCssH] = useState(0);
  // Everything the frame loop reads; the effects below keep it current.
  const live = useRef({
    clips,
    timeline,
    style: null as CaptionStyle | null,
    W: 0,
    H: 0,
    scale: 1,
    renderer: null as CaptionRenderer | null,
    ready: false,
    dirty: true,
    lastT: NaN as number,
    page: -1,
    gen: 0,
    draw: () => {},
    prepare: () => {},
    refreshSel: () => {},
  });
  useEffect(() => {
    toSourceRef.current = props.toSource;
    segIdRef.current = props.playingSegId;
  });

  // ── the frame loop and the canvas geometry (mount) ──────────────────
  useEffect(() => {
    const v = videoRef.current as RVFCVideo | null;
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!v || !canvas || !box) return;
    const ctx = canvas.getContext("2d") as unknown as Ctx2D | null;
    if (!ctx) return;
    const L = live.current;
    const hook: CaptionLayerHook | null = TEST_HOOK
      ? { ready: false, preset: null, draws: 0, fontMs: 0, pages: 0, t: null, page: null, pageId: null, adjust: null, selected: null }
      : null;
    if (hook) window.__captionLayer = hook;

    const placeHit = (pageIndex: number) => {
      const hit = hitRef.current;
      const r = L.renderer;
      if (!hit) return;
      if (!r || pageIndex < 0) {
        hit.hidden = true;
        return;
      }
      const b = r.layout(pageIndex).box;
      const s = L.scale;
      const pad = 6;
      hit.hidden = false;
      hit.style.left = `${b.left / s - pad}px`;
      hit.style.top = `${b.top / s - pad}px`;
      hit.style.width = `${(b.right - b.left) / s + 2 * pad}px`;
      hit.style.height = `${(b.bottom - b.top) / s + 2 * pad}px`;
    };

    const draw = (mediaTime?: number) => {
      const r = L.renderer;
      if (!r || !L.ready) return;
      const src = toSourceRef.current(mediaTime ?? v.currentTime);
      const out = outputTime(L.clips, src, segIdRef.current);
      const tt = out ?? -1;
      if (!L.dirty && tt === L.lastT) return;
      const force = L.dirty;
      L.dirty = false;
      L.lastT = tt;
      const { changed, state } = r.drawFrame(ctx, tt, { force });
      const pi = state ? state.page : -1;
      if (pi !== L.page || force) {
        L.page = pi;
        placeHit(pi);
      }
      if (hook) {
        if (changed) hook.draws++;
        const page = pi >= 0 ? r.pages[pi] : null;
        hook.t = out;
        hook.page = page ? pageText(page.words.map((w) => ({ text: w.source }))) : null;
        hook.pageId = page ? captionIdOf(page) : null;
        // the renderer's own style: the pages were built with it
        hook.adjust = page ? effectiveAdjust(r.style, page) : null;
        hook.pages = r.pages.length;
      }
    };
    L.draw = () => draw();

    // Fonts that failed (offline) are asked for again once back online.
    const retry = () => L.prepare();
    let slowTimer = 0;
    const prepare = () => {
      if (!L.W || !L.H) return;
      const s = L.style;
      const gen = ++L.gen;
      if (!s) {
        L.renderer?.dispose();
        L.renderer = null;
        L.ready = false;
        ctx.clearRect(0, 0, L.W, L.H);
        placeHit(-1);
        if (hook) {
          hook.ready = true;
          hook.preset = "none";
          hook.page = null;
          hook.pageId = null;
        }
        setFontLoading(false);
        return;
      }
      const t0 = performance.now();
      window.clearTimeout(slowTimer);
      slowTimer = window.setTimeout(() => {
        if (gen === L.gen) setFontLoading(true);
      }, 150);
      const words = L.timeline.words;
      void ensureFonts(s, { lang, text: words.map((w) => w.text) })
        .then(
          (st) => st.ok,
          () => false,
        )
        .then((ok) => {
          if (gen !== L.gen) return; // superseded
          window.clearTimeout(slowTimer);
          setFontLoading(false);
          if (!ok) {
            // No fallback-font frame: nothing until the fonts are there.
            L.renderer?.dispose();
            L.renderer = null;
            L.ready = false;
            ctx.clearRect(0, 0, L.W, L.H);
            placeHit(-1);
            window.removeEventListener("online", retry);
            window.addEventListener("online", retry, { once: true });
            return;
          }
          const input = { words, style: s, W: L.W, H: L.H, lang, breaks: L.timeline.breaks };
          if (L.renderer) L.renderer.update(input);
          else L.renderer = new CaptionRenderer(input);
          L.ready = true;
          L.dirty = true;
          canvas.style.transform = "";
          if (hook) {
            hook.ready = true;
            hook.preset = s.presetId;
            hook.fontMs = Math.round(performance.now() - t0);
          }
          draw();
          L.refreshSel();
        });
    };
    L.prepare = prepare;

    const layout = () => {
      const b = contentBox(v.clientWidth, v.clientHeight, v.videoWidth, v.videoHeight);
      box.style.left = `${v.offsetLeft + b.x}px`;
      box.style.top = `${v.offsetTop + b.y}px`;
      box.style.width = `${b.w}px`;
      box.style.height = `${b.h}px`;
      setCssH(b.h);
      const { W, H, scale } = canvasPixels(b, window.devicePixelRatio);
      L.scale = b.w > 0 ? W / b.w : scale;
      if (W === L.W && H === L.H) {
        L.refreshSel();
        return;
      }
      L.W = W;
      L.H = H;
      canvas.width = W; // clears the canvas
      canvas.height = H;
      L.dirty = true;
      L.style = resolveFromDoc();
      prepare();
    };
    // the style for this canvas size (resolveStyle depends on the frame shape)
    const resolveFromDoc = () => {
      const st = doc.getState().present.style;
      return resolveStyle(st.presetId, (st.overrides ?? {}) as StyleOverrides, { W: L.W, H: L.H });
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
      window.clearTimeout(slowTimer);
      ro?.disconnect();
      v.removeEventListener("loadedmetadata", layout);
      v.removeEventListener("resize", layout);
      window.removeEventListener("resize", layout);
      v.removeEventListener("seeked", onSeeked);
      window.removeEventListener("online", retry);
      L.gen++;
      L.renderer?.dispose();
      L.renderer = null;
      L.ready = false;
      L.draw = () => {};
      L.prepare = () => {};
      L.refreshSel = () => {};
      if (hook && window.__captionLayer === hook) delete window.__captionLayer;
    };
    // lang is fixed for a job (the shell is keyed by job).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, doc]);

  // ── inputs: style, words, clips ─────────────────────────────────────
  useEffect(() => {
    const L = live.current;
    L.clips = clips;
    L.timeline = timeline;
    L.style = L.W && L.H ? resolveStyle(style.presetId, overrides, { W: L.W, H: L.H }) : null;
    L.prepare();
    // overrides is part of style
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, timeline, clips]);

  useEffect(() => {
    setBarHost(boxRef.current?.closest<HTMLElement>("[data-testid=ed-fullscreen-wrap]") ?? null);
  }, []);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const box = selBoxRef.current;
    if (!bar || !box) return;
    const host = barHost ?? box;
    const area = (barHost?.closest<HTMLElement>("[data-testid=ed-stage]") ?? barHost ?? box).getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const gap = phone ? 26 : 16;
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - bw / 2, area.left + 8), Math.max(area.left + 8, area.right - 8 - bw));
    let top = r.top - gap - bh;
    if (top < area.top + 8) top = r.bottom + gap;
    bar.style.left = `${left - h.left}px`;
    bar.style.top = `${top - h.top}px`;
  });

  // ── selection ───────────────────────────────────────────────────────
  const pageOf = useCallback((id: string): { page: Page; index: number } | null => {
    const r = live.current.renderer;
    if (!r) return null;
    const index = r.pages.findIndex((p) => captionIdOf(p) === id);
    return index >= 0 ? { page: r.pages[index], index } : null;
  }, []);

  const refreshSel = useCallback(() => {
    const L = live.current;
    const cur = selRef.current;
    if (!cur) {
      setGeo(null);
      return;
    }
    const hit = pageOf(cur.id);
    if (!hit || !L.renderer) {
      // the caption is gone (an edit, another style's paging)
      selRef.current = null;
      setSel(null);
      setGeo(null);
      return;
    }
    const b = L.renderer.layout(hit.index).box;
    const s = L.scale;
    const pad = 6;
    setGeo({
      left: b.left / s - pad,
      top: b.top / s - pad,
      width: (b.right - b.left) / s + 2 * pad,
      height: (b.bottom - b.top) / s + 2 * pad,
      cx: (b.left + b.right) / 2 / s,
      cy: (b.top + b.bottom) / 2 / s,
      eff: effectiveAdjust(L.renderer.style, hit.page),
      styleY: L.renderer.style.layout.y,
    });
  }, [pageOf, setSel]);
  useEffect(() => {
    live.current.refreshSel = refreshSel;
  }, [refreshSel]);
  useEffect(() => {
    if (TEST_HOOK && window.__captionLayer) window.__captionLayer.selected = sel?.id ?? null;
  }, [sel]);

  // playing again ends the selection
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => {
      setSel(null);
      setGeo(null);
    };
    v.addEventListener("play", onPlay);
    return () => v.removeEventListener("play", onPlay);
  }, [videoRef, setSel]);

  const select = () => {
    const L = live.current;
    const r = L.renderer;
    if (!r || L.page < 0 || props.readOnly) return;
    videoRef.current?.pause();
    const id = captionIdOf(r.pages[L.page]);
    if (!id) return;
    setSel({ id, scope: "here", before: null });
    refreshSel();
    // keyboard users go on with the move handle (arrows nudge)
    requestAnimationFrame(() => moveRef.current?.focus({ preventScroll: true }));
  };
  const deselect = useCallback(() => {
    setSel(null);
    setGeo(null);
  }, [setSel]);
  const selected = sel !== null;
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        deselect();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected, deselect]);

  const current = () => {
    const L = live.current;
    if (!sel || !L.renderer) return null;
    const hit = pageOf(sel.id);
    if (!hit) return null;
    const style = L.renderer.style;
    return { page: hit.page, eff: effectiveAdjust(style, hit.page), style };
  };

  /** Writes a new position / size for the selected caption in its scope (one undo step). */
  const commit = (next: CaptionAdjust) => {
    const cur = current();
    if (!sel || !cur) return;
    const same =
      Math.abs((next.y ?? cur.eff.y) - cur.eff.y) < 5e-4 && Math.abs((next.sizeScale ?? cur.eff.sizeScale) - cur.eff.sizeScale) < 5e-3;
    if (same) {
      if (canvasRef.current) canvasRef.current.style.transform = "";
      return;
    }
    const value = { y: next.y ?? cur.eff.y, sizeScale: next.sizeScale ?? cur.eff.sizeScale };
    apply((d) => {
      const o = (d.style.overrides ?? {}) as StyleOverrides;
      const no = sel.scope === "here" ? setCaptionAdjust(o, cur.page, ownOf(value, cur.style)) : setStyleAdjust(o, cur.page, value);
      return setStyle(d, { presetId: d.style.presetId, overrides: no as Record<string, unknown> });
    });
  };

  const setScope = (scope: "here" | "all") => {
    const cur = current();
    if (!sel || !cur || sel.scope === scope) return;
    const o0 = (doc.getState().present.style.overrides ?? {}) as StyleOverrides;
    if (scope === "all") {
      const before = { y: o0.y, sizeScale: o0.sizeScale };
      if (cur.eff.own) {
        apply((d) => {
          const o = (d.style.overrides ?? {}) as StyleOverrides;
          return setStyle(d, { presetId: d.style.presetId, overrides: setStyleAdjust(o, cur.page, cur.eff) as Record<string, unknown> });
        });
      }
      setSel({ ...sel, scope, before });
    } else {
      // back to "only here": the style's own values as before "everywhere", this caption keeps its look
      const before = sel.before;
      if (before) {
        const L = live.current;
        apply((d) => {
          const o = { ...((d.style.overrides ?? {}) as StyleOverrides) };
          if (before.y === undefined) delete o.y;
          else o.y = before.y;
          if (before.sizeScale === undefined) delete o.sizeScale;
          else o.sizeScale = before.sizeScale;
          const restored = resolveStyle(d.style.presetId, o, { W: L.W, H: L.H });
          const no = setCaptionAdjust(o, cur.page, restored ? ownOf(cur.eff, restored) : null);
          return setStyle(d, { presetId: d.style.presetId, overrides: no as Record<string, unknown> });
        });
      }
      setSel({ ...sel, scope, before: null });
    }
  };

  const reset = () => {
    const cur = current();
    if (!sel || !cur) return;
    apply((d) => {
      const o = (d.style.overrides ?? {}) as StyleOverrides;
      return setStyle(d, { presetId: d.style.presetId, overrides: resetAdjust(o, cur.page, sel.scope === "all") as Record<string, unknown> });
    });
    setSel({ ...sel, before: null });
  };

  // ── dragging (pointer events; a click without movement steps) ──────
  const preview = (d: Drag) => {
    const cv = canvasRef.current;
    if (!cv || !geo || !cssH) return;
    const dy = (d.now.y - d.start.y) * cssH;
    const k = d.now.sizeScale / d.start.sizeScale;
    cv.style.transformOrigin = `${geo.cx}px ${geo.cy}px`;
    cv.style.transform = `translateY(${dy}px) scale(${k})`;
  };
  const begin = (kind: Drag["kind"], e: React.PointerEvent) => {
    const cur = current();
    if (!cur) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const pointers = new Map(drag?.pointers ?? []);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag && pointers.size === 2) {
      // a second finger: pinch to resize
      const [a, b] = [...pointers.values()];
      setDrag({ ...drag, kind: "pinch", pointers, pinch0: Math.hypot(a.x - b.x, a.y - b.y), start: drag.now, moved: true });
      return;
    }
    const start = { y: cur.eff.y, sizeScale: cur.eff.sizeScale };
    setDrag({ kind, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, start, now: start, line: null, moved: false, pointers });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag || !cssH || !geo) return;
    const pointers = new Map(drag.pointers);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    let d: Drag = { ...drag, pointers };
    const style = live.current.style;
    if (drag.kind === "pinch" && pointers.size >= 2 && drag.pinch0) {
      const [a, b] = [...pointers.values()];
      const k = Math.hypot(a.x - b.x, a.y - b.y) / drag.pinch0;
      d = { ...d, now: { ...d.now, sizeScale: Math.min(1.6, Math.max(0.6, drag.start.sizeScale * k)) } };
    } else if (e.pointerId === drag.pointer) {
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      const moved = drag.moved || Math.hypot(dx, dy) > 4;
      if (!moved) return;
      if (drag.kind === "move") {
        const lines = snapLines(style?.layout.y ?? 0.68);
        const s = snapY(drag.start.y + dy / cssH, lines);
        d = { ...d, moved, line: s.line, now: { ...d.now, y: s.y } };
      } else if (drag.kind === "size") {
        // distance from the caption's centre, against where the drag started
        const rect = boxRef.current?.getBoundingClientRect();
        const cx = (rect?.left ?? 0) + geo.cx;
        const cy = (rect?.top ?? 0) + geo.cy;
        const r0 = Math.max(8, Math.hypot(drag.x0 - cx, drag.y0 - cy));
        const r1 = Math.hypot(e.clientX - cx, e.clientY - cy);
        d = { ...d, moved, now: { ...d.now, sizeScale: Math.min(1.6, Math.max(0.6, (drag.start.sizeScale * r1) / r0)) } };
      }
    } else return;
    setDrag(d);
    preview(d);
  };
  const end = (e: React.PointerEvent) => {
    if (!drag) return;
    const pointers = new Map(drag.pointers);
    pointers.delete(e.pointerId);
    if (drag.kind === "pinch" && pointers.size > 0) {
      setDrag({ ...drag, pointers });
      return;
    }
    setDrag(null);
    if (!drag.moved) {
      const cur = current();
      if (!cur) return;
      if (drag.kind === "move" && e.currentTarget.getAttribute("data-handle") === "move") {
        commit({ y: nextLine(cur.eff.y, snapLines(cur.style.layout.y)) });
      } else if (drag.kind === "size") commit({ sizeScale: nextSize(cur.eff.sizeScale) });
      return;
    }
    commit(drag.now);
  };
  const nudge = (kind: "move" | "size", e: React.KeyboardEvent) => {
    const cur = current();
    if (!cur) return;
    const up = e.key === "ArrowUp" || e.key === "ArrowRight";
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
    if (!up && !down) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === "move") commit({ y: cur.eff.y + (e.key === "ArrowUp" ? -0.01 : e.key === "ArrowDown" ? 0.01 : 0) });
    else commit({ sizeScale: cur.eff.sizeScale + (up ? 0.05 : -0.05) });
  };

  const cur = sel && geo ? geo : null;
  const lines = cur ? snapLines(cur.styleY) : [];
  const shownLine = drag?.kind === "move" ? drag.line : cur ? (lines.find((l) => Math.abs(l - cur.eff.y) < 0.002) ?? null) : null;
  const pct = cur ? Math.round((drag?.now.sizeScale ?? cur.eff.sizeScale) * 100) : 100;
  const dragDy = drag && cssH ? (drag.now.y - drag.start.y) * cssH : 0;
  const k = drag ? drag.now.sizeScale / drag.start.sizeScale : 1;
  const boxStyle: React.CSSProperties | undefined = geo
    ? {
        left: geo.cx - (geo.width * k) / 2,
        top: geo.cy + dragDy - (geo.height * k) / 2,
        width: geo.width * k,
        height: geo.height * k,
      }
    : undefined;

  // The bar is wider than the phone's preview: it lives in the stage (the
  // frame clips), placed over the caption box and kept inside the stage.
  const bar = sel ? (
    <div
      ref={barRef}
      className={`${c.bar} ${phone ? c.phone : ""}`}
      role="toolbar"
      aria-label={t("editor.caption.bar")}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="caption-bar"
    >
      <div className={c.seg} role="group" aria-label={t("editor.caption.scope")}>
        <button type="button" aria-pressed={sel.scope === "here"} onClick={() => setScope("here")} data-testid="caption-scope-here">
          {t("editor.caption.here")}
        </button>
        <button type="button" aria-pressed={sel.scope === "all"} onClick={() => setScope("all")} data-testid="caption-scope-all">
          {t("editor.caption.everywhere")}
        </button>
      </div>
      <button type="button" className={c.barBtn} onClick={reset} data-testid="caption-reset">
        <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
        {t("editor.caption.reset")}
      </button>
    </div>
  ) : null;

  return (
    <div ref={boxRef} className={`${c.layer} ${phone ? c.phone : ""}`} data-testid="caption-layer">
      <canvas ref={canvasRef} aria-hidden="true" className={c.canvas} data-testid="caption-canvas" />
      {(sel || props.zones) && (
        <>
          {ZONES.map((z, i) => (
            <span key={i} className={c.zone} style={z} aria-hidden data-testid="caption-zone" />
          ))}
        </>
      )}
      {sel && (
        <>
          <button type="button" className={c.cover} aria-label={t("editor.caption.deselect")} onClick={deselect} data-testid="caption-deselect" />
          {lines.map((l) => (
            <span key={l} className={c.snap} style={{ top: `${l * 100}%` }} data-on={l === shownLine || undefined} aria-hidden />
          ))}
        </>
      )}
      <button
        ref={hitRef}
        type="button"
        hidden
        className={c.hit}
        aria-label={t("editor.caption.select")}
        title={t("editor.caption.selectTip")}
        onClick={select}
        style={sel ? { visibility: "hidden" } : undefined}
        data-testid="caption-hit"
      />
      {sel && geo && cur && (
        <div
          className={c.box}
          style={boxStyle}
          data-dragging={drag ? "" : undefined}
          onPointerDown={(e) => begin("move", e)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          ref={selBoxRef}
          data-testid="caption-box"
          data-own={cur.eff.own || undefined}
        >
          <button
            type="button"
            className={`${c.hdl} ${c.hmove}`}
            aria-label={t("editor.caption.move")}
            title={t("editor.caption.moveTip")}
            ref={moveRef}
            data-handle="move"
            onPointerDown={(e) => begin("move", e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => nudge("move", e)}
            data-testid="caption-move"
          >
            <span className={`${c.knob} ${c.kmove}`} />
          </button>
          <button
            type="button"
            className={`${c.hdl} ${c.hsize}`}
            aria-label={t("editor.caption.size")}
            title={t("editor.caption.sizeTip", { pct: String(pct) })}
            data-handle="size"
            onPointerDown={(e) => begin("size", e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => nudge("size", e)}
            data-testid="caption-size"
          >
            <span className={`${c.knob} ${c.ksize}`} />
          </button>
          {!barHost && bar}
        </div>
      )}
      {barHost && sel && geo && cur && createPortal(bar, barHost)}
      {fontLoading && (
        <span className={c.chip} role="status" data-testid="caption-font-loading">
          {t("editor.caption.fontLoading")}
        </span>
      )}
    </div>
  );
}

export default memo(
  CaptionLayer,
  (a, b) =>
    a.videoRef === b.videoRef &&
    a.doc === b.doc &&
    a.apply === b.apply &&
    a.editSegs === b.editSegs &&
    a.toSource === b.toSource &&
    a.playingSegId === b.playingSegId &&
    a.phone === b.phone &&
    a.zones === b.zones &&
    a.readOnly === b.readOnly,
);
