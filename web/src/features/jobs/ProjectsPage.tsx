"use client";
/**
 * /app: Projekte (PR3, plan §6 P3-C and D17; mockup
 * docs/mockups/start/3-projekte.html). Every project of this device and
 * the account in one list, newest first (./ProjectRow); the expired
 * ones collapsed at the end (no thumbnail requests). Nothing else: a new
 * video starts from the menu, the voice test is in Einstellungen.
 *
 * Data: features/jobs/jobsStore (this device's list, the account's list
 * with accounts on, the batched status poll).
 *
 * First paint: a skeleton until the store has asked the server once.
 * Nothing to show: the first screen of a visit goes on to Neues Video
 * (replace: back leaves the app); reached through the menu, the page
 * says so (useShell navigatedInApp). A legacy editor link
 * (/app?job=<id>) goes on to /app/edit/<id>.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { AppPage } from "@/components/AppPage";
import { CONTROL_TOUCH, EMPTY_PRIMARY, EmptyState } from "@/components/EmptyState";
import { PageTitle } from "@/components/PageTitle";
import { navigatedInApp } from "@/components/shell/useShell";
import { Button, PRESS } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { AUTH_ENABLED } from "@/lib/auth";
import { getLocalJobs, markStaleUploads, refreshProjects, useProjects } from "./jobsStore";
import { emptyListAction, type Project } from "./projects";
import { ProjectRow } from "./ProjectRow";
import s from "./projects.module.css";

/** /app?job=<id> (the editor's URL before UX5) → /app/edit/<id>; an
 *  `?editor=v1|v2` choice goes along (features/editor/v2/flag). */
export function legacyJobRedirect(search: string): string | null {
  const q = new URLSearchParams(search);
  const id = q.get("job");
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const editor = q.get("editor");
  return `/app/edit/${id}${editor === "v1" || editor === "v2" ? `?editor=${editor}` : ""}`;
}

/** How long projects are kept after their last change (the default plan;
 *  backend PLAN_RETENTION_DAYS). */
const RETENTION_DAYS = 14;

/** The list's shape while it loads. */
export function ProjectsSkeleton() {
  return (
    <div data-testid="dashboard-skeleton" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className={s.skeletonRow}>
          <div className={`skeleton ${s.skeletonThumb}`} />
          <div className={s.skeletonLines}>
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One polite line for screen readers when a video Cleo worked on turns
 * ready or fails while the page is open, with its name. The rows' status
 * lines change without a word: their percents and times would be read
 * out all the time.
 */
function useAnnouncement(projects: Project[]): string {
  const t = useT();
  const key = projects.map((p) => `${p.id}:${p.state}`).join(" ");
  const [seen, setSeen] = useState(() => ({ key, states: new Map(projects.map((p) => [p.id, p.state])) }));
  const [say, setSay] = useState("");
  if (seen.key !== key) {
    let line = "";
    for (const p of projects) {
      if (seen.states.get(p.id) !== "processing") continue;
      const name = p.name || t("app.library.untitled");
      if (p.state === "ready" || p.state === "edited") line = t("app.projects.announceReady", { name });
      else if (p.state === "failed") line = t("app.projects.announceFailed", { name });
    }
    setSeen({ key, states: new Map(projects.map((p) => [p.id, p.state])) });
    if (line) setSay(line);
  }
  return say;
}

function Rows({ list, onOpen }: { list: Project[]; onOpen: (href: string) => void }) {
  return (
    <ul className={s.list}>
      {list.map((p) => (
        <li key={p.id}>
          <ProjectRow p={p} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

export function ProjectsPage() {
  const t = useT();
  const router = useRouter();
  const { ready, serverLoaded, projects } = useProjects();
  const emptyAction = AUTH_ENABLED ? emptyListAction({ ready, serverLoaded, count: projects.length }) : "show";
  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const announce = useAnnouncement(projects);

  useEffect(() => {
    const legacy = legacyJobRedirect(window.location.search);
    if (legacy) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setLeaving(true);
      router.replace(legacy);
      return;
    }
    // Nothing on this device (accounts off: nothing anywhere) on the
    // visit's first screen: the start screen. With accounts on the
    // account's list decides (below).
    if (!AUTH_ENABLED && getLocalJobs().length === 0 && !navigatedInApp()) {
      setLeaving(true);
      router.replace("/app/new");
      return;
    }
    setMounted(true);
  }, [router]);

  useEffect(() => {
    // Only when the account's list really is empty (not on an error), and
    // not when the menu led here.
    if (emptyAction === "redirect" && !navigatedInApp()) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setLeaving(true);
      router.replace("/app/new");
    }
  }, [emptyAction, router]);

  // Upload records left over from a reload / closed tab never finish:
  // they become stopped uploads ("Try again").
  useEffect(() => {
    markStaleUploads();
    const id = setInterval(() => markStaleUploads(), 10_000);
    return () => clearInterval(id);
  }, []);

  const live = useMemo(() => projects.filter((p) => p.state !== "expired"), [projects]);
  const expired = useMemo(() => projects.filter((p) => p.state === "expired"), [projects]);
  const open = (href: string) => router.push(href);
  const title = t("app.projects.title");

  const body =
    // This device's rows at once; the server's answers fill them in (and,
    // with accounts on, the account's other projects join).
    !mounted || leaving || (!ready && projects.length === 0) ? (
      <ProjectsSkeleton />
    ) : (
      <div data-testid="dashboard">
        {live.length > 0 ? (
          <Rows list={live} onOpen={open} />
        ) : emptyAction === "retry" ? (
          <EmptyState testId="projects-load-failed" alert title={t("app.projects.loadFailed")}>
            <Button size="md" variant="tint" onClick={() => refreshProjects()} data-testid="projects-retry" className={cx(PRESS, CONTROL_TOUCH, "min-h-11")}>
              {t("app.projects.retry")}
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            testId={expired.length ? "projects-all-expired" : "projects-empty"}
            title={expired.length ? t("app.projects.allExpired.title", { days: RETENTION_DAYS }) : t("app.projects.empty")}
            body={expired.length ? t("app.projects.allExpired.body", { days: RETENTION_DAYS }) : t("app.projects.emptyBody")}
          >
            <Link href="/app/new" className={EMPTY_PRIMARY}>
              {t("app.nav.uploadVideo")}
            </Link>
          </EmptyState>
        )}

        {expired.length > 0 && (
          <details className={s.expired} data-testid="projects-expired">
            <summary className={s.expiredSummary}>
              <Icon icon={ChevronDown} className={s.expiredChevron} />
              {t("app.projects.expiredGroup", { count: expired.length })}
            </summary>
            <p className={s.expiredNote}>{t("app.projects.expiredNote", { days: RETENTION_DAYS })}</p>
            <Rows list={expired} onOpen={open} />
          </details>
        )}
      </div>
    );

  return (
    <AppPage width="3xl">
      <div className={s.page}>
        <PageTitle bar={title}>{title}</PageTitle>
        {body}
        <p role="status" className="sr-only" data-testid="projects-announce">
          {announce}
        </p>
      </div>
    </AppPage>
  );
}
