"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { ArrowRight, ArrowUp, CircleAlert, Play, Sparkle, X, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Progress } from "@/components/ui/Progress";
import { useT } from "@/i18n";
import type { ActiveJobV2 } from "@/lib/activeJobs";
import { friendlyError, jobErrorText, localizeKnown } from "@/lib/errors.legacy";
import { presetLabelFor } from "@/features/start/presets.legacy";
import type { CardStatus } from "./types";

// Compact card for an in-progress job. The copy is deliberately warm
// and non-technical — we translate the backend's phase into a plain
// "we're doing X" sentence instead of dumping ffmpeg / whisper jargon
// on the user. Progress bar shows movement; the % lives in the corner
// as a small tabular number.
export function ActiveJobCard({
  job,
  status,
  onOpen,
  onRetry,
}: {
  job: ActiveJobV2;
  status?: CardStatus;
  onOpen: () => void;
  onRetry?: () => void;
}) {
  const t = useT();
  const isError = status?.status === "error" || Boolean(job.error);
  // Waiting for a free analysis / render slot (backend admission queue).
  const queued =
    !isError &&
    (job.phase === "analyzing" || job.phase === "rendering") &&
    status?.status === "processing" &&
    status.message === "queued";
  const phaseCopy: Record<ActiveJobV2["phase"], { title: string; sub: string; icon: LucideIcon }> = {
    uploading: {
      title: t("app.card.uploading.title"),
      sub: t("app.card.uploading.sub"),
      icon: ArrowUp,
    },
    analyzing: {
      title: t("app.card.analyzing.title"),
      sub: t("app.card.analyzing.sub"),
      icon: Sparkle,
    },
    reviewing: {
      title: t("app.card.reviewing.title"),
      sub: t("app.card.reviewing.sub"),
      icon: Play,
    },
    rendering: {
      title: t("app.card.rendering.title"),
      sub: t("app.card.rendering.sub"),
      icon: Sparkle,
    },
  };
  const presetLabel = presetLabelFor(job.presetId, job.presetLabel, t);
  const phaseAccent: Record<ActiveJobV2["phase"], string> = {
    uploading: "#5A9FFF",
    analyzing: "#F5B54D",
    reviewing: "#4ECC77",
    rendering: "#B979FF",
  };
  const pct =
    job.phase === "uploading" ? job.uploadPct ?? 0 : status?.progress ?? 0;
  const canOpen = job.phase === "reviewing" && !isError;
  const copy =
    job.phase === "uploading" && job.resuming
      ? { ...phaseCopy.uploading, sub: t("app.upload.resuming") }
      : phaseCopy[job.phase];
  const accent = phaseAccent[job.phase];

  return (
    <button
      onClick={canOpen ? onOpen : undefined}
      // Error cards stay enabled: a disabled <button> swallows clicks on
      // its children, which made the "Try again" chip below dead.
      disabled={!canOpen && !isError}
      data-testid="job-card"
      data-phase={job.phase}
      className={`group relative flex flex-col overflow-hidden rounded-2xl p-4 text-left transition-all ${
        canOpen ? "cursor-pointer hover:-translate-y-0.5" : "cursor-default"
      }`}
      style={{
        background: "var(--surface-1)",
        border: `1px solid ${
          isError
            ? "#F26E6E55"
            : canOpen
              ? accent + "80"
              : "var(--border)"
        }`,
        boxShadow: canOpen ? `0 4px 24px ${accent}20` : "none",
      }}
    >
      {/* Ambient accent glow — same treatment as preset cards */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-30 blur-2xl"
        style={{ background: isError ? "#F26E6E" : accent }}
      />

      {/* Header row: filename + preset chip */}
      <div className="relative z-10 mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-bold"
            style={{ color: "var(--text-strong)" }}
          >
            {job.filename}
          </div>
          {presetLabel && (
            <div
              className="mt-0.5 text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-faint)" }}
            >
              {presetLabel}
            </div>
          )}
        </div>
        {canOpen ? (
          <div
            data-testid="job-card-open"
            className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-transform group-hover:translate-x-0.5"
            style={{ background: accent, color: "#0f0f0f" }}
          >
            {t("app.card.open")} <Icon icon={ArrowRight} />
          </div>
        ) : (
          <div
            className="shrink-0 text-lg leading-none opacity-70"
            style={{ color: isError ? "#F26E6E" : accent }}
          >
            <Icon icon={isError ? CircleAlert : copy.icon} />
          </div>
        )}
      </div>

      {/* Status line */}
      {isError ? (
        <div
          data-testid="job-card-status"
          className="relative z-10 mb-3 text-xs"
          style={{ color: "#F26E6E" }}
        >
          {job.error || !status ? friendlyError(job.error, t) : jobErrorText(status, t)}
        </div>
      ) : (
        <div
          data-testid="job-card-status"
          className="relative z-10 mb-3 text-xs leading-relaxed"
          style={{ color: job.note ? "var(--warn)" : "var(--text-body)" }}
        >
          {job.note ? localizeKnown(job.note, t) : queued ? t("app.card.queued.sub") : copy.sub}
        </div>
      )}

      {/* Progress bar for non-review phases */}
      {job.phase !== "reviewing" && !isError && (
        <div className="relative z-10">
          <Progress value={pct} color={accent} min={3} label={copy.title} />
          <div
            className="mt-1.5 flex items-center justify-between text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            <span>
              {queued
                ? status?.queuePosition
                  ? t("app.card.queued.title", { n: status.queuePosition })
                  : t("app.card.queued.titleNoPos")
                : copy.title}
            </span>
            {!queued && <span className="tabular-nums">{Math.round(pct)}%</span>}
          </div>
        </div>
      )}

      {/* Error retry */}
      {isError && onRetry && (
        <span
          data-testid="job-card-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          className="relative z-10 mt-1 inline-flex w-fit cursor-pointer items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
          }}
        >
          <Icon icon={X} />
          {t("app.card.remove")}
        </span>
      )}
    </button>
  );
}
