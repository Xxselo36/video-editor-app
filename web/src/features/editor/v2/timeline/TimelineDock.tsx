"use client";
/**
 * Timeline dock (UX7a, restyle of the v1 TimelineEditor with its
 * mechanics: timeline/mechanics.ts, useTimelineZoom, the shared undo
 * history). Opens fitted — an edit longer than a minute opens showing
 * its first minute (OPEN_SPAN_S, owner: a 10-min video at Fit is a blur
 * of 2 px clips); uniform clips, violet only when selected;
 * Split / Delete / ⋯ Clip only while a clip is selected; a draggable
 * playhead drawn from the playhead store (no React render per frame).
 * No caption track, no waveform (review G3). Each clip shows the
 * filmstrip frames of its own source range (UX7b, Filmstrip.tsx: GET
 * /jobs/{id}/filmstrip), drawn for the visible window only.
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
 *     holding still for 0.5 s while trimming zooms in around the edge
 *     (back on release), and from 4 px per frame the frame grid shows
 *     (the v2 export puts edges on the nearest frame).
 *
 * The trim flow round (owner: "Länge anpassen" must feel direct):
 *   - both handles stay under the finger (a start trim draws its clip
 *     shifted until release, mechanics.stripLayout), the magnifier zooms
 *     around the edge (not the pointer), and after release the edge
 *     stays where it was let go (the strip closes up around it; at Fit
 *     the zoom is held instead of re-fitting under the finger);
 *   - near the view's edge a trim scrolls the strip along;
 *   - a hold or a drag that ends where it started commits nothing (no
 *     undo step, no save, no preview rebuild);
 *   - a phone handle reaches at most half into a short clip, so a short
 *     clip's start handle is never under its end handle.
 */
import { Ellipsis, Minus, Plus, RotateCcw, Scissors, Trash2, X } from "lucide-react";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import type { PlaybackMode } from "@/features/editor/session/useEditSession";
import { gapKind, seamIsCut, type PieceKind } from "@/features/editor/state/cuts";
import { usePlayhead, usePlayheadEffect, type PlayheadState, type PlayheadStore } from "@/features/editor/state/playhead";
import type { TimelineHistory } from "@/features/editor/timeline/history";
import {
  canDelete,
  dropIndex,
  exactFps,
  frameEdge,
  trimFrameGrid,
  moveSeg,
  patchSeg,
  MIN_CLIP_S,
  playheadCutOf,
  releasedTrim,
  rulerMarks,
  snapRadiusS,
  seamTapClip,
  snapTrimToFrame,
  sourceAtCut,
  splittableIndex,
  stripDuration,
  stripLayout,
  tickShown,
  trimBounds,
  trimRemoves,
  trimToStep,
  type EditorSeg,
} from "@/features/editor/timeline/mechanics";
import { useTimelineZoom } from "@/features/editor/timeline/useTimelineZoom";
import { kbd } from "../hooks";
import { cutDuration, decimalSeparator, fmtClock, fmtSeconds } from "../model";
import { Popover } from "../Popover";
import { Filmstrip, type FilmSource } from "./Filmstrip";
import { filmWindow } from "./filmstrip";
import type { CutsApi } from "../useCuts";
import s from "../editor.module.css";

export type DockApi = { zoomIn: () => void; zoomOut: () => void; fit: () => void };

export type TimelineDockProps = {
  phone: boolean;
  store: PlayheadStore;
  segments: EditorSeg[];
  /** UX10: what each seam removed, and its restore. */
  cuts: CutsApi;
  /** A trim / extension of one clip committed (backlog #20: its revealed footage may get text). */
  onTrimmed?: () => void;
  /** The mezz's frame rate (the frame grid; 30 when unknown). */
  fps?: number | null;
  /** UX7b: the loaded filmstrip sprite (null: plain clips). */
  film?: FilmSource | null;
  duration: number;
  history: TimelineHistory;
  selected: string | null;
  setSelected: (id: string | null) => void;
  toSource: (t: number) => number;
  /** The clip the proxy player is in (read per frame, no render). */
  playingSeg: () => string | null;
  mode: PlaybackMode;
  seekOriginal: (t: number, segId?: string) => void;
  /** drag-9: show source time t (a trim edge being dragged); null when let go (`restore`: a cancelled trim). */
  onScrub?: (t: number | null, opts?: { restore?: boolean }) => void;
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

/**
 * How far a seam's hit area reaches to one side (px): the 3 px of the gap
 * plus at most 13 px into the clip there — only as far as the clip keeps
 * a 24 px body between its two seams (review 6: on the phone at fit zoom
 * a short clip was all seam, it could not be tapped or held). 16 + 16 =
 * the full 32 px target next to clips of 50 px and more.
 */
export function seamReach(clipPx: number): number {
  return 3 + Math.min(13, Math.max(0, (clipPx - 24) / 2));
}

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
/** An edit longer than this opens showing only its first OPEN_SPAN_S (owner request). */
export const OPEN_SPAN_S = 60;
/** Test builds (NEXT_PUBLIC_TEST_PAGES=1): the e2e clips are 30 s, so a
 *  suite sets a shorter opening span in localStorage. */
function openSpan(): number {
  if (process.env.NEXT_PUBLIC_TEST_PAGES !== "1") return OPEN_SPAN_S;
  try {
    const v = Number(localStorage.getItem("cleocuts.test.openSpanS"));
    return v > 0 ? v : OPEN_SPAN_S;
  } catch {
    return OPEN_SPAN_S;
  }
}
/** A trim this close to the view's edge scrolls the strip along (px). */
const EDGE_SCROLL_PX = 24;
/** Holding a trim handle still this long zooms in (ms). */
export const MAGNIFY_MS = 500;
/** Zoom of the trim magnifier: 0.01 s = 10 px. */
const MAGNIFY_PPS = 1000;
/** The frame grid shows from this many px per frame. */
const FRAME_GRID_PX = 4;
/** A released trim edge inside a word goes to the gap next to it within this far on screen (drag-9/13), at most WORD_SNAP_MAX_S. */
const WORD_SNAP_PX = 12;
const WORD_SNAP_MAX_S = 0.25;
/**
 * A clip drawn narrower than this (px) is "tiny": it has hardly a body left
 * to tap between its seams' hit areas (3 px into it each, seamReach), so a
 * tap on a seam's part over it is for the clip (drag-6). Wider ones are
 * tapped on their body, and a seam tap is Restore (phone-tiny-seam: at 24
 * px, at the phone's opening zoom of a long edit nearly every seam
 * selected a clip). With a mouse, narrower still.
 */
export const TINY_CLIP_PX = 12;
const TINY_CLIP_PX_MOUSE = 10;
/** The settle after a released trim (FLIP from where things were drawn at
 *  the release): a beat with everything where it was let go, then the
 *  brand's ease-out into place. */
const SETTLE_DELAY_MS = 140;
const SETTLE_MS = 240;
const SETTLE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const SETTLE_ID = "ed-settle";
/** At most this many clips (and as many seams) settle: the nearest to the released edge. */
const SETTLE_MAX = 24;
/** Runs `fn` once the next frame has been painted. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** A dragged trim edge's frame: one seek at most this often (ms). */
const SCRUB_MS = 90;

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

type ClipLay = { seg: EditorSeg; i: number; left: number; width: number; padL: number; padR: number };

/** The strip's clips (cut seconds) and seams, a trim's moving edge
 *  following the handle (mechanics.stripLayout). */
function layOut(segs: EditorSeg[], trim: Parameters<typeof stripLayout>[1]): { clips: ClipLay[]; seamViews: SeamView[] } {
  const out: ClipLay[] = [];
  const sv: SeamView[] = [];
  const lay = stripLayout(segs, trim);
  lay.forEach(({ seg, i, left, width }, k) => {
    const prev = k > 0 ? lay[k - 1].seg : null;
    const next = lay[k + 1]?.seg ?? null;
    const cutBefore = !!prev && Math.abs(seg.start - prev.end) > 0.02;
    const cutAfter = !!next && Math.abs(next.start - seg.end) > 0.02;
    out.push({ seg, i, left, width, padL: prev ? (cutBefore ? 3 : 1) : 0, padR: next ? (cutAfter ? 3 : 1) : 0 });
    // a ≥ b: a reordered pair (no footage removed between them)
    if (next && cutAfter) sv.push({ k: sv.length, x: left + width, a: seg.end, b: next.start, prev: seg.id, next: next.id });
  });
  return { clips: out, seamViews: sv };
}

/** What the clip and seam elements are drawn from. */
type ElCtx = {
  pps: number;
  selected: string | null;
  reorder: { id: string; left: number } | null;
  trimId: string | null;
  removing: boolean;
  film: FilmSource | null;
  clipH: number;
  /** Drawn at all: around the view, one view width either side (strip px,
   *  filmWindow) — drag-12-rest: the owner's 103 clips and seams cost every
   *  trim move its layout, paint and layerize. The trimmed, selected and
   *  lifted clip always. */
  lo: number;
  hi: number;
  /** Drawn width of every clip (px): how far a seam's hit area may reach into it. */
  clipPx: Map<string, number>;
  t: ReturnType<typeof useT>;
  dec: string;
  stable: {
    onClip: (seg: EditorSeg, fraction: number, timeStamp: number) => void;
    onPress: (e: React.PointerEvent, seg: EditorSeg) => void;
    onTrimStart: (e: React.PointerEvent, id: string, mode: "start" | "end") => void;
    onTrimMove: (e: React.PointerEvent) => void;
    onTrimEnd: (e: React.PointerEvent) => void;
    onSeamDown: () => void;
    onSeamOpen: (
      el: HTMLElement,
      v: { a: number; b: number; kind: PieceKind; prev: string; next: string },
      timeStamp: number,
      clientX: number | null,
    ) => void;
  };
};

function clipElement({ seg, i, left, width, padL, padR }: ClipLay, x: ElCtx) {
  const lifted = x.reorder?.id === seg.id;
  if (!lifted && seg.id !== x.selected && seg.id !== x.trimId && !((left + width) * x.pps >= x.lo && left * x.pps <= x.hi)) return null;
  return (
    <ClipView
      key={seg.id}
      seg={seg}
      index={i}
      selected={seg.id === x.selected}
      lifted={lifted}
      removing={x.removing && seg.id === x.trimId}
      left={lifted && x.reorder ? x.reorder.left : left * x.pps + padL}
      width={Math.max(2, width * x.pps - padL - padR)}
      title={`${x.t("editor.clipTitle", { n: i + 1, len: fmtSeconds(seg.end - seg.start, x.dec) })} · ${x.t("editor.clip.moveHint")}`}
      film={x.film}
      filmH={x.clipH}
      filmLo={x.lo}
      filmHi={x.hi}
      onClip={x.stable.onClip}
      onPress={x.stable.onPress}
      onTrimStart={x.stable.onTrimStart}
      onTrimMove={x.stable.onTrimMove}
      onTrimEnd={x.stable.onTrimEnd}
    />
  );
}

function seamElement(v: SeamView, kind: PieceKind | null, x: ElCtx) {
  const at = v.x * x.pps;
  if (at < x.lo || at > x.hi) return null;
  if (!kind) {
    // a reordered boundary: no footage removed here
    return <span key={`m${v.prev}>${v.next}`} className={s.seamMoved} style={{ left: at }} data-seam-key={`${v.prev}>${v.next}`} aria-hidden />;
  }
  return (
    <SeamButton
      // by the clips it joins: a restored seam's button goes (an index
      // key handed it to the next seam)
      key={`${v.prev}>${v.next}`}
      kind={kind}
      x={at}
      // the hit area reaches into a clip only as far as it leaves that
      // clip a body to tap and hold (review 6)
      extL={seamReach(x.clipPx.get(v.prev) ?? 0)}
      extR={seamReach(x.clipPx.get(v.next) ?? 0)}
      a={v.a}
      b={v.b}
      prev={v.prev}
      next={v.next}
      // next to a selected clip its trim handles win
      nearSel={x.selected === v.prev || x.selected === v.next}
      dec={x.dec}
      onDown={x.stable.onSeamDown}
      onOpen={x.stable.onSeamOpen}
    />
  );
}

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
    /** Removes the trim's window listener. */
    off: () => void;
    /** Geometry read once at the press (drag-12-rest: no layout reads per
     *  move): the strip's client x at scroll 0, the view's box. */
    origin: number;
    view: { left: number; right: number; width: number };
  } | null>(null);
  const [trimming, setTrimming] = useState<{
    id: string;
    mode: "start" | "end";
    start0: number;
    end0: number;
    /** The clips at the press: everything but the trimmed clip stays as laid out from them. */
    startSegs: EditorSeg[];
  } | null>(null);
  /** After a release: keep the trimmed edge at this client x once the strip closes up. */
  const releaseAnchor = useRef<{ id: string; mode: "start" | "end"; clientX: number } | null>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  // ── the settle after a committed trim (F7, drag-11; the effect below) ──
  const rulerRef = useRef<HTMLDivElement>(null);
  const flipFrom = useRef<{
    clips: Map<string, DOMRect>;
    seams: Map<string, number>;
    playhead: number | null;
    pps: number;
    /** The trimmed clip and edge: it settles around that edge (under the finger). */
    trim: { id: string; mode: "start" | "end" };
  } | null>(null);
  /** Ends a running settle at once (a new gesture starts from where things are). */
  const settleNow = () => {
    const inner = stripRef.current?.parentElement;
    if (!inner || typeof inner.getAnimations !== "function") return;
    for (const a of inner.getAnimations({ subtree: true })) if (a.id === SETTLE_ID) a.finish();
  };
  /** Where clips and seams are drawn (strip px), set with each layout: the settle measures only what is in view. */
  const drawnRef = useRef<{ clips: { id: string; x0: number; x1: number }[]; seams: { key: string; x: number }[] }>({
    clips: [],
    seams: [],
  });
  const snapFlip = (pxs: number, trim: { id: string; mode: "start" | "end" }) => {
    const el = stripRef.current;
    const sc = scrollRef.current;
    if (!el || !sc) return null;
    // the view and a margin: what is off screen settles off screen (drag-12)
    const lo = sc.scrollLeft - sc.clientWidth / 2;
    const hi = sc.scrollLeft + sc.clientWidth * 1.5;
    const clips = new Map<string, DOMRect>();
    for (const c of drawnRef.current.clips) {
      if (c.x1 < lo || c.x0 > hi) continue;
      const n = el.querySelector<HTMLElement>(`[data-seg="${CSS.escape(c.id)}"]`);
      if (n) clips.set(c.id, n.getBoundingClientRect());
    }
    const seams = new Map<string, number>();
    for (const x of drawnRef.current.seams) {
      if (x.x < lo || x.x > hi) continue;
      const n = el.querySelector<HTMLElement>(`[data-seam-key="${CSS.escape(x.key)}"]`);
      if (n) seams.set(x.key, n.getBoundingClientRect().left);
    }
    const ph = playheadRef.current;
    return {
      clips,
      seams,
      playhead: ph && ph.style.visibility !== "hidden" ? ph.getBoundingClientRect().left : null,
      pps: pxs,
      trim,
    };
  };
  /** The auto-scroll loop of a trim at the view's edge. */
  const edgeScroll = useRef(0);
  const [boost, setBoost] = useState<number | undefined>(undefined);
  const dragEndedAt = useRef(0);
  // ── seam popover: what was removed, and Restore (state; the view below) ──
  const [seamOpen, setSeamOpen] = useState<{ a: number; b: number; kind: PieceKind } | null>(null);
  const seamAnchor = useRef<HTMLElement | null>(null);
  /** What had focus before a seam was pressed (focus goes back there after Restore). */
  const seamPrevFocus = useRef<HTMLElement | null>(null);
  /** Drawn width of every clip (px), for the seam handlers (set with the layout below). */
  const clipPxRef = useRef<Map<string, number>>(new Map());

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

  // A released trim, shown at once while the editor takes it in (a
  // transition): its clips until p.segments has moved on (drag-12-rest).
  const [held, setHeld] = useState<{ base: EditorSeg[]; segs: EditorSeg[] } | null>(null);
  const shown = held && held.base === p.segments ? held.segs : p.segments;
  /** The same for the handlers, set at the release (before `held` renders). */
  const releasing = useRef<{ base: EditorSeg[]; segs: EditorSeg[] } | null>(null);
  /** The clips a new gesture starts from: a release still being taken in counts. */
  const liveSegs = () => {
    const r = releasing.current;
    return r && r.base === p.segments ? r.segs : shown;
  };
  const segs = reorder?.order ?? dragSegs ?? shown;
  const totalDur = dragTotal ?? stripDuration(reorder ? reorder.startSegs : segs);

  const [span] = useState(openSpan);
  const zoom = useTimelineZoom(scrollRef, totalDur, p.phone, p.phone ? 358 : 1400, boost, span);
  const { contentW, viewW, effPps, fitPps, maxPps, zoomTo, canZoomOut, lastUserScrollRef } = zoom;
  const pps = contentW / totalDur;

  /** Zoom in / out around `anchorX` (px from the view's left; its middle by default). */
  const zoomIn = (anchorX = viewW / 2) => zoomTo(effPps * 1.5, anchorX);
  const zoomOut = (anchorX = viewW / 2) => {
    // reaching Fit is Fit (it stays Fit as the edit's length changes, F7)
    if (effPps / 1.5 <= fitPps * 1.001) zoom.fit();
    else zoomTo(effPps / 1.5, anchorX);
  };
  useImperativeHandle(p.apiRef, () => ({ zoomIn: () => zoomIn(), zoomOut: () => zoomOut(), fit: () => zoom.fit() }));

  // the visible part of the strip (ruler marks and the frame grid are drawn there only)
  const [scrollX, setScrollX] = useState(0);
  const scrollRaf = useRef(0);
  /** The strip as last laid out (the playhead, and trims between renders). */
  const layout = useRef({ segs, pps, contentW, canZoomOut, dragging: false });
  /** The strip's scrollLeft as of its last scroll event or own scroll (no layout read). */
  const scrollLeftRef = useRef(0);
  /** The strip as drawn now (client px): from the press's geometry, the scroll and the zoom. */
  const geo = (d: { origin: number }) => ({ left: d.origin - scrollLeftRef.current, width: layout.current.contentW });

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
  /** Client x where the strip draws the trimmed edge now (stripLayout). */
  const drawnEdgeX = (d: NonNullable<typeof dragRef.current>): number => {
    const rect = geo(d);
    const cur = d.last.find((x) => x.id === d.id);
    const s0 = d.startSegs.find((x) => x.id === d.id);
    if (!cur || !s0) return d.clientX - d.grabPx;
    const sec =
      d.mode === "start" ? edgeAt(d.startSegs, d.id, "start") + (cur.start - s0.start) : edgeAt(d.last, d.id, "end");
    return rect.left + (sec * rect.width) / d.total;
  };
  const magnify = () => {
    const d = dragRef.current;
    if (!d || d.prevPps !== null) return;
    d.prevPps = zoom.pps;
    setBoost(MAGNIFY_PPS);
    // the next frame has the raised cap; zoom around the EDGE, so it stays
    // put (around the pointer it jumped 140–750 px, review drag-8)
    requestAnimationFrame(() => {
      const cur = dragRef.current;
      if (cur === d) animateZoom(Math.max(effPps, MAGNIFY_PPS), drawnEdgeX(d));
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
    // a second finger (a pinch) never trims (review 7)
    if (!el || !e.isPrimary || dragRef.current) return;
    // a settle still running (a trim just before): everything at rest now
    settleNow();
    e.currentTarget.setPointerCapture(e.pointerId);
    // another finger going down during the trim (a pinch starting) ends
    // it with nothing committed
    const pid = e.pointerId;
    const onOther = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) endTrim({ type: "pointercancel", clientX: ev.clientX, clientY: ev.clientY, timeStamp: ev.timeStamp });
    };
    window.addEventListener("pointerdown", onOther, true);
    const off = () => window.removeEventListener("pointerdown", onOther, true);
    const startSegs = liveSegs().map((x) => ({ ...x }));
    // every read now, none per move (drag-12-rest)
    const rect = el.getBoundingClientRect();
    const sc = scrollRef.current;
    const vr = sc ? sc.getBoundingClientRect() : rect;
    scrollLeftRef.current = sc ? sc.scrollLeft : 0;
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
      off,
      origin: rect.left + scrollLeftRef.current,
      view: { left: vr.left, right: vr.left + (sc?.clientWidth ?? vr.width), width: sc?.clientWidth ?? vr.width },
    };
    dragRef.current = d;
    armMagnify(d);
    setDragTotal(totalDur);
    setDragSegs(startSegs);
    const s0 = startSegs.find((x) => x.id === id);
    setTrimming({ id, mode, start0: s0?.start ?? 0, end0: s0?.end ?? 0, startSegs });
  };
  /** The trim at pointer x (the strip as laid out now). The neighbour
   *  snap is a few px on screen (drag-13); the clip may shrink to nothing
   *  (it goes on release, state-3). The video shows the edge (drag-9). */
  const trimAt = (d: NonNullable<typeof dragRef.current>, clientX: number) => {
    const rect = geo(d);
    const pxs = rect.width / d.total;
    const seconds = (clientX - d.grabPx - rect.left) / pxs;
    const next = trimToStep(d.startSegs, d.id, d.mode, seconds, d.bounds, { snapS: snapRadiusS(pxs), minLen: 0 });
    const was = d.last.find((x) => x.id === d.id);
    d.last = next;
    setDragSegs(next);
    const cur = next.find((x) => x.id === d.id);
    if (!cur || (was && was.start === cur.start && was.end === cur.end)) return;
    // the frame at the edge: a start's first frame, an end's last one
    scrubTo(d.mode === "start" ? cur.start : Math.max(cur.start, cur.end - 0.001));
  };
  /** The video shows a dragged edge: a seek at most every SCRUB_MS (each
   *  one redraws the frame, the captions, the clock: drag-12), the last
   *  position always. */
  const scrubState = useRef<{ at: number; timer: ReturnType<typeof setTimeout> | null; want: number | null }>({
    at: 0,
    timer: null,
    want: null,
  });
  const scrubTo = (t: number | null, opts?: { restore?: boolean }) => {
    const st = scrubState.current;
    if (t === null) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.want = null;
      st.at = 0;
      p.onScrub?.(null, opts);
      return;
    }
    st.want = t;
    if (st.timer) return;
    const wait = SCRUB_MS - (performance.now() - st.at);
    const go = () => {
      st.timer = null;
      st.at = performance.now();
      if (st.want !== null) p.onScrub?.(st.want);
    };
    if (wait <= 0) go();
    else st.timer = setTimeout(go, wait);
  };
  /** -1 / 1: the pointer is in the left / right edge zone of the view,
   *  having moved toward it (a handle grabbed at the edge doesn't scroll). */
  const edgeDir = (d: NonNullable<typeof dragRef.current>): -1 | 0 | 1 => {
    const vr = d.view;
    if (d.clientX < vr.left + EDGE_SCROLL_PX && d.clientX < d.x0 - 4) return -1;
    if (d.clientX > vr.right - EDGE_SCROLL_PX && d.clientX > d.x0 + 4) return 1;
    return 0;
  };
  /** Near the view's edge the strip scrolls along (as a reorder does),
   *  while the pointer stays there; the magnifier waits meanwhile. */
  const runEdgeScroll = () => {
    cancelAnimationFrame(edgeScroll.current);
    const step = () => {
      const d = dragRef.current;
      const sc = scrollRef.current;
      if (!d || !sc) return;
      const dir = edgeDir(d);
      const vr = d.view;
      const max = Math.max(0, layout.current.contentW - vr.width);
      const at = scrollLeftRef.current;
      // the edge at its limit that way (a neighbour's footage, the 0.1 s minimum): no further
      const cur = d.last.find((x) => x.id === d.id);
      const atLimit =
        !!cur &&
        (d.mode === "end"
          ? dir > 0
            ? cur.end >= d.bounds.next - 1e-6
            : cur.end <= cur.start + 0.1 + 1e-6
          : dir < 0
            ? cur.start <= d.bounds.prev + 1e-6
            : cur.start >= cur.end - 0.1 - 1e-6);
      if (!dir || atLimit || (dir < 0 && at <= 0) || (dir > 0 && at >= max - 0.5)) {
        edgeScroll.current = 0;
        return;
      }
      if (d.timer) {
        clearTimeout(d.timer);
        d.timer = null;
      }
      const depth = dir < 0 ? vr.left + EDGE_SCROLL_PX - d.clientX : d.clientX - (vr.right - EDGE_SCROLL_PX);
      const to = Math.max(0, Math.min(max, at + dir * Math.min(14, 3 + depth / 3)));
      sc.scrollLeft = to;
      scrollLeftRef.current = to;
      trimAt(d, d.clientX);
      edgeScroll.current = requestAnimationFrame(step);
    };
    edgeScroll.current = requestAnimationFrame(step);
  };
  const moveTrim = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.started) {
      // magnified (held still): every move counts, it is a precise trim
      if (d.prevPps === null && Math.abs(e.clientX - d.x0) < d.slop) return;
      d.started = true;
    }
    // from the strip as laid out now: the magnifier changes the zoom mid-drag;
    // the edge keeps its distance to the finger (no jump on the first move)
    d.clientX = e.clientX;
    trimAt(d, e.clientX);
    if (edgeDir(d) !== 0) {
      if (!edgeScroll.current) runEdgeScroll();
    } else if (Math.abs(e.clientX - d.holdX) > 3) {
      d.holdX = e.clientX;
      armMagnify(d);
    }
  };
  const endTrim = (e: { type: string; clientX: number; clientY: number; timeStamp: number }) => {
    const d = dragRef.current;
    if (!d) return;
    const edgeX = drawnEdgeX(d);
    const pxs = geo(d).width / d.total;
    dragRef.current = null;
    d.off();
    if (d.timer) clearTimeout(d.timer);
    cancelAnimationFrame(edgeScroll.current);
    edgeScroll.current = 0;
    const tap = !d.started && d.prevPps === null;
    // the edge where it started (a hold, a drag back, a drag against a
    // bound): a look, not an edit — no undo step, no save (state-5)
    const a0 = d.startSegs.find((x) => x.id === d.id);
    const a1 = d.last.find((x) => x.id === d.id);
    const moved = !!a0 && !!a1 && (d.mode === "start" ? a1.start !== a0.start : a1.end !== a0.end);
    const commit = !tap && e.type !== "pointercancel" && moved;
    // where everything is drawn now: the strip settles from there (FLIP)
    if (commit && d.prevPps === null) flipFrom.current = snapFlip(pxs, { id: d.id, mode: d.mode });
    // a commit: the strip keeps the drag's layout until the released one is
    // laid out, as a transition (below) — the release itself does no render
    const endDrag = () => {
      setDragSegs(null);
      setDragTotal(null);
      setTrimming(null);
    };
    if (!commit) endDrag();
    if (tap) {
      // no trim: no undo step; a tap on the part of the handle outside
      // the clip is a tap on what is there (the neighbour) (review 5)
      if (e.type === "pointerup") tapThrough(e.clientX, e.clientY, e.timeStamp);
    } else {
      dragEndedAt.current = e.timeStamp;
      // the system took the gesture (a scroll): nothing is committed, the video goes back
      if (!commit) scrubTo(null, { restore: true });
      else {
        // the edge stays where it was let go: the strip closes up around it
        // (and at Fit fills the dock again, F7), settling from the release
        releaseAnchor.current = { id: d.id, mode: d.mode, clientX: edgeX };
        const next = releaseTrim(d, pxs);
        scrubTo(null);
        // The strip lays out the released clips as a transition (the drag's
        // layout stays on screen meanwhile); the rest of the editor
        // (captions, text, video, save) takes them in once that is on
        // screen, also in slices (drag-12-rest: one long task of the whole
        // editor was the release). Still one undo step.
        const base = p.segments;
        releasing.current = { base, segs: next };
        const fit = d.prevPps === null && !canZoomOut;
        startTransition(() => {
          endDrag();
          if (fit) zoom.fit();
          setHeld({ base, segs: next });
        });
        afterPaint(() => {
          let added = false;
          startTransition(() => {
            added = p.history.commit(next);
            if (added && !next.some((x) => x.id === d.id)) p.setSelected(null);
          });
          if (added) p.onTrimmed?.();
          else setHeld((h) => (h?.segs === next ? null : h));
        });
      }
    }
    if (d.prevPps !== null) {
      // back to the zoom before the magnifier, around the edge (Fit stays Fit)
      const prev = d.prevPps;
      animateZoom(prev > 0 ? prev : fitPps, edgeX, () => {
        setBoost(undefined);
        if (!(prev > 0)) zoom.fit();
      });
    }
  };
  /**
   * The clip list a released trim commits: the edge out of a word's sound
   * into the gap next to it when one is within WORD_SNAP_PX (drag-9; an
   * edge between words, at a bound or on a neighbour's footage stays
   * exact), then on the frame both exports cut at (≤ half a frame), and
   * the clip gone when it is shorter than MIN_CLIP_S (state-3).
   */
  const releaseTrim = (d: { id: string; mode: "start" | "end"; last: EditorSeg[]; bounds: ReturnType<typeof trimBounds> }, pxs: number) => {
    let next = d.last;
    const cur = next.find((x) => x.id === d.id);
    if (cur && !trimRemoves(next, d.id)) {
      const edge = d.mode === "start" ? cur.start : cur.end;
      const atBound = d.mode === "start" ? edge === d.bounds.prev : edge === d.bounds.next;
      if (!atBound) {
        const safe = p.cuts.safeEdge(edge, snapRadiusS(pxs, WORD_SNAP_PX, WORD_SNAP_MAX_S));
        if (safe !== edge) {
          const v =
            d.mode === "start"
              ? Math.max(d.bounds.prev, Math.min(cur.end - MIN_CLIP_S, safe))
              : Math.min(d.bounds.next, Math.max(cur.start + MIN_CLIP_S, safe));
          next = next.map((x) => (x.id !== d.id ? x : d.mode === "start" ? { ...x, start: v } : { ...x, end: v }));
        }
      }
    }
    next = snapTrimToFrame(next, d.id, d.mode, d.bounds, p.fps, 0);
    return releasedTrim(next, d.id, d.mode);
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(zoomAnim.current);
      cancelAnimationFrame(scrollRaf.current);
      cancelAnimationFrame(edgeScroll.current);
      if (dragRef.current?.timer) clearTimeout(dragRef.current.timer);
      dragRef.current?.off();
      if (holdRef.current) clearTimeout(holdRef.current.timer);
      if (scrubState.current.timer) clearTimeout(scrubState.current.timer);
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
    settleNow();
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
      const from = liveSegs();
      putReorder({ id: seg.id, startSegs: from, grab: x0 - box.left, left: box.left - rect.left, order: from });
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
        // the tap's point goes along: over a tiny clip it is for the clip
        seam.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }));
        return;
      }
      const clipEl = el.closest<HTMLElement>("[data-seg]");
      if (!clipEl) continue;
      const seg = shown.find((s) => s.id === clipEl.dataset.seg);
      if (!seg) return;
      const r = clipEl.getBoundingClientRect();
      onClip(seg, r.width > 0 ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0, timeStamp);
      return;
    }
  };

  // the clips get stable handlers that call the latest ones, so a trim
  // re-renders only the clips whose place changes (memo ClipView)
  /** A seam pressed: what had focus (it goes back there after Restore). */
  const seamDown = () => {
    seamPrevFocus.current = document.activeElement as HTMLElement | null;
  };
  /**
   * A seam tapped: what it removed, and Restore — as on the desktop. Only a
   * tap on the part of the seam that lies over a tiny clip (under
   * TINY_CLIP_PX: at Fit a 2 px clip is all seam, drag-6) is for that clip
   * (phone-tiny-seam: at the phone's opening zoom most clips are tiny, and
   * every seam next to one selected it — Restore was out of reach).
   * `clientX` null: no point (a key, a synthetic click) — the popover.
   */
  const openSeam = (
    el: HTMLElement,
    v: { a: number; b: number; kind: PieceKind; prev: string; next: string },
    timeStamp: number,
    clientX: number | null,
  ) => {
    if (clientX !== null) {
      // the seam line: the hit area reaches extL px to its left (--sl)
      const r = el.getBoundingClientRect();
      const line = r.left + (parseFloat(el.style.getPropertyValue("--sl")) || r.width / 2);
      const px = (id: string) => clipPxRef.current.get(id) ?? Infinity;
      const side = seamTapClip(clientX, line, px(v.prev), px(v.next), p.phone ? TINY_CLIP_PX : TINY_CLIP_PX_MOUSE);
      const seg = side ? shown.find((x) => x.id === (side === "prev" ? v.prev : v.next)) : undefined;
      if (seg) {
        onClip(seg, 0.5, timeStamp);
        return;
      }
    }
    seamAnchor.current = el;
    setSeamOpen({ a: v.a, b: v.b, kind: v.kind });
  };
  const handlers = useRef({ onClip, clipPointerDown, startTrim, moveTrim, endTrim, seamDown, openSeam });
  useLayoutEffect(() => {
    handlers.current = { onClip, clipPointerDown, startTrim, moveTrim, endTrim, seamDown, openSeam };
  });
  const [stable] = useState(() => ({
    onClip: (seg: EditorSeg, fraction: number, timeStamp: number) => handlers.current.onClip(seg, fraction, timeStamp),
    onPress: (e: React.PointerEvent, seg: EditorSeg) => handlers.current.clipPointerDown(e, seg),
    onTrimStart: (e: React.PointerEvent, id: string, mode: "start" | "end") => handlers.current.startTrim(e, id, mode),
    onTrimMove: (e: React.PointerEvent) => handlers.current.moveTrim(e),
    onTrimEnd: (e: React.PointerEvent) => handlers.current.endTrim(e),
    onSeamDown: () => handlers.current.seamDown(),
    onSeamOpen: (
      el: HTMLElement,
      v: { a: number; b: number; kind: PieceKind; prev: string; next: string },
      timeStamp: number,
      clientX: number | null,
    ) => handlers.current.openSeam(el, v, timeStamp, clientX),
  }));

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
  // (a layout effect: the settle below draws the playhead with it)
  useLayoutEffect(() => {
    // a start trim draws the other clips where they were: the playhead too
    const drawn = trimming ? trimming.startSegs : segs;
    layout.current = { segs: drawn, pps, contentW, canZoomOut, dragging: dragSegs !== null || reorder !== null };
  });
  const { toSource, segments: committed } = p;
  const { playingSeg, mode: playMode } = p;
  const drawPlayhead = useCallback(
    (st: PlayheadState) => {
      const el = playheadRef.current;
      if (!el) return;
      const L = layout.current;
      const cut = playheadCutOf(L.segs, toSource(st.mediaTime), playMode === "proxy" ? playingSeg() : null);
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
    [toSource, playingSeg, playMode, lastUserScrollRef],
  );
  usePlayheadEffect(p.store, drawPlayhead);

  // ── after a committed trim (F7, drag-11) ────────────────────────────
  // The strip closed up (a start trim) and changed its length (at Fit it
  // fills the dock again): scrolled so the trimmed edge is where it was
  // let go, and everything that moved settles there from where it was
  // drawn at the release (FLIP, compositor-only transforms), so nothing
  // jumps under the finger. Reduced motion: no settle.
  useLayoutEffect(() => {
    const a = releaseAnchor.current;
    const sc = scrollRef.current;
    const el = stripRef.current;
    if (!a || !sc || !el || dragSegs) return;
    releaseAnchor.current = null;
    const from = flipFrom.current;
    flipFrom.current = null;
    // (the released clips: shown before p.segments has them, see `held`)
    if (segs.some((x) => x.id === a.id)) {
      const sec = edgeAt(segs, a.id, a.mode);
      const vr = sc.getBoundingClientRect();
      sc.scrollLeft = Math.max(0, sec * (contentW / totalDur) - (a.clientX - vr.left));
      scrollLeftRef.current = sc.scrollLeft;
    }
    if (!from || typeof el.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const opts: KeyframeAnimationOptions = {
      id: SETTLE_ID,
      duration: SETTLE_MS,
      delay: SETTLE_DELAY_MS,
      easing: SETTLE_EASE,
      fill: "backwards",
    };
    // every read first, then the animations (a read after an animate() recalculates style)
    const moves: { el: HTMLElement; o: DOMRect; n: DOMRect; id: string }[] = [];
    for (const [id, o] of from.clips) {
      const c = el.querySelector<HTMLElement>(`[data-seg="${CSS.escape(id)}"]`);
      if (c) moves.push({ el: c, o, n: c.getBoundingClientRect(), id });
    }
    const seamMoves: { el: HTMLElement; dx: number; o: number }[] = [];
    for (const [key, o] of from.seams) {
      const x = el.querySelector<HTMLElement>(`[data-seam-key="${CSS.escape(key)}"]`);
      if (x) seamMoves.push({ el: x, dx: o - x.getBoundingClientRect().left, o });
    }
    // Only what is near the released edge settles, the rest is in place at
    // once (drag-12-rest: at Fit ~200 clip and seam animations made every
    // hover hit test and pre-paint of the settle slow — a 200 ms release):
    // the SETTLE_MAX nearest that move a pixel or more.
    const near = (x: number) => Math.abs(x - a.clientX);
    const clipAnims = moves
      .map(({ el: c, o, n, id }) => {
        const sx = n.width > 0.5 ? o.width / n.width : 1;
        // the trimmed clip settles around its trimmed edge (it stays exactly
        // under the finger at the release), the others around their left
        const right = from.trim.id === id && from.trim.mode === "end";
        const dx = right ? o.right - n.right : o.left - n.left;
        return { c, sx, dx, right, d: Math.min(near(o.left), near(o.right)) };
      })
      .filter((m) => Math.abs(m.dx) >= 1 || Math.abs(m.sx - 1) >= 0.01)
      .sort((x, y) => x.d - y.d)
      .slice(0, SETTLE_MAX);
    for (const { c, sx, dx, right } of clipAnims) {
      const origin = right ? "100% 50%" : "0 50%";
      c.animate(
        [
          { transform: `translateX(${dx}px) scaleX(${sx})`, transformOrigin: origin },
          { transform: "none", transformOrigin: origin },
        ],
        opts,
      );
    }
    const seamAnims = seamMoves
      .filter((m) => Math.abs(m.dx) >= 1)
      .sort((x, y) => near(x.o) - near(y.o))
      .slice(0, SETTLE_MAX);
    for (const { el: x, dx } of seamAnims) x.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], opts);
    const r = rulerRef.current;
    const k = from.pps / (contentW / totalDur);
    if (r && Math.abs(k - 1) > 0.002) {
      r.animate([{ transform: `scaleX(${k})`, transformOrigin: "0 0" }, { transform: "none", transformOrigin: "0 0" }], opts);
    }
    const ph = playheadRef.current;
    if (ph && from.playhead !== null) {
      drawPlayhead(p.store.getState());
      if (ph.style.visibility !== "hidden") {
        const dx = from.playhead - ph.getBoundingClientRect().left;
        if (Math.abs(dx) >= 0.5) ph.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], opts);
      }
    }
  }, [segs, contentW, totalDur, dragSegs, drawPlayhead, p.store]);

  // A zoom moved the strip under the view (useTimelineZoom keeps its
  // anchor): the scroll it set, and the window of clips drawn, before the
  // frame is painted — never a frame with the clips in view left out.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const x = sc.scrollLeft;
    scrollLeftRef.current = x;
    setScrollX((was) => (Math.abs(was - x) > 1 ? x : was));
  }, [contentW]);

  // re-place after a layout change (zoom, edit) without a new frame
  useEffect(() => {
    drawPlayhead(p.store.getState());
  }, [contentW, segs, drawPlayhead, p.store]);

  // ── selection tools ─────────────────────────────────────────────────
  const selSeg = p.selected ? shown.find((x) => x.id === p.selected && !x.disabled) : undefined;
  /** The selected clip's middle in the view (px from its left), clamped into it: the phone's zoom anchor. */
  const selAnchor = () => {
    const sc = scrollRef.current;
    const c = selSeg && stripRef.current?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(selSeg.id)}"]`);
    if (!sc || !c) return viewW / 2;
    const r = c.getBoundingClientRect();
    const v = sc.getBoundingClientRect();
    return Math.min(v.width, Math.max(0, r.left + r.width / 2 - v.left));
  };
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
        aria-label={t("editor.split")}
        onClick={p.onSplit}
        data-testid="ed-split"
      >
        <Scissors size={icon} strokeWidth={1.75} aria-hidden />
        <span className={s.toolLabel}>{t("editor.split")}</span>
      </button>
      <button
        type="button"
        className={btn}
        title={t("editor.deleteTip")}
        aria-label={t("editor.delete")}
        onClick={p.onDelete}
        disabled={!canDelete(p.segments, selSeg.id)}
        data-testid="ed-delete"
      >
        <Trash2 size={icon} strokeWidth={1.75} aria-hidden />
        <span className={s.toolLabel}>{t("editor.delete")}</span>
      </button>
      <button
        ref={clipBtn}
        type="button"
        className={btn}
        aria-haspopup="dialog"
        aria-expanded={clipMenu}
        title={t("editor.clipTip")}
        aria-label={t("editor.clip")}
        onClick={() => setClipMenu((m) => !m)}
        data-testid="ed-clip-menu"
      >
        <Ellipsis size={icon} strokeWidth={1.75} aria-hidden />
        <span className={s.toolLabel}>{t("editor.clip")}</span>
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

  // a trimmed clip moves its edge, the others keep their place (stripLayout)
  const trimLay = trimming;
  const { clips, seamViews } = useMemo(() => layOut(segs, trimLay), [segs, trimLay]);
  // ... so during a trim everything but the trimmed clip (and its seams)
  // is drawn once, from the clips at the press (drag-12-rest: one element
  // per move, not 200)
  const rest = useMemo(() => (trimming ? layOut(trimming.startSegs, trimming) : null), [trimming]);
  // drawn width of every clip (px): how far a seam's hit area may reach into it
  const clipPx = useMemo(() => new Map(clips.map((c) => [c.seg.id, c.width * pps - c.padL - c.padR])), [clips, pps]);
  useLayoutEffect(() => {
    clipPxRef.current = clipPx;
    drawnRef.current = {
      clips: clips.map((c) => ({ id: c.seg.id, x0: c.left * pps, x1: (c.left + c.width) * pps })),
      seams: seamViews.map((v) => ({ key: `${v.prev}>${v.next}`, x: v.x * pps })),
    };
  }, [clipPx, clips, seamViews, pps]);
  const pieces = p.cuts.pieces;
  // The seams' kinds of the clips at rest, once per edit; a trim's moves
  // look them up and work out only the trimmed clip's own seam (a trim
  // never grows into footage another clip plays — trimBounds) —
  // drag-12-rest: every move ran ~100 × gapKind over all pieces.
  const restKinds = useMemo(() => {
    const m = new Map<string, PieceKind | null>();
    const live = shown.filter((x) => !x.disabled);
    for (let k = 0; k + 1 < live.length; k++) {
      const a = live[k].end;
      const b = live[k + 1].start;
      if (Math.abs(b - a) > 0.02) m.set(`${a}|${b}`, seamIsCut(shown, a, b) ? gapKind(pieces, a, b) : null);
    }
    return m;
  }, [shown, pieces]);
  const seamKinds = useMemo(
    // a seam that jumps across a clip playing elsewhere (a reorder) is a
    // move, not a cut: drawn as one, no kind, no Restore (review 2/8)
    () =>
      seamViews.map((v) => {
        const k = restKinds.get(`${v.a}|${v.b}`);
        return k !== undefined ? k : seamIsCut(segs, v.a, v.b) ? gapKind(pieces, v.a, v.b) : null;
      }),
    [seamViews, restKinds, pieces, segs],
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

  // the filmstrip: tiles at the clips' height, for the window around the view
  const [clipH, setClipH] = useState(p.phone ? 80 : 52);
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0) setClipH(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const film = p.film ?? null;
  const filmWin = filmWindow(scrollX, viewW);

  const { marks, labelStep } = rulerMarks(scrollX, contentW, totalDur, viewW, p.phone ? 48 : 64);

  // the frame grid: while trimming, around the visible part of the trimmed clip
  const fps = p.fps && p.fps > 0 ? exactFps(p.fps) : 0;
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
  // the trimmed clip got shorter than MIN_CLIP_S: it goes on release (state-3)
  const removing = !!trimming && trimRemoves(segs, trimming.id);
  const readout = (() => {
    if (!trimming) return null;
    const c = clips.find((x) => x.seg.id === trimming.id);
    if (!c) return null;
    const edge = trimming.mode === "start" ? c.seg.start : c.seg.end;
    const x = (trimming.mode === "start" ? c.left : c.left + c.width) * pps;
    if (removing) return { x, text: t("editor.trim.remove"), removing: true };
    // the value the export uses: the edge's frame (the handle itself moves in 0.01 s)
    const used = frameEdge(edge, fps);
    return { x, text: `${used.toFixed(2).replace(".", dec)} s`, removing: false };
  })();
  const magnified = boost !== undefined;

  // ── the phone's tool row: icons only where the tools and the zoom
  // buttons don't fit with their names (measured, any language) ────────
  const ctxRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const needW = useRef(0);
  const hasTools = !!selSeg;
  useLayoutEffect(() => {
    const el = ctxRef.current;
    if (!el || compact) return;
    if (el.scrollWidth > el.clientWidth + 1) {
      needW.current = el.scrollWidth;
      setCompact(true);
    }
  }, [compact, hasTools, lang, p.phone]);
  useEffect(() => {
    const el = ctxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth >= needW.current) setCompact(false);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.phone]);

  // ── the clips and seams as elements (made once per trim for all but
  // the trimmed clip: `rest`) ────────────────────────────────────────
  const { lo: filmLo, hi: filmHi } = filmWin;
  const selId = p.selected;
  const trimId = trimming?.id ?? null;
  const restPx = useMemo(
    () => (rest ? new Map(rest.clips.map((c) => [c.seg.id, c.width * pps - c.padL - c.padR])) : new Map<string, number>()),
    [rest, pps],
  );
  // (a primitive copy: the compiler can't tell decimalSeparator's result is one)
  const decStr = `${dec}`;
  const restCtx = useMemo<ElCtx>(
    () => ({ pps, selected: selId, reorder: null, trimId, removing: false, film, clipH, lo: filmLo, hi: filmHi, clipPx: restPx, t, dec: decStr, stable }),
    [pps, selId, trimId, film, clipH, filmLo, filmHi, restPx, t, decStr, stable],
  );
  const restClipEls = useMemo(() => (rest ? rest.clips.map((c) => clipElement(c, restCtx)) : null), [rest, restCtx]);
  const restSeamEls = useMemo(
    () => (rest && !reorder ? rest.seamViews.map((v) => seamElement(v, restKinds.get(`${v.a}|${v.b}`) ?? null, restCtx)) : null),
    [rest, restCtx, restKinds, reorder],
  );
  const ctx: ElCtx = {
    ...restCtx,
    reorder: reorder ? { id: reorder.id, left: reorder.left } : null,
    removing,
    clipPx,
  };
  const clipEl = (c: ClipLay | undefined) => (c ? clipElement(c, ctx) : null);
  const seamEl = (v: SeamView, kind: PieceKind | null) => seamElement(v, kind, ctx);

  const strip = (
    <div
      ref={scrollRef}
      className={s.strip}
      data-testid="timeline-scroll"
      data-magnified={magnified || undefined}
      onScroll={(e) => {
        if (!scrubbing.current) lastUserScrollRef.current = Date.now();
        const x = e.currentTarget.scrollLeft;
        scrollLeftRef.current = x;
        cancelAnimationFrame(scrollRaf.current);
        scrollRaf.current = requestAnimationFrame(() => setScrollX(x));
      }}
    >
      <div className={s.stripInner} style={{ width: contentW }}>
        <div ref={rulerRef} className={s.ruler} data-testid="timeline-ruler" {...scrubHandlers}>
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
          {restClipEls && trimming
            ? restClipEls.map((el, k) => (rest!.clips[k].seg.id === trimming.id ? clipEl(clips.find((c) => c.seg.id === trimming.id)) : el))
            : clips.map((c) => clipEl(c))}
          {frameLines.map((x) => (
            <span key={x} className={s.frameLine} style={{ left: x }} aria-hidden />
          ))}
          {!reorder &&
            (restSeamEls && trimming
              ? restSeamEls.map((el, k) => {
                  const v = rest!.seamViews[k];
                  if (v.prev !== trimming.id && v.next !== trimming.id) return el;
                  const live = seamViews.find((x) => x.prev === v.prev && x.next === v.next);
                  return live ? seamEl(live, seamKinds[live.k]) : null;
                })
              : seamViews.map((v) => seamEl(v, seamKinds[v.k])))}
          {readout && (
            <span
              className={`${s.mono} ${s.trimReadout}`}
              style={{ left: readout.x }}
              data-removing={readout.removing || undefined}
              data-testid="ed-trim-readout"
            >
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
        <div ref={ctxRef} className={s.phoneCtx} data-compact={compact || undefined}>
          {tools}
          {/* drag-6: zoom without a pinch (44 px targets), next to a selected
              clip's tools — around that clip (the default state keeps the
              phone's ten-control budget) */}
          {selSeg && (
            <>
              <span className={s.flex1} />
              <button
                type="button"
                className={`${s.mb} ${s.ico}`}
                aria-label={t("app.timeline.zoomOutAria")}
                title={t("app.timeline.zoomOutTitle")}
                disabled={!canZoomOut}
                onClick={() => zoomOut(selAnchor())}
                data-testid="timeline-zoom-out"
              >
                <Minus size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                type="button"
                className={`${s.mb} ${s.ico}`}
                aria-label={t("app.timeline.zoomInAria")}
                title={t("app.timeline.zoomInTitle")}
                disabled={!zoom.canZoomIn}
                onClick={() => zoomIn(selAnchor())}
                data-testid="timeline-zoom-in"
              >
                <Plus size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          )}
        </div>
        {strip}
        <div className={s.phoneLegend}>
          {legend}
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className={`${s.mono} ${s.cutsFrom}`}>{fmtClock(p.duration)}</span>
            <span aria-hidden style={{ color: "var(--ed-text-3)" }}>→</span>
            <span className={`${s.mono} ${s.cutsTo}`}>{fmtClock(cutDuration(shown))}</span>
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
            onClick={() => zoom.fit()}
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
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v <= 0) zoom.fit();
              else zoomTo(fitPps * Math.exp((v / 100) * zoomRange), viewW / 2);
            }}
          />
          <Plus size={14} strokeWidth={1.75} aria-hidden />
        </div>
      </div>
      {strip}
    </section>
  );
});

/** A cut seam's button (memo: a trim re-draws only the seams that move, drag-12). */
const SeamButton = memo(function SeamButton({
  kind,
  x,
  extL,
  extR,
  a,
  b,
  prev,
  next,
  nearSel,
  dec,
  onDown,
  onOpen,
}: {
  kind: PieceKind;
  /** The boundary, px in the strip. */
  x: number;
  extL: number;
  extR: number;
  a: number;
  b: number;
  prev: string;
  next: string;
  nearSel: boolean;
  dec: string;
  onDown: () => void;
  onOpen: (
    el: HTMLElement,
    v: { a: number; b: number; kind: PieceKind; prev: string; next: string },
    timeStamp: number,
    clientX: number | null,
  ) => void;
}) {
  const t = useT();
  const label = t("editor.seam.label", { kind: t(KIND_NAME[kind]), len: fmtSeconds(b - a, dec) });
  return (
    <button
      type="button"
      className={s.seam}
      data-seam={kind}
      data-seam-key={`${prev}>${next}`}
      data-testid="ed-seam"
      tabIndex={-1}
      style={{
        left: x - extL,
        width: extL + extR,
        pointerEvents: nearSel ? "none" : undefined,
        ["--sl" as string]: `${extL}px`,
      }}
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      onPointerDown={onDown}
      // a key or a synthetic click (detail 0): no point to go by
      onClick={(e) => onOpen(e.currentTarget, { a, b, kind, prev, next }, e.timeStamp, e.detail > 0 ? e.clientX : null)}
    >
      <span className={s.seamLine} />
      <span className={s.seamGlyph}>
        <Cross color={KIND_COLOR[kind]} />
      </span>
    </button>
  );
});

const ClipView = memo(function ClipView({
  seg,
  index,
  selected,
  lifted,
  removing,
  left,
  width,
  title,
  film,
  filmH,
  filmLo,
  filmHi,
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
  /** Being trimmed away: it goes on release. */
  removing: boolean;
  left: number;
  width: number;
  title: string;
  film: FilmSource | null;
  filmH: number;
  filmLo: number;
  filmHi: number;
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
      data-removing={removing || undefined}
      data-testid={`clip-${index}`}
      data-seg={seg.id}
      title={title}
      // --hin: how far a phone trim handle reaches into the clip: 36 px (the
      // 44 px target with the 8 px outside), never past the clip's middle —
      // on a short clip the end handle (on top) covered the start handle,
      // so dragging the start trimmed the end (drag-5); a tap on it that
      // doesn't trim reaches the clip below (review 5)
      style={{ left, width, ["--hin" as string]: `${Math.max(2, Math.min(36, width / 2))}px` }}
      onPointerDown={(e) => onPress(e, seg)}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onClip(seg, r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0, e.timeStamp);
      }}
    >
      <div className={s.clipBody} data-film={film ? true : undefined}>
        {film && (
          <Filmstrip
            film={film}
            start={seg.start}
            end={seg.end}
            // the window relative to the clip, clamped to it: a clip that
            // an edit only shifts (inside the window) keeps its tiles as is
            left={0}
            width={width}
            h={filmH}
            lo={Math.max(0, filmLo - left)}
            hi={Math.min(width, filmHi - left)}
          />
        )}
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
});

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
