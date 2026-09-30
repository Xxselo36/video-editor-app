"use client";
/**
 * Timeline dock (UX7a, restyle of the v1 TimelineEditor with its
 * mechanics: timeline/mechanics.ts, useTimelineZoom, the shared undo
 * history). Opens fitted; uniform clips, violet only when selected;
 * Split / Delete / ⋯ Clip only while a clip is selected; a draggable
 * playhead drawn from the playhead store (no React render per frame).
 * No caption track, no waveform (review G3). Filmstrip thumbnails come
 * with 7b (GET /jobs/{id}/filmstrip).
 */
import { Ellipsis, Minus, Plus, Scissors, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type RefObject } from "react";
import { useLang, useT } from "@/i18n";
import type { PlaybackMode } from "@/features/editor/session/useEditSession";
import { usePlayhead, usePlayheadEffect, type PlayheadState, type PlayheadStore } from "@/features/editor/state/playhead";
import type { TimelineHistory } from "@/features/editor/timeline/history";
import {
  canDelete,
  patchSeg,
  playheadCutOf,
  rulerMarks,
  sourceAtCut,
  splittableIndex,
  stripDuration,
  trimBounds,
  trimTo,
  type EditorSeg,
} from "@/features/editor/timeline/mechanics";
import { useTimelineZoom } from "@/features/editor/timeline/useTimelineZoom";
import { kbd } from "../hooks";
import { cutDuration, decimalSeparator, fmtClock, fmtSeconds, seams } from "../model";
import { Popover } from "../Popover";
import s from "../editor.module.css";

export type DockApi = { zoomIn: () => void; zoomOut: () => void; fit: () => void };

export type TimelineDockProps = {
  phone: boolean;
  store: PlayheadStore;
  segments: EditorSeg[];
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

function Cross({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 8 8" width="8" height="8" aria-hidden style={{ display: "block", color }}>
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
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
    rect: DOMRect;
    pxPerSec: number;
    bounds: ReturnType<typeof trimBounds>;
    last: EditorSeg[];
  } | null>(null);
  const dragEndedAt = useRef(0);
  const segs = dragSegs ?? p.segments;
  const totalDur = dragTotal ?? stripDuration(segs);

  const zoom = useTimelineZoom(scrollRef, totalDur, p.phone, p.phone ? 358 : 1400);
  const { contentW, viewW, effPps, fitPps, maxPps, zoomTo, canZoomOut, lastUserScrollRef } = zoom;
  const pps = contentW / totalDur;

  useImperativeHandle(p.apiRef, () => ({
    zoomIn: () => zoomTo(effPps * 1.5, viewW / 2),
    zoomOut: () => zoomTo(effPps / 1.5, viewW / 2),
    fit: () => zoomTo(fitPps, 0),
  }));

  const startTrim = (e: React.PointerEvent, id: string, mode: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const el = stripRef.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const startSegs = p.segments.map((x) => ({ ...x }));
    dragRef.current = {
      id,
      mode,
      startSegs,
      rect,
      pxPerSec: rect.width / totalDur,
      bounds: trimBounds(startSegs, id, p.duration),
      last: startSegs,
    };
    setDragTotal(totalDur);
    setDragSegs(startSegs);
  };
  const moveTrim = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const seconds = (e.clientX - d.rect.left) / d.pxPerSec;
    d.last = trimTo(d.startSegs, d.id, d.mode, seconds, d.bounds);
    setDragSegs(d.last);
  };
  const endTrim = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    dragEndedAt.current = e.timeStamp;
    setDragSegs(null);
    setDragTotal(null);
    p.history.commit(d.last);
  };

  /** A click on a clip selects it and seeks to the clicked point (not its
   *  start), so Split right after works there — not right after a trim. */
  const onClip = (seg: EditorSeg, fraction: number, timeStamp: number) => {
    p.setSelected(seg.id);
    if (timeStamp - dragEndedAt.current < 300) return;
    const d = seg.end - seg.start;
    p.seekOriginal(Math.max(seg.start, Math.min(seg.end - 0.05, seg.start + fraction * d)), seg.id);
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
    layout.current = { segs, pps, contentW, canZoomOut, dragging: dragSegs !== null };
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

  const legend = (
    <div className={s.legend}>
      <span className={s.legendItem}>
        <Cross color="var(--ed-removed)" />
        {t("editor.legend.cut")}
      </span>
    </div>
  );

  // zoom slider: log scale between fit and max
  const zoomRange = Math.log(Math.max(maxPps / fitPps, 1.0001));
  const zoomVal = Math.round((Math.log(effPps / fitPps) / zoomRange) * 100) || 0;

  const clips = useMemo(() => {
    const out: { seg: EditorSeg; i: number; left: number; width: number; padL: number; padR: number }[] = [];
    const sm = seams(segs);
    let acc = 0;
    let k = 0;
    segs.forEach((seg, i) => {
      if (seg.disabled) return;
      const d = seg.end - seg.start;
      const before = k > 0 ? sm[k - 1] : null;
      const after = sm[k] ?? null;
      out.push({
        seg,
        i,
        left: acc,
        width: d,
        padL: before ? (before.cut ? 3 : 1) : 0,
        padR: after ? (after.cut ? 3 : 1) : 0,
      });
      acc += d;
      k++;
    });
    return out;
  }, [segs]);
  const cutSeams = useMemo(() => seams(segs).filter((x) => x.cut), [segs]);
  const { marks, labelStep } = rulerMarks(0, contentW, totalDur, contentW, p.phone ? 48 : 64);

  const strip = (
    <div
      ref={scrollRef}
      className={s.strip}
      data-testid="timeline-scroll"
      onScroll={() => {
        if (!scrubbing.current) lastUserScrollRef.current = Date.now();
      }}
    >
      <div className={s.stripInner} style={{ width: contentW }}>
        <div className={s.ruler} data-testid="timeline-ruler" {...scrubHandlers}>
          {marks.map((m) =>
            m.kind === "tenth" || m.kind === "half" ? null : (
              <span
                key={m.t}
                className={s.tick}
                style={{
                  left: m.x,
                  height: m.kind === "major" ? 7 : 4,
                  background: m.kind === "major" ? "rgba(255,255,255,.26)" : "rgba(255,255,255,.12)",
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
        <div ref={stripRef} className={s.clips}>
          {clips.map(({ seg, i, left, width, padL, padR }) => (
            <ClipView
              key={seg.id}
              seg={seg}
              index={i}
              selected={seg.id === p.selected}
              left={left * pps + padL}
              width={Math.max(2, width * pps - padL - padR)}
              title={t("editor.clipTitle", { n: i + 1, len: fmtSeconds(seg.end - seg.start, dec) })}
              onClip={onClip}
              onTrimStart={startTrim}
              onTrimMove={moveTrim}
              onTrimEnd={endTrim}
            />
          ))}
          {cutSeams.map((x, k) => (
            <div
              key={k}
              className={s.seam}
              style={{ left: x.at * pps }}
              title={t("editor.seamTip", { len: fmtSeconds(x.gap, dec) })}
              aria-hidden
            >
              <span className={s.seamLine} />
              <span className={s.seamGlyph}>
                <Cross color="var(--ed-removed)" />
              </span>
            </div>
          ))}
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
  left,
  width,
  title,
  onClip,
  onTrimStart,
  onTrimMove,
  onTrimEnd,
}: {
  seg: EditorSeg;
  index: number;
  selected: boolean;
  left: number;
  width: number;
  title: string;
  onClip: (seg: EditorSeg, fraction: number, timeStamp: number) => void;
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
      data-testid={`clip-${index}`}
      title={title}
      style={{ left, width }}
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
