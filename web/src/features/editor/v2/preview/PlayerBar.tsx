"use client";
/**
 * Player bar (editor.md §4.4): play/pause, the clock on the CUT timeline
 * (the edit, not the file: no "0:35 vs 0:28"), mute, fullscreen. The
 * clock is written to the DOM from the playhead store — playing never
 * re-renders React for it. The phone row carries undo/redo instead of
 * mute.
 */
import { Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useRef, type ReactNode } from "react";
import { useLang, useT } from "@/i18n";
import { cutClockOf, type PlaybackMode } from "@/features/editor/session/useEditSession";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { usePlayhead, usePlayheadEffect, type PlayheadState, type PlayheadStore } from "@/features/editor/state/playhead";
import { decimalSeparator, fmtClock, fmtClockTenths } from "../model";
import s from "../editor.module.css";

const selPlaying = (st: PlayheadState) => st.playing;
const selMuted = (st: PlayheadState) => st.muted;

export function PlayerBar({
  store,
  phone,
  width,
  editSegs,
  toSource,
  playingSegId,
  mode,
  onTogglePlay,
  onToggleMute,
  onFullscreen,
  extra,
}: {
  store: PlayheadStore;
  phone: boolean;
  width?: number;
  editSegs: EditorSeg[];
  toSource: (t: number) => number;
  playingSegId: string | null;
  mode: PlaybackMode;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onFullscreen: () => void;
  /** Phone: undo / redo between the clock and fullscreen. */
  extra?: ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const playing = usePlayhead(store, selPlaying);
  const muted = usePlayhead(store, selMuted);
  const clockRef = useRef<HTMLSpanElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  const dec = decimalSeparator(lang);

  const write = useCallback(
    (st: PlayheadState) => {
      const c = cutClockOf(editSegs, toSource(st.mediaTime), playingSegId, mode);
      const a = fmtClockTenths(c.at, dec);
      const b = ` / ${fmtClock(c.total)}`;
      if (clockRef.current && clockRef.current.textContent !== a) clockRef.current.textContent = a;
      if (totalRef.current && totalRef.current.textContent !== b) totalRef.current.textContent = b;
    },
    [editSegs, toSource, playingSegId, mode, dec],
  );
  usePlayheadEffect(store, write);

  const btn = `${phone ? s.mb : s.gb} ${s.ico}`;
  const icon = phone ? 20 : 18;
  return (
    <div className={s.playerBar} style={phone ? undefined : { width }} data-testid="ed-playerbar">
      <button
        type="button"
        className={`${btn} ${s.hi}`}
        aria-label={playing ? t("editor.pause") : t("editor.play")}
        title={t("editor.playTip")}
        onClick={onTogglePlay}
        data-testid="ed-play"
      >
        {playing ? (
          <Pause size={icon} strokeWidth={1.75} aria-hidden />
        ) : (
          <Play size={icon} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      <span className={`${s.mono} ${s.clock}`} data-testid="editor-cut-time">
        <span ref={clockRef}>0:00{dec}0</span>
        <span ref={totalRef} className={s.clockTotal} />
      </span>
      <span className={s.flex1} />
      {extra}
      {!phone && (
        <button
          type="button"
          className={btn}
          aria-label={t("editor.mute")}
          aria-pressed={muted}
          title={t("editor.muteTip")}
          onClick={onToggleMute}
          data-testid="ed-mute"
        >
          {muted ? (
            <VolumeX size={icon} strokeWidth={1.75} aria-hidden />
          ) : (
            <Volume2 size={icon} strokeWidth={1.75} aria-hidden />
          )}
        </button>
      )}
      <button
        type="button"
        className={btn}
        aria-label={t("editor.fullscreen")}
        title={t("editor.fullscreenTip")}
        onClick={onFullscreen}
        data-testid="ed-fullscreen"
      >
        <Maximize size={icon - 2} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
