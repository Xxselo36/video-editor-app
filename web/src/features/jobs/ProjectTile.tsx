"use client";
/**
 * One project on the Projects page (UX12, flows.md §3.9): a thumbnail in
 * its own aspect ratio (a 16:9 export isn't cropped to 9:16), a status
 * badge, the name (middle-ellipsis, the extension stays), when and how
 * long, one status line, and a ⋯ menu.
 *
 * An <article> with real buttons (T16). The whole tile opens the project
 * (a stretched button under the content); the menu and the upload
 * actions sit above it. An expired tile requests no thumbnail.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Film, RotateCw, X } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT, type TFn } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import { describeError, stageText } from "@/lib/errors";
import { plural } from "@/lib/i18n/plural";
import { presetLabelFor, PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { canRetryInPlace, cancelUpload, retryUpload, retryUploadWith } from "@/features/upload/uploadControls";
import { useLiveUpload, useLocalThumb } from "@/features/upload/uploadState";
import { matchResumable, stoppedTileShowsError, useResumableUploads } from "@/features/upload/useResumable";
import { discardResumable } from "@/lib/uploadResume";
import type { UploadSettings } from "@/features/upload/uploadJob";
import { getLocalJob, removeJob } from "./jobsStore";
import { daysLeft, middleEllipsis, type Project, type ProjectState } from "./projects";
import { ProjectMenu } from "./ProjectMenu";

/** `data-phase` of a tile: the card phases the suites know (+ the new). */
const PHASE: Record<ProjectState, string> = {
  uploading: "uploading",
  upload_failed: "uploading",
  unknown: "unknown",
  processing: "analyzing",
  ready: "reviewing",
  edited: "reviewing",
  exporting: "rendering",
  exported: "done",
  failed: "error",
  expired: "expired",
};

const BADGE: Record<ProjectState, { key: Parameters<TFn>[0]; tone: "brand" | "busy" | "ok" | "bad" | "muted" }> = {
  uploading: { key: "app.projects.badge.uploading", tone: "busy" },
  upload_failed: { key: "app.projects.badge.uploadFailed", tone: "bad" },
  unknown: { key: "app.projects.badge.checking", tone: "muted" },
  processing: { key: "app.projects.badge.processing", tone: "busy" },
  ready: { key: "app.projects.badge.ready", tone: "brand" },
  edited: { key: "app.projects.badge.edited", tone: "brand" },
  exporting: { key: "app.projects.badge.exporting", tone: "busy" },
  exported: { key: "app.projects.badge.exported", tone: "ok" },
  failed: { key: "app.projects.badge.failed", tone: "bad" },
  expired: { key: "app.projects.badge.expired", tone: "muted" },
};

const TONE: Record<string, { bg: string; fg: string }> = {
  brand: { bg: "var(--brand-solid)", fg: "#fff" },
  busy: { bg: "rgba(0,0,0,0.72)", fg: "#fff" },
  ok: { bg: "rgba(0,0,0,0.72)", fg: "#86efac" },
  bad: { bg: "rgba(0,0,0,0.72)", fg: "#fca5a5" },
  muted: { bg: "rgba(0,0,0,0.6)", fg: "#d4d4d8" },
};

/** Where a tile click goes (null: nothing to open). */
export function openHref(p: Project): string | null {
  switch (p.state) {
    case "ready":
    case "edited":
      return `/app/edit/${p.id}`;
    case "processing":
    case "exporting":
    case "exported":
    case "failed":
      return `/app/p/${p.id}`;
    default:
      return null;
  }
}

/** m:ss (h:mm:ss over an hour). */
export function formatDuration(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "3 hours ago" in the UI language (Intl.RelativeTimeFormat, T10). */
export function relativeTime(ms: number, lang: string, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  const [v, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60 ? [s, "second"]
      : abs < 3600 ? [Math.round(s / 60), "minute"]
        : abs < 86_400 ? [Math.round(s / 3600), "hour"]
          : abs < 30 * 86_400 ? [Math.round(s / 86_400), "day"]
            : [Math.round(s / (30 * 86_400)), "month"];
  try {
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(v, unit);
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

/** A touch device: uploads stop when the tab is left or the screen locks. */
function touchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod|Android/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** The settings to upload a picked file again with (the record's, else
 *  its workflow's), or null — then the user starts over. */
function retrySettings(id: string): { settings: UploadSettings; preset: PresetId | null } | null {
  const local = getLocalJob(id);
  const preset = local?.presetId && local.presetId in PRESETS ? (local.presetId as PresetId) : null;
  if (local?.upload?.settings) return { settings: local.upload.settings, preset };
  if (!preset) return null;
  const p = PRESETS[preset].settings;
  return {
    preset,
    settings: {
      caption_preset: p.captionPreset,
      style: p.cutStyle,
      voice_triggers: p.voiceTriggers,
      remove_fillers: p.removeFillers,
      smartcam_enabled: p.smartcamEnabled,
      smartcam_format: p.smartcamFormat,
      resolution: "1080",
      output_formats: p.outputFormats,
    },
  };
}

function Thumb({ p }: { p: Project }) {
  const t = useT();
  const local = useLocalThumb(p.id);
  // Exported once: the server's poster frame. Never for an expired tile.
  const wantServer = p.hasOutput && p.state !== "expired";
  const server = useMediaUrl(p.id, "thumbnail");
  const [failed, setFailed] = useState(false);
  const src = local ?? (wantServer && !failed ? server : null);
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "var(--surface-2)" }}>
      {src ? (
        <>
          {/* The frame twice: blurred to fill the box, and whole on top. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-xl" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            loading="lazy"
            data-testid="job-card-thumb"
            className="absolute inset-0 h-full w-full object-contain"
            onError={() => setFailed(true)}
          />
        </>
      ) : (
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest"
          style={{ color: "var(--text-faint)" }}
          data-testid="job-card-nothumb"
        >
          <Icon icon={Film} size={22} strokeWidth={1.5} />
          {p.state === "expired" ? null : t("app.card.noPreview")}
        </div>
      )}
    </div>
  );
}

export function ProjectTile({ p, onOpen, onMenuAction }: {
  p: Project;
  onOpen: (href: string) => void;
  onMenuAction: (action: "rename" | "delete", p: Project) => void;
}) {
  const t = useT();
  const lang = useLang();
  const liveUpload = useLiveUpload(p.id);
  const fileRef = useRef<HTMLInputElement>(null);
  // A stopped upload whose resume record is still here: "Continue upload"
  // at its percent (the same bytes continue, whatever the file is called).
  const resumables = useResumableUploads();
  const resumable =
    p.state === "upload_failed" && !canRetryInPlace(p.id)
      ? matchResumable(resumables, getLocalJob(p.id)?.fileSize, p.filename)
      : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const name = p.name || t("app.library.untitled");
  const shown = middleEllipsis(name);
  const href = openHref(p);
  const badge = BADGE[p.state];
  const tone = TONE[badge.tone];
  const left = p.state === "expired" ? null : daysLeft(p.expiresAt, now);
  const expiring = left !== null && left <= 3 && (p.state === "exported" || p.state === "ready" || p.state === "edited");
  const uploading = p.state === "uploading";
  const pct = uploading ? (liveUpload?.pct ?? p.upload?.pct ?? 0) : p.progress;
  const resuming = uploading && (liveUpload ? liveUpload.resuming : Boolean(p.upload?.resuming));
  // The file is stored and POST /jobs went out: the job may exist — no
  // cancel any more.
  const starting = uploading && Boolean(liveUpload?.starting || p.upload?.starting);
  const queued = (p.state === "processing" || p.state === "exporting") && p.stage === "queued";
  const showBar = uploading || p.state === "processing" || p.state === "exporting";
  const preset = presetLabelFor(p.presetId, p.presetLabel, t);

  const status = (() => {
    switch (p.state) {
      case "uploading":
        if (starting) return t("app.projects.starting");
        return resuming ? t("app.upload.resuming") : t(touchDevice() ? "app.projects.uploadKeepOpenPhone" : "app.projects.uploadKeepOpen");
      case "upload_failed":
        // The reason first (the resume line goes under it).
        if (!stoppedTileShowsError(p.errorCode, Boolean(resumable))) return null;
        return describeError({ code: p.errorCode, params: p.errorParams, refunded: p.refunded }, t);
      case "failed":
        return describeError({ code: p.errorCode, params: p.errorParams, refunded: p.refunded }, t);
      case "processing":
      case "exporting":
        if (p.note === "cancel_too_late") return t("app.projects.cancelTooLate");
        if (queued) return p.queuePosition ? t("app.card.queued.title", { n: p.queuePosition }) : t("app.card.queued.titleNoPos");
        return stageText(p.stage, p.stageParams, t) ?? t(p.state === "exporting" ? "app.card.rendering.sub" : "app.card.analyzing.sub");
      case "ready":
      case "edited":
        return p.renderFailed ? t("app.card.renderFailedNote") : null;
      case "expired":
        return t("library.card.expired");
      default:
        return null;
    }
  })();
  const statusTone =
    p.state === "failed" || p.state === "upload_failed"
      ? "var(--danger)"
      : p.renderFailed && (p.state === "ready" || p.state === "edited")
        ? "var(--warn)"
        : "var(--text-muted)";

  const onRetry = () => {
    if (retryUpload(p.id)) return;
    fileRef.current?.click();
  };
  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const s = retrySettings(p.id);
    if (!s) {
      removeJob(p.id);
      onOpen("/app/new");
      return;
    }
    retryUploadWith(p.id, file, s.settings, s.preset);
  };

  return (
    <article
      data-testid="job-card"
      data-phase={PHASE[p.state]}
      data-state={p.state}
      aria-label={name}
      className="group relative flex flex-col overflow-hidden rounded-2xl transition-colors"
      style={{
        background: "var(--surface-1)",
        border: `1px solid ${p.state === "failed" || p.state === "upload_failed" ? "#F26E6E55" : "var(--border)"}`,
      }}
    >
      {href && (
        <button
          type="button"
          onClick={() => onOpen(href)}
          data-testid="job-card-open"
          aria-label={t("app.projects.openAria", { name })}
          className="absolute inset-0 z-0 rounded-2xl outline-offset-2 transition-colors hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand)]"
        />
      )}
      <div className="pointer-events-none relative aspect-[4/5] w-full">
        <Thumb p={p} />
        <span
          data-testid="job-card-badge"
          className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: tone.bg, color: tone.fg, backdropFilter: "blur(4px)" }}
        >
          {t(badge.key)}
        </span>
        {expiring && (
          <span
            data-testid="job-card-expiry"
            className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: "rgba(0,0,0,0.72)", color: "#fcd34d", backdropFilter: "blur(4px)" }}
          >
            {left === 0
              ? t("app.projects.badge.expiresToday")
              : t(plural(lang, left!, { one: "app.projects.badge.expiresOne", other: "app.projects.badge.expiresOther" }), { n: left! })}
          </span>
        )}
        {showBar && (
          <div className="absolute inset-x-0 bottom-0 h-1.5" style={{ background: "rgba(0,0,0,0.4)" }}>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label={t(badge.key)}
              className="h-full transition-[width] duration-500"
              style={{ width: `${Math.max(3, Math.min(100, pct))}%`, background: "var(--brand)" }}
            />
          </div>
        )}
      </div>
      <div className="pointer-events-none relative flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-start gap-1">
          <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug" style={{ color: "var(--text-strong)" }} title={name}>
            <span aria-hidden className="block break-all">{shown}</span>
            <span className="sr-only">{name}</span>
          </h3>
          {p.state !== "uploading" && p.state !== "upload_failed" && (
            <div className="pointer-events-auto -mr-1.5 -mt-1 relative z-10">
              <ProjectMenu p={p} onAction={(a) => onMenuAction(a, p)} onOpen={onOpen} />
            </div>
          )}
        </div>
        <div className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
          {[
            p.createdAt ? relativeTime(p.createdAt, lang, now) : null,
            p.duration ? formatDuration(p.duration) : null,
            preset,
          ]
            .filter(Boolean)
            .join(" · ")}
          {uploading && <span className="ml-1">· {Math.round(pct)}%</span>}
          {resumable && <span className="ml-1">· {resumable.pct}%</span>}
        </div>
        {status && (
          <p data-testid="job-card-status" className="text-xs leading-relaxed" style={{ color: statusTone }}>
            {status}
          </p>
        )}
        {resumable && (
          <p data-testid="job-card-resume" className="text-xs leading-relaxed" style={{ color: "var(--text-body)" }}>
            {t("app.projects.resumeAt", { pct: resumable.pct })}
          </p>
        )}
        {(uploading || p.state === "upload_failed" || p.state === "expired") && (
          <div className="pointer-events-auto relative z-10 mt-1 flex flex-wrap gap-1.5">
            {uploading && !starting && (
              <button
                type="button"
                data-testid="job-card-cancel"
                onClick={() => void cancelUpload(p.id)}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
              >
                <Icon icon={X} />
                {t("app.projects.cancel")}
              </button>
            )}
            {p.state === "upload_failed" && (
              <>
                <button
                  type="button"
                  data-testid="job-card-retry"
                  onClick={onRetry}
                  className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                  style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
                  title={canRetryInPlace(p.id) ? undefined : t("app.projects.pickAgain")}
                  data-resume={resumable ? resumable.pct : undefined}
                >
                  <Icon icon={RotateCw} />
                  {t(resumable ? "app.projects.resume" : "app.projects.retry")}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  aria-label={t("app.projects.pickAgain")}
                  data-testid="job-card-retry-input"
                  onChange={onPicked}
                />
              </>
            )}
            {(p.state === "upload_failed" || p.state === "expired") && (
              <button
                type="button"
                data-testid="job-card-remove"
                onClick={() => {
                  if (p.state === "expired") return removeJob(p.id);
                  // Given up: the interrupted upload goes on the server too.
                  if (resumable) void discardResumable(resumable.fp);
                  void cancelUpload(p.id);
                }}
                className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
              >
                <Icon icon={X} />
                {t("app.card.remove")}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
