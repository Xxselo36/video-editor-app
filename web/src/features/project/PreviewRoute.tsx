"use client";
/**
 * /app/preview: the Vorschau tab (PR3, plan D15). It opens a project's
 * Vorschau (./pickPreview: the one last opened in this tab unless a
 * newer project came since, else the newest with something to show).
 * With none it says what there is: an upload still going, one waiting
 * for "Los geht's", or nothing yet. Browsers off v2 have no shell and no
 * such tab: /app.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppPage } from "@/components/AppPage";
import { CONTROL_TOUCH, EMPTY_PRIMARY, EMPTY_TINT, EmptyState } from "@/components/EmptyState";
import { PageTitle } from "@/components/PageTitle";
import { Button, PRESS } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { useT } from "@/i18n";
import { AUTH_ENABLED } from "@/lib/auth";
import { runningUploads } from "@/lib/uploadLock";
import { refreshProjects, useProjects } from "@/features/jobs/jobsStore";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import { useAwaitingGoIds } from "@/features/upload/uploadState";
import { pickPreview, readLastPreview } from "./pickPreview";
import { PreviewSkeleton } from "./PreviewSkeleton";

/** The upload records some tab runs now (lib/uploadLock), asked every
 *  few seconds while `ask`; null: not asked, or this browser can't tell. */
function useRunningUploads(ask: boolean): Set<string> | null {
  const [running, setRunning] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!ask) return;
    let on = true;
    // (The same set again: no new render of the page.)
    const same = (a: Set<string> | null, b: Set<string> | null) =>
      a === b || (!!a && !!b && a.size === b.size && [...a].every((x) => b.has(x)));
    const check = () => void runningUploads().then((r) => on && setRunning((cur) => (same(cur, r) ? cur : r)));
    check();
    const timer = setInterval(check, 5000);
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [ask]);
  return ask ? running : null;
}

export function PreviewRoute() {
  const t = useT();
  const router = useRouter();
  const v2 = useProjectsV2();
  const { ready, serverLoaded, statusFailed, projects } = useProjects();
  const awaiting = useAwaitingGoIds();
  const target = useMemo(() => (ready ? pickPreview(projects, readLastPreview()) : null), [ready, projects]);

  useEffect(() => {
    if (v2 === false) router.replace("/app");
    else if (v2 && target) router.replace(`/app/p/${target}`);
  }, [v2, target, router]);

  const title = t("editor.preview");
  const upload = projects.find((p) => p.state === "uploading");
  // Waiting for "Los geht's" in another tab: its record says so while
  // that tab runs it. A record whose page died without a word (an
  // Android tab discard) is an upload until Projekte marks it stopped.
  const waitingElsewhere = upload?.upload?.awaitingGo && !awaiting.has(upload.id) ? upload.id : null;
  const running = useRunningUploads(waitingElsewhere !== null);
  const waitsThere = waitingElsewhere !== null && running?.has(waitingElsewhere) !== false;
  // Projects whose state the server hasn't told yet: one of them may have
  // something to show. Its request failed (offline, a 5xx): the retry;
  // not asked yet (a job another tab just made): a moment.
  const unchecked = projects.some((p) => p.state === "unknown");
  let body;
  if (!v2 || !ready || target || (unchecked && !statusFailed)) {
    body = <PreviewSkeleton testId="preview-resolving" />;
  } else if (upload && awaiting.has(upload.id)) {
    // Waiting for "Los geht's" in this page: Continue brings it back.
    body = (
      <EmptyState testId="preview-uploading" title={t("app.start.waitingForGo")}>
        <Link href="/app/new" className={EMPTY_PRIMARY}>
          {t("app.start.continueStart")}
        </Link>
      </EmptyState>
    );
  } else if (upload) {
    // Uploading, or waiting in the tab that uploads it (its way back is
    // there).
    body = (
      <EmptyState testId="preview-uploading" title={t(waitsThere ? "app.start.waitingForGo" : "app.preview.uploading")}>
        <Link href="/app" className={EMPTY_TINT}>
          {t("editor.expired.back")}
        </Link>
      </EmptyState>
    );
  } else if ((AUTH_ENABLED && !serverLoaded) || unchecked) {
    // The list or the states didn't load: not "nothing yet".
    body = (
      <EmptyState testId="preview-load-failed" alert title={t("app.projects.loadFailed")}>
        <Button size="md" variant="tint" onClick={() => refreshProjects()} data-testid="preview-retry" className={cx(PRESS, CONTROL_TOUCH, "min-h-11")}>
          {t("app.projects.retry")}
        </Button>
      </EmptyState>
    );
  } else {
    body = (
      <EmptyState testId="preview-empty" title={t("app.preview.emptyTitle")} body={t("app.preview.emptyBody")}>
        <Link href="/app/new" className={EMPTY_PRIMARY}>
          {t("app.nav.uploadVideo")}
        </Link>
      </EmptyState>
    );
  }

  return (
    <AppPage width="3xl">
      <div className="flex max-w-[760px] flex-col gap-5">
        <PageTitle bar={title}>{title}</PageTitle>
        {body}
      </div>
    </AppPage>
  );
}
