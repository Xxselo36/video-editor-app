"use client";
/**
 * The export sheet of the v2 editor (UX11; DF mock "Desktop-Export" /
 * "Handy-Export"): a modal on desktop, a bottom sheet on the phone.
 *
 *   confirm    what is exported ("9:16 · 0:28") and what it costs —
 *              exportsInfo.costLine: "Free", the free exports left, or
 *              the minutes it records; "ready instantly" when nothing
 *              changed since the analysis (speculative render)
 *   saving /   progress with the stage; "You can leave" (the project
 *   rendering  page and its card show the rest)
 *   done       the Done view (download, share, post text, SRT / VTT,
 *              Edit again)
 *   failed     the cause, Try again; the edit is intact. The 2nd failure
 *              in a row says so ("We've been notified": the backend
 *              reports every render failure to Sentry)
 */
import { CircleHelp, Download, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLang, useT } from "@/i18n";
import { useMe } from "@/lib/account";
import { stageText } from "@/lib/errors";
import { DoneView } from "@/features/project/DoneView";
import { clock, costHelp, costLine } from "@/features/project/exportsInfo";
import type { ExportFlow } from "./useExportFlow";
import s from "./exportSheet.module.css";

export function ExportSheet({
  flow,
  phone,
  aspect,
  seconds,
  offline,
  reexport,
  onNewVideo,
}: {
  flow: ExportFlow;
  phone: boolean;
  /** The output frame ("9:16"); default: the job's (output_aspect). */
  aspect?: string | null;
  /** The cut's length on screen. */
  seconds: number;
  offline: boolean;
  /** The project was exported before (its export stays until this one). */
  reexport: boolean;
  onNewVideo: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const me = useMe().me;
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [help, setHelp] = useState(false);
  const { phase, job } = flow;

  const closeRef = useRef(flow.close);
  useEffect(() => {
    closeRef.current = flow.close;
  });
  useEffect(() => {
    if (phase === "closed") return;
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.({ preventScroll: true });
    };
    // once per opening, not per phase
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "closed"]);

  if (phase === "closed") return null;

  const remaining =
    me?.minutes != null ? (me.minutes.remaining_seconds ?? Math.round(me.minutes.remaining * 60)) : null;
  const cost = job ? costLine(job, t, lang, remaining) : null;
  const helpText = job ? costHelp(job, t) : null;
  const frame = aspect ?? job?.output_aspect ?? null;
  const summary = [frame && frame !== "original" ? frame : null, clock(seconds)].filter(Boolean).join(" · ");

  const title =
    phase === "done"
      ? t("app.export.doneTitle")
      : phase === "failed"
        ? t("app.export.failedTitle")
        : phase === "confirm"
          ? t("app.export.title")
          : t("app.export.exportingTitle");
  const canClose = phase !== "saving";
  const progress = job?.status === "processing" ? Math.max(1, Math.min(100, job.progress || 0)) : null;
  const stage =
    phase === "saving"
      ? t("app.export.saving")
      : (job?.status === "processing" && stageText(job.stage, job.stage_params, t)) || t("app.export.starting");

  return (
    <div
      className={s.scrim}
      data-phone={phone}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && (phase === "confirm" || phase === "failed")) flow.close();
      }}
    >
      <div
        ref={box}
        className={s.dialog}
        data-wide={phase === "done" && !phone}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="export-sheet"
        data-phase={phase}
      >
        {phone && <span className={s.handle} aria-hidden />}
        <div className={s.head}>
          <h2 id={titleId} className={s.title}>
            {title}
          </h2>
          {canClose && (
            <button
              type="button"
              className={s.icon}
              aria-label={phase === "rendering" ? t("app.export.leave") : t("editor.close")}
              title={phase === "rendering" ? t("app.export.leave") : t("editor.close")}
              onClick={flow.close}
              data-testid="export-close"
            >
              <X size={18} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>

        {phase === "confirm" && (
          <>
            <div className={s.summary}>
              <p className={s.line} style={{ fontVariantNumeric: "tabular-nums" }} data-testid="export-summary">
                {summary}
              </p>
              <div className={s.cost} data-testid="export-cost">
                <span>{cost ? cost.text : t("app.export.costLoading")}</span>
                {helpText && (
                  <button
                    type="button"
                    className={s.icon}
                    style={{ width: 22, height: 22, marginTop: -2 }}
                    aria-label={t("app.export.costHelpLabel")}
                    title={t("app.export.costHelpLabel")}
                    aria-expanded={help}
                    onClick={() => setHelp((v) => !v)}
                  >
                    <CircleHelp size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </div>
              {cost?.note && (
                <p className={`${s.muted} ${cost.note === t("app.export.costOverQuota") ? s.warn : ""}`} data-testid="export-cost-note">
                  {cost.note}
                </p>
              )}
              {help && helpText && <p className={s.help}>{helpText}</p>}
              {reexport && <p className={s.muted}>{t("app.export.previousStays")}</p>}
              {offline && <p className={`${s.muted} ${s.warn}`}>{t("editor.exportOffline")}</p>}
            </div>
            <div className={s.actions}>
              <button type="button" className={s.ghost} onClick={flow.close} data-testid="export-cancel">
                {t("app.export.cancel")}
              </button>
              <button
                type="button"
                className={s.primary}
                onClick={flow.confirm}
                disabled={offline}
                data-testid="export-confirm"
              >
                <Download size={16} strokeWidth={1.75} aria-hidden />
                {t("app.export.exportNow")}
              </button>
            </div>
          </>
        )}

        {(phase === "saving" || phase === "rendering") && (
          <div aria-live="polite">
            <p className={s.line} data-testid="export-stage">
              {stage}
              {progress !== null && <span className={s.muted}>{`  ${Math.round(progress)} %`}</span>}
            </p>
            <div className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined} aria-label={stage}>
              <div
                className={s.barFill}
                data-indeterminate={progress === null}
                style={progress !== null ? { width: `${progress}%` } : undefined}
              />
            </div>
            <p className={s.muted}>{t("app.export.canLeave")}</p>
            {job?.queue_position ? (
              <p className={s.muted}>{t("app.export.queued", { n: job.queue_position })}</p>
            ) : null}
          </div>
        )}

        {phase === "failed" && (
          <>
            <p className={s.error} role="alert" data-testid="export-error">
              {/* the real reason first (a 429 / 503 says what to do) */}
              {flow.error ?? (flow.failures >= 2 ? t("app.export.failedAgain") : t("app.export.editsSafe"))}
            </p>
            {(flow.failures >= 2 || flow.error) && (
              <p className={s.muted} style={{ marginTop: 8 }}>
                {t("app.export.editsSafe")}
              </p>
            )}
            <div className={s.actions}>
              <button type="button" className={s.ghost} onClick={flow.close}>
                {t("editor.close")}
              </button>
              <button type="button" className={s.primary} onClick={flow.retry} disabled={offline} data-testid="export-retry">
                {t("app.export.tryAgain")}
              </button>
            </div>
          </>
        )}

        {phase === "done" && job && (
          <div className={s.done}>
            {flow.instant && (
              <p className={s.muted} style={{ textAlign: "center" }} data-testid="export-instant">
                {t("app.export.instantDone")}
              </p>
            )}
            <DoneView
              job={job}
              inEditor
              onEditAgain={flow.editAgain}
              editAgainBusy={flow.reopening}
              editAgainError={flow.reopenError}
              onNewVideo={onNewVideo}
            />
          </div>
        )}
      </div>
    </div>
  );
}
