"use client";
/**
 * /app: Projects (UX12, flows.md §3.9). One page for what the dashboard
 * (cards in progress + the 3 newest) and /app/library (the finished ones)
 * showed apart: every project as a tile with its status, newest first;
 * expired ones collapsed at the end (no thumbnail requests); search and
 * All / To edit / Exported.
 *
 * Data: features/jobs/jobsStore (this device's list, the account's list
 * with accounts on, the batched status poll).
 *
 * First paint: a skeleton until the store has asked the server once —
 * or, for someone with nothing yet, straight on to /app/new (replace:
 * back leaves the app). A legacy editor link (/app?job=<id>) goes on to
 * /app/edit/<id>.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import { AppPage } from "@/components/AppPage";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { useLang, useT } from "@/i18n";
import { AUTH_ENABLED } from "@/lib/auth";
import { plural } from "@/lib/i18n/plural";
import { VoiceTeaser } from "@/features/voice-test/VoiceTeaser";
import { VoiceTestDialog } from "@/features/voice-test/VoiceTestDialog";
import { deleteProject, getLocalJobs, markStaleUploads, refreshProjects, renameProject, useProjects } from "./jobsStore";
import { emptyListAction, matchesFilter, matchesSearch, type Filter, type Project } from "./projects";
import { ProjectTile } from "./ProjectTile";

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

export function ProjectsSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-skeleton" aria-busy="true">
      <div className="h-4 w-24 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-9 w-64 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="aspect-[4/6] animate-pulse rounded-2xl bg-[var(--surface-1)]" />
        ))}
      </div>
    </div>
  );
}

function RenameDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(p.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    const v = value.trim();
    if (!v || v === p.name) return onClose();
    setBusy(true);
    setError(false);
    const ok = await renameProject(p.id, v);
    setBusy(false);
    if (ok) onClose();
    else setError(true);
  };
  return (
    <Dialog onClose={onClose} labelledBy={titleId} testId="dialog-rename" initialFocus={input}
      panelClassName="w-full max-w-sm rounded-2xl p-5"
      panelStyle={{ background: "var(--surface-1)", border: "1px solid var(--border-hover)" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        <h2 id={titleId} className="text-base font-semibold" style={{ color: "var(--text-strong)" }}>
          {t("app.projects.renameTitle")}
        </h2>
        <label className="flex flex-col gap-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
          {t("app.projects.renameLabel")}
          <input
            ref={input}
            value={value}
            maxLength={120}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            data-testid="rename-input"
            className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
            style={{ background: "var(--surface-2)", color: "var(--text-strong)", border: "1px solid var(--border)" }}
          />
        </label>
        {error && (
          <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>
            {t("app.projects.renameFailed")}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="tint" size="sm" onClick={onClose}>
            {t("app.projects.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy} data-testid="rename-save">
            {t("app.projects.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ p, onClose }: { p: Project; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"busy" | "failed" | null>(null);
  const name = p.name || t("app.library.untitled");
  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await deleteProject(p.id);
    setBusy(false);
    if (r === "ok") onClose();
    else setError(r);
  };
  return (
    <Dialog onClose={onClose} labelledBy={titleId} testId="dialog-delete"
      panelClassName="w-full max-w-sm rounded-2xl p-5"
      panelStyle={{ background: "var(--surface-1)", border: "1px solid var(--border-hover)" }}>
      <div className="flex flex-col gap-3">
        <h2 id={titleId} className="break-words text-base font-semibold" style={{ color: "var(--text-strong)" }}>
          {t("app.projects.deleteTitle", { name })}
        </h2>
        <p className="text-sm" style={{ color: "var(--text-body)" }}>
          {t("app.projects.deleteBody")}
        </p>
        {error && (
          <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>
            {t(error === "busy" ? "app.projects.deleteBusy" : "library.deleteFailed")}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="tint" size="sm" onClick={onClose}>
            {t("app.projects.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void remove()}
            data-testid="delete-confirm"
            className="!bg-[var(--danger)]"
          >
            {t("app.projects.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function ProjectsPage() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const { ready, serverLoaded, projects } = useProjects();
  const emptyAction = AUTH_ENABLED ? emptyListAction({ ready, serverLoaded, count: projects.length }) : "show";
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<{ kind: "rename" | "delete"; p: Project } | null>(null);
  const [showVoiceTest, setShowVoiceTest] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const legacy = legacyJobRedirect(window.location.search);
    if (legacy) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setLeaving(true);
      router.replace(legacy);
      return;
    }
    // Nothing on this device (accounts off: nothing anywhere): the start
    // screen. With accounts on the account's list decides (below).
    if (!AUTH_ENABLED && getLocalJobs().length === 0) {
      setLeaving(true);
      router.replace("/app/new");
      return;
    }
    setMounted(true);
  }, [router]);

  useEffect(() => {
    // Only when the account's list really is empty — not on an error.
    if (emptyAction === "redirect") {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setLeaving(true);
      router.replace("/app/new");
    }
  }, [emptyAction, router]);

  // Upload records left over from a reload / closed tab never finish —
  // they become failed uploads ("Try again").
  useEffect(() => {
    markStaleUploads();
    const id = setInterval(() => markStaleUploads(), 10_000);
    return () => clearInterval(id);
  }, []);

  const live = useMemo(() => projects.filter((p) => p.state !== "expired"), [projects]);
  const expired = useMemo(() => projects.filter((p) => p.state === "expired"), [projects]);
  const shown = useMemo(
    () => live.filter((p) => matchesFilter(p, filter) && matchesSearch(p, query)),
    [live, filter, query],
  );

  // Headline counts (T7): working, ready for review and failed apart.
  const counts = { working: 0, ready: 0, failed: 0 };
  for (const p of live) {
    if (p.state === "failed" || p.state === "upload_failed") counts.failed++;
    else if (p.state === "ready" || p.state === "edited") counts.ready++;
    else if (p.state === "uploading" || p.state === "processing" || p.state === "exporting") counts.working++;
  }
  const headline = (
    [
      [counts.working, "app.dashboard.inProgressCountOne", "app.dashboard.inProgressCountOther"],
      [counts.ready, "app.dashboard.readyCountOne", "app.dashboard.readyCountOther"],
      [counts.failed, "app.dashboard.failedCountOne", "app.dashboard.failedCountOther"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, one, other]) => t(plural(lang, n, { one, other }), { count: n }));

  const closeVoiceTest = () => {
    setShowVoiceTest(false);
    try {
      localStorage.setItem("cleocuts.voiceOnboardingSeen.v1", "1");
    } catch {
      // ignore
    }
  };

  const filters: [Filter, Parameters<typeof t>[0]][] = [
    ["all", "app.projects.filter.all"],
    ["edit", "app.projects.filter.edit"],
    ["exported", "app.projects.filter.exported"],
  ];

  const body =
    // This device's tiles at once; the server's answers fill them in (and,
    // with accounts on, the account's other projects join).
    !mounted || leaving || (!ready && projects.length === 0) ? (
      <ProjectsSkeleton />
    ) : (
      <div className="relative z-10 flex flex-col" data-testid="dashboard">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <SectionLabel>{t("app.projects.title")}</SectionLabel>
            <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl" style={{ color: "var(--text-strong)" }}>
              {headline[0] ?? t("app.dashboard.readyWhenYouAre")}
            </h1>
            {headline.length > 1 && (
              <div data-testid="dashboard-counts" className="mt-1 text-sm" style={{ color: "var(--text-body)" }}>
                {headline.slice(1).join(" · ")}
              </div>
            )}
          </div>
          <Button
            size="pill"
            onClick={() => router.push("/app/new")}
            data-testid="dashboard-new-video"
            className="inline-flex shrink-0 items-center gap-1.5 transition-transform hover:-translate-y-0.5"
          >
            <Icon icon={Plus} strokeWidth={2.5} className="text-base" />
            {t("app.dashboard.newVideo")}
          </Button>
        </div>

        {live.length > 3 && (
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative flex-1">
              <span className="sr-only">{t("app.projects.search")}</span>
              <Icon icon={Search} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("app.projects.search")}
                data-testid="projects-search"
                className="w-full rounded-xl py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[var(--brand)]"
                style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-strong)" }}
              />
            </label>
            <div role="group" aria-label={t("app.projects.filterLabel")} className="flex gap-1 rounded-xl p-1" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
              {filters.map(([f, key]) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  data-testid={`projects-filter-${f}`}
                  onClick={() => setFilter(f)}
                  className="flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors sm:flex-none"
                  style={
                    filter === f
                      ? { background: "var(--brand-tint)", color: "var(--brand-strong)" }
                      : { color: "var(--text-muted)" }
                  }
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {shown.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="projects-grid">
            {shown.map((p) => (
              <ProjectTile
                key={p.id}
                p={p}
                onOpen={(href) => router.push(href)}
                onMenuAction={(kind, proj) => setDialog({ kind, p: proj })}
              />
            ))}
          </div>
        ) : live.length > 0 ? (
          <p className="py-10 text-center text-sm" style={{ color: "var(--text-muted)" }} data-testid="projects-no-results">
            {query.trim() ? t("app.projects.noResults", { q: query.trim() }) : t("app.projects.noneInFilter")}
          </p>
        ) : (
          emptyAction === "retry" ? (
          <div
            data-testid="projects-load-failed"
            role="alert"
            className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border-hover)] bg-[var(--surface-1)] px-6 py-10 text-center"
          >
            <div className="text-base font-bold" style={{ color: "var(--text-strong)" }}>
              {t("app.projects.loadFailed")}
            </div>
            <Button size="pill" onClick={() => refreshProjects()} data-testid="projects-retry" className="mt-2">
              {t("app.projects.retry")}
            </Button>
          </div>
          ) : (
          <div
            data-testid={expired.length ? "projects-all-expired" : "projects-empty"}
            className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border-hover)] bg-[var(--surface-1)] px-6 py-10 text-center"
          >
            <div className="text-base font-bold" style={{ color: "var(--text-strong)" }}>
              {expired.length ? t("app.projects.allExpired.title", { days: RETENTION_DAYS }) : t("app.dashboard.startFirst")}
            </div>
            <div className="max-w-sm text-sm" style={{ color: "var(--text-muted)" }}>
              {expired.length ? t("app.projects.allExpired.body", { days: RETENTION_DAYS }) : t("app.dashboard.startFirstSub")}
            </div>
            <Button size="pill" onClick={() => router.push("/app/new")} className="mt-2">
              {t("app.dashboard.newVideo")}
            </Button>
          </div>
          )
        )}

        {expired.length > 0 && (
          <details className="group mt-8" data-testid="projects-expired">
            <summary
              className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em]"
              style={{ color: "var(--text-muted)" }}
            >
              <Icon icon={ChevronDown} className="transition-transform group-open:rotate-180" />
              {t("app.projects.expiredGroup", { count: expired.length })}
            </summary>
            <p className="mb-3 mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
              {t("app.projects.expiredNote", { days: RETENTION_DAYS })}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {expired.map((p) => (
                <ProjectTile
                  key={p.id}
                  p={p}
                  onOpen={(href) => router.push(href)}
                  onMenuAction={(kind, proj) => setDialog({ kind, p: proj })}
                />
              ))}
            </div>
          </details>
        )}

        <VoiceTeaser onClick={() => setShowVoiceTest(true)} className="mt-8 w-fit" />
      </div>
    );

  return (
    <AppPage width="5xl">
      {body}
      {/* Dialogs outside the view: a tile update never unmounts them. */}
      {dialog?.kind === "rename" && <RenameDialog p={dialog.p} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && <DeleteDialog p={dialog.p} onClose={() => setDialog(null)} />}
      {showVoiceTest && <VoiceTestDialog onClose={closeVoiceTest} />}
    </AppPage>
  );
}
