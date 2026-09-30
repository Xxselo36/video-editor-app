"use client";
// The workflow picker of /app/new (moved from app/app/page.tsx in UX4;
// the dashboard it used to switch to in the same URL is /app since UX5,
// features/jobs/DashboardPage).
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { IconArrowRight, IconSliders } from "@/components/Icons";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { getActiveJobs } from "@/lib/activeJobs";
import { getLibrary } from "@/lib/library";
import { VoiceTeaser } from "@/features/voice-test/VoiceTeaser";
import { VoiceTestDialog } from "@/features/voice-test/VoiceTestDialog";
import { getPresetChips, PRESET_ACCENTS, PRESET_ICONS, PRESETS, type PresetId } from "./presets.legacy";
import { useBillingHint } from "./useBillingHint";

export function PickerScreen({ onPick }: { onPick: (id: PresetId) => void }) {
  const t = useT();
  const billingHint = useBillingHint();
  const featured: PresetId[] = ["tiktok", "podcast", "vlog", "captions"];
  const [showVoiceOnboarding, setShowVoiceOnboarding] = useState(false);
  // "← Dashboard" only when there is a dashboard to go back to (cards or
  // projects on this device); first-time users land here from /app.
  const [hasDashboard, setHasDashboard] = useState(false);
  useEffect(() => {
    // Read once after mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasDashboard(getActiveJobs().length > 0 || getLibrary().length > 0);
  }, []);

  const dismissVoiceOnboarding = () => {
    setShowVoiceOnboarding(false);
    try {
      localStorage.setItem("cleocuts.voiceOnboardingSeen.v1", "1");
    } catch {
      // ignore
    }
  };

  return (
    <>
      {renderPicker()}
      {/* Through a portal: where it sits in the tree doesn't change the page. */}
      {showVoiceOnboarding && <VoiceTestDialog onClose={dismissVoiceOnboarding} />}
    </>
  );

  function renderPicker() {
    return (
    <div className="relative z-10 flex flex-col" data-testid="picker">
      {/* Back to dashboard — only rendered when there's a dashboard to
          go back to (existing jobs or library entries). Fresh users
          land here directly and don't see the back button. */}
      {hasDashboard && (
        <Link
          href="/app"
          data-testid="picker-back"
          className="mb-6 inline-flex w-fit items-center gap-1.5 text-sm transition-opacity hover:opacity-70"
          style={{ color: "var(--text-muted)" }}
        >
          <Icon icon={ArrowLeft} className="text-base" />
          {t("app.picker.backToDashboard")}
        </Link>
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
        <VoiceTeaser onClick={() => setShowVoiceOnboarding(true)} className="mt-5" />
      </div>

      {/* Preset grid — big cards with per-preset accent glow + config chips */}
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
        {featured.map((id) => {
          const p = PRESETS[id];
          const PresetIcon = PRESET_ICONS[id];
          const accent = PRESET_ACCENTS[id];
          const chips = getPresetChips(p, t);
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              data-testid={`picker-card-${id}`}
              className="group relative flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--brand-hover)]"
              style={{ minHeight: "180px" }}
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
                  <PresetIcon size={24} strokeWidth={2} />
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
        className="mt-4 flex items-center gap-3 rounded-2xl border border-dashed border-[var(--border-hover)] bg-transparent p-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-1)]"
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
    </div>
    );
  }
}
