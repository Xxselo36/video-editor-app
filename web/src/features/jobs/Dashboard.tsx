"use client";
// The dashboard: job cards and recent projects (moved from
// app/app/page.tsx in UX4, where PickerScreen rendered it; it still owns
// the state and passes it in).
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, Plus } from "lucide-react";
import { IconArrowRight } from "@/components/Icons";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import type { ActiveJobV2 } from "@/lib/activeJobs";
import type { LibraryEntry } from "@/lib/library";
import { VoiceTeaser } from "@/features/voice-test/VoiceTeaser";
import { ActiveJobCard } from "./ActiveJobCard";
import { RecentProjectCard } from "./RecentProjectCard";
import type { CardStatus } from "./types";

export function Dashboard({
  activeJobs,
  jobStatuses,
  recent,
  onNewVideo,
  onOpenJob,
  onRemoveJob,
  onPlay,
  onVoiceTest,
  children,
}: {
  activeJobs: ActiveJobV2[];
  jobStatuses: Record<string, CardStatus>;
  recent: LibraryEntry[] | null;
  onNewVideo: () => void;
  onOpenJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onPlay: (jobId: string) => void;
  onVoiceTest: () => void;
  /** The dialogs, rendered at the end of the dashboard. */
  children?: ReactNode;
}) {
  const t = useT();
  // Headline counts (T7): working (uploading / analyzing / exporting),
  // ready for review and failed are counted apart — a failed or waiting
  // card is not "in progress". Same failure test as ActiveJobCard.
  const counts = { working: 0, ready: 0, failed: 0 };
  for (const j of activeJobs) {
    if (jobStatuses[j.jobId]?.status === "error" || j.error) counts.failed++;
    else if (j.phase === "reviewing") counts.ready++;
    else counts.working++;
  }
  const headline = (
    [
      [counts.working, "app.dashboard.inProgressCountOne", "app.dashboard.inProgressCountOther"],
      [counts.ready, "app.dashboard.readyCountOne", "app.dashboard.readyCountOther"],
      [counts.failed, "app.dashboard.failedCountOne", "app.dashboard.failedCountOther"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, one, other]) => t(n === 1 ? one : other, { count: n }));

  return (
    <div className="relative z-10 flex flex-col" data-testid="dashboard">
      {/* Dashboard header — logo/tagline on the left, primary CTA on
          the right. This screen is deliberately jobs-only; the
          workflow picker lives on its own screen. */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <SectionLabel>{t("app.dashboard.workspace")}</SectionLabel>
          <h1
            className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl"
            style={{ color: "var(--text-strong)" }}
          >
            {headline[0] ?? t("app.dashboard.readyWhenYouAre")}
          </h1>
          {headline.length > 1 && (
            <div
              data-testid="dashboard-counts"
              className="mt-1 text-sm"
              style={{ color: "var(--text-body)" }}
            >
              {headline.slice(1).join(" · ")}
            </div>
          )}
        </div>
        <Button
          size="pill"
          onClick={onNewVideo}
          data-testid="dashboard-new-video"
          className="inline-flex shrink-0 items-center gap-1.5 transition-transform hover:-translate-y-0.5"
        >
          <Icon icon={Plus} strokeWidth={2.5} className="text-base" />
          {t("app.dashboard.newVideo")}
        </Button>
      </div>

      {/* Active jobs */}
      {activeJobs.length > 0 && (
        <div className="mb-10">
          <SectionLabel className="mb-3">{t("app.dashboard.inProgress")}</SectionLabel>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {activeJobs.map((j) => (
              <ActiveJobCard
                key={j.jobId}
                job={j}
                status={jobStatuses[j.jobId]}
                onOpen={() => onOpenJob(j.jobId)}
                onRetry={() => onRemoveJob(j.jobId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Recent projects */}
      {recent && recent.length > 0 && (
        <div className="mb-10">
          <div className="mb-3 flex items-center justify-between">
            <SectionLabel>{t("app.dashboard.recentProjects")}</SectionLabel>
            <Link
              href="/app/library"
              className="text-xs transition-opacity hover:opacity-70"
              style={{ color: "var(--brand-strong)" }}
            >
              {t("app.dashboard.viewAll")} <Icon icon={ArrowRight} />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {recent.map((entry) => (
              <RecentProjectCard
                key={entry.jobId}
                entry={entry}
                onPlay={onPlay}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state — no jobs and no library entries yet */}
      {activeJobs.length === 0 && (!recent || recent.length === 0) && (
        <button
          onClick={onNewVideo}
          className="flex items-center gap-4 rounded-2xl border border-dashed border-[var(--border-hover)] bg-[var(--surface-1)] p-6 text-left transition-colors hover:border-[var(--brand)]"
        >
          <div
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "var(--brand-tint)", color: "var(--brand)" }}
          >
            <IconArrowRight size={22} strokeWidth={2.5} />
          </div>
          <div>
            <div
              className="text-base font-bold"
              style={{ color: "var(--text-strong)" }}
            >
              {t("app.dashboard.startFirst")}
            </div>
            <div
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {t("app.dashboard.startFirstSub")}
            </div>
          </div>
        </button>
      )}

      {/* Voice teaser pinned at the bottom of the dashboard so it
          stays a reminder without competing with the CTA. */}
      <VoiceTeaser onClick={onVoiceTest} className="mt-2 w-fit" />

      {children}
    </div>
  );
}
