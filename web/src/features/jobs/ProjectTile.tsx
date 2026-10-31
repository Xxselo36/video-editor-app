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
 *
 * An upload waiting for "Let's go" (D3) says so and leads back to the
 * start screen ("Continue"), also once it failed (instead of "Try again").
 * Its bytes all stored, its badge says "Uploaded": nothing goes on until
 * "Let's go". Another tab of the browser shows it waiting too (its
 * record says so), without the way back: that start is the other tab's.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowRight, Film, RotateCw, X } from "lucide-react";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT, type TFn } from "@/i18n";
import { fmtMinutes } from "@/lib/account";
import { useMediaUrl } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { describeError, stageText } from "@/lib/errors";
import { plural } from "@/lib/i18n/plural";
import { presetLabelFor, PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { PickMissedHint } from "@/features/start/PickMissedHint";
import { usePickWatch } from "@/features/start/pickWatch";
import { usePreparing } from "@/features/start/usePreparing";
import { originalTooBig, overLimitGb, pickedKind, resumeWithAny, useIsIOS, useVideoAccept } from "@/features/start/videoPicker";
import { canRetryInPlace, cancelUpload, retryUpload, retryUploadWith, runsElsewhere } from "@/features/upload/uploadControls";
import { useAwaitingGo, useLiveUpload, useLocalThumb } from "@/features/upload/uploadState";
import { matchResumable, stoppedTileShowsError, useResumableUploads } from "@/features/upload/useResumable";
import { discardResumable, findRecord } from "@/lib/uploadResume";
import type { UploadSettings } from "@/features/upload/uploadJob";
import type { LastUsedPrefs } from "@/features/start/lastUsed";
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

/** An upload whose bytes are all stored while it waits for "Let's go". */
const STORED_BADGE: (typeof BADGE)[ProjectState] = { key: "app.processing.step.uploaded", tone: "busy" };

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
 *  its workflow's), or null — then the user starts over. `lastUsed`: the
 *  start screen's choices of a video picked there. */
function retrySettings(id: string): { settings: UploadSettings; preset: PresetId | null; lastUsed?: LastUsedPrefs } | null {
  const local = getLocalJob(id);
  const preset = local?.presetId && local.presetId in PRESETS ? (local.presetId as PresetId) : null;
  if (local?.upload?.settings) return { settings: local.upload.settings, preset, lastUsed: local.upload.lastUsed };
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

/** The upload of this record runs in another tab (asked while `ask`,
 *  every few seconds). */
function useRunsElsewhere(id: string, ask: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ask) return;
    let mounted = true;
    const check = () => void runsElsewhere(id).then((v) => mounted && setOn(v));
    check();
    const timer = setInterval(check, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [id, ask]);
  return ask && on;
}

/** "Continue upload" got a file whose bytes don't match the stopped
 *  upload: `other` names the stopped upload they do belong to. */
type Mismatch = { file: File; other: string | null; confirm: boolean; source?: "any" };

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

export function ProjectTile({ p: project, onOpen, onMenuAction }: {
  p: Project;
  onOpen: (href: string) => void;
  onMenuAction: (action: "rename" | "delete", p: Project) => void;
}) {
  const t = useT();
  const lang = useLang();
  const liveUpload = useLiveUpload(project.id);
  // Picked on the start screen, waiting for "Let's go": the way on is
  // back there.
  const awaitingGo = useAwaitingGo(project.id);
  // Running in another tab: shown as running, nothing to cancel, remove
  // or upload again here.
  const elsewhere = useRunsElsewhere(project.id, !liveUpload && (project.state === "uploading" || project.state === "upload_failed"));
  // Still running in this page (waiting for the connection, say) or in
  // another tab: never a stopped tile, whatever the record says.
  const p: Project = (liveUpload || elsewhere) && project.state === "upload_failed" ? { ...project, state: "uploading" } : project;
  // Waiting for "Let's go" here, or in the tab that uploads it.
  const waits = awaitingGo || (elsewhere && Boolean(p.upload?.awaitingGo));
  const fileRef = useRef<HTMLInputElement>(null);
  // iPhone/iPad: the original-formats chooser, and "Pick anyway" (no
  // filter) when iOS gives up on a very large video (features/start/
  // videoPicker, pickWatch).
  const anyRef = useRef<HTMLInputElement>(null);
  const accept = useVideoAccept();
  const ios = useIsIOS();
  const { missed, stalled, watch } = usePickWatch(ios && p.state === "upload_failed");
  const [pickError, setPickError] = useState<string | null>(null);
  // The original picked is over the upload cap (its message).
  const [tooBig, setTooBig] = useState<string | null>(null);
  // "Preparing video…" between the pick and the file (iOS only here).
  const { preparing, arm: armPreparing, done: donePreparing } = usePreparing(null);
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
  // Stored, waiting for "Let's go": not uploading any more.
  const stored = liveUpload ? liveUpload.uploaded : p.upload?.pct === 100;
  const badge = waits && p.state === "uploading" && stored ? STORED_BADGE : BADGE[p.state];
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
        // (Waiting for "Let's go" too: the connection comes first.)
        if (liveUpload?.paused) return t("app.upload.paused");
        if (waits) return t("app.start.waitingForGo");
        if (starting) return t("app.projects.starting");
        return resuming ? t("app.upload.resuming") : t(touchDevice() ? "app.projects.uploadKeepOpenPhone" : "app.projects.uploadKeepOpen");
      case "upload_failed":
        // The reason first (the resume line goes under it).
        if (!stoppedTileShowsError(p.errorCode, Boolean(resumable))) return null;
        return describeError({ code: p.errorCode, params: p.errorParams, refunded: p.refunded }, t, { v2: true });
      case "failed":
        return describeError({ code: p.errorCode, params: p.errorParams, refunded: p.refunded }, t, { v2: true });
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

  // A stopped upload's / failed job's code (snake_case only — never a
  // stored sentence), in small print under its reason.
  const showsCode =
    (p.state === "upload_failed" || p.state === "failed") && typeof p.errorCode === "string" && /^[a-z][a-z0-9_]*$/.test(p.errorCode);

  // Picked with "Pick anyway" (iOS converted it): "Continue upload" opens
  // that chooser again (the other one hands over the original).
  const any = resumeWithAny(ios, getLocalJob(p.id)?.upload?.source ?? resumable?.source);
  const onRetry = () => {
    if (retryUpload(p.id)) return;
    if (ios) {
      watch.opened({ any });
      setPickError(null);
      setTooBig(null);
      armPreparing();
    }
    (any ? anyRef : fileRef).current?.click();
  };
  const chooseAnyway = () => {
    setPickError(null);
    watch.opened({ any: true, fromHint: true });
    armPreparing();
    anyRef.current?.click();
  };
  useEffect(() => {
    // A chooser closed without a file (iOS: maybe it gave up).
    const inputs = [fileRef.current, anyRef.current].filter((i): i is HTMLInputElement => i !== null);
    const onCancel = () => {
      donePreparing();
      watch.cancelled();
    };
    inputs.forEach((i) => i.addEventListener("cancel", onCancel));
    return () => inputs.forEach((i) => i.removeEventListener("cancel", onCancel));
  }, [ios, p.state, watch, donePreparing]);
  // "Continue upload" got a file whose bytes don't match the stopped
  // upload: another video — or, on an iPhone, the same one converted
  // again (the Photos picker may hand over a new copy on every pick).
  // Asked, not refused: it can go up from the start, after a second "yes"
  // (that gives the stopped upload up). The video of ANOTHER stopped
  // upload is pointed to that one's tile (its own settings).
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const upload = (file: File, source?: "any") => {
    setMismatch(null);
    const s = retrySettings(p.id);
    if (!s) {
      removeJob(p.id);
      onOpen("/app/new");
      return;
    }
    void retryUploadWith(p.id, file, s.settings, s.preset, source, s.lastUsed);
  };
  const onPicked = async (e: ChangeEvent<HTMLInputElement>, anyway = false) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    donePreparing();
    if (!file) return;
    // "Pick anyway" lists photos too: only a video goes up.
    const kind = anyway ? pickedKind(file) : "video";
    if (kind !== "video") {
      watch.closed();
      setPickError(t(kind === "audio" ? "app.errors.noVideoTrack" : "app.start.notVideo"));
      return;
    }
    watch.arrived();
    setPickError(null);
    setTooBig(null);
    // iOS: an original over the upload cap isn't uploaded; "Pick anyway"
    // sends the converted copy (features/start/videoPicker).
    if (ios && !anyway) {
      const { limits } = await getConfig();
      if (originalTooBig(file.size, limits.max_upload_bytes, { ios, original: true })) {
        const max = fmtMinutes(limits.max_upload_bytes / 1e9, lang);
        setTooBig(t("app.start.pickTooBig", { size: fmtMinutes(overLimitGb(file.size), lang), max }));
        return;
      }
    }
    const source = anyway ? ("any" as const) : undefined;
    if (resumable) {
      // (A record moved from an older key has a new fp: the size says.)
      const rec = await findRecord(file).catch(() => null);
      if (!rec || (rec.fp !== resumable.fp && rec.size !== resumable.size)) {
        return setMismatch({ file, other: rec?.name ?? null, confirm: false, source });
      }
    }
    upload(file, source);
  };
  const fromStart = () => {
    if (!mismatch || mismatch.other) return;
    if (!mismatch.confirm) return setMismatch({ ...mismatch, confirm: true });
    // The stopped upload can't continue with this copy: it goes.
    if (resumable) void discardResumable(resumable.fp);
    upload(mismatch.file, mismatch.source);
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
        {status && showsCode && (
          // The code under the reason: what support asks for.
          <p data-testid="job-card-code" className="text-[10px] leading-snug" style={{ color: "var(--text-faint)" }}>
            {t("app.projects.errorCode", { code: p.errorCode! })}
          </p>
        )}
        {resumable && (
          <p data-testid="job-card-resume" className="text-xs leading-relaxed" style={{ color: "var(--text-body)" }}>
            {t("app.projects.resumeAt", { pct: resumable.pct })}
          </p>
        )}
        {resumable && mismatch && (
          <div role="alert" data-testid="job-card-mismatch" className="pointer-events-auto relative z-10 flex flex-col items-start gap-1.5">
            <p className="text-xs leading-relaxed" style={{ color: "var(--warn)" }}>
              {mismatch.other
                ? t("app.projects.otherUpload", { name: mismatch.other })
                : mismatch.confirm
                  ? t("app.projects.fromStartConfirm", { pct: resumable.pct })
                  : t(ios ? "app.projects.copyMismatch" : "app.projects.copyMismatchOther", {
                      name: resumable.name,
                    })}
            </p>
            {!mismatch.other && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-testid="job-card-from-start"
                  onClick={fromStart}
                  className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                  style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
                >
                  <Icon icon={RotateCw} />
                  {t(mismatch.confirm ? "app.projects.fromStartYes" : "app.projects.uploadFromStart")}
                </button>
                {mismatch.confirm && (
                  <button
                    type="button"
                    data-testid="job-card-from-start-back"
                    onClick={() => setMismatch(null)}
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                    style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
                  >
                    {t("app.projects.cancel")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {ios && p.state === "upload_failed" &&
          (preparing ? (
            <div className="pointer-events-auto relative z-10 flex flex-col items-start gap-0.5">
              <p role="status" data-testid="job-card-preparing" className="text-xs leading-relaxed" style={{ color: "var(--text-body)" }}>
                {t("app.start.preparing")}
              </p>
              {stalled && (
                // No word from iOS for a long while (features/start/pickWatch).
                <p data-testid="job-card-pick-stalled" className="text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  {t("app.start.stillNothing")}{" "}
                  <button
                    type="button"
                    data-testid="pick-anyway"
                    onClick={chooseAnyway}
                    className="font-semibold underline underline-offset-2"
                    style={{ color: "var(--brand-strong)" }}
                  >
                    {t("app.start.pickAnyway")}
                  </button>
                </p>
              )}
            </div>
          ) : (
            (missed || pickError || tooBig) && (
              <PickMissedHint
                variant="tile"
                testId="job-card-pick-missed"
                className="pointer-events-auto relative z-10"
                onPickAnyway={chooseAnyway}
                error={pickError}
                tooBig={tooBig}
              />
            )
          ))}
        {(uploading || p.state === "upload_failed" || p.state === "expired") && (
          <div className="pointer-events-auto relative z-10 mt-1 flex flex-wrap gap-1.5">
            {awaitingGo && (
              <button
                type="button"
                data-testid="job-card-continue-start"
                onClick={() => onOpen("/app/new")}
                className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
              >
                {t("app.start.continueStart")}
                <Icon icon={ArrowRight} />
              </button>
            )}
            {uploading && !elsewhere && (!starting || liveUpload?.paused) && (
              <button
                type="button"
                data-testid="job-card-cancel"
                onClick={() => void cancelUpload(p.id)}
                className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
              >
                <Icon icon={X} />
                {t("app.projects.cancel")}
              </button>
            )}
            {p.state === "upload_failed" && !awaitingGo && (
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
                  accept={accept}
                  className="hidden"
                  aria-label={t("app.projects.pickAgain")}
                  data-testid="job-card-retry-input"
                  onChange={(e) => void onPicked(e)}
                />
                {ios && (
                  <input
                    ref={anyRef}
                    type="file"
                    className="hidden"
                    aria-label={t("app.start.pickAnyway")}
                    data-testid="job-card-retry-input-any"
                    onChange={(e) => void onPicked(e, true)}
                  />
                )}
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
                // (Beside "Continue" of a waiting upload: as tall as it.)
                className={cx("inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold", awaitingGo && "min-h-11")}
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
