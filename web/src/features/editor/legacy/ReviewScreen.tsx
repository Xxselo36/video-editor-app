"use client";
// The v1 editor (moved from app/app/page.tsx in UX4): player in
// proxy or preview mode, timeline, transcript and captions tabs, the
// autosave with flush-on-leave, and Apply & render. The session logic
// (playback source, timeline autosave, apply) lives in
// features/editor/session/useEditSession.ts since UX7, shared with the
// v2 shell.
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Pencil, Play, Timer, Type, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, SectionLabel } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { Tabs } from "@/components/ui/Tabs";
import { useLang, useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { publicUrl } from "@/lib/api";
import { audioWarningText } from "@/lib/errors";
import { plural } from "@/lib/i18n/plural";
import { PlaybackDebug } from "@/features/editor/debug/PlaybackDebug";
import { fmtTime, fmtTimecode } from "@/features/editor/format";
import { cutClockOf, sourceTimeOf, useEditSession } from "@/features/editor/session/useEditSession";
import { TimelineEditor } from "@/features/editor/timeline/TimelineEditor";
import type { CutRange, SavedSeg } from "@/features/jobs/types";
import { captionLabel } from "@/features/start/presets.legacy";
import { CaptionsV2Marker } from "@/features/captions-ui/CaptionsV2Marker";
import type { Phrase, Subtitle } from "./buildPhrases";

// UT1: engine captions over the editor video (flag; its own chunk).
const CAPTIONS_INTERIM = process.env.NEXT_PUBLIC_CAPTIONS_INTERIM === "1";
const InterimOverlay = dynamic(() => import("@/features/captions-ui/InterimOverlay"), { ssr: false });

export function ReviewScreen({
  jobId,
  savedSegments,
  previewSegments,
  previewVersion,
  hasProxy,
  phrases,
  units,
  captionPreset,
  audioWarnings,
  formatWarning = null,
  cutRanges,
  duration,
  onChange,
  onApply,
  applyNote = null,
  onBack,
}: {
  jobId: string;
  savedSegments: SavedSeg[];
  previewSegments: [number, number][];
  previewVersion: number;
  /** GET /jobs/{id} has_proxy: true / false, undefined = not reported. */
  hasProxy: boolean | undefined;
  phrases: Phrase[];
  units: { readonly current: Subtitle[] };
  captionPreset: string;
  audioWarnings: string[];
  /** job.format_warning in words (UX6: speaker tracking failed, the
   *  video was centre-cropped), or null. */
  formatWarning?: string | null;
  cutRanges: CutRange[];
  duration: number;
  onChange: (p: Phrase[]) => void;
  onApply: () => void;
  /** UX11: what a re-export costs (billed viewers), under the button. */
  applyNote?: string | null;
  onBack: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [formatWarningClosed, setFormatWarningClosed] = useState(false);
  const {
    videoRef,
    fadeRef,
    videoSrc,
    mode,
    onVideoError,
    keptSegments,
    videoSegments,
    editSegs,
    commitEditSegs,
    saveError,
    editSaving,
    applying,
    applyError,
    apply,
    playingSegId,
    seekToPhrase,
    seekOriginal,
    togglePlay,
  } = useEditSession({ jobId, savedSegments, previewSegments, previewVersion, hasProxy, cutRanges, duration, onApply });
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const phraseRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Poll video.currentTime every animation frame while playing.
  // onTimeUpdate only fires ~4x/sec (browser throttle) which lags the
  // active-phrase highlight visibly behind the spoken word. rAF hits
  // ~60fps so the highlight lands on the syllable.
  // Throttled to ~12 updates/s: every update re-renders the whole
  // editor (timeline, transcript), and 60/s pegged phone CPUs on long
  // videos. 80 ms is still well under a spoken syllable.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let rafId = 0;
    let last = -1;
    const tick = () => {
      if (!video.paused && !video.ended) {
        const t = video.currentTime;
        if (Math.abs(t - last) >= 0.08) {
          last = t;
          setCurrentTime(t);
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The playhead on the ORIGINAL (source) timeline (session: sourceTimeOf).
  const originalTime = useMemo(
    () => sourceTimeOf(currentTime, mode, videoSegments, keptSegments, duration),
    [mode, currentTime, videoSegments, keptSegments, duration],
  );

  const [activeTab, setActiveTab] = useState<
    "timeline" | "transcript" | "style"
  >("timeline");

  // The chip on the video: the playhead's place in the EDIT and the
  // edit's length (the native control bar shows the file's own time —
  // the whole source in proxy mode). Same mapping as the timeline readout.
  const cutClock = cutClockOf(editSegs, originalTime, playingSegId, mode);

  // The preview follows the user's edited timeline, so phrases are
  // matched on SOURCE time (original_start / original_end) against the
  // playhead mapped back through the segments of the playing preview.
  useEffect(() => {
    const idx = phrases.findIndex(
      (p) => originalTime >= p.original_start && originalTime <= p.original_end,
    );
    setActiveIdx(idx === -1 ? null : idx);
  }, [originalTime, phrases]);

  // Keep the active phrase visible in the transcript container. Uses
  // getBoundingClientRect (not offsetTop) so it works regardless of
  // the container's positioned ancestor, and always scrolls so the
  // active block sits at ~30% from the top — upcoming lines stay in
  // sight, past lines fall off cleanly.
  useEffect(() => {
    if (activeIdx === null) return;
    if (videoRef.current?.paused) return;
    const container = transcriptScrollRef.current;
    const el = phraseRefs.current[activeIdx];
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const relativeTop = (eRect.top - cRect.top) + container.scrollTop;
    const desiredOffset = container.clientHeight * 0.3;
    container.scrollTo({
      top: Math.max(0, relativeTop - desiredOffset),
      behavior: "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx]);

  // The line's text when its field got focus (words_edited on blur).
  const editStartRef = useRef<string | null>(null);
  const updateText = (idx: number, text: string) => {
    const next = phrases.slice();
    next[idx] = { ...next[idx], text };
    onChange(next);
  };
  // Deleting a line is instant, with a few seconds to undo it.
  const [lastRemoved, setLastRemoved] = useState<{ idx: number; phrase: Phrase } | null>(null);
  const removedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remove = (idx: number) => {
    track("words_edited", { action: "line_deleted" });
    setLastRemoved({ idx, phrase: phrases[idx] });
    if (removedTimer.current) clearTimeout(removedTimer.current);
    removedTimer.current = setTimeout(() => setLastRemoved(null), 6000);
    onChange(phrases.filter((_, i) => i !== idx));
  };
  const undoRemove = () => {
    if (!lastRemoved) return;
    track("undo", { area: "transcript" });
    const next = phrases.slice();
    next.splice(Math.min(lastRemoved.idx, next.length), 0, lastRemoved.phrase);
    onChange(next);
    setLastRemoved(null);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="editor" data-editor-root>
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          data-testid="editor-back"
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          <Icon icon={ArrowLeft} /> {t("app.review.backToDashboard")}
        </button>
      </div>

      {formatWarning && !formatWarningClosed && (
        <div
          role="status"
          data-testid="format-warning"
          className="flex items-start justify-between gap-3 rounded-xl border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-3 text-xs text-[var(--warn)]"
        >
          <span>{formatWarning}</span>
          <button
            type="button"
            onClick={() => setFormatWarningClosed(true)}
            aria-label={t("editor.close")}
            className="-m-1 shrink-0 rounded p-1 hover:bg-[var(--warn)]/10"
          >
            <Icon icon={X} />
          </button>
        </div>
      )}

      {audioWarnings.length > 0 && (
        <div className="rounded-xl border border-[var(--warn)]/30 bg-[var(--warn)]/10 p-3 text-xs text-[var(--warn)]">
          <div className="mb-1 font-semibold uppercase tracking-wider">
            {t("app.review.audioHeadsUp")}
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {audioWarnings.map((w, i) => (
              <li key={i}>{audioWarningText(w, t)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Server-rendered cut preview — continuous MP4 with all
          enabled segments concatenated, so playback is always smooth
          (no client-side seek hops). Rebuild happens in the background
          via a debounced POST; we swap src only while paused so the
          user never sees a reload mid-playback. */}
      <div className="group relative overflow-hidden rounded-xl bg-[var(--surface-1)]">
        <video
          ref={videoRef}
          src={videoSrc ?? undefined}
          data-playback={mode}
          data-testid="editor-video"
          // The proxy can't be played after all (gone, codec): fall back
          // to the server-built preview.
          onError={onVideoError}
          controls
          // No download (it would be the source or a draft preview, not
          // the export), no speed menu (in proxy mode it would show the
          // clip's effective rate, not the user's speed; EditPlayer still
          // copes with browsers that ignore this), no casting.
          controlsList="nodownload noplaybackrate noremoteplayback"
          playsInline
          // metadata only: don't pull the whole preview over mobile data
          // before the user presses play.
          preload="metadata"
          // Seeks while paused (rAF loop only runs while playing).
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          className="block max-h-[55vh] w-full bg-[var(--surface-0)]"
        />
        {/* Live caption preview: the current transcript line, so the
            user sees their text on the video before rendering. (The
            exact caption style is applied in the final render.) */}
        {CAPTIONS_INTERIM && captionPreset !== "none" && (
          <InterimOverlay
            videoRef={videoRef}
            phrases={phrases}
            units={units}
            captionPreset={captionPreset}
            mode={mode}
            segments={mode === "proxy" ? editSegs.filter((s) => !s.disabled).map((s) => [s.start, s.end] as const) : videoSegments.length ? videoSegments : keptSegments}
            duration={duration}
          />
        )}
        {!CAPTIONS_INTERIM && captionPreset !== "none" && activeIdx !== null && phrases[activeIdx]?.text.trim() && (
          <div
            aria-hidden
            data-testid="caption-overlay"
            className="pointer-events-none absolute inset-x-3 bottom-12 flex justify-center"
          >
            <span
              className="max-w-[90%] rounded-md px-2 py-1 text-center text-base font-extrabold leading-tight sm:text-lg"
              style={{
                color: "#fff",
                background: "rgba(0,0,0,0.35)",
                textShadow: "0 2px 6px rgba(0,0,0,0.9)",
              }}
            >
              {phrases[activeIdx].text}
            </span>
          </div>
        )}
        {/* Clip fades (proxy mode), faded in and out by EditPlayer. Drawn
            over the captions, as the render fades burned-in subtitles
            too. Hidden while the pointer is over the video so the native
            control bar under it stays readable. */}
        {mode === "proxy" && (
          <div
            ref={fadeRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-black opacity-0 group-hover:opacity-0!"
          />
        )}
        {cutClock.total > 0 && (
          <div
            data-testid="editor-cut-time"
            className="pointer-events-none absolute left-3 top-3 rounded-full px-2.5 py-1 font-mono text-[11px] tabular-nums"
            style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
          >
            {fmtTimecode(cutClock.at)} / {fmtTimecode(cutClock.total)}
          </div>
        )}
        <PlaybackDebug videoRef={videoRef} mode={mode} />
        {/* Proxy mode has no preview to update: the edit already plays. */}
        {editSaving && mode !== "proxy" && (
          <div
            data-testid="preview-updating"
            className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold backdrop-blur-md"
            style={{
              background: "rgba(0,0,0,0.55)",
              color: "var(--brand-strong)",
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {t("app.review.updatingPreview")}
          </div>
        )}
      </div>

      {/* Tab bar — clean 3-way switch for the editor */}
      <Tabs
        tabs={[
          { id: "timeline", label: t("app.review.tabTimeline"), icon: <Icon icon={Timer} size="1em" className="mx-[0.1075em]" /> },
          { id: "transcript", label: t("app.review.tabTranscript"), icon: <Icon icon={Type} size="0.61em" /> },
          { id: "style", label: t("app.review.tabCaptions"), icon: <Icon icon={Pencil} /> },
        ]}
        active={activeTab}
        onChange={setActiveTab}
        testIdPrefix="editor-tab"
      />

      {/* Timeline tab — everything for cut/trim/effects lives here */}
      {/* Stays mounted when another tab is open (just hidden), so undo
          history, zoom and scroll position survive tab switches. */}
      {editSegs.length > 0 && duration > 0 && (
        <div style={{ display: activeTab === "timeline" ? undefined : "none" }}>
        <TimelineEditor
          segments={editSegs}
          duration={duration}
          playhead={originalTime}
          playheadSegId={mode === "proxy" ? playingSegId : null}
          open={activeTab === "timeline"}
          saving={editSaving}
          saveError={saveError}
          onToggleOpen={() => {}}
          onCommit={(next) => void commitEditSegs(next)}
          onSeekOriginal={seekOriginal}
          getVideoTime={() => originalTime}
          onPlayPauseKey={togglePlay}
        />
        </div>
      )}

      {/* Transcript tab — phrase-level text editing */}
      {activeTab === "transcript" && lastRemoved && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
        >
          <span style={{ color: "var(--text-body)" }}>{t("app.transcript.lineDeleted")}</span>
          <Button variant="tint" size="sm" onClick={undoRemove} data-testid="transcript-undo">
            <Icon icon={Undo2} /> {t("app.transcript.undo")}
          </Button>
        </div>
      )}
      {activeTab === "transcript" && (
        <Card>
          <div
            className="border-b px-4 pt-3 pb-2"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-1)",
            }}
          >
            <SectionLabel>
              {t(
                plural(lang, phrases.length, { one: "app.transcript.headingOne", other: "app.transcript.headingOther" }),
                { count: phrases.length },
              )}
            </SectionLabel>
            <div className="mt-0.5 text-[11px] text-[var(--text-faint)]">
              {t("app.transcript.hint")}
            </div>
          </div>
          <div
            ref={transcriptScrollRef}
            className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto p-3"
          >
            {phrases.length === 0 && (
              <div className="rounded-xl border border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
                {t("app.transcript.empty")}
              </div>
            )}
            {phrases.map((p, i) => {
              const isActive = i === activeIdx;
              const lowConfidence = p.confidence < 0.6;
              let extraClass = "border border-[var(--border)]";
              if (isActive) {
                extraClass =
                  "border border-[var(--brand)] bg-[var(--brand-tint)] " +
                  "ring-2 ring-[var(--brand-hover)]/50 shadow-[0_0_20px_var(--brand-glow)]";
              } else if (lowConfidence) {
                extraClass = "border border-[var(--warn)]/60 bg-[var(--warn)]/[0.04]";
              }
              return (
                <div
                  key={i}
                  ref={(el) => {
                    phraseRefs.current[i] = el;
                  }}
                  onClick={() => seekToPhrase(p)}
                  data-testid="transcript-line"
                  className={`relative cursor-pointer rounded-xl p-3 transition-all ${extraClass}`}
                >
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute -left-1 top-1/2 -translate-y-1/2 h-8 w-1 rounded-full"
                      style={{
                        background: "var(--brand-hover)",
                        boxShadow: "0 0 8px var(--brand-glow)",
                      }}
                    />
                  )}
                  <div className="mb-1.5 flex items-center justify-between">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        seekToPhrase(p);
                      }}
                      data-testid="transcript-seek"
                      className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-strong)]"
                    >
                      <Icon icon={Play} size="0.5em" className="fill-current" /> {fmtTime(p.original_start)}
                    </button>
                    <div className="flex items-center gap-2">
                      {lowConfidence && (
                        <span className="text-[9px] uppercase tracking-wider text-[var(--warn)]">
                          {t("app.transcript.verify")}
                        </span>
                      )}
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(i);
                        }}
                        className="-m-2 flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-faint)] hover:text-[var(--danger)]"
                        label={t("app.transcript.deleteSentence")}
                        title={t("app.transcript.deleteSentence")}
                      >
                        <Icon icon={X} />
                      </IconButton>
                    </div>
                  </div>
                  <textarea
                    value={p.text}
                    // Analytics: one words_edited per line edit (focus → blur).
                    onFocus={() => {
                      editStartRef.current = p.text;
                    }}
                    onBlur={() => {
                      if (editStartRef.current !== null && editStartRef.current !== p.text) {
                        track("words_edited", { action: "text" });
                      }
                      editStartRef.current = null;
                    }}
                    onChange={(e) => updateText(i, e.target.value)}
                    rows={Math.min(4, Math.max(1, Math.ceil(p.text.length / 38)))}
                    className="w-full resize-none bg-transparent text-base leading-snug text-[var(--text-strong)] focus:outline-none"
                  />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Captions tab — style picker */}
      {activeTab === "style" && (
        <Card className="p-4">
          <SectionLabel className="mb-3">
            {t("app.captions.styleHeading", { style: captionPreset })}
          </SectionLabel>
          {captionPreset !== "none" ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3"
              style={{ background: "var(--surface-0)" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={publicUrl(`/caption-previews/${captionPreset}.png?w=240&h=90`)}
                alt={t("app.configure.captionPreviewAlt", { style: captionPreset })}
                className="h-14 w-40 rounded-md object-cover"
              />
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {t("app.captions.appliedToOutput")}
                </div>
                <div className="text-sm font-medium capitalize">{captionLabel(captionPreset, t)}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">
              {t("app.captions.disabled")}
            </div>
          )}
        </Card>
      )}

      <Button
        size="lg"
        // Save the timeline on screen, then render (session: apply).
        onClick={apply}
        // Only the render itself blocks the button — autosaves no
        // longer flip it to "Preparing…" every few seconds.
        disabled={applying}
        data-testid="apply-render"
        className="mt-1 w-full"
      >
        {applying ? t("app.review.preparing") : t("app.review.applyRender")}
      </Button>
      <CaptionsV2Marker style={{ textAlign: "center", color: "var(--text-muted)" }} />
      {applyNote && (
        <div className="text-center text-xs" style={{ color: "var(--text-muted)" }} data-testid="apply-note">
          {applyNote}
        </div>
      )}
      {applyError && (
        <div className="text-center text-xs" style={{ color: "var(--danger)" }} data-testid="apply-error">
          {applyError}
        </div>
      )}
    </div>
  );
}
