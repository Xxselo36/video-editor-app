"use client";
// Moved from app/app/page.tsx (UX4).
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Minus, Plus, Redo2, SquareSplitHorizontal, Undo2, X } from "lucide-react";
import { Card, SectionLabel } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { Slider } from "@/components/ui/Slider";
import { useLang, useT } from "@/i18n";
import { plural } from "@/lib/i18n/plural";
import { fmtTimecode } from "@/features/editor/format";
import { keyTargetAllowed } from "@/features/editor/shortcuts/keymap";
import { useTimelineHistory } from "./history";
import {
  canDelete,
  patchSeg as patchSegs,
  playheadCutOf,
  sourceAtCut,
  splitAt,
  splittableIndex,
  stripDuration,
  trimBounds,
  trimTo,
  type EditorSeg,
} from "./mechanics";
import { RulerTicks } from "./RulerTicks";
import { useTimelineZoom } from "./useTimelineZoom";

export type { EditorSeg } from "./mechanics";

// Timeline editor with per-segment trim, split, delete, reorder.
// Segments are rendered as blocks in a horizontal strip proportional
// to their duration. Handles on the left/right edges let the user drag
// to trim; a Delete button removes a segment (soft-disable so it can
// be restored); Split at playhead splits the current block into two;
// drag-and-drop reorders. All edits POST to the backend which rebuilds
// the preview MP4. The mechanics (trim, split, zoom, history) live in
// ./mechanics, ./history and ./useTimelineZoom, shared with the v2 dock.

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
  const lang = useLang();
  const [selected, setSelected] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragMode, setDragMode] = useState<"start" | "end" | null>(null);
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
  const totalDur = dragTotalRef.current ?? stripDuration(displaySegs);
  const activeCount = displaySegs.filter((s) => !s.disabled).length;

  const fmt = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Undo/redo (./history): commit() pushes the clip list it replaces;
  // `coalesce` groups a slider drag into ONE undo step.
  const { commit, undo, redo, history, future } = useTimelineHistory(segments, onCommit);

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
    const bounds = trimBounds(startSegs, draggingId, duration);

    const handleMove = (e: MouseEvent | TouchEvent) => {
      // Touch: keep the page / strip from scrolling under the finger.
      if (e.cancelable && "touches" in e) e.preventDefault();
      const clientX =
        (e as TouchEvent).touches?.[0]?.clientX ?? (e as MouseEvent).clientX;
      const relX = clientX - stripRect.left;
      // May be negative: dragging the first clip's start handle past the
      // strip's left edge brings back footage before it.
      const seconds = relX / pxPerSec;

      const next = trimTo(startSegs, draggingId, dragMode, seconds, bounds);
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
    if (!canDelete(segments, id)) {
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
  const splittable = (at: number) => splittableIndex(segments, at);
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
    commit(splitAt(segments, idx, at));
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
    commit(patchSegs(segments, id, patch), `${id}:${Object.keys(patch).sort().join(",")}`);
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
      const target = e.target instanceof Element ? e.target : null;
      const onPage = !target || target === document.body || target === document.documentElement;
      // Target filtering: shortcuts/keymap.ts (UX3, tech.md T4).
      if (!keyTargetAllowed(e, target, onPage)) return;
      const meta = e.metaKey || e.ctrlKey;
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
  const playheadCut = playheadCutOf(segments, playhead, playheadSegId);
  const playheadPct =
    playheadCut !== null ? Math.min(100, (playheadCut / totalDur) * 100) : null;

  // Zoom (0 = fit), the anchor-keeping zoomTo, wheel / pinch gestures and
  // the visible width: ./useTimelineZoom. Re-attached when the strip
  // mounts (`open`).
  const { viewW, effPps, fitPps, contentW, canZoomIn, canZoomOut, zoomTo, lastUserScrollRef } =
    useTimelineZoom(scrollRef, totalDur, open);

  // Click on the ruler → seek. Converts cut-timeline x into the
  // original time of whichever clip sits there.
  const seekFromRuler = (clientX: number) => {
    const el = stripRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cut = Math.max(0, Math.min(totalDur, ((clientX - rect.left) / rect.width) * totalDur));
    const at = sourceAtCut(segments, cut);
    if (at) onSeekOriginal(at.t, at.segId);
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
              {t(plural(lang, activeCount, { one: "app.timeline.clipsOne", other: "app.timeline.clipsOther" }), {
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
              <Icon icon={SquareSplitHorizontal} size="0.75em" /> {t("app.timeline.split")}
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
