"use client";
/**
 * The preview's <video> and what sits on it (UX7): the session's playback
 * source (proxy or cut preview, see useEditSession — the same code as the
 * v1 editor), the clip-fade overlay EditPlayer drives, the caption slot,
 * the buffering spinner and the "updating preview" chip of preview mode.
 * No native controls: the PlayerBar is the control surface. A click on
 * the picture plays / pauses (editor.md §4.4).
 */
import dynamic from "next/dynamic";
import { memo, useMemo } from "react";
import { useT } from "@/i18n";
import type { Phrase, Subtitle } from "@/features/editor/legacy/buildPhrases";
import type { EditSession } from "@/features/editor/session/useEditSession";
import { activeIndexAt, usePlayhead, type PlayheadState, type PlayheadStore } from "@/features/editor/state/playhead";
import s from "../editor.module.css";

// UT1: engine captions over the video (flag; its own chunk). UT5's
// CaptionLayer replaces it in this slot.
const CAPTIONS_INTERIM = process.env.NEXT_PUBLIC_CAPTIONS_INTERIM === "1";
const InterimOverlay = dynamic(() => import("@/features/captions-ui/InterimOverlay"), { ssr: false });

const selBuffering = (st: PlayheadState) => st.buffering;

export type CaptionSlotProps = {
  session: EditSession;
  store: PlayheadStore;
  phrases: Phrase[];
  units: { readonly current: Subtitle[] };
  captionPreset: string;
  duration: number;
  /**
   * TODO(UT5): the caption layer reports a click on a caption here
   * (select → size/position adjust, "Nur hier | Überall"). Unused until
   * CaptionLayer lands.
   */
  onCaptionSelect?: (pageIndex: number) => void;
};

/** Plain text of the line under the playhead (flag off: no engine). */
function PlainCaption({ store, phrases, toSource }: { store: PlayheadStore; phrases: Phrase[]; toSource: (t: number) => number }) {
  const starts = useMemo(() => phrases.map((p) => p.original_start), [phrases]);
  const ends = useMemo(() => phrases.map((p) => p.original_end), [phrases]);
  const sel = useMemo(
    () => (st: PlayheadState) => activeIndexAt(starts, ends, toSource(st.mediaTime)),
    [starts, ends, toSource],
  );
  const idx = usePlayhead(store, sel);
  const text = idx >= 0 ? phrases[idx]?.text.trim() : "";
  if (!text) return null;
  return (
    <div
      aria-hidden
      data-testid="caption-overlay"
      style={{ position: "absolute", left: 12, right: 12, top: "66%", display: "flex", justifyContent: "center" }}
    >
      <span
        style={{
          maxWidth: "90%",
          padding: "2px 8px",
          borderRadius: 6,
          textAlign: "center",
          fontWeight: 800,
          fontSize: 17,
          lineHeight: 1.2,
          color: "#fff",
          background: "rgba(0,0,0,0.35)",
          textShadow: "0 2px 6px rgba(0,0,0,0.9)",
        }}
      >
        {text}
      </span>
    </div>
  );
}

function CaptionSlotImpl({ session, store, phrases, units, captionPreset, duration }: CaptionSlotProps) {
  const { mode, editSegs, videoSegments, keptSegments, videoRef, toSource } = session;
  const segments = useMemo(
    () =>
      mode === "proxy"
        ? editSegs.filter((x) => !x.disabled).map((x) => [x.start, x.end] as const)
        : videoSegments.length
          ? videoSegments
          : keptSegments,
    [mode, editSegs, videoSegments, keptSegments],
  );
  if (captionPreset === "none") return null;
  return (
    <div data-testid="ed-caption-slot" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 1 }}>
      {CAPTIONS_INTERIM ? (
        <InterimOverlay
          videoRef={videoRef}
          phrases={phrases}
          units={units}
          captionPreset={captionPreset}
          mode={mode}
          segments={segments}
          duration={duration}
        />
      ) : (
        <PlainCaption store={store} phrases={phrases} toSource={toSource} />
      )}
    </div>
  );
}
const CaptionSlot = memo(CaptionSlotImpl);

export function VideoLayer({
  session,
  store,
  phrases,
  units,
  captionPreset,
  duration,
  onCaptionSelect,
  tapToPlay,
  paused,
}: CaptionSlotProps & { tapToPlay?: boolean; paused?: boolean }) {
  const t = useT();
  const { videoRef, fadeRef, videoSrc, mode, onVideoError, togglePlay, editSaving } = session;
  const buffering = usePlayhead(store, selBuffering);
  return (
    <>
      <video
        ref={videoRef}
        src={videoSrc ?? undefined}
        data-playback={mode}
        data-testid="editor-video"
        className={s.video}
        // The proxy can't be played after all (gone, codec): fall back to
        // the server-built preview (session).
        onError={onVideoError}
        onClick={togglePlay}
        playsInline
        // metadata only: don't pull the whole preview over mobile data
        // before the user presses play.
        preload="metadata"
        aria-label={t("editor.preview")}
      />
      <CaptionSlot
        session={session}
        store={store}
        phrases={phrases}
        units={units}
        captionPreset={captionPreset}
        duration={duration}
        onCaptionSelect={onCaptionSelect}
      />
      {/* Clip fades (proxy mode), driven by EditPlayer. Over the captions,
          as the render fades burned-in subtitles too. */}
      <div ref={fadeRef} aria-hidden className={s.fade} />
      {editSaving && mode !== "proxy" && (
        <div className={s.stageChip} data-testid="preview-updating">
          {t("app.review.updatingPreview")}
        </div>
      )}
      {buffering && <div className={s.spinner} aria-hidden data-testid="ed-buffering" />}
      {tapToPlay && (
        <button
          type="button"
          className={s.tapPlay}
          aria-label={paused ? t("editor.play") : t("editor.pause")}
          title={t("editor.playTip")}
          onClick={togglePlay}
        >
          {paused && (
            <span className={s.tapGlyph} aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M7 4.5v15l12.5-7.5z" />
              </svg>
            </span>
          )}
        </button>
      )}
    </>
  );
}
