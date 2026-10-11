"use client";
/**
 * /app/new (UX6, PLAN 3.6, flows.md §2.2): one start screen instead of
 * the workflow picker → file → settings steps. Choosing (or dropping) a
 * file starts the upload at once; the format chips and the "Change"
 * settings above it stay editable until the upload is done — POST /jobs
 * reads them when it goes out (uploadJob: SettingsSource). Then the
 * dashboard shows the job's card.
 *
 * - Limits (GET /config) and the minutes left show before any file.
 * - A local probe greys out 16:9 for a vertical video (the server
 *   decides anyway: SmartCam from the real video).
 * - After the chooser closes, "Preparing video…" until the file arrives
 *   (./usePreparing; iOS may download or convert it first). On iOS the
 *   chooser offers the original formats (./videoPicker); when iOS gives
 *   up on a very large video (./pickWatch), a hint says why and "Pick
 *   anyway" opens the chooser without a format filter (iOS converts the
 *   video). The same with an original over the upload cap, and "Other
 *   video formats" opens that chooser at once. An upload that came from
 *   it resumes with it.
 * - An interrupted upload (a reload, a dead phone: lib/uploadResume) is
 *   offered on top: picking a file with the same content — whatever its
 *   name — continues it where R2 has it; another file starts a new
 *   upload and leaves the interrupted one for later. "Discard" aborts it.
 * - No caption style here: the editor owns it (defaults.ts). The one
 *   saved in its Style tab ("Save as default", captionDefault.ts) goes
 *   with the upload: its preset as the hint, the whole style once the
 *   job exists.
 */
import { ChevronDown, RotateCw, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { Progress } from "@/components/ui/Progress";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { fmtMinutes, useMe } from "@/lib/account";
import { getActiveJobs } from "@/lib/activeJobs";
import { track } from "@/lib/analytics";
import { useConfig } from "@/lib/config";
import { getLibrary } from "@/lib/library";
import { readLocalJobs } from "@/features/jobs/localJobs";
import { isUploading, loadUploadCode, startUpload, useLiveUpload } from "@/features/upload/uploadManager";
import { useResumableUploads } from "@/features/upload/useResumable";
import { discardResumable } from "@/lib/uploadResume";
import { VoiceTestDialog } from "@/features/voice-test/VoiceTestDialog";
import {
  ASPECTS,
  DEFAULT_SETTINGS,
  sameSettings,
  uploadSettings,
  type JobSettings,
  type TargetAspect,
} from "./defaults";
import { PickMissedHint } from "./PickMissedHint";
import { STALL_MS, usePickWatch } from "./pickWatch";
import { isPortrait, probeVideo, type VideoProbe } from "./probe";
import { languageName, SettingsPanel } from "./SettingsSheet";
import { useBillingHint } from "./useBillingHint";
import { usePrefs } from "./usePrefs";
import { applyToNewJob } from "./captionDefault";
import { originalTooBig, overLimitGb, pickedKind, resumeWithAny, useIsIOS, useVideoAccept } from "./videoPicker";
import { usePreparing } from "./usePreparing";

const ASPECT_SUB: Record<TargetAspect, MessageKey | null> = {
  "9:16": "app.start.formatVertical",
  "16:9": "app.start.formatWide",
  original: null,
};

const PHONE_QUERY = "(max-width: 639px)";
function subscribePhone(cb: () => void) {
  const m = window.matchMedia(PHONE_QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const usePhone = () =>
  useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);

/** m:ss of `seconds`. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Upload = { tempId: string | null; name: string };

export function StartScreen() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const config = useConfig();
  const billingHint = useBillingHint();
  const { me } = useMe();
  const prefs = usePrefs();
  const phone = usePhone();
  // iPhone/iPad: read after hydration (the server render says no).
  const ios = useIsIOS();
  // The chooser's formats: the original ones on iOS (./videoPicker).
  const accept = useVideoAccept();
  // iOS gave up on the video (the chooser closed, no file came), or no
  // word from it for a long while (stalled).
  const { missed, stalled, watch } = usePickWatch(ios);
  // Why the last "Pick anyway" file wasn't taken (not a video).
  const [pickError, setPickError] = useState<string | null>(null);
  // iOS: the original picked is over the upload cap (its message).
  const [tooBig, setTooBig] = useState<string | null>(null);
  // "Preparing video…": on iOS until the file or a cancel comes (the
  // pick watch speaks up after STALL_MS); elsewhere off after STALL_MS.
  const { preparing, slow: preparingSlow, arm: armPreparing, done: donePreparing } = usePreparing(ios ? null : STALL_MS);

  const [settings, setSettings] = useState<JobSettings>(DEFAULT_SETTINGS);
  // The saved defaults apply once they are read — unless the user
  // already changed something.
  const [touched, setTouched] = useState(false);
  const [appliedPrefs, setAppliedPrefs] = useState(false);
  if (prefs.ready && !appliedPrefs) {
    setAppliedPrefs(true);
    if (!touched && prefs.saved) setSettings({ ...DEFAULT_SETTINGS, ...prefs.saved });
  }
  // What POST /jobs reads when it goes out (after the upload).
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const change = (patch: Partial<JobSettings>) => {
    setTouched(true);
    setSaveState("idle");
    setSettings((cur) => ({ ...cur, ...patch }));
  };

  const [open, setOpen] = useState(false);
  const [voiceHelp, setVoiceHelp] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [probe, setProbe] = useState<VideoProbe | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [hasDashboard, setHasDashboard] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // iOS: "Pick anyway" (no format filter: iOS converts the video).
  const anyRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  // Set once a file was taken: a second pick, drop or double tap
  // meanwhile must not start a second upload — a second job, charged
  // twice.
  const startedRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    // Read once after mount: the server render has no storage.
    // (This device's Projects list — UX12 — or the lists of before.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasDashboard(readLocalJobs().length > 0 || getActiveJobs().length > 0 || getLibrary().length > 0);
    // The upload code now, not when the file is picked (a deploy
    // meanwhile would take this build's chunk away).
    loadUploadCode().catch(() => {});
    // Links from before UX6 (/app/new?step=file|settings): one screen now.
    if (new URLSearchParams(window.location.search).has("step")) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  const live = useLiveUpload(upload?.tempId ?? "");
  // The newest interrupted upload of this browser (none while this
  // screen uploads).
  const resumables = useResumableUploads();
  const resume = upload === null ? (resumables?.[0] ?? null) : null;
  const [discarding, setDiscarding] = useState(false);
  const discard = async (fp: string) => {
    setDiscarding(true);
    try {
      await discardResumable(fp);
    } finally {
      if (mounted.current) setDiscarding(false);
    }
  };
  const portrait = isPortrait(probe);
  // A vertical video asked for 16:9 is treated as original (the server
  // does the same): no pillarbox.
  useEffect(() => {
    if (portrait && settings.targetAspect === "16:9") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSettings((cur) => ({ ...cur, targetAspect: "original" }));
    }
  }, [portrait, settings.targetAspect]);

  /** `source` "any": from the unfiltered iOS input (kept with the
   *  upload: a resume opens that input again). */
  const takeFile = (f: File | null, source?: "any") => {
    donePreparing();
    if (!f || startedRef.current) return;
    // (A slow export that arrives after all: the hint goes.)
    watch.arrived();
    setPickError(null);
    setTooBig(null);
    // This very file is uploading already (started here before, the
    // user came back): its card is on the dashboard — no second upload,
    // and nothing to wait for here.
    if (isUploading(f)) {
      router.push("/app");
      return;
    }
    startedRef.current = true;
    // Projects in this browser and no saved defaults: keep Clipper
    // (review D11). Read before this upload's own card goes up.
    const returning =
      !prefs.saved && (readLocalJobs().length > 0 || getActiveJobs().length > 0 || getLibrary().length > 0);
    // The caption style saved in the editor's Style tab: its preset goes
    // as the hint, the whole style once the job exists (captionDefault.ts).
    const captionStyle = prefs.captionStyle;
    const s = settingsRef.current;
    track("file_chosen", {
      preset: "start",
      target_aspect: s.targetAspect,
      pace: s.pace,
      size_mb: Math.round(f.size / 1e6),
      video: f.type.startsWith("video/"),
    });
    setUpload({ tempId: null, name: f.name });
    void probeVideo(f).then((p) => mounted.current && setProbe(p));
    const captionPreset = captionStyle?.presetId ?? null;
    void startUpload(f, () => uploadSettings(settingsRef.current, { returning, captionPreset }), null, {
      source,
      onCard: (tempId) => mounted.current && setUpload({ tempId, name: f.name }),
      onCreated: (jobId) => {
        if (captionStyle) void applyToNewJob(jobId, captionStyle);
      },
      // Created, or failed (its card says why): the dashboard shows it.
      onEnd: () => {
        if (mounted.current) router.push("/app");
      },
    });
  };

  const choose = () => {
    if (startedRef.current) return;
    if (ios) {
      watch.opened();
      setPickError(null);
      setTooBig(null);
    }
    armPreparing();
    inputRef.current?.click();
  };
  // iOS: the chooser without a format filter (iOS converts the video), a
  // photo or an audio file picked there isn't uploaded (the hint says so
  // and stays). From the hint ("Pick anyway"): it comes back on a cancel.
  const chooseAny = (fromHint: boolean) => {
    if (startedRef.current) return;
    setPickError(null);
    if (!fromHint) setTooBig(null);
    watch.opened({ any: true, fromHint });
    armPreparing();
    anyRef.current?.click();
  };
  const chooseAnyway = () => chooseAny(true);
  const takeAnyway = (f: File | null) => {
    if (!f) return;
    const kind = pickedKind(f);
    if (kind !== "video") {
      donePreparing();
      watch.closed();
      setPickError(t(kind === "audio" ? "app.errors.noVideoTrack" : "app.start.notVideo"));
      return;
    }
    takeFile(f, "any");
  };
  useEffect(() => {
    // A cancelled chooser: nothing is coming (iOS: maybe it gave up).
    const inputs = [inputRef.current, anyRef.current].filter((i): i is HTMLInputElement => i !== null);
    const onCancel = () => {
      donePreparing();
      watch.cancelled();
    };
    inputs.forEach((i) => i.addEventListener("cancel", onCancel));
    return () => inputs.forEach((i) => i.removeEventListener("cancel", onCancel));
  }, [ios, watch, donePreparing]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    takeFile(e.dataTransfer.files?.[0] ?? null);
  };

  const save = async () => {
    setSaveState("saving");
    const ok = await prefs.save(settingsRef.current);
    setSaveState(ok ? "saved" : "failed");
  };
  const savedSame =
    saveState !== "failed" && prefs.saved !== null && sameSettings({ ...DEFAULT_SETTINGS, ...prefs.saved }, settings);

  const { limits, spoken_languages } = config;
  const gb = fmtMinutes(limits.max_upload_bytes / 1e9, lang);
  /** The original-formats input: on iOS an original over the upload cap
   *  isn't uploaded; "Pick anyway" sends the converted copy instead. */
  const takeOriginal = (input: HTMLInputElement) => {
    const f = input.files?.[0] ?? null;
    if (f && !startedRef.current && originalTooBig(f.size, limits.max_upload_bytes, { ios, original: true })) {
      // (The same video again must fire change again.)
      input.value = "";
      donePreparing();
      watch.arrived();
      setPickError(null);
      setTooBig(t("app.start.pickTooBig", { size: fmtMinutes(overLimitGb(f.size), lang), max: gb }));
      return;
    }
    takeFile(f);
  };
  const limitsLine =
    limits.max_seconds !== null
      ? t("app.start.limits", { minutes: fmtMinutes(limits.max_seconds / 60, lang), gb })
      : t("app.start.limitsNoLength", { gb });
  const languages = spoken_languages.filter((l) => l !== "auto");

  const summary = [
    t(settings.pace === "tight" ? "app.start.summaryTight" : settings.pace === "smooth" ? "app.start.summarySmooth" : "app.start.summaryNone"),
    ...(settings.pace !== "none" && settings.removeFillers ? [t("app.start.summaryFillers")] : []),
    ...(settings.pace !== "none" && settings.voiceTriggers ? [t("app.start.summaryVoice")] : []),
    ...(settings.spokenLanguage !== "auto" ? [languageName(settings.spokenLanguage, lang)] : []),
  ].join(" · ");

  const minutesLeft = me?.minutes ? Math.max(0, me.minutes.remaining) : null;
  const panel = (
    <SettingsPanel
      settings={settings}
      onChange={change}
      languages={languages}
      locked={upload !== null}
      onVoiceHelp={() => {
        // One dialog at a time: the sheet closes (focus goes back to
        // "Change", where the voice test returns it).
        if (phone) setOpen(false);
        setVoiceHelp(true);
      }}
      onSave={() => void save()}
      saveState={savedSame ? "same" : saveState}
    />
  );

  return (
    <div className="relative z-10 flex flex-col gap-6" data-testid="start-screen">
      {hasDashboard && (
        <Link
          href="/app"
          data-testid="start-back"
          className="-mb-2 inline-flex w-fit items-center gap-1.5 text-sm text-[var(--text-muted)] transition-opacity hover:opacity-70"
        >
          <Icon icon={ArrowLeft} className="text-base" />
          {t("app.picker.backToDashboard")}
        </Link>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-3xl font-bold tracking-tight text-[var(--text-strong)] sm:text-4xl">{t("app.start.title")}</h1>
        {billingHint && (
          <Link
            href={billingHint.href}
            data-testid="start-minutes"
            className="text-xs font-medium text-[var(--brand-strong)] transition-opacity hover:opacity-80"
          >
            {billingHint.text}
          </Link>
        )}
      </div>

      {resume && (
        <div
          role="region"
          aria-labelledby="start-resume-text"
          data-testid="start-resume"
          className="rounded-2xl border border-[var(--brand)] bg-[var(--brand-tint)] p-4"
        >
          <p id="start-resume-text" className="flex items-start gap-2 text-sm font-medium text-[var(--text-strong)]">
            <Icon icon={RotateCw} className="mt-0.5 shrink-0 text-[var(--brand-strong)]" />
            <span className="min-w-0 break-words">{t("app.start.resumeCard", { name: resume.name, pct: resume.pct })}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              // Picked with "Pick anyway" (iOS converted it): that chooser
              // again, the other one hands over different bytes.
              onClick={resumeWithAny(ios, resume.source) ? () => chooseAny(false) : choose}
              data-testid="start-resume-choose"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--brand-solid)] px-4 text-sm font-semibold text-white hover:bg-[var(--brand-solid-hover)]"
            >
              <Icon icon={Upload} />
              {t("app.start.resumeChoose")}
            </button>
            <button
              type="button"
              onClick={() => void discard(resume.fp)}
              disabled={discarding}
              data-testid="start-resume-discard"
              className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-[var(--text-body)] hover:bg-[var(--surface-1)] disabled:opacity-50"
            >
              {t("app.start.resumeDiscard")}
            </button>
          </div>
        </div>
      )}

      {upload === null ? (
        <div>
          <button
            type="button"
            onClick={choose}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            data-testid="upload-dropzone"
            aria-describedby="start-limits"
            className="group flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] px-6 py-6 text-center transition-colors hover:border-[var(--brand)] sm:py-12"
          >
            <span className="hidden items-center gap-3 text-sm text-[var(--text-body)] sm:flex">
              <Icon icon={Upload} className="text-lg text-[var(--brand)]" />
              {t("app.start.drop")}
            </span>
            <span className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--brand-solid)] px-6 py-3 text-base font-semibold text-white group-hover:bg-[var(--brand-solid-hover)]">
              <Icon icon={Upload} className="sm:hidden" />
              {t("app.start.choose")}
            </span>
          </button>
          {ios && (
            <>
              <p className="mt-2 text-center text-xs text-[var(--text-muted)]" data-testid="start-ios-hint">
                {t("app.start.iosHint")}
              </p>
              {/* MOV / MP4 / HEVC only in the chooser above (./videoPicker). */}
              <div className="-my-1.5 text-center">
                <button
                  type="button"
                  onClick={() => chooseAny(false)}
                  data-testid="start-other-formats"
                  className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-[var(--brand-strong)] underline underline-offset-2 hover:opacity-80"
                >
                  {t("app.start.otherFormats")}
                </button>
              </div>
            </>
          )}
          <p id="start-limits" className="mt-2 text-center text-xs text-[var(--text-muted)]" data-testid="start-limits">
            {limitsLine}
          </p>
          {preparing ? (
            <>
              <div role="status" className="mt-2 text-center" data-testid="start-preparing-status">
                <p className="text-sm font-medium text-[var(--text-body)]" data-testid="start-preparing">
                  {t("app.start.preparing")}
                </p>
                {preparingSlow && (
                  <p className="mt-1 text-xs text-[var(--text-muted)]" data-testid="start-preparing-slow">
                    {t("app.start.preparingSlow")}
                  </p>
                )}
              </div>
              {ios && stalled && (
                // No word from iOS for a long while: maybe it gave up
                // without saying so. Softly: it may still deliver.
                <p className="phase-fade mt-1 text-center text-xs text-[var(--text-muted)]" data-testid="pick-stalled">
                  {t("app.start.stillNothing")}{" "}
                  <button
                    type="button"
                    onClick={chooseAnyway}
                    data-testid="pick-anyway"
                    className="inline-flex min-h-11 items-center px-1 font-semibold text-[var(--brand-strong)] underline underline-offset-2 hover:opacity-80"
                  >
                    {t("app.start.pickAnyway")}
                  </button>
                </p>
              )}
            </>
          ) : (
            ios &&
            (missed || pickError || tooBig) && (
              <PickMissedHint variant="screen" className="mt-3" onPickAnyway={chooseAnyway} error={pickError} tooBig={tooBig} />
            )
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-4" data-testid="start-upload">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-semibold text-[var(--text-strong)]" title={upload.name}>
              {upload.name}
            </span>
            <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{Math.round(live?.pct ?? 0)}%</span>
          </div>
          <Progress value={live?.pct ?? 0} min={2} color="var(--brand)" label={t("app.start.uploading")} />
          {live?.paused ? (
            <p className="mt-2 text-xs text-[var(--warn)]" role="status" data-testid="start-paused">{t("app.upload.paused")}</p>
          ) : (
            live?.resuming && <p className="mt-2 text-xs text-[var(--text-muted)]">{t("app.upload.resuming")}</p>
          )}
          {probe?.duration && minutesLeft !== null && (
            <p className="mt-2 text-xs text-[var(--text-body)]" data-testid="start-uses">
              {t("app.start.usesMinutes", { used: clock(probe.duration), left: fmtMinutes(minutesLeft, lang) })}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
            <span data-testid="start-keep-open">{t(phone ? "app.start.keepOpenPhone" : "app.start.keepOpen")}</span>
            <Link href="/app" data-testid="start-to-projects" className="font-semibold text-[var(--brand-strong)] hover:opacity-80">
              {t("app.start.toProjects")}
            </Link>
          </div>
        </div>
      )}

      <div>
        <div id="start-format-label" className="mb-2 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
          {t("app.start.format")}
        </div>
        <div role="radiogroup" aria-labelledby="start-format-label" className="grid grid-cols-3 gap-2">
          {ASPECTS.map((a) => {
            const on = settings.targetAspect === a;
            const off = a === "16:9" && portrait;
            const sub = ASPECT_SUB[a];
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={off || undefined}
                aria-describedby={off ? "start-vertical-hint" : undefined}
                disabled={off}
                data-testid={`start-format-${a === "original" ? "original" : a.replace(":", "x")}`}
                onClick={() => change({ targetAspect: a })}
                className={cx(
                  "min-h-11 rounded-xl border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  on
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]",
                )}
              >
                <div className="text-sm font-semibold text-[var(--text-strong)]">{a === "original" ? t("app.start.formatOriginal") : a}</div>
                {sub && <div className="truncate text-[11px] text-[var(--text-muted)]">{t(sub)}</div>}
              </button>
            );
          })}
        </div>
        {portrait && (
          <p id="start-vertical-hint" className="mt-2 text-xs text-[var(--text-muted)]" data-testid="start-vertical-hint">
            {t("app.start.verticalHint")}
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">{t("app.start.edit")}</div>
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-[var(--text-body)]" data-testid="start-summary">
            {summary}
          </p>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={!phone ? open : undefined}
            aria-haspopup={phone ? "dialog" : undefined}
            aria-controls={!phone && open ? "start-settings-panel" : undefined}
            data-testid="start-change"
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-[var(--brand-strong)] hover:bg-[var(--surface-1)]"
          >
            {t("app.start.change")}
            <Icon icon={ChevronDown} className={cx("transition-transform", open && !phone && "rotate-180")} />
          </button>
        </div>
        {open && !phone && (
          <div id="start-settings-panel" className="mt-3 rounded-2xl border border-[var(--border)] p-4">
            {panel}
          </div>
        )}
      </div>

      <Link
        href="/privacy"
        data-testid="upload-privacy"
        className="w-fit text-xs text-[var(--text-muted)] underline underline-offset-2 hover:opacity-80"
      >
        {t("app.upload.privacyLink")}
      </Link>

      {open && phone && (
        <Dialog
          onClose={() => setOpen(false)}
          labelledBy="start-sheet-title"
          testId="start-sheet"
          backdrop="rgba(0,0,0,0.5)"
          panelClassName="fixed inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface-0)] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--border-strong)]" />
          <h2 id="start-sheet-title" className="mb-3 text-base font-semibold text-[var(--text-strong)]">
            {t("app.start.settingsTitle")}
          </h2>
          {panel}
          <button
            type="button"
            onClick={() => setOpen(false)}
            data-testid="start-sheet-done"
            className="mt-4 min-h-11 w-full rounded-xl bg-[var(--brand-solid)] px-4 text-sm font-semibold text-white"
          >
            {t("app.start.done")}
          </button>
        </Dialog>
      )}
      {/* Through a portal: where it sits in the tree doesn't change the page. */}
      {voiceHelp && <VoiceTestDialog onClose={() => setVoiceHelp(false)} />}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        data-testid="upload-input"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => takeOriginal(e.target)}
      />
      {ios && (
        <input
          ref={anyRef}
          type="file"
          data-testid="upload-input-any"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            // The same file again must fire change again.
            e.target.value = "";
            takeAnyway(f);
          }}
        />
      )}
    </div>
  );
}
