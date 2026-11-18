"use client";
/**
 * /app/p/[jobId] (UX5): one project, by its status (PLAN_TECH §1.1).
 *
 * The v2 editor (useProjectsV2): the Vorschau (PreviewScreen, PR2 plan
 * D11), its own chunk, in every state of the project: processing, ready,
 * edited, finishing, done, failed. Its shape (frame, title, two buttons)
 * while it loads, also while the server can't be reached (useJobPoll
 * tries again); a project that is gone says so, with the way back to
 * Projects.
 *
 * v1, as before: ./LegacyProject, a chunk of its own (the job card, the
 * v1 Done view; useJobPoll sends a project in review to the editor).
 *
 * The job comes from useJobPoll: GET /jobs/{id}, again every 2 s while it
 * runs, at rest a look at its status row every 45 s (an export made on
 * another device), paused while the tab is hidden.
 */
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AppPage } from "@/components/AppPage";
import { useT } from "@/i18n";
import { EDITOR_V2 } from "@/features/editor/v2/flag";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import { ErrorView } from "./ErrorView";
import { PreviewSkeleton } from "./PreviewSkeleton";
import { useJobPoll, type JobPoll } from "./useJobPoll";

// The Vorschau with its players and the caption engine: a chunk of its
// own (keeps /app/p within its first-load budget).
const PreviewScreen = dynamic(() => import("./PreviewScreen"), { ssr: false, loading: () => <PreviewSkeleton /> });

// v1's project page (its card and Done view): a chunk of its own.
const LegacyProject = dynamic(() => import("./LegacyProject").then((m) => m.LegacyProject), {
  loading: () => (
    <AppPage width="md">
      <div className="h-40 animate-pulse rounded-2xl bg-[var(--surface-1)]" data-testid="project-loading" />
    </AppPage>
  ),
});

export function ProjectPage({ jobId }: { jobId: string }) {
  const poll = useJobPoll(jobId);
  // Known after hydration; until then the build's default.
  const v2 = useProjectsV2() ?? EDITOR_V2;
  return v2 ? <Vorschau {...poll} /> : <LegacyProject {...poll} />;
}

function Vorschau({ load, setJob, settled, previewFailed }: JobPoll) {
  const t = useT();
  const router = useRouter();
  if (load.state === "gone" || load.state === "failed") {
    return (
      <AppPage width="5xl">
        <div data-testid="project" data-status={load.state}>
          <ErrorView
            message={t(load.state === "gone" ? "app.errors.expired" : load.status === 401
              ? "app.errors.signInRequired" : "app.notice.loadFailed")}
            actionLabel={t(load.state === "gone" ? "editor.expired.back" : "app.picker.backToDashboard")}
            onReset={() => router.push("/app")}
          />
        </div>
      </AppPage>
    );
  }
  return (
    <AppPage width="5xl">
      {load.state === "loading" ? (
        <PreviewSkeleton />
      ) : (
        <div data-testid="project" data-status={load.job.status}>
          <PreviewScreen job={load.job} setJob={setJob} settled={settled} previewFailed={previewFailed} />
        </div>
      )}
    </AppPage>
  );
}
