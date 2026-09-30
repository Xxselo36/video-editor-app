"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Minus, Plus, Redo2, SquareSplitHorizontal, Undo2, X } from "lucide-react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { Slider } from "@/components/ui/Slider";
import { useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { fmtTimecode } from "@/features/editor/format";
import { RulerTicks } from "./RulerTicks";

// Timeline editor with per-segment trim, split, delete, reorder.
// Segments are rendered as blocks in a horizontal strip proportional
// to their duration. Handles on the left/right edges let the user drag
// to trim; a Delete button removes a segment (soft-disable so it can
// be restored); Split at playhead splits the current block into two;
// drag-and-drop reorders. All edits POST to the backend which rebuilds
// the preview MP4.
export type EditorSeg = {
  id: string;
  start: number;
  end: number;
  disabled?: boolean;
  speed?: number;      // 0.25 – 4.0, default 1
  fadeIn?: number;     // seconds
  fadeOut?: number;    // seconds
  volume?: number;     // 0 – 2.5, default 1
};

// Trimming snaps onto a neighbouring clip's footage when it would leave
// less than this much of the removed gap between them.
const TRIM_SNAP_S = 0.3;
const TIMELINE_MAX_PPS = 400; // 0.1s = 40px

export function TimelineEditor({
  segments,
  duration,
  playhead,
  playheadSegId,
  open,
  saving,
  saveError,
  onToggleOpen,
  onCommit,
  onSeekOriginal,
  getVideoTime,
  onPlayPauseKey,
}: {
  segments: EditorSeg[];
  duration: number;
  playhead: number;
  /** The clip playing (proxy mode): a split point or a clip moved away
   *  from its footage's neighbours can't be told apart by time alone. */
  playheadSegId?: string | null;
  open: boolean;
  saving: boolean;
  saveError?: "retrying" | "failed" | null;
  onToggleOpen: () => void;
  onCommit: (next: EditorSeg[]) => void;
  onSeekOriginal: (t: number, segId?: string) => void;
  getVideoTime: () => number;
  onPlayPauseKey?: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragMode, setDragMode] = useState<"start" | "end" | null>(null);
  // Zoom as pixels per second. 0 = "Fit" (effPps below never goes under
  // the fit zoom): the timeline opens showing the whole edit.
  const [pps, setPps] = useState(0);
  const [history, setHistory] = useState<EditorSeg[][]>([]);
  const [future, setFuture] = useState<EditorSeg[][]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragPreviewRef = useRef<EditorSeg[] | null>(null);
  // When the last trim drag ended: the click that follows its mouseup
  // must not seek (the trim itself places the playhead).
  const dragEndedAtRef = useRef(0);
  const scrubbingRef = useRef(false);
  const [, forceRender] = useState({});

  // While the user is dragging a trim handle, use the live preview
  // for measurements so the visible strip stays in sync with the
  // dragging cursor. Otherwise fall back to committed props.
  const displaySegs = dragPreviewRef.current ?? segments;
  // During a trim drag the strip keeps the scale it had when the drag
  // started — otherwise shrinking a clip rescales every block under the
  // cursor and the trim runs away.
  const dragTotalRef = useRef<number | null>(null);
  const totalDur =
    dragTotalRef.current ??
    (displaySegs.reduce((acc, s) => acc + (s.end - s.start), 0) || 1);
  const activeCount = displaySegs.filter((s) => !s.disabled).length;

  const fmt = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Wrap onCommit to push history state
  // `coalesce` groups rapid changes of the same control (a slider being
  // dragged fires dozens of changes) into ONE undo step.
  const lastCommitRef = useRef<{ key: string; t: number } | null>(null);
  const commit = (next: EditorSeg[], coalesce?: string) => {
    const now = Date.now();
    const last = lastCommitRef.current;
    const merge = coalesce && last && last.key === coalesce && now - last.t < 1000;
    lastCommitRef.current = coalesce ? { key: coalesce, t: now } : null;
    if (!merge) {
      setHistory((h) => [...h, segments].slice(-50));
    }
    setFuture([]);
    onCommit(next);
  };
  const undo = () => {
    if (history.length === 0) return;
    track("undo", { area: "timeline" });
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setFuture((f) => [segments, ...f].slice(0, 30));
    onCommit(prev);
  };
  const redo = () => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setHistory((h) => [...h, segments].slice(-30));
    onCommit(next);
  };

  // Trim drag — during the gesture we mutate a LOCAL preview so the
  // strip resizes visually without spamming the backend. Only on
  // release do we call onCommit ONCE with the final state. Without
  // this, every mousemove pixel used to fire an /edit-segments POST
  // which triggered concurrent preview MP4 rebuilds and crashed the
  // video element mid-playback.
  useEffect(() => {
    if (!draggingId || !dragMode || !stripRef.current) return;
    const strip = stripRef.current;
    const stripRect = strip.getBoundingClientRect();
    const pxPerSec = stripRect.width / totalDur;
    dragTotalRef.current = totalDur;
    // Every move is computed from this snapshot (not the previous
    // move's result) so offsets don't accumulate.
    const startSegs = segments.map((s) => ({ ...s }));
    dragPreviewRef.current = startSegs;
    // Growing a clip brings back removed source footage, but never
    // footage another clip already uses — that would play it twice.
    const bounds = (() => {
      const self = startSegs.find((x) => x.id === draggingId);
      const others = startSegs.filter((x) => x.id !== draggingId && !x.disabled);
      if (!self) return { prev: 0, next: duration };
      return {
        prev: Math.max(0, ...others.filter((o) => o.end <= self.start + 1e-6).map((o) => o.end)),
        next: Math.min(duration, ...others.filter((o) => o.start >= self.end - 1e-6).map((o) => o.start)),
      };
    })();

    const handleMove = (e: MouseEvent | TouchEvent) => {
      // Touch: keep the page / strip from scrolling under the finger.
      if (e.cancelable && "touches" in e) e.preventDefault();
      const clientX =
        (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX;
      const relX = clientX - stripRect.left;
      // May be negative: dragging the first clip's start handle past the
      // strip's left edge brings back footage before it.
      const seconds = relX / pxPerSec;

      let acc = 0;
      const next = startSegs.map((s) => {
        if (s.disabled) return s;
        const sDur = s.end - s.start;
        if (s.id === draggingId) {
          if (dragMode === "start") {
            const target = s.start + (seconds - acc);
            let clamped = Math.max(bounds.prev, Math.min(s.end - 0.1, target));
            // Snap onto the neighbouring clip's footage instead of
            // leaving a sliver of the removed gap.
            if (clamped < s.start && clamped - bounds.prev < TRIM_SNAP_S) clamped = bounds.prev;
            return { ...s, start: clamped };
          } else if (dragMode === "end") {
            const target = s.start + Math.max(0.1, seconds - acc);
            let clamped = Math.min(bounds.next, Math.max(s.start + 0.1, target));
            if (clamped > s.end && bounds.next - clamped < TRIM_SNAP_S) clamped = bounds.next;
            return { ...s, end: clamped };
          }
        }
        acc += sDur;
        return s;
      });
      dragPreviewRef.current = next;
      forceRender({});
    };

    const handleUp = () => {
      const final = dragPreviewRef.current;
      dragEndedAtRef.current = performance.now();
      dragTotalRef.current = null;
      setDraggingId(null);
      setDragMode(null);
      if (final) {
        // Through commit() so ⌘Z can undo a trim.
        commit(final);
      }
      dragPreviewRef.current = null;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingId, dragMode]);

  const del = (id: string) => {
    // Refuse to remove the last clip — the backend would have nothing
    // to render. Undo (⌘Z / ↶) brings anything back.
    const active = segments.filter((s) => !s.disabled);
    if (active.length <= 1 && active.some((s) => s.id === id)) {
      setSelected(id);
      return;
    }
    commit(segments.filter((s) => s.id !== id));
    setSelected(null);
  };
  // Split needs the playhead inside a clip, at least 0.1 s from its
  // edges. When it can't split, the button says why (title + a short
  // note on click) instead of doing nothing.
  const [splitNote, setSplitNote] = useState<string | null>(null);
  const splitNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (splitNoteTimer.current) clearTimeout(splitNoteTimer.current);
  }, []);
  const splittable = (at: number) =>
    segments.findIndex((s) => !s.disabled && at > s.start + 0.1 && at < s.end - 0.1);
  const canSplit = splittable(playhead) !== -1;
  const splitAtPlayhead = () => {
    const at = getVideoTime();
    const idx = splittable(at);
    if (idx === -1) {
      setSplitNote(t("app.timeline.splitUnavailable"));
      if (splitNoteTimer.current) clearTimeout(splitNoteTimer.current);
      splitNoteTimer.current = setTimeout(() => setSplitNote(null), 4000);
      return;
    }
    setSplitNote(null);
    const cur = segments[idx];
    const first: EditorSeg = { ...cur, end: at, id: `${cur.id}-a` };
    const second: EditorSeg = {
      ...cur,
      start: at,
      id: `${cur.id}-b-${Date.now()}`,
    };
    commit([...segments.slice(0, idx), first, second, ...segments.slice(idx + 1)]);
  };
  const moveLeft = (id: string) => {
    const idx = segments.findIndex((s) => s.id === id);
    if (idx <= 0) return;
    const next = [...segments];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    commit(next);
  };
  const moveRight = (id: string) => {
    const idx = segments.findIndex((s) => s.id === id);
    if (idx === -1 || idx >= segments.length - 1) return;
    const next = [...segments];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    commit(next);
  };
  const patchSeg = (id: string, patch: Partial<EditorSeg>) => {
    commit(
      segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      `${id}:${Object.keys(patch).sort().join(",")}`,
    );
  };

  // Keyboard shortcuts: Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z (redo),
  // Delete (remove selected), Space (play/pause via callback). They work
  // on every editor tab (Delete only while the timeline shows, where the
  // selection is visible), but only for keys aimed at the editor or the
  // page itself — not in a dialog or elsewhere in the app — and never
  // for text fields. A focused button, tab or link keeps its own Space /
  // Enter / Backspace (tech.md T4).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      const onPage = !target || target === document.body || target === document.documentElement;
      if (!onPage && !target?.closest("[data-editor-root]")) return;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta && target?.closest("button, a, [role=tab], [role=button], summary")) return;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        meta &&
        (e.key.toLowerCase() === "y" ||
          (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected && open) {
        e.preventDefault();
        del(selected);
      } else if (!meta && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        onPlayPauseKey?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected, history, future, segments]);

  const selectedSeg = selected ? segments.find((x) => x.id === selected) : null;

  // Playhead position on the CUT timeline (what the strip lays out).
  const playheadCut = (() => {
    if (playheadSegId) {
      let acc = 0;
      for (const s of segments) {
        if (s.disabled) continue;
        if (s.id === playheadSegId && playhead >= s.start - 0.05 && playhead <= s.end + 0.05) {
          return acc + Math.min(s.end - s.start, Math.max(0, playhead - s.start));
        }
        acc += s.end - s.start;
      }
    }
    let acc = 0;
    for (const s of segments) {
      if (s.disabled) continue;
      if (playhead >= s.start && playhead <= s.end) return acc + (playhead - s.start);
      acc += s.end - s.start;
    }
    return null;
  })();
  const playheadPct =
    playheadCut !== null ? Math.min(100, (playheadCut / totalDur) * 100) : null;

  // Visible strip width, so ruler density adapts to phone vs desktop.
  const [viewW, setViewW] = useState(640);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth || 640));
    ro.observe(sc);
    return () => ro.disconnect();
  }, [open]);

  // Effective zoom: never narrower than the view ("fit"), and capped
  // so very long videos don't produce absurdly wide elements.
  const fitPps = viewW / totalDur;
  const maxPps = Math.max(fitPps, Math.min(TIMELINE_MAX_PPS, 200_000 / totalDur));
  const effPps = Math.min(maxPps, Math.max(fitPps, pps));
  const contentW = Math.max(viewW, Math.round(totalDur * effPps));
  const canZoomOut = contentW > viewW + 1;
  const canZoomIn = effPps < maxPps - 1e-6;

  // Zoom while keeping the time under `anchorX` (px from the left edge
  // of the visible strip) in place. The scroll correction is applied
  // after the new width has been laid out.
  const pendingAnchorRef = useRef<{ t: number; x: number } | null>(null);
  const zoomStateRef = useRef({ effPps, contentW, totalDur, fitPps, maxPps });
  zoomStateRef.current = { effPps, contentW, totalDur, fitPps, maxPps };
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
    setPps(clamped);
  };
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const a = pendingAnchorRef.current;
    if (!sc || !a) return;
    pendingAnchorRef.current = null;
    sc.scrollLeft = Math.max(0, (a.t / totalDur) * contentW - a.x);
  }, [contentW, totalDur]);

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
        zoomToRef.current(
          zoomStateRef.current.effPps * Math.exp(-e.deltaY * 0.01),
          e.clientX - rect.left,
        );
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
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
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
  }, [open]);

  // Click on the ruler → seek. Converts cut-timeline x into the
  // original time of whichever clip sits there.
  const seekFromRuler = (clientX: number) => {
    const el = stripRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cut = Math.max(0, Math.min(totalDur, ((clientX - rect.left) / rect.width) * totalDur));
    let acc = 0;
    for (const s of segments) {
      if (s.disabled) continue;
      const d = s.end - s.start;
      if (cut <= acc + d) {
        onSeekOriginal(Math.min(s.end, s.start + (cut - acc)), s.id);
        return;
      }
      acc += d;
    }
  };

  // Keep the playhead in view while it moves — unless the user just
  // scrolled or zoomed by hand, so we don't yank the strip away.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || playheadPct === null || !canZoomOut || draggingId) return;
    if (Date.now() - lastUserScrollRef.current < 2500) return;
    const x = (playheadPct / 100) * contentW;
    if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) {
      sc.scrollTo({ left: Math.max(0, x - sc.clientWidth / 3), behavior: "smooth" });
    }
  }, [playheadPct, contentW, canZoomOut, draggingId]);

  const toolBtn = {
    background: "var(--surface-2)",
    color: "var(--text-body)",
    border: "1px solid var(--border)",
  } as const;

  return (
    <Card className="mb-3" style={{ boxShadow: "var(--shadow-md)" }}>
      <button
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        style={{ borderBottom: open ? "1px solid var(--border)" : "none" }}
      >
        <div>
          <SectionLabel className="flex items-center gap-2">
            {t("app.timeline.title")}
            <span
              className="rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal tabular-nums"
              style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
            >
              {t(activeCount === 1 ? "app.timeline.clipsOne" : "app.timeline.clipsOther", {
                count: activeCount,
                dur: fmt(totalDur),
              })}
            </span>
            {saving && (
              <span
                data-testid="timeline-saving"
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal"
                style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--brand)", animation: "soft-pulse 1.2s ease-in-out infinite" }}
                />
                {t("app.timeline.saving")}
              </span>
            )}
            {saveError && !saving && (
              <span
                data-testid="timeline-save-error"
                className="rounded-full px-2 py-0.5 text-[10px] normal-case tracking-normal"
                style={{ background: "rgba(239,107,87,0.14)", color: "var(--danger)" }}
                title={
                  saveError === "failed"
                    ? t("app.timeline.saveFailedTitle")
                    : t("app.timeline.saveRetryingTitle")
                }
              >
                {saveError === "failed" ? t("app.timeline.notSaved") : t("app.timeline.notSavedRetrying")}
              </span>
            )}
          </SectionLabel>
        </div>

      </button>

      {open && (
        <div className="p-3">
          {/* Toolbar */}
          <div className="mb-3 flex items-center gap-2">
            <div className="flex overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
              <IconButton
                onClick={undo}
                disabled={history.length === 0}
                data-testid="timeline-undo"
                className="px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 disabled:hover:bg-transparent sm:px-2.5 sm:py-1"
                style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
                title={t("app.timeline.undoTitle")}
                label={t("app.timeline.undoAria")}
              >
                <Icon icon={Undo2} />
              </IconButton>
              <IconButton
                onClick={redo}
                disabled={future.length === 0}
                data-testid="timeline-redo"
                className="px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 disabled:hover:bg-transparent sm:px-2.5 sm:py-1"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-body)",
                  borderLeft: "1px solid var(--border)",
                }}
                title={t("app.timeline.redoTitle")}
                label={t("app.timeline.redoAria")}
              >
                <Icon icon={Redo2} />
              </IconButton>
            </div>
            <button
              onClick={splitAtPlayhead}
              data-testid="timeline-split"
              // aria-disabled, not disabled: a click still explains why.
              aria-disabled={!canSplit}
              aria-describedby={splitNote ? "timeline-split-note" : undefined}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors hover:border-[var(--brand)] aria-disabled:opacity-40 sm:px-2.5 sm:py-1"
              style={{ ...toolBtn, color: "var(--text-strong)" }}
              title={canSplit ? t("app.timeline.splitTitle") : t("app.timeline.splitUnavailable")}
            >
              <Icon icon={SquareSplitHorizontal} /> {t("app.timeline.split")}
            </button>

            <div className="ml-auto flex items-center gap-2">
              <span
                data-testid="timeline-timecode"
                className="rounded-md px-2 py-1 font-mono text-[11px] tabular-nums"
                style={{ background: "var(--surface-0)", color: "var(--text-strong)" }}
              >
                {fmtTimecode(playheadCut ?? 0)}
                <span className="hidden sm:inline" style={{ color: "var(--text-faint)" }}>
                  {" "}/ {fmt(totalDur)}
                </span>
              </span>
              <div className="flex items-center overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
                <IconButton
                  onClick={() => zoomTo(effPps / 1.5, viewW / 2)}
                  disabled={!canZoomOut}
                  data-testid="timeline-zoom-out"
                  className="px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 sm:px-2 sm:py-1"
                  style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
                  title={t("app.timeline.zoomOutTitle")}
                  label={t("app.timeline.zoomOutAria")}
                >
                  <Icon icon={Minus} />
                </IconButton>
                <button
                  onClick={() => zoomTo(fitPps, 0)}
                  disabled={!canZoomOut}
                  data-testid="timeline-zoom-fit"
                  className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 sm:py-1"
                  style={{
                    background: "var(--surface-2)",
                    color: "var(--text-muted)",
                    borderLeft: "1px solid var(--border)",
                  }}
                  title={t("app.timeline.fitTitle")}
                >
                  {t("app.timeline.fit")}
                </button>
                <IconButton
                  onClick={() => zoomTo(effPps * 1.5, viewW / 2)}
                  disabled={!canZoomIn}
                  data-testid="timeline-zoom-in"
                  className="px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] disabled:opacity-40 sm:px-2 sm:py-1"
                  style={{
                    background: "var(--surface-2)",
                    color: "var(--text-body)",
                    borderLeft: "1px solid var(--border)",
                  }}
                  title={t("app.timeline.zoomInTitle")}
                  label={t("app.timeline.zoomInAria")}
                >
                  <Icon icon={Plus} />
                </IconButton>
              </div>
            </div>
          </div>

          <div
            id="timeline-split-note"
            role="status"
            data-testid="timeline-split-note"
            className={splitNote ? "-mt-1 mb-2 text-xs" : "sr-only"}
            style={{ color: "var(--warn)" }}
          >
            {splitNote}
          </div>

          {/* Ruler + clip strip — width scales with zoom, in a scroll container */}
          <div
            ref={scrollRef}
            data-testid="timeline-scroll"
            className="overflow-x-auto rounded-xl"
            style={{
              background: "var(--surface-0)",
              border: "1px solid var(--border)",
              // Native swipe/scroll; pinch is handled above instead of
              // zooming the whole page.
              touchAction: "pan-x pan-y",
              scrollbarWidth: "thin",
              scrollbarColor: "var(--border-strong) transparent",
            }}
          >
            <div
              className="relative select-none"
              style={{ width: `${contentW}px` }}
            >
              {/* Time ruler */}
              <div
                data-testid="timeline-ruler"
                className="relative h-7 cursor-pointer sm:h-6"
                style={{ borderBottom: "1px solid var(--border)", touchAction: "none" }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  scrubbingRef.current = true;
                  seekFromRuler(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (scrubbingRef.current) seekFromRuler(e.clientX);
                }}
                onPointerUp={() => {
                  scrubbingRef.current = false;
                }}
                onPointerCancel={() => {
                  scrubbingRef.current = false;
                }}
              >
                <RulerTicks scrollRef={scrollRef} contentW={contentW} totalDur={totalDur} viewW={viewW} />
              </div>

              {/* Clips */}
              <div
                ref={stripRef}
                className="relative flex h-20 items-stretch py-2"
              >
                {(dragPreviewRef.current ?? segments).map((s, i) => {
                  const dur = s.end - s.start;
                  const width = (dur / totalDur) * 100;
                  const isSel = selected === s.id;
                  const isDragging = draggingId === s.id;
                  const fadeInPct = s.fadeIn ? Math.min(50, (s.fadeIn / Math.max(dur, 0.01)) * 100) : 0;
                  const fadeOutPct = s.fadeOut ? Math.min(50, (s.fadeOut / Math.max(dur, 0.01)) * 100) : 0;
                  return (
                    <div
                      key={s.id}
                      className="relative shrink-0 px-[1.5px]"
                      style={{ width: `${width}%`, minWidth: "14px" }}
                    >
                      <div
                        onClick={(e) => {
                          setSelected(s.id);
                          if (performance.now() - dragEndedAtRef.current < 300) return;
                          // Seek to the clicked point of the clip (not its
                          // start), so Split right after works there.
                          const r = e.currentTarget.getBoundingClientRect();
                          const f = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
                          onSeekOriginal(Math.max(s.start, Math.min(s.end - 0.05, s.start + f * (s.end - s.start))), s.id);
                        }}
                        data-testid={`clip-${i}`}
                        className="@container group relative flex h-full cursor-pointer flex-col justify-between overflow-clip rounded-md transition-[box-shadow,border-color] duration-150"
                        style={{
                          background: s.disabled
                            ? "var(--surface-2)"
                            : isSel
                              ? "linear-gradient(180deg, rgba(139,92,246,0.45) 0%, rgba(139,92,246,0.22) 100%)"
                              : i % 2 === 0
                                ? "linear-gradient(180deg, rgba(139,92,246,0.24) 0%, rgba(139,92,246,0.10) 100%)"
                                : "linear-gradient(180deg, rgba(167,139,250,0.20) 0%, rgba(167,139,250,0.08) 100%)",
                          border: isSel
                            ? "1px solid var(--brand-hover)"
                            : "1px solid rgba(139,92,246,0.28)",
                          boxShadow: isSel || isDragging ? "var(--shadow-glow)" : "none",
                          opacity: s.disabled ? 0.35 : 1,
                        }}
                      >
                        {/* Fade ramps */}
                        {fadeInPct > 0 && (
                          <div
                            className="pointer-events-none absolute inset-y-0 left-0"
                            style={{
                              width: `${fadeInPct}%`,
                              background: "linear-gradient(90deg, rgba(11,10,16,0.85), rgba(11,10,16,0.15))",
                            }}
                          />
                        )}
                        {fadeOutPct > 0 && (
                          <div
                            className="pointer-events-none absolute inset-y-0 right-0"
                            style={{
                              width: `${fadeOutPct}%`,
                              background: "linear-gradient(270deg, rgba(11,10,16,0.85), rgba(11,10,16,0.15))",
                            }}
                          />
                        )}

                        {!s.disabled && (
                          <>
                            {(["start", "end"] as const).map((mode) => (
                              // Hit area is wider than the visible bar on
                              // touch screens. Without hover, handles only
                              // react on the selected clip so a tap near an
                              // edge selects instead of trimming.
                              <div
                                key={mode}
                                data-testid={`clip-trim-${mode}`}
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  setDraggingId(s.id);
                                  setDragMode(mode);
                                }}
                                onTouchStart={(e) => {
                                  e.stopPropagation();
                                  setDraggingId(s.id);
                                  setDragMode(mode);
                                }}
                                className={`absolute top-0 bottom-0 z-10 w-5 cursor-ew-resize transition-opacity [@media(hover:hover)]:w-2 ${
                                  mode === "start" ? "left-0" : "right-0"
                                } ${
                                  isSel || isDragging
                                    ? "opacity-100"
                                    : "pointer-events-none opacity-0 [@media(hover:hover)]:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100"
                                }`}
                                style={{ touchAction: "none" }}
                              >
                                <div
                                  className={`absolute top-0 bottom-0 flex w-2.5 items-center justify-center [@media(hover:hover)]:w-2 ${
                                    mode === "start" ? "left-0" : "right-0"
                                  }`}
                                  style={{
                                    background: isSel ? "var(--brand)" : "var(--border-strong)",
                                  }}
                                >
                                  <span
                                    className="h-4 w-px rounded-full"
                                    style={{ background: "rgba(255,255,255,0.7)" }}
                                  />
                                </div>
                              </div>
                            ))}
                          </>
                        )}

                        <div className="pointer-events-none relative hidden items-center justify-between gap-1 px-2.5 pt-1 @min-[30px]:flex">
                          {/* Sticky so the labels stay visible when the
                              clip's start is scrolled out of view. */}
                          <span
                            className="sticky left-2.5 text-[9px] font-semibold tabular-nums"
                            style={{ color: isSel ? "var(--brand-strong)" : "var(--text-muted)" }}
                          >
                            {i + 1}
                          </span>
                          {!s.disabled && (
                            <div className="sticky right-2.5 hidden gap-0.5 @min-[64px]:flex">
                              {s.speed && s.speed !== 1 && (
                                <span
                                  className="rounded px-1 text-[8px] font-semibold"
                                  style={{ background: "var(--brand-solid)", color: "white" }}
                                >
                                  {s.speed}×
                                </span>
                              )}
                              {s.volume !== undefined && s.volume !== 1 && (
                                <span
                                  className="rounded px-1 text-[8px] font-semibold"
                                  style={{
                                    background: s.volume === 0 ? "var(--danger)" : "var(--warn)",
                                    color: "white",
                                  }}
                                >
                                  {s.volume === 0 ? t("app.timeline.muteBadge") : `${Math.round(s.volume * 100)}%`}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="pointer-events-none relative hidden px-2.5 pb-1 @min-[40px]:block">
                          <span
                            className="sticky left-2.5 inline-block text-[10px] tabular-nums"
                            style={{
                              color: s.disabled ? "var(--text-faint)" : "var(--text-strong)",
                            }}
                          >
                            {fmt(dur)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Playhead — spans ruler + strip */}
              {playheadPct !== null && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-20"
                  style={{ left: `${playheadPct}%`, transform: "translateX(-50%)" }}
                >
                  <div
                    className="absolute left-1/2 top-0 -translate-x-1/2"
                    style={{
                      width: 0,
                      height: 0,
                      borderLeft: "5px solid transparent",
                      borderRight: "5px solid transparent",
                      borderTop: "7px solid var(--accent)",
                    }}
                  />
                  <div
                    className="mx-auto h-full w-0.5"
                    style={{
                      background: "var(--accent)",
                      boxShadow: "0 0 8px rgba(236,72,153,0.55)",
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Effects panel — only when a segment is selected */}
          {selectedSeg && !selectedSeg.disabled && (
            <div
              className="mt-3 grid grid-cols-1 gap-2 rounded-lg p-3 text-[11px] sm:grid-cols-2"
              style={{
                background: "var(--surface-0)",
                border: "1px solid var(--border)",
              }}
            >
              <div className="col-span-1 flex flex-wrap items-center gap-x-3 gap-y-2 sm:col-span-2">
                <span
                  className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
                >
                  {t("app.timeline.clipLabel", {
                    n: segments.findIndex((x) => x.id === selectedSeg.id) + 1,
                  })}
                </span>
                <span className="tabular-nums" style={{ color: "var(--text-strong)" }}>
                  {fmt(selectedSeg.start)} → {fmt(selectedSeg.end)}
                  <span className="ml-1.5" style={{ color: "var(--text-faint)" }}>
                    ({(selectedSeg.end - selectedSeg.start).toFixed(1)}s)
                  </span>
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <IconButton
                    onClick={() => moveLeft(selectedSeg.id)}
                    data-testid="clip-move-left"
                    className="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] sm:px-2.5 sm:py-1"
                    style={toolBtn}
                    title={t("app.timeline.moveLeft")}
                    label={t("app.timeline.moveLeft")}
                  >
                    <Icon icon={ArrowLeft} />
                  </IconButton>
                  <IconButton
                    onClick={() => moveRight(selectedSeg.id)}
                    data-testid="clip-move-right"
                    className="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[var(--surface-tint)] sm:px-2.5 sm:py-1"
                    style={toolBtn}
                    title={t("app.timeline.moveRight")}
                    label={t("app.timeline.moveRight")}
                  >
                    <Icon icon={ArrowRight} />
                  </IconButton>
                  <button
                    onClick={() => del(selectedSeg.id)}
                    data-testid="clip-delete"
                    className="rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-[rgba(239,107,87,0.12)] sm:px-2.5 sm:py-1"
                    style={{
                      background: "var(--surface-2)",
                      color: "var(--danger)",
                      border: "1px solid rgba(239,107,87,0.3)",
                    }}
                    title={t("app.timeline.deleteTitle")}
                  >
                    <Icon icon={X} /> {t("app.timeline.delete")}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.speed")}</span>
                <select
                  value={selectedSeg.speed ?? 1}
                  data-testid="clip-speed"
                  onChange={(e) => patchSeg(selectedSeg.id, { speed: Number(e.target.value) })}
                  className="flex-1 rounded-md px-2 py-1 text-base sm:text-xs"
                  style={{
                    background: "var(--surface-1)",
                    color: "var(--text-strong)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <option value={0.25}>0.25×</option>
                  <option value={0.5}>0.5×</option>
                  <option value={0.75}>0.75×</option>
                  <option value={1}>{t("app.timeline.speedNormal")}</option>
                  <option value={1.25}>1.25×</option>
                  <option value={1.5}>1.5×</option>
                  <option value={2}>2×</option>
                  <option value={3}>3×</option>
                  <option value={4}>4×</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.volume")}</span>
                <Slider
                  min={0}
                  max={2.5}
                  step={0.05}
                  value={selectedSeg.volume ?? 1}
                  data-testid="clip-volume"
                  onChange={(e) => patchSeg(selectedSeg.id, { volume: Number(e.target.value) })}
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {Math.round(((selectedSeg.volume ?? 1) * 100))}%
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.fadeIn")}</span>
                <Slider
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedSeg.fadeIn ?? 0}
                  data-testid="clip-fade-in"
                  onChange={(e) => patchSeg(selectedSeg.id, { fadeIn: Number(e.target.value) })}
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {(selectedSeg.fadeIn ?? 0).toFixed(1)}s
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-14 text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{t("app.timeline.fadeOut")}</span>
                <Slider
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedSeg.fadeOut ?? 0}
                  data-testid="clip-fade-out"
                  onChange={(e) => patchSeg(selectedSeg.id, { fadeOut: Number(e.target.value) })}
                />
                <span
                  className="w-10 text-right tabular-nums"
                  style={{ color: "var(--text-strong)" }}
                >
                  {(selectedSeg.fadeOut ?? 0).toFixed(1)}s
                </span>
              </div>

              <div className="col-span-1 sm:col-span-2 flex justify-end">
                <button
                  onClick={() =>
                    patchSeg(selectedSeg.id, {
                      speed: 1,
                      volume: 1,
                      fadeIn: 0,
                      fadeOut: 0,
                    })
                  }
                  className="rounded-md px-2 py-1 text-[10px]"
                  style={{
                    background: "transparent",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {t("app.timeline.resetEffects")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
