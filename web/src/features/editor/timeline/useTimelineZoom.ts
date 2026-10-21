"use client";
/**
 * Zoom and scroll gestures of the timeline strip (moved out of
 * TimelineEditor, UX7; shared with the v2 dock):
 *   - zoom as px per second, 0 = "Fit" (the timeline opens showing the
 *     whole edit); never narrower than the view;
 *   - zoomTo keeps the time under an anchor x in place (the scroll is
 *     corrected once the new width is laid out);
 *   - the mouse wheel scrolls the strip sideways, Ctrl/⌘ + wheel or a
 *     trackpad pinch zooms, two fingers pinch-zoom on touch screens.
 * `lastUserScrollRef` is when the user last scrolled or zoomed by hand
 * (auto-follow of the playhead waits after that).
 *
 * v2 dock (owner): `initialSpanS` opens a long edit zoomed so that only
 * its first `initialSpanS` seconds fill the strip (a 10-min video at Fit
 * is a blur of 2 px clips); a shorter one opens at Fit as before. The
 * span holds until the user zooms (pinch, ⌘-wheel, slider, keys, Fit).
 * `fit()` is the "Fit" zoom itself (0): it stays Fit while the edit's
 * length changes (F7: a trim at Fit fills the dock again — zoomTo(fitPps)
 * would pin the px/s of the moment). `hold(pps)` keeps a zoom as it is
 * even where the strip no longer fills the view.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { zoomLimits } from "./mechanics";

export type TimelineZoom = {
  viewW: number;
  /** Requested px/s (0 = fit; the opening span's zoom while it holds). */
  pps: number;
  effPps: number;
  fitPps: number;
  maxPps: number;
  contentW: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomTo: (nextPps: number, anchorX: number) => void;
  /** Fit, and stay Fit while the edit's length changes. */
  fit: () => void;
  /** Keep this zoom (px/s) as it is, also below Fit, until the next zoom. */
  hold: (pps: number) => void;
  lastUserScrollRef: RefObject<number>;
};

/**
 * The zoom the strip opens at: `span` seconds fill the view when the
 * strip is longer, else 0 (Fit).
 */
export function openingPps(viewW: number, totalDur: number, span: number | null | undefined): number {
  return span && span > 0 && totalDur > span + 1e-6 ? viewW / span : 0;
}

/**
 * `mountKey` re-attaches the observers when the scroll container is
 * re-created (the v1 timeline mounts it only while its tab is open).
 */
export function useTimelineZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  totalDur: number,
  mountKey: unknown,
  initialViewW = 640,
  /** A higher zoom cap while it's set (the v2 dock's trim magnifier, UX10). */
  maxBoost?: number,
  /** Open showing this many seconds (v2 dock: the first minute), see openingPps. */
  initialSpanS?: number,
): TimelineZoom {
  // Zoom as pixels per second. 0 = "Fit" (effPps below never goes under
  // the fit zoom): the timeline opens showing the whole edit — or, with
  // initialSpanS, its first part, until the user zooms.
  const [explicitPps, setPps] = useState(0);
  const [span, setSpan] = useState<number | null>(initialSpanS ?? null);
  const [held, setHeld] = useState<number | null>(null);

  // Visible strip width, so ruler density adapts to phone vs desktop.
  const [viewW, setViewW] = useState(initialViewW);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth || initialViewW));
    ro.observe(sc);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey]);

  // Effective zoom: never narrower than the view ("fit"), and capped
  // so very long videos don't produce absurdly wide elements.
  const limits = zoomLimits(viewW, totalDur);
  const fitPps = limits.fitPps;
  const maxPps = maxBoost ? Math.max(limits.maxPps, maxBoost) : limits.maxPps;
  const pps = span !== null ? openingPps(viewW, totalDur, span) : explicitPps;
  const effPps = held ?? Math.min(maxPps, Math.max(fitPps, pps));
  const contentW = held !== null ? Math.max(1, Math.round(totalDur * held)) : Math.max(viewW, Math.round(totalDur * effPps));
  const canZoomOut = contentW > viewW + 1;
  const canZoomIn = effPps < maxPps - 1e-6;

  // Zoom while keeping the time under `anchorX` (px from the left edge
  // of the visible strip) in place. The scroll correction is applied
  // after the new width has been laid out.
  const pendingAnchorRef = useRef<{ t: number; x: number } | null>(null);
  const zoomStateRef = useRef({ effPps, contentW, totalDur, fitPps, maxPps });
  useLayoutEffect(() => {
    zoomStateRef.current = { effPps, contentW, totalDur, fitPps, maxPps };
  });
  const zoomTo = (nextPps: number, anchorX: number) => {
    const sc = scrollRef.current;
    const z = zoomStateRef.current;
    const clamped = Math.min(z.maxPps, Math.max(z.fitPps, nextPps));
    if (sc) {
      pendingAnchorRef.current = {
        t: ((sc.scrollLeft + anchorX) / z.contentW) * z.totalDur,
        x: anchorX,
      };
    }
    setSpan(null);
    setHeld(null);
    // all the way out is Fit (0): it stays Fit as the edit's length changes
    setPps(clamped <= z.fitPps * (1 + 1e-6) ? 0 : clamped);
  };
  const hold = (p: number) => {
    if (p > 0 && Number.isFinite(p)) setHeld(p);
  };
  const fit = () => {
    pendingAnchorRef.current = null;
    setSpan(null);
    setHeld(null);
    setPps(0);
  };
  const zoomToRef = useRef(zoomTo);
  useLayoutEffect(() => {
    zoomToRef.current = zoomTo;
  });
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const a = pendingAnchorRef.current;
    if (!sc || !a) return;
    pendingAnchorRef.current = null;
    sc.scrollLeft = Math.max(0, (a.t / totalDur) * contentW - a.x);
  }, [contentW, totalDur, scrollRef]);

  // Mouse wheel scrolls the strip sideways (Ctrl/⌘ + wheel or a
  // trackpad pinch zooms); two-finger pinch zooms on touch screens.
  const lastUserScrollRef = useRef(0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      const rect = sc.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        lastUserScrollRef.current = Date.now();
        zoomToRef.current(zoomStateRef.current.effPps * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left);
        return;
      }
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
        lastUserScrollRef.current = Date.now();
        return; // native horizontal scroll (trackpad, shift+wheel)
      }
      const max = sc.scrollWidth - sc.clientWidth;
      // At either end, let the page scroll as usual.
      if (max <= 0 || (e.deltaY < 0 && sc.scrollLeft <= 0) || (e.deltaY > 0 && sc.scrollLeft >= max - 1)) return;
      e.preventDefault();
      lastUserScrollRef.current = Date.now();
      sc.scrollLeft += e.deltaY;
    };
    let pinch: { dist: number; pps: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      lastUserScrollRef.current = Date.now();
      if (e.touches.length === 2) {
        pinch = { dist: dist(e.touches), pps: zoomStateRef.current.effPps };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      lastUserScrollRef.current = Date.now();
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const rect = sc.getBoundingClientRect();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      zoomToRef.current((pinch.pps * dist(e.touches)) / pinch.dist, midX);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    sc.addEventListener("touchstart", onTouchStart, { passive: true });
    sc.addEventListener("touchmove", onTouchMove, { passive: false });
    sc.addEventListener("touchend", onTouchEnd);
    sc.addEventListener("touchcancel", onTouchEnd);
    return () => {
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("touchstart", onTouchStart);
      sc.removeEventListener("touchmove", onTouchMove);
      sc.removeEventListener("touchend", onTouchEnd);
      sc.removeEventListener("touchcancel", onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey]);

  return { viewW, pps: held ?? pps, effPps, fitPps, maxPps, contentW, canZoomIn, canZoomOut, zoomTo, fit, hold, lastUserScrollRef };
}
