"use client";
// The /app home (moved verbatim from app/app/page.tsx in UX4): the
// dashboard for returning users, else the workflow picker. It owns the
// job cards, the recent projects and their status poll.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconArrowRight, IconMic, IconSliders } from "@/components/Icons";
import { VideoModal } from "@/components/VideoModal";
import { useT } from "@/i18n";
import { fetchServerJobs, serverJobToLibraryEntry } from "@/lib/account";
import {
  addActiveJob,
  getActiveJobs,
  markStaleUploads,
  removeActiveJob,
  subscribeActiveJobs,
  type ActiveJobV2,
} from "@/lib/activeJobs";
import { AUTH_ENABLED } from "@/lib/auth";
import { tEn } from "@/lib/errors.legacy";
import { getLibrary, type LibraryEntry } from "@/lib/library";
import { Dashboard } from "@/features/jobs/Dashboard";
import { useJobStatusPoller } from "@/features/jobs/JobStatusPoller";
import { VoiceTestDialog } from "@/features/voice-test/VoiceTestDialog";
import { getPresetChips, PRESET_ACCENTS, PRESET_ICONS, PRESETS, type PresetId } from "./presets.legacy";
import { useBillingHint } from "./useBillingHint";

export function PickerScreen({
  onPick,
  onResumeJob,
}: {
  onPick: (id: PresetId) => void;
  onResumeJob?: (jobId: string) => void;
}) {
  const t = useT();
  const billingHint = useBillingHint();
  const featured: PresetId[] = ["tiktok", "podcast", "vlog", "captions"];
  const [recent, setRecent] = useState<LibraryEntry[] | null>(null);
  const [playingJobId, setPlayingJobId] = useState<string | null>(null);
  const [showVoiceOnboarding, setShowVoiceOnboarding] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveJobV2[]>([]);
  // Dashboard (jobs + recent) is the home for returning users. The
  // workflow picker is its own screen — reached via "+ New video" and
  // returned from via ← Back. First-time users skip the empty
  // dashboard and land straight on the picker.
  const [view, setView] = useState<"dashboard" | "picker">("picker");

  useEffect(() => {
    const rec = getLibrary().slice(0, 3);
    const jobs = getActiveJobs();
    setRecent(rec);
    setActiveJobs(jobs);
    if (jobs.length > 0 || rec.length > 0) setView("dashboard");
    // The voice test (camera + mic) is NOT opened automatically any
    // more — it scared off people who only want to upload a video.
    // It's one tap away via the "Cleo" hint chip.
  }, []);

  // Accounts on: the server knows this user's projects from every
  // device. Finished ones join "Recent", unfinished ones get a card
  // (the poll below keeps it current).
  useEffect(() => {
    if (!AUTH_ENABLED) return;
    let cancelled = false;
    void fetchServerJobs().then((list) => {
      if (cancelled || !list) return;
      const known = new Set(getActiveJobs().map((j) => j.jobId));
      // Oldest first: addActiveJob puts each new card on top.
      for (const s of [...list].reverse()) {
        if (known.has(s.id)) continue;
        if (!["pending", "processing", "awaiting_review"].includes(s.status)) continue;
        addActiveJob({
          jobId: s.id,
          phase:
            s.status === "awaiting_review"
              ? "reviewing"
              : s.message?.toLowerCase().includes("render")
                ? "rendering"
                : "analyzing",
          timestamp: (s.created_at ?? Date.now() / 1000) * 1000,
          filename: s.filename || tEn("app.library.untitled"),
          presetId: s.preset_id ?? null,
          presetLabel: s.preset_label ?? null,
          presetIcon: null,
          captionPreset: "clean",
        });
      }
      const done = list.filter((s) => s.has_output).map(serverJobToLibraryEntry);
      if (done.length > 0) {
        const ids = new Set(done.map((e) => e.jobId));
        setRecent(
          [...done, ...getLibrary().filter((e) => !ids.has(e.jobId))]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 3),
        );
        setView("dashboard");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // React to add/update/remove from anywhere in the app (uploads
  // starting, progress ticks, jobs finishing). Bumps to dashboard only
  // when a job is ADDED so the user sees their upload land — progress
  // ticks used to bump too, which threw the user out of the workflow
  // picker ("+ New video") while another job was running. Counting
  // (not ids) because an upload card swaps its temp id for the real one.
  const jobCountRef = useRef(0);
  useEffect(() => {
    jobCountRef.current = getActiveJobs().length;
    const refresh = () => {
      const jobs = getActiveJobs();
      setActiveJobs(jobs);
      if (jobs.length > jobCountRef.current) setView("dashboard");
      jobCountRef.current = jobs.length;
    };
    return subscribeActiveJobs(refresh);
  }, []);

  // Upload cards left over from a reload / closed tab never finish —
  // flip them to error cards so the user can clear them and retry.
  useEffect(() => {
    markStaleUploads();
    const id = setInterval(() => markStaleUploads(), 10_000);
    return () => clearInterval(id);
  }, []);

  const jobStatuses = useJobStatusPoller(setRecent);

  const dismissVoiceOnboarding = () => {
    setShowVoiceOnboarding(false);
    try {
      localStorage.setItem("cleocuts.voiceOnboardingSeen.v1", "1");
    } catch {
      // ignore
    }
  };

  const modals = (
    <>
      {playingJobId && (
        <VideoModal
          jobId={playingJobId}
          onClose={() => setPlayingJobId(null)}
        />
      )}
      {showVoiceOnboarding && (
        <VoiceTestDialog onClose={dismissVoiceOnboarding} />
      )}
    </>
  );

  if (view === "dashboard") {
    return (
      <Dashboard
        activeJobs={activeJobs}
        jobStatuses={jobStatuses}
        recent={recent}
        onNewVideo={() => setView("picker")}
        onOpenJob={(jobId) => onResumeJob?.(jobId)}
        onRemoveJob={(jobId) => {
          removeActiveJob(jobId);
          setActiveJobs(getActiveJobs());
        }}
        onPlay={setPlayingJobId}
        onVoiceTest={() => setShowVoiceOnboarding(true)}
      >
        {modals}
      </Dashboard>
    );
  }

  return (
    <div className="relative z-10 flex flex-col" data-testid="picker">
      {/* Back to dashboard — only rendered when there's a dashboard to
          go back to (existing jobs or library entries). Fresh users
          land here directly and don't see the back button. */}
      {(activeJobs.length > 0 || (recent && recent.length > 0)) && (
        <button
          onClick={() => setView("dashboard")}
          data-testid="picker-back"
          className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="text-base leading-none">←</span>
          {t("app.picker.backToDashboard")}
        </button>
      )}

      {/* Hero */}
      <div className="mb-10">
        {billingHint ? (
          // Paid plans live: minutes left (or the way to a plan) instead
          // of "Free during beta".
          <Link
            href={billingHint.href}
            className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium transition-opacity hover:opacity-80"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-hover)",
              color: "var(--text-body)",
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {billingHint.text}
          </Link>
        ) : (
          <div
            className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border-hover)",
              color: "var(--text-body)",
            }}
          >
            <span
              className="pulse-dot inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--brand)" }}
            />
            {t("app.picker.freeDuringBeta")}
          </div>
        )}

        <h1
          className="mb-3 text-4xl font-bold tracking-tight sm:text-5xl"
          style={{ color: "var(--text-strong)" }}
        >
          {t("app.picker.title")}
        </h1>
        <p
          className="max-w-md text-base leading-relaxed"
          style={{ color: "var(--text-body)" }}
        >
          {t("app.picker.subtitle")}
        </p>

        {/* Voice-commands teaser — link to the onboarding modal so
            users can always re-open the cheat sheet. */}
        <button
          onClick={() => setShowVoiceOnboarding(true)}
          data-testid="voice-teaser"
          className="mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
            border: "1px solid var(--brand)/30",
          }}
        >
          <IconMic size={14} strokeWidth={2.5} />
          {t("app.dashboard.voiceTeaser")}
          <span className="opacity-70">→</span>
        </button>
      </div>

      {/* Preset grid — big cards with per-preset accent glow + config chips */}
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {featured.map((id) => {
          const p = PRESETS[id];
          const Icon = PRESET_ICONS[id];
          const accent = PRESET_ACCENTS[id];
          const chips = getPresetChips(p, t);
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              data-testid={`picker-card-${id}`}
              className="group relative flex flex-col overflow-hidden rounded-2xl p-5 text-left transition-all hover:-translate-y-0.5"
              style={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                minHeight: "180px",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--brand-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              {/* Ambient accent glow — top-right corner */}
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-40 blur-2xl transition-opacity group-hover:opacity-70"
                style={{ background: accent }}
              />

              {/* Icon + hover-arrow */}
              <div className="relative z-10 mb-4 flex items-start justify-between">
                <div
                  className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    background: "var(--brand-tint)",
                    color: "var(--brand)",
                  }}
                >
                  <Icon size={24} strokeWidth={2} />
                </div>
                <span
                  className="translate-x-0 opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100"
                  style={{ color: "var(--brand)" }}
                >
                  <IconArrowRight size={18} strokeWidth={2.5} />
                </span>
              </div>

              {/* Title + tagline */}
              <div className="relative z-10 mb-4 flex-1">
                <div
                  className="mb-1 text-base font-bold"
                  style={{ color: "var(--text-strong)" }}
                >
                  {t(p.labelKey)}
                </div>
                <div
                  className="text-xs leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t(p.taglineKey)}
                </div>
              </div>

              {/* Config chips — actual settings this preset applies */}
              <div className="relative z-10 flex flex-wrap items-center gap-1.5">
                {chips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: "var(--surface-2)",
                      color: "var(--text-body)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {/* Custom setup — separated, distinct dashed treatment */}
      <button
        onClick={() => onPick("custom")}
        data-testid="picker-card-custom"
        className="mt-4 flex items-center gap-3 rounded-2xl p-4 text-left transition-colors"
        style={{
          background: "transparent",
          border: "1px dashed var(--border-hover)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--border-strong)";
          e.currentTarget.style.background = "var(--surface-1)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--border-hover)";
          e.currentTarget.style.background = "transparent";
        }}
      >
        <div
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--surface-2)", color: "var(--text-body)" }}
        >
          <IconSliders size={18} strokeWidth={2} />
        </div>
        <div className="flex-1">
          <div
            className="text-sm font-semibold"
            style={{ color: "var(--text-strong)" }}
          >
            {t("app.picker.customTitle")}
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {t("app.picker.customSub")}
          </div>
        </div>
        <span style={{ color: "var(--text-muted)" }}>
          <IconArrowRight size={14} strokeWidth={2} />
        </span>
      </button>

      {/* The cards open the file chooser: the privacy note sits here. */}
      <Link
        href="/privacy"
        data-testid="picker-privacy"
        className="mt-3 w-fit text-xs underline underline-offset-2 hover:opacity-80"
        style={{ color: "var(--text-muted)" }}
      >
        {t("app.upload.privacyLink")}
      </Link>

      {modals}
    </div>
  );
}
