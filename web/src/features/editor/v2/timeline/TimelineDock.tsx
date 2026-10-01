"use client";
/**
 * Timeline dock (UX7a, restyle of the v1 TimelineEditor with its
 * mechanics: timeline/mechanics.ts, useTimelineZoom, the shared undo
 * history). Opens fitted; uniform clips, violet only when selected;
 * Split / Delete / ⋯ Clip only while a clip is selected; a draggable
 * playhead drawn from the playhead store (no React render per frame).
 * No caption track, no waveform (review G3). Filmstrip thumbnails come
 * with 7b (GET /jobs/{id}/filmstrip).
 *
 * UX10 (+ the owner's iPhone feedback):
 *   - cut seams name their reason (pause, filler word, Cleo cut, the
 *     user's own) by colour; a tap (32 px target) opens what was removed,
 *     how long, and Restore — one undo step, shown in the text too;
 *   - the ruler draws 0.1 s / 0.5 s marks once they are ≥ 6 px apart;
 *   - press and hold a clip (350 ms; mouse or touch), then drag: it lifts,
 *     the others make room, release drops it (one undo step). A tap still
 *     selects; a swipe that moves before the hold still scrolls;
 *   - trims move the edge on a 0.01 s grid with a readout ("3,47 s");
 *     holding still for 0.5 s while trimming zooms in around the handle
 *     (back on release), and from 4 px per frame the frame grid shows
 *     (the v2 export puts edges on the nearest frame).
 */
import { Ellipsis, Minus, Plus, RotateCcw, Scissors, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import type { PlaybackMode } from "@/features/editor/session/useEditSession";
import { gapKind, seamIsCut, type PieceKind } from "@/features/editor/state/cuts";
import { usePlayhead, usePlayheadEffect, type PlayheadState, type PlayheadStore } from "@/features/editor/state/playhead";
import type { TimelineHistory } from "@/features/editor/timeline/history";
import {
  canDelete,
  dropIndex,
  frameEdge,
  trimFrameGrid,
  moveSeg,
  patchSeg,
  playheadCutOf,
  rulerMarks,
  snapTrimToFrame,
  sourceAtCut,
  splittableIndex,
  stripDuration,
  tickShown,
  trimBounds,
  trimToStep,
  type EditorSeg,
} from "@/features/editor/timeline/mechanics";
import { useTimelineZoom } from "@/features/editor/timeline/useTimelineZoom";
import { kbd } from "../hooks";
import { cutDuration, decimalSeparator, fmtClock, fmtSeconds } from "../model";
import { Popover } from "../Popover";
import type { CutsApi } from "../useCuts";
import s from "../editor.module.css";

export type DockApi = { zoomIn: () => void; zoomOut: () => void; fit: () => void };

export type TimelineDockProps = {
  phone: boolean;
  store: PlayheadStore;
  segments: EditorSeg[];
  /** UX10: what each seam removed, and its restore. */
  cuts: CutsApi;
  /** The mezz's frame rate (the frame grid; 30 when unknown). */
  fps?: number | null;
  duration: number;
  history: TimelineHistory;
  selected: string | null;
  setSelected: (id: string | null) => void;
  toSource: (t: number) => number;
  playingSegId: string | null;
  mode: PlaybackMode;
  seekOriginal: (t: number, segId?: string) => void;
  onSplit: () => void;
  onDelete: () => void;
  apiRef: RefObject<DockApi | null>;
};

/** Press-and-hold before a clip lifts for reordering (ms). */
export const HOLD_MS = 350;
/** Movement that turns a press into a scroll / tap instead (px). */
const HOLD_SLOP_PX = 8;
/** A trim moves the edge only once the pointer moved this far: a tap or
 *  jitter on a handle is no trim (review 5). */
const TRIM_SLOP_PX = { mouse: 3, touch: 6 };
/** Phone: how far a trim handle's hit area reaches outside its clip
 *  (the 6 px gap to the neighbour + 2 px; review 5). */
export const PHONE_HANDLE_OUT_PX = 8;

/** Strip seconds of clip `id`'s start or end edge. */
function edgeAt(segs: EditorSeg[], id: string, mode: "start" | "end"): number {
  let acc = 0;
  for (const s of segs) {
    if (s.disabled) continue;
    if (s.id === id) return mode === "start" ? acc : acc + (s.end - s.start);
    acc += s.end - s.start;
  }
  return acc;
}
/** Holding a trim handle still this long zooms in (ms). */
export const MAGNIFY_MS = 500;
/** Zoom of the trim magnifier: 0.01 s = 10 px. */
const MAGNIFY_PPS = 1000;
/** The frame grid shows from this many px per frame. */
const FRAME_GRID_PX = 4;

const KIND_COLOR: Record<PieceKind, string> = {
  silence: "var(--ed-removed)",
  filler: "var(--ed-filler)",
  voice_cmd: "var(--ed-cleo)",
  bad_take: "var(--ed-cleo)",
  user: "var(--ed-text-3)",
};
export const KIND_NAME: Record<PieceKind, MessageKey> = {
  silence: "editor.cutKind.silence",
  filler: "editor.cutKind.filler",
  voice_cmd: "editor.cutKind.voice_cmd",
  bad_take: "editor.cutKind.bad_take",
  user: "editor.cutKind.user",
};

function Cross({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden style={{ display: "block", color }}>
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A boundary between two clips that aren't contiguous footage: x in
 *  cut seconds, a–b the source gap, the clips either side. */
type SeamView = { k: number; x: number; a: number; b: number; prev: string; next: string };

export const TimelineDock = memo(function TimelineDock(p: TimelineDockProps) {
  const t = useT();
  const lang = useLang();
  const dec = decimalSeparator(lang);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // ── trim drag: a local preview, one commit on release ───────────────
  const [dragSegs, setDragSegs] = useState<EditorSeg[] | null>(null);
  const [dragTotal, setDragTotal] = useState<number | null>(null);
  const dragRef = useRef<{
    id: string;
    mode: "start" | "end";
    startSegs: EditorSeg[];
    total: number;
    bounds: ReturnType<typeof trimBounds>;
    last: EditorSeg[];
    /** Pointer x of the last move that counted (hold-still detection). */
    holdX: number;
    clientX: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** The zoom before the magnifier (0 = fit), while magnified. */
    prevPps: number | null;
    /** Pointer x minus the edge's x at the press: the edge never jumps to the finger. */
    grabPx: number;
    x0: number;
    y0: number;
    /** Moved past TRIM_SLOP_PX (or magnified): a trim, not a tap. */
    started: boolean;
    slop: number;
  } | null>(null);
  const [trimming, setTrimming] = useState<{ id: string; mode: "start" | "end" } | null>(null);
  const [boost, setBoost] = useState<number | undefined>(undefined);
  const dragEndedAt = useRef(0);

  // ── reorder: press and hold, then drag ──────────────────────────────
  // The press is followed on the window (the pointer leaves the clip
  // while it moves): a move over HOLD_SLOP_PX before HOLD_MS is a tap
  // that slid or a swipe (the strip scrolls natively), never a drag.
  const holdRef = useRef<{ pointerId: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** Removes the window listeners of the press / drag in progress. */
  const pressOff = useRef<(() => void) | null>(null);
  const [reorder, setReorder] = useState<{
    id: string;
    startSegs: EditorSeg[];
    /** Pointer x minus the clip's left edge, px. */
    grab: number;
    /** The dragged clip's left edge, px in the strip. */
    left: number;
    order: EditorSeg[];
  } | null>(null);
  const reorderRef = useRef(reorder);
  // the handlers read the latest without waiting for a render
  const putReorder = (r: typeof reorder) => {
    reorderRef.current = r;
    setReorder(r);
  };

  const segs = reorder?.order ?? dragSegs ?? p.segments;
  const totalDur = dragTotal ?? stripDuration(reorder ? reorder.startSegs : segs);

  const zoom = useTimelineZoom(scrollRef, totalDur, p.phone, p.phone ? 358 : 1400, boost);
  const { contentW, viewW, effPps, fitPps, maxPps, zoomTo, canZoomOut, lastUserScrollRef } = zoom;
  const pps = contentW / totalDur;

  useImperativeHandle(p.apiRef, () => ({
    zoomIn: () => zoomTo(effPps * 1.5, viewW / 2),
    zoomOut: () => zoomTo(effPps / 1.5, viewW / 2),
    fit: () => zoomTo(fitPps, 0),
  }));

  // the visible part of the strip (ruler marks and the frame grid are drawn there only)
  const [scrollX, setScrollX] = useState(0);
  const scrollRaf = useRef(0);

  // ── the trim magnifier ──────────────────────────────────────────────
  const zoomAnim = useRef(0);
  const animateZoom = useCallback(
    (to: number, anchorClientX: number, done?: () => void) => {
      cancelAnimationFrame(zoomAnim.current);
      const sc = scrollRef.current;
      const from = Math.max(1e-6, (sc?.scrollWidth ?? contentW) / totalDur);
      const target = Math.max(1e-6, to);
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 180);
        const e = 1 - (1 - k) * (1 - k);
        const rect = scrollRef.current?.getBoundingClientRect();
        zoomTo(from * Math.pow(target / from, e), anchorClientX - (rect?.left ?? 0));
        if (k < 1) zoomAnim.current = requestAnimationFrame(step);
        else done?.();
      };
      zoomAnim.current = requestAnimationFrame(step);
    },
    [contentW, totalDur, zoomTo],
  );
  const magnify = () => {
    const d = dragRef.current;
    if (!d || d.prevPps !== null) return;
    d.prevPps = zoom.pps;
    setBoost(MAGNIFY_PPS);
    // the next frame has the raised cap
    requestAnimationFrame(() => {
      const cur = dragRef.current;
      if (cur === d) animateZoom(Math.max(effPps, MAGNIFY_PPS), d.clientX);
    });
  };
  const armMagnify = (d: NonNullable<typeof dragRef.current>) => {
    if (d.timer) clearTimeout(d.timer);
    d.timer = d.prevPps === null ? setTimeout(magnify, MAGNIFY_MS) : null;
  };

  const startTrim = (e: React.PointerEvent, id: string, mode: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const el = stripRef.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startSegs = p.segments.map((x) => ({ ...x }));
    const rect = el.getBoundingClientRect();
    const edgeX = rect.left + (edgeAt(startSegs, id, mode) * rect.width) / totalDur;
    const d = {
      id,
      mode,
      startSegs,
      total: totalDur,
      bounds: trimBounds(startSegs, id, p.duration),
      last: startSegs,
      holdX: e.clientX,
      clientX: e.clientX,
      timer: null,
      prevPps: null,
      grabPx: e.clientX - edgeX,
      x0: e.clientX,
      y0: e.clientY,
      started: false,
      slop: e.pointerType === "mouse" ? TRIM_SLOP_PX.mouse : TRIM_SLOP_PX.touch,
    };
    dragRef.current = d;
    armMagnify(d);
    setDragTotal(totalDur);
    setDragSegs(startSegs);
    setTrimming({ id, mode });
  };
  const moveTrim = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = stripRef.current;
    if (!d || !el) return;
    if (!d.started) {
      // magnified (held still): every move counts, it is a precise trim
      if (d.prevPps === null && Math.abs(e.clientX - d.x0) < d.slop) return;
      d.started = true;
    }
    // from the strip as laid out now: the magnifier changes the zoom mid-drag;
    // the edge keeps its distance to the finger (no jump on the first move)
    const rect = el.getBoundingClientRect();
    const seconds = (e.clientX - d.grabPx - rect.left) / (rect.width / d.total);
    d.last = trimToStep(d.startSegs, d.id, d.mode, seconds, d.bounds);
    d.clientX = e.clientX;
    setDragSegs(d.last);
    if (Math.abs(e.clientX - d.holdX) > 3) {
      d.holdX = e.clientX;
      armMagnify(d);
    }
  };
  const endTrim = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.timer) clearTimeout(d.timer);
    setDragSegs(null);
    setDragTotal(null);
    setTrimming(null);
    const tap = !d.started && d.prevPps === null;
    if (tap) {
      // no trim: no undo step; a tap on the part of the handle outside
      // the clip is a tap on what is there (the neighbour) (review 5)
      if (e.type === "pointerup") tapThrough(e.clientX, e.clientY, e.timeStamp);
    } else {
      dragEndedAt.current = e.timeStamp;
      // the system took the gesture (a scroll): nothing is committed
      if (e.type !== "pointercancel") {
        // on release the edge moves to the frame both exports cut at (≤ half a frame)
        p.history.commit(snapTrimToFrame(d.last, d.id, d.mode, d.bounds, p.fps));
      }
    }
    if (d.prevPps !== null) {
      // back to the zoom before the magnifier, around the handle
      const prev = d.prevPps;
      animateZoom(prev > 0 ? prev : fitPps, e.clientX, () => setBoost(undefined));
    }
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(zoomAnim.current);
      cancelAnimationFrame(scrollRaf.current);
      if (dragRef.current?.timer) clearTimeout(dragRef.current.timer);
      if (holdRef.current) clearTimeout(holdRef.current.timer);
      pressOff.current?.();
    },
    [],
  );

  // ── reorder handlers ────────────────────────────────────────────────
  const cancelHold = () => {
    const h = holdRef.current;
    if (h) clearTimeout(h.timer);
    holdRef.current = null;
  };
  const moveReorder = (clientX: number) => {
    const r = reorderRef.current;
    const strip = stripRef.current;
    const sc = scrollRef.current;
    if (!r || !strip || !sc) return;
    // near an edge of the view: scroll along
    const vr = sc.getBoundingClientRect();
    if (clientX < vr.left + 24) sc.scrollLeft -= 8;
    else if (clientX > vr.right - 24) sc.scrollLeft += 8;
    const rect = strip.getBoundingClientRect();
    const left = clientX - rect.left - r.grab;
    const pxs = rect.width / totalDur;
    const seg = r.startSegs.find((x) => x.id === r.id);
    if (!seg) return;
    const center = (left + ((seg.end - seg.start) * pxs) / 2) / pxs;
    const order = moveSeg(r.startSegs, r.id, dropIndex(r.startSegs, r.id, center));
    putReorder({ ...r, left, order: order === r.startSegs ? r.startSegs : order });
  };
  const dropReorder = (timeStamp: number, cancelled: boolean) => {
    const r = reorderRef.current;
    if (!r) return;
    putReorder(null);
    dragEndedAt.current = timeStamp;
    // one undo step; a cancelled gesture (the system took it) drops nothing
    if (!cancelled && r.order !== r.startSegs) p.history.commit(r.order);
    p.setSelected(r.id);
  };
  const clipPointerDown = (e: React.PointerEvent, seg: EditorSeg) => {
    // a second finger (a pinch) never arms a hold of its own (review 7)
    if (e.button !== 0 || reorderRef.current || !e.isPrimary) return;
    cancelHold();
    pressOff.current?.();
    const el = e.currentTarget as HTMLElement;
    const { pointerId, clientX: x0, clientY: y0 } = e;
    const touch = e.pointerType !== "mouse";
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (reorderRef.current) moveReorder(ev.clientX);
      else if (holdRef.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) > HOLD_SLOP_PX) {
        cancelHold();
        off();
      }
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cancelHold();
      off();
      dropReorder(ev.timeStamp, ev.type === "pointercancel");
    };
    // Another finger down anywhere (a pinch-zoom starting): no hold, no
    // lift; a lifted clip goes back, nothing is committed (review 7).
    const onOther = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) return;
      cancelHold();
      off();
      if (reorderRef.current) dropReorder(ev.timeStamp, true);
    };
    const off = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("pointerdown", onOther, true);
      if (pressOff.current === off) pressOff.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("pointerdown", onOther, true);
    pressOff.current = off;
    const timer = setTimeout(() => {
      holdRef.current = null;
      const strip = stripRef.current;
      if (!strip || !el.isConnected) {
        off();
        return;
      }
      const rect = strip.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (touch) navigator.vibrate?.(10);
      putReorder({ id: seg.id, startSegs: p.segments, grab: x0 - box.left, left: box.left - rect.left, order: p.segments });
    }, HOLD_MS);
    holdRef.current = { pointerId, timer };
  };
  // While a clip is lifted, a touch move drags it instead of scrolling.
  // Registered for good (not when the lift starts): a touch sequence
  // only stays cancelable if a blocking listener was there at its start.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const stop = (ev: TouchEvent) => {
      if (reorderRef.current && ev.cancelable) ev.preventDefault();
    };
    sc.addEventListener("touchmove", stop, { passive: false });
    return () => sc.removeEventListener("touchmove", stop);
  }, []);

  /** A click on a clip selects it and seeks to the clicked point (not its
   *  start), so Split right after works there — not right after a trim. */
  const onClip = (seg: EditorSeg, fraction: number, timeStamp: number) => {
    p.setSelected(seg.id);
    if (timeStamp - dragEndedAt.current < 300) return;
    const d = seg.end - seg.start;
    p.seekOriginal(Math.max(seg.start, Math.min(seg.end - 0.05, seg.start + fraction * d)), seg.id);
  };

  /** A tap on a trim handle that didn't trim: what lies under the point
   *  besides the handle gets it — the selected clip (a seek there), the
   *  neighbour clip (select + seek) or a seam (review 5). */
  const tapThrough = (x: number, y: number, timeStamp: number) => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest("[data-testid^='clip-trim-']")) continue;
      const seam = el.closest<HTMLElement>("[data-testid=ed-seam]");
      if (seam) {
        seam.click();
        return;
      }
      const clipEl = el.closest<HTMLElement>("[data-seg]");
      if (!clipEl) continue;
      const seg = p.segments.find((s) => s.id === clipEl.dataset.seg);
      if (!seg) return;
      const r = clipEl.getBoundingClientRect();
      onClip(seg, r.width > 0 ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0, timeStamp);
      return;
    }
  };

  // ── seeking ─────────────────────────────────────────────────────────
  const scrubbing = useRef(false);
  const seekAtX = (clientX: number) => {
    const el = stripRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cut = Math.max(0, Math.min(totalDur, ((clientX - rect.left) / rect.width) * totalDur));
    const at = sourceAtCut(p.segments, cut);
    if (at) p.seekOriginal(at.t, at.segId);
  };
  const scrubHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbing.current = true;
      lastUserScrollRef.current = 0;
      seekAtX(e.clientX);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (scrubbing.current) seekAtX(e.clientX);
    },
    onPointerUp: () => {
      scrubbing.current = false;
    },
    onPointerCancel: () => {
      scrubbing.current = false;
    },
  };

  // ── playhead: DOM writes from the store ─────────────────────────────
  const playheadRef = useRef<HTMLDivElement>(null);
  const layout = useRef({ segs, pps, contentW, canZoomOut, dragging: false });
  useEffect(() => {
    layout.current = { segs, pps, contentW, canZoomOut, dragging: dragSegs !== null || reorder !== null };
  });
  const { toSource, segments: committed } = p;
  const segId = p.mode === "proxy" ? p.playingSegId : null;
  const drawPlayhead = useCallback(
    (st: PlayheadState) => {
      const el = playheadRef.current;
      if (!el) return;
      const L = layout.current;
      const cut = playheadCutOf(L.segs, toSource(st.mediaTime), segId);
      if (cut === null) {
        el.style.visibility = "hidden";
        return;
      }
      const x = Math.min(L.contentW, cut * L.pps);
      el.style.visibility = "visible";
      el.style.transform = `translateX(${x}px)`;
      // Keep the playhead in view while it moves — unless the user just
      // scrolled or zoomed by hand.
      const sc = scrollRef.current;
      if (!sc || !L.canZoomOut || L.dragging || !st.playing) return;
      if (Date.now() - lastUserScrollRef.current < 2500) return;
      if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) {
        sc.scrollTo({ left: Math.max(0, x - sc.clientWidth / 3), behavior: "smooth" });
      }
    },
    [toSource, segId, lastUserScrollRef],
  );
  usePlayheadEffect(p.store, drawPlayhead);
  // re-place after a layout change (zoom, edit) without a new frame
  useEffect(() => {
    drawPlayhead(p.store.getState());
  }, [contentW, segs, drawPlayhead, p.store]);

  // ── selection tools ─────────────────────────────────────────────────
  const selSeg = p.selected ? p.segments.find((x) => x.id === p.selected && !x.disabled) : undefined;
  const canSplitSel = useMemo(
    () => (st: PlayheadState) => splittableIndex(committed, toSource(st.mediaTime)) !== -1,
    [committed, toSource],
  );
  const canSplit = usePlayhead(p.store, canSplitSel);
  const clipBtn = useRef<HTMLButtonElement>(null);
  const [clipMenuFor, setClipMenuFor] = useState<string | null>(null);
  const clipMenu = !!selSeg && clipMenuFor === selSeg.id;
  const setClipMenu = (open: boolean | ((o: boolean) => boolean)) =>
    setClipMenuFor(() => {
      const next = typeof open === "function" ? open(clipMenu) : open;
      return next && selSeg ? selSeg.id : null;
    });

  const btn = p.phone ? s.mb : s.gb;
  const icon = p.phone ? 18 : 16;
  const tools = selSeg ? (
    <>
      <button
        type="button"
        className={btn}
        aria-disabled={!canSplit}
        title={canSplit ? t("editor.splitTip") : t("app.timeline.splitUnavailable")}
        onClick={p.onSplit}
        data-testid="ed-split"
      >
        <Scissors size={icon} strokeWidth={1.75} aria-hidden />
        {t("editor.split")}
      </button>
      <button
        type="button"
        className={btn}
        title={t("editor.deleteTip")}
        onClick={p.onDelete}
        disabled={!canDelete(p.segments, selSeg.id)}
        data-testid="ed-delete"
      >
        <Trash2 size={icon} strokeWidth={1.75} aria-hidden />
        {t("editor.delete")}
      </button>
      <button
        ref={clipBtn}
        type="button"
        className={btn}
        aria-haspopup="dialog"
        aria-expanded={clipMenu}
        title={t("editor.clipTip")}
        onClick={() => setClipMenu((m) => !m)}
        data-testid="ed-clip-menu"
      >
        <Ellipsis size={icon} strokeWidth={1.75} aria-hidden />
        {t("editor.clip")}
      </button>
      {clipMenu && (
        <Popover
          anchor={clipBtn}
          onClose={() => setClipMenu(false)}
          label={t("editor.clipTip")}
          placement="above"
          width={352}
          testId="ed-clip-popover"
        >
          <ClipControls seg={selSeg} segments={p.segments} history={p.history} />
        </Popover>
      )}
    </>
  ) : null;

  // zoom slider: log scale between fit and max
  const zoomRange = Math.log(Math.max(maxPps / fitPps, 1.0001));
  const zoomVal = Math.round((Math.log(effPps / fitPps) / zoomRange) * 100) || 0;

  const { clips, seamViews } = useMemo(() => {
    const out: { seg: EditorSeg; i: number; left: number; width: number; padL: number; padR: number }[] = [];
    const sv: SeamView[] = [];
    const act = segs.filter((x) => !x.disabled);
    let acc = 0;
    let k = 0;
    segs.forEach((seg, i) => {
      if (seg.disabled) return;
      const d = seg.end - seg.start;
      const prev = k > 0 ? act[k - 1] : null;
      const next = act[k + 1] ?? null;
      const cutBefore = !!prev && Math.abs(seg.start - prev.end) > 0.02;
      const cutAfter = !!next && Math.abs(next.start - seg.end) > 0.02;
      out.push({
        seg,
        i,
        left: acc,
        width: d,
        padL: prev ? (cutBefore ? 3 : 1) : 0,
        padR: next ? (cutAfter ? 3 : 1) : 0,
      });
      acc += d;
      if (next && cutAfter) {
        // a ≥ b: a reordered pair (no footage removed between them)
        sv.push({ k: sv.length, x: acc, a: seg.end, b: next.start, prev: seg.id, next: next.id });
      }
      k++;
    });
    return { clips: out, seamViews: sv };
  }, [segs]);
  const pieces = p.cuts.pieces;
  const seamKinds = useMemo(
    // a seam that jumps across a clip playing elsewhere (a reorder) is a
    // move, not a cut: drawn as one, no kind, no Restore (review 2/8)
    () => seamViews.map((v) => (seamIsCut(segs, v.a, v.b) ? gapKind(pieces, v.a, v.b) : null)),
    [seamViews, pieces, segs],
  );
  const legendKinds = useMemo(() => {
    const present = new Set<PieceKind>();
    for (const k of seamKinds) if (k) present.add(k === "bad_take" ? "voice_cmd" : k);
    return (["silence", "filler", "voice_cmd", "user"] as PieceKind[]).filter((k) => present.has(k));
  }, [seamKinds]);
  const legend = (
    <div className={s.legend} data-testid="ed-legend">
      {(legendKinds.length ? legendKinds : (["silence"] as PieceKind[])).map((k) => (
        <span key={k} className={s.legendItem}>
          <Cross color={KIND_COLOR[k]} />
          {legendKinds.length ? t(KIND_NAME[k]) : t("editor.legend.cut")}
        </span>
      ))}
    </div>
  );

  // ── seam popover: what was removed, and Restore ─────────────────────
  const [seamOpen, setSeamOpen] = useState<{ a: number; b: number; kind: PieceKind } | null>(null);
  const seamAnchor = useRef<HTMLElement | null>(null);
  /** What had focus before a seam was pressed (focus goes back there after Restore). */
  const seamPrevFocus = useRef<HTMLElement | null>(null);
  const restoreSeam = () => {
    if (!seamOpen) return;
    p.cuts.restore([{ start: seamOpen.a, end: seamOpen.b }]);
    setSeamOpen(null);
    // The restored seam is gone; never leave focus on another seam button
    // (Space would open its popover, single-key shortcuts would stop):
    // back to what had it before, else nowhere (review 9).
    setTimeout(() => {
      const isSeam = (el: Element | null) => !!el?.closest?.("[data-testid=ed-seam]");
      const ae = document.activeElement;
      if (ae && ae !== document.body && !isSeam(ae)) return;
      const prev = seamPrevFocus.current;
      seamPrevFocus.current = null;
      if (prev && prev.isConnected && prev !== document.body && !isSeam(prev)) prev.focus({ preventScroll: true });
      else (ae as HTMLElement | null)?.blur?.();
    }, 0);
  };

  const { marks, labelStep } = rulerMarks(scrollX, contentW, totalDur, viewW, p.phone ? 48 : 64);

  // the frame grid: while trimming, around the visible part of the trimmed clip
  const fps = p.fps && p.fps > 0 ? p.fps : 0;
  const frameLines = useMemo(() => {
    if (!trimming || !fps || pps / fps < FRAME_GRID_PX) return [];
    const c = clips.find((x) => x.seg.id === trimming.id);
    if (!c) return [];
    const lo = (scrollX - 40) / pps;
    const hi = (scrollX + viewW + 40) / pps;
    // the clip's own footage plus what a trim can grow into on the moving
    // side, counted from the visible window (mechanics.trimFrameGrid)
    return trimFrameGrid({ left: c.left, start: c.seg.start, end: c.seg.end }, trimming.mode, lo, hi, fps).map(
      (x) => x * pps,
    );
  }, [trimming, pps, fps, clips, scrollX, viewW]);
  const readout = (() => {
    if (!trimming) return null;
    const c = clips.find((x) => x.seg.id === trimming.id);
    if (!c) return null;
    const edge = trimming.mode === "start" ? c.seg.start : c.seg.end;
    const x = (trimming.mode === "start" ? c.left : c.left + c.width) * pps;
    // the value the export uses: the edge's frame (the handle itself moves in 0.01 s)
    const used = frameEdge(edge, fps);
    return { x, text: `${used.toFixed(2).replace(".", dec)} s` };
  })();
  const magnified = boost !== undefined;

  const strip = (
    <div
      ref={scrollRef}
      className={s.strip}
      data-testid="timeline-scroll"
      data-magnified={magnified || undefined}
      onScroll={(e) => {
        if (!scrubbing.current) lastUserScrollRef.current = Date.now();
        const x = e.currentTarget.scrollLeft;
        cancelAnimationFrame(scrollRaf.current);
        scrollRaf.current = requestAnimationFrame(() => setScrollX(x));
      }}
    >
      <div className={s.stripInner} style={{ width: contentW }}>
        <div className={s.ruler} data-testid="timeline-ruler" {...scrubHandlers}>
          {marks.map((m) =>
            !tickShown(m.kind, pps) ? null : (
              <span
                key={m.t}
                className={s.tick}
                data-kind={m.kind}
                style={{
                  left: m.x,
                  height: m.kind === "major" ? 7 : m.kind === "second" ? 4 : m.kind === "half" ? 3 : 2,
                  background:
                    m.kind === "major"
                      ? "rgba(255,255,255,.26)"
                      : m.kind === "second"
                        ? "rgba(255,255,255,.12)"
                        : "rgba(255,255,255,.09)",
                }}
              />
            ),
          )}
          {marks
            .filter((m) => m.kind === "major" && m.x < contentW - 24)
            .map((m) => (
              <span key={`l${m.t}`} className={`${s.mono} ${s.tickLabel}`} style={{ left: m.x }}>
                {labelStep < 1 ? m.t.toFixed(1).replace(".", dec) : fmtClock(m.t)}
              </span>
            ))}
        </div>
        <div ref={stripRef} className={s.clips} data-reordering={reorder ? true : undefined}>
          {clips.map(({ seg, i, left, width, padL, padR }) => {
            const lifted = reorder?.id === seg.id;
            return (
              <ClipView
                key={seg.id}
                seg={seg}
                index={i}
                selected={seg.id === p.selected}
                lifted={lifted}
                left={lifted ? reorder.left : left * pps + padL}
                width={Math.max(2, width * pps - padL - padR)}
                title={`${t("editor.clipTitle", { n: i + 1, len: fmtSeconds(seg.end - seg.start, dec) })} · ${t("editor.clip.moveHint")}`}
                onClip={onClip}
                onPress={clipPointerDown}
                onTrimStart={startTrim}
                onTrimMove={moveTrim}
                onTrimEnd={endTrim}
              />
            );
          })}
          {frameLines.map((x) => (
            <span key={x} className={s.frameLine} style={{ left: x }} aria-hidden />
          ))}
          {!reorder &&
            seamViews.map((v) => {
              const kind = seamKinds[v.k];
              if (!kind) {
                // a reordered boundary: no footage removed here
                return <span key={`m${v.k}`} className={s.seamMoved} style={{ left: v.x * pps }} aria-hidden />;
              }
              const len = fmtSeconds(v.b - v.a, dec);
              const label = t("editor.seam.label", { kind: t(KIND_NAME[kind]), len });
              // next to a selected clip its trim handles win
              const nearSel = p.selected === v.prev || p.selected === v.next;
              return (
                <button
                  // by the clips it joins: a restored seam's button goes
                  // (an index key handed it to the next seam)
                  key={`${v.prev}>${v.next}`}
                  type="button"
                  className={s.seam}
                  data-seam={kind}
                  data-testid="ed-seam"
                  tabIndex={-1}
                  style={{ left: v.x * pps, pointerEvents: nearSel ? "none" : undefined }}
                  title={label}
                  aria-label={label}
                  aria-haspopup="dialog"
                  onPointerDown={() => {
                    seamPrevFocus.current = document.activeElement as HTMLElement | null;
                  }}
                  onClick={(e) => {
                    seamAnchor.current = e.currentTarget;
                    setSeamOpen({ a: v.a, b: v.b, kind });
                  }}
                >
                  <span className={s.seamLine} style={{ background: KIND_COLOR[kind], opacity: 0.35 }} />
                  <span className={s.seamGlyph}>
                    <Cross color={KIND_COLOR[kind]} />
                  </span>
                </button>
              );
            })}
          {readout && (
            <span className={`${s.mono} ${s.trimReadout}`} style={{ left: readout.x }} data-testid="ed-trim-readout">
              {readout.text}
            </span>
          )}
        </div>
        <div ref={playheadRef} className={s.playhead} aria-hidden data-testid="ed-playhead">
          <div className={s.playheadLine} />
          <div className={s.playheadGrab} {...scrubHandlers}>
            <svg viewBox="0 0 12 14" width="12" height="14">
              <path
                d="M1.5 0.5 H10.5 A1 1 0 0 1 11.5 1.5 V8.4 L6 13.4 L0.5 8.4 V1.5 A1 1 0 0 1 1.5 0.5 Z"
                fill="#FFFFFF"
                stroke="#0D0D10"
                strokeOpacity={0.6}
              />
            </svg>
          </div>
        </div>
      </div>
      {seamOpen && (
        <Popover
          anchor={seamAnchor}
          onClose={() => setSeamOpen(null)}
          label={t(KIND_NAME[seamOpen.kind])}
          placement="above"
          width={260}
          testId="ed-seam-popover"
        >
          <div className={s.seamPop}>
            <div className={s.seamPopHead}>
              <Cross color={KIND_COLOR[seamOpen.kind]} />
              <span>{t(KIND_NAME[seamOpen.kind])}</span>
            </div>
            <div className={s.seamPopText}>
              {t("editor.seam.removed", { len: fmtSeconds(seamOpen.b - seamOpen.a, dec) })}
            </div>
            <button type="button" className={s.mi} onClick={restoreSeam} data-testid="ed-seam-restore">
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
              <span>{t("editor.seam.restore")}</span>
            </button>
          </div>
        </Popover>
      )}
    </div>
  );

  if (p.phone) {
    return (
      <section className={s.dock} aria-label={t("editor.timeline")} data-testid="ed-timeline">
        <div className={s.phoneCtx}>{tools}</div>
        {strip}
        <div className={s.phoneLegend}>
          {legend}
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className={`${s.mono} ${s.cutsFrom}`}>{fmtClock(p.duration)}</span>
            <span aria-hidden style={{ color: "var(--ed-text-3)" }}>→</span>
            <span className={`${s.mono} ${s.cutsTo}`}>{fmtClock(cutDuration(p.segments))}</span>
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className={s.dock} aria-label={t("editor.timeline")} data-testid="ed-timeline">
      <div className={s.dockBar}>
        {tools ?? legend}
        <span className={s.flex1} />
        {canZoomOut && (
          <button
            type="button"
            className={s.gb}
            title={t("editor.fitTip").replace("⇧Z", kbd("⇧Z"))}
            onClick={() => zoomTo(fitPps, 0)}
            data-testid="timeline-zoom-fit"
          >
            {t("app.timeline.fit")}
          </button>
        )}
        <div className={s.zoomBox}>
          <Minus size={14} strokeWidth={1.75} aria-hidden />
          <input
            type="range"
            className={`${s.range} ${s.zoom}`}
            min={0}
            max={100}
            step={1}
            value={Math.max(0, Math.min(100, zoomVal))}
            aria-label={t("editor.zoom")}
            title={t("editor.zoomTip")}
            data-testid="ed-zoom"
            onChange={(e) => zoomTo(fitPps * Math.exp((Number(e.target.value) / 100) * zoomRange), viewW / 2)}
          />
          <Plus size={14} strokeWidth={1.75} aria-hidden />
        </div>
      </div>
      {strip}
    </section>
  );
});

function ClipView({
  seg,
  index,
  selected,
  lifted,
  left,
  width,
  title,
  onClip,
  onPress,
  onTrimStart,
  onTrimMove,
  onTrimEnd,
}: {
  seg: EditorSeg;
  index: number;
  selected: boolean;
  lifted: boolean;
  left: number;
  width: number;
  title: string;
  onClip: (seg: EditorSeg, fraction: number, timeStamp: number) => void;
  onPress: (e: React.PointerEvent, seg: EditorSeg) => void;
  onTrimStart: (e: React.PointerEvent, id: string, mode: "start" | "end") => void;
  onTrimMove: (e: React.PointerEvent) => void;
  onTrimEnd: (e: React.PointerEvent) => void;
}) {
  const d = seg.end - seg.start;
  const fi = seg.fadeIn ? Math.min(50, (seg.fadeIn / Math.max(d, 0.01)) * 100) : 0;
  const fo = seg.fadeOut ? Math.min(50, (seg.fadeOut / Math.max(d, 0.01)) * 100) : 0;
  const speed = seg.speed ?? 1;
  const volume = seg.volume ?? 1;
  return (
    <div
      className={s.clip}
      data-selected={selected}
      data-lifted={lifted || undefined}
      data-testid={`clip-${index}`}
      data-seg={seg.id}
      title={title}
      // --hin: how far a phone trim handle reaches into the clip — at most
      // 36 px, always leaving a 12 px body to tap / long-press (review 5)
      style={{ left, width, ["--hin" as string]: `${Math.max(4, Math.min(36, (width - 12) / 2))}px` }}
      onPointerDown={(e) => onPress(e, seg)}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onClip(seg, r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0, e.timeStamp);
      }}
    >
      <div className={s.clipBody}>
        {fi > 0 && (
          <div
            className={s.fadeRamp}
            style={{ left: 0, width: `${fi}%`, background: "linear-gradient(90deg, rgba(0,0,0,.6), transparent)" }}
          />
        )}
        {fo > 0 && (
          <div
            className={s.fadeRamp}
            style={{ right: 0, width: `${fo}%`, background: "linear-gradient(270deg, rgba(0,0,0,.6), transparent)" }}
          />
        )}
        {width > 56 && (speed !== 1 || volume !== 1) && (
          <span className={s.clipBadge}>
            {speed !== 1 && <span className={`${s.badge} ${s.mono}`}>{speed}×</span>}
            {volume !== 1 && <span className={`${s.badge} ${s.mono}`}>{Math.round(volume * 100)}%</span>}
          </span>
        )}
      </div>
      <div className={s.clipRing} />
      {selected &&
        (["start", "end"] as const).map((m) => (
          <div
            key={m}
            className={s.handle}
            style={m === "start" ? { left: -2 } : { right: -2 }}
            data-testid={`clip-trim-${m}`}
            onPointerDown={(e) => onTrimStart(e, seg.id, m)}
            onPointerMove={onTrimMove}
            onPointerUp={onTrimEnd}
            onPointerCancel={onTrimEnd}
            onClick={(e) => e.stopPropagation()}
          >
            <span />
          </div>
        ))}
    </div>
  );
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/** ⋯ Clip: speed, volume + mute, fades, reset (plan ClipPopover). */
function ClipControls({ seg, segments, history }: { seg: EditorSeg; segments: EditorSeg[]; history: TimelineHistory }) {
  const t = useT();
  const patch = (x: Partial<EditorSeg>) =>
    history.commit(patchSeg(segments, seg.id, x), `${seg.id}:${Object.keys(x).sort().join(",")}`);
  const vol = seg.volume ?? 1;
  return (
    <div style={{ padding: "4px 0" }}>
      <div className={s.popRow}>
        <span className={s.popRowLabel}>{t("app.timeline.speed")}</span>
        <div className={s.seg} role="group" aria-label={t("app.timeline.speed")}>
          {SPEEDS.map((v) => (
            <button
              key={v}
              type="button"
              className={`${s.segBtn} ${s.mono}`}
              aria-pressed={(seg.speed ?? 1) === v}
              onClick={() => patch({ speed: v })}
            >
              {v}×
            </button>
          ))}
        </div>
      </div>
      <div className={s.popRow}>
        <span className={s.popRowLabel}>{t("app.timeline.volume")}</span>
        <input
          type="range"
          className={s.range}
          min={0}
          max={2.5}
          step={0.05}
          value={vol}
          aria-label={t("app.timeline.volume")}
          onChange={(e) => patch({ volume: Number(e.target.value) })}
        />
        <span className={`${s.popValue} ${s.mono}`}>{Math.round(vol * 100)}%</span>
        <button
          type="button"
          className={`${s.gb} ${s.sm}`}
          aria-label={t("editor.clip.mute")}
          aria-pressed={vol === 0}
          title={t("editor.clip.mute")}
          onClick={() => patch({ volume: vol === 0 ? 1 : 0 })}
        >
          <X size={12} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {(["fadeIn", "fadeOut"] as const).map((k) => (
        <div className={s.popRow} key={k}>
          <span className={s.popRowLabel}>{t(k === "fadeIn" ? "app.timeline.fadeIn" : "app.timeline.fadeOut")}</span>
          <input
            type="range"
            className={s.range}
            min={0}
            max={2}
            step={0.1}
            value={seg[k] ?? 0}
            aria-label={t(k === "fadeIn" ? "app.timeline.fadeIn" : "app.timeline.fadeOut")}
            onChange={(e) => patch({ [k]: Number(e.target.value) })}
          />
          <span className={`${s.popValue} ${s.mono}`}>{(seg[k] ?? 0).toFixed(1)} s</span>
        </div>
      ))}
      <div className={s.msep} />
      <button type="button" className={s.mi} onClick={() => patch({ speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 })}>
        {t("app.timeline.resetEffects")}
      </button>
    </div>
  );
}
