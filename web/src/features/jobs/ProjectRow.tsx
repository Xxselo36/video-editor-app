"use client";
/**
 * One project on Projekte (PR3, plan §6 P3-C and D17; mockup
 * docs/mockups/start/3-projekte.html): a 9:16 frame, the name, a status
 * line and a note, an upload's own buttons.
 *
 * An <article>. A project with something to show opens its Vorschau
 * through a link stretched over the row (job-card-open); the buttons sit
 * above it. While Cleo works on it the row is grey, its frame blurred,
 * and opens nothing; it keeps its nodes when it turns ready, so the frame
 * clears in place and the status line says "Bereit" for as long as the
 * page stays open (screen readers hear it once: useNews). The
 * menu (rename, delete) is on the
 * Vorschau. An expired row requests no frame.
 *
 * An upload waiting for "Let's go" (D3) says so and leads back to the
 * start screen ("Continue"), also once it failed (instead of "Try
 * again"). Its bytes all stored, it says "Uploaded": nothing goes on
 * until "Let's go". Another tab of the browser shows it waiting too (its
 * record says so), without the way back: that start is the other tab's.
 */
import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
import { ArrowRight, ChevronRight, RotateCw, X } from "lucide-react";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { fmtMinutes } from "@/lib/account";
import { useMediaUrl } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/i18n/plural";
import { formatPct } from "@/lib/percent";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import { PickMissedHint } from "@/features/start/PickMissedHint";
import { usePickWatch } from "@/features/start/pickWatch";
import { usePreparing } from "@/features/start/usePreparing";
import { originalTooBig, overLimitGb, pickedKind, resumeWithAny, useIsIOS, useVideoAccept } from "@/features/start/videoPicker";
import { canRetryInPlace, cancelUpload, retryUpload, retryUploadWith, runsElsewhere } from "@/features/upload/uploadControls";
import { useAwaitingGo, useLiveUpload, useLocalThumb, useUploadsRunning } from "@/features/upload/uploadState";
import { matchResumable, stoppedTileShowsError, useResumableUploads } from "@/features/upload/useResumable";
import { discardResumable, findRecord } from "@/lib/uploadResume";
import type { UploadSettings } from "@/features/upload/uploadJob";
import type { LastUsedPrefs } from "@/features/start/lastUsed";
import { forgetArriving, isArriving } from "./arrive";
import { getLocalJob, removeJob } from "./jobsStore";
import { daysLeft, displayName, formatDuration, relativeTime, type Project, type ProjectState } from "./projects";
import s from "./projects.module.css";

/** `data-phase` of a row: the card phases the suites know (+ the new). */
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

/** The job state's hue (plan §0): uploading blue, analysing amber, ready
 *  green, exporting purple, failed red. */
type Dot = "upload" | "busy" | "ready" | "export" | "bad";

/** Where a row leads (null: nowhere): the Vorschau, whose Feinschliff
 *  opens the editor. Not while Cleo works on the video (D17: the
 *  Vorschau tab shows it), nor an upload or an expired project. */
export function openHref(p: Project): string | null {
  switch (p.state) {
    case "ready":
    case "edited":
    case "exporting":
    case "exported":
    case "failed":
      return `/app/p/${p.id}`;
    default:
      return null;
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

/**
 * The row's frame: this device's own (the upload's first frame), else the
 * export's thumbnail, else the analysis' poster, else a plain surface.
 * One that doesn't load gives way to the next. Never for an expired row.
 */
function Thumb({ p }: { p: Project }) {
  const local = useLocalThumb(p.id);
  const gone = p.state === "expired";
  const thumbnail = useMediaUrl(p.id, "thumbnail");
  const poster = useMediaUrl(p.id, "poster");
  const [failed, setFailed] = useState<readonly string[]>([]);
  const src =
    [local, !gone && p.hasOutput ? thumbnail : null, !gone && p.hasPoster ? poster : null].find(
      (u): u is string => Boolean(u) && !failed.includes(u!),
    ) ?? null;
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      data-testid="job-card-thumb"
      className={s.frame}
      onError={() => setFailed((f) => [...f, src])}
    />
  ) : (
    <span className={s.frame} data-testid="job-card-nothumb" />
  );
}

/** What a screen reader hears when the row's state changes while the page
 *  is open (its status line changes without a word: percents, times).
 *  Any other change clears it, so the same news again is news again. */
function newsFor(from: ProjectState, to: ProjectState, renderFailed: boolean): MessageKey | null {
  if (from === "processing") {
    if (to === "ready" || to === "edited") return "app.projects.announceReady";
    return to === "failed" ? "app.projects.announceFailed" : null;
  }
  if (from === "uploading" && to === "upload_failed") return "app.projects.announceUploadStopped";
  if (from === "exporting") {
    if (to === "exported") return "app.projects.announceExported";
    if ((to === "ready" || to === "edited") && renderFailed) return "app.projects.announceExportFailed";
  }
  return null;
}

function useNews(state: ProjectState, renderFailed: boolean): MessageKey | null {
  const [seen, setSeen] = useState(state);
  const [news, setNews] = useState<MessageKey | null>(null);
  if (seen !== state) {
    setSeen(state);
    setNews(newsFor(seen, state, renderFailed));
  }
  return news;
}

/** Turned ready while this row was on screen: "Bereit" (not a time) for
 *  as long as the row stays (plan: fresh until unmount). */
function useFresh(state: ProjectState): boolean {
  const [seen, setSeen] = useState(state);
  const [fresh, setFresh] = useState(false);
  if (seen !== state) {
    setSeen(state);
    if (seen === "processing" && (state === "ready" || state === "edited")) setFresh(true);
  }
  return fresh;
}

export function ProjectRow({ p: project, onOpen }: { p: Project; onOpen: (href: string) => void }) {
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
  // another tab: never a stopped row, whatever the record says.
  const p: Project = (liveUpload || elsewhere) && project.state === "upload_failed" ? { ...project, state: "uploading" } : project;
  // Waiting for "Let's go" here, or in the tab that uploads it.
  const waits = awaitingGo || (elsewhere && Boolean(p.upload?.awaitingGo));
  const uploadsHere = useUploadsRunning();
  const fresh = useFresh(p.state);
  const news = useNews(p.state, p.renderFailed);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Its start was just created: the row enters once.
  const [arrives] = useState(() => isArriving(p.id));
  useEffect(() => forgetArriving(p.id), [p.id]);
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
  const shown = displayName(name);
  // The whole name as the row's tooltip while a mouse is over it, where
  // the row shortens it (its link lies over the name). No title the rest
  // of the time: screen readers would hear the name twice.
  const tipOn = (e: PointerEvent<HTMLElement>) => {
    const h = titleRef.current;
    if (e.pointerType === "mouse" && (shown !== name || (h !== null && h.scrollWidth > h.clientWidth + 1))) e.currentTarget.title = name;
  };
  const tipOff = (e: PointerEvent<HTMLElement>) => e.currentTarget.removeAttribute("title");
  const href = openHref(p);
  // Cleo works on it: grey, blurred, not a way in.
  const busy = p.state === "processing";
  // Stored, waiting for "Let's go": not uploading any more.
  const stored = liveUpload ? liveUpload.uploaded : p.upload?.pct === 100;
  const left = p.state === "expired" ? null : daysLeft(p.expiresAt, now);
  const expiring = left !== null && left <= 3 && (p.state === "exported" || p.state === "ready" || p.state === "edited");
  const uploading = p.state === "uploading";
  const pct = uploading ? (liveUpload?.pct ?? p.upload?.pct ?? 0) : p.progress;
  const resuming = uploading && (liveUpload ? liveUpload.resuming : Boolean(p.upload?.resuming));
  // The file is stored and POST /jobs went out: the job may exist — no
  // cancel any more.
  const starting = uploading && Boolean(liveUpload?.starting || p.upload?.starting);
  const queued = (p.state === "processing" || p.state === "exporting") && p.stage === "queued";
  const length = p.length ? formatDuration(p.length) : null;
  const when = p.createdAt ? relativeTime(p.createdAt, lang, now, t("app.relative.justNow")) : null;
  const joined = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");

  // The status line: a dot in the state's hue while something happens,
  // what happens, else when and how long. A finished row's state word is
  // for screen readers (the line shows only time and length).
  const meta: { dot?: Dot; word?: string; text: string } = (() => {
    switch (p.state) {
      case "uploading":
        if (starting || stored) return { dot: "upload", text: t("app.processing.step.uploaded") };
        return { dot: "upload", text: t("app.start.uploadingPct", { pct: formatPct(pct, lang) }) };
      case "upload_failed":
        return { dot: "bad", text: t("app.projects.badge.uploadFailed") };
      case "unknown":
        return { text: t("app.projects.badge.checking") };
      case "processing":
        return { dot: "busy", text: t("app.projects.badge.processing") };
      case "exporting":
        return { dot: "export", text: t("app.projects.badge.exporting") };
      case "ready":
        return fresh
          ? { dot: "ready", text: joined(t("app.projects.readyNow"), length) }
          : { word: t("app.projects.badge.ready"), text: joined(when, length) };
      case "edited":
        return { text: joined(when, length) };
      case "exported":
        return { word: t("app.projects.badge.exported"), text: joined(when, length) };
      case "failed":
        return { dot: "bad", text: t("app.projects.badge.failed") };
      case "expired":
        return { text: t("app.projects.badge.expired") };
    }
  })();

  // The note under it: why, what next.
  const note = (() => {
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
        // The work runs on the server: the page can go, unless an upload
        // runs in it.
        return p.state === "processing" && !uploadsHere ? t("app.projects.canClose") : null;
      case "ready":
      case "edited":
        if (p.renderFailed) return t("app.card.renderFailedNote");
        return p.state === "edited" ? t("app.projects.badge.edited") : null;
      default:
        return null;
    }
  })();
  const noteTone =
    p.state === "failed" || p.state === "upload_failed"
      ? "bad"
      : p.renderFailed && (p.state === "ready" || p.state === "edited")
        ? "warn"
        : undefined;

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
  // upload is pointed to that one's row (its own settings).
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const upload = (file: File, source?: "any") => {
    setMismatch(null);
    const st = retrySettings(p.id);
    if (!st) {
      removeJob(p.id);
      onOpen("/app/new");
      return;
    }
    void retryUploadWith(p.id, file, st.settings, st.preset, source, st.lastUsed);
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

  const actions = uploading || p.state === "upload_failed" || p.state === "expired";
  return (
    <article
      data-testid="job-card"
      data-phase={PHASE[p.state]}
      data-state={p.state}
      data-fresh={fresh || undefined}
      data-busy={busy || undefined}
      data-arrive={arrives || undefined}
      aria-label={name}
      onPointerEnter={tipOn}
      onPointerLeave={tipOff}
      className={s.row}
    >
      {href && (
        <Link
          href={href}
          prefetch={false}
          data-testid="job-card-open"
          aria-label={t("app.projects.openAria", { name })}
          className={s.open}
        />
      )}
      <span className={s.thumb} aria-hidden="true">
        <Thumb p={p} />
      </span>
      <div className={s.text}>
        <h3 ref={titleRef} className={s.title}>
          <span aria-hidden="true">{shown}</span>
          <span className="sr-only">{name}</span>
        </h3>
        <span role="status" className="sr-only" data-testid="job-card-announce">
          {news ? t(news, { name }) : ""}
        </span>
        <p className={s.meta} data-testid="job-card-meta">
          {meta.dot && <span className={s.dot} data-dot={meta.dot} aria-hidden="true" />}
          {meta.word && <span className="sr-only">{meta.word}, </span>}
          <span className={s.metaText}>{meta.text}</span>
          {expiring && (
            <span className={s.expiry} data-testid="job-card-expiry">
              <span aria-hidden="true">· </span>
              {left === 0
                ? t("app.projects.badge.expiresToday")
                : t(plural(lang, left!, { one: "app.projects.badge.expiresOne", other: "app.projects.badge.expiresOther" }), { n: left! })}
            </span>
          )}
        </p>
        {note && (
          <p data-testid="job-card-status" className={s.note} data-tone={noteTone}>
            {note}
          </p>
        )}
        {note && showsCode && (
          // The code under the reason: what support asks for.
          <p data-testid="job-card-code" className={s.code}>
            {t("app.projects.errorCode", { code: p.errorCode! })}
          </p>
        )}
        {resumable && (
          <p data-testid="job-card-resume" className={s.note}>
            {t("app.projects.resumeAt", { pct: formatPct(resumable.pct, lang) })}
          </p>
        )}
        {resumable && mismatch && (
          <div role="alert" data-testid="job-card-mismatch" className={s.above}>
            <p className={s.note} data-tone="warn">
              {mismatch.other
                ? t("app.projects.otherUpload", { name: mismatch.other })
                : mismatch.confirm
                  ? t("app.projects.fromStartConfirm", { pct: resumable.pct })
                  : t(ios ? "app.projects.copyMismatch" : "app.projects.copyMismatchOther", {
                      name: resumable.name,
                    })}
            </p>
            {!mismatch.other && (
              <div className={s.actions}>
                <button type="button" data-testid="job-card-from-start" onClick={fromStart} className={s.action} data-tone="tint">
                  <Icon icon={RotateCw} />
                  {t(mismatch.confirm ? "app.projects.fromStartYes" : "app.projects.uploadFromStart")}
                </button>
                {mismatch.confirm && (
                  <button type="button" data-testid="job-card-from-start-back" onClick={() => setMismatch(null)} className={s.action}>
                    {t("app.projects.cancel")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {ios && p.state === "upload_failed" &&
          (preparing ? (
            <div className={s.above}>
              <p role="status" data-testid="job-card-preparing" className={s.note}>
                {t("app.start.preparing")}
              </p>
              {stalled && (
                // No word from iOS for a long while (features/start/pickWatch).
                <p data-testid="job-card-pick-stalled" className={s.note}>
                  {t("app.start.stillNothing")}{" "}
                  <button type="button" data-testid="pick-anyway" onClick={chooseAnyway} className={s.inline}>
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
                className={s.above}
                onPickAnyway={chooseAnyway}
                error={pickError}
                tooBig={tooBig}
              />
            )
          ))}
        {actions && (
          <div className={cx(s.actions, s.above)}>
            {awaitingGo && (
              <button type="button" data-testid="job-card-continue-start" onClick={() => onOpen("/app/new")} className={s.action} data-tone="tint">
                {t("app.start.continueStart")}
                <Icon icon={ArrowRight} />
              </button>
            )}
            {uploading && !elsewhere && (!starting || liveUpload?.paused) && (
              <button type="button" data-testid="job-card-cancel" onClick={() => void cancelUpload(p.id)} className={s.action}>
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
                  className={s.action}
                  data-tone="tint"
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
                className={s.action}
              >
                <Icon icon={X} />
                {t("app.card.remove")}
              </button>
            )}
          </div>
        )}
      </div>
      {href && <Icon icon={ChevronRight} className={s.chev} />}
    </article>
  );
}
