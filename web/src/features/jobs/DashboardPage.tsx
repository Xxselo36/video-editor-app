"use client";
/**
 * /app (UX5): the dashboard — job cards, recent projects, their status
 * poll. Moved out of PickerScreen, which used to switch between this and
 * the workflow picker in one URL; the picker is /app/new now.
 *
 * First paint: a skeleton until this device's cards and projects are
 * read (localStorage, and the server list with accounts on), then the
 * dashboard — or, for someone with nothing yet, straight on to /app/new
 * (replace: back leaves the app, as before). Never a flash of the
 * picker. A legacy editor link (/app?job=<id>) goes on to
 * /app/edit/<id>.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppPage } from "@/components/AppPage";
import { VideoModal } from "@/components/VideoModal";
import { fetchServerJobs, serverJobToLibraryEntry } from "@/lib/account";
import {
  addActiveJob,
  dropLegacyActiveJob,
  getActiveJobs,
  markStaleUploads,
  removeActiveJob,
  subscribeActiveJobs,
  type ActiveJobV2,
} from "@/lib/activeJobs";
import { AUTH_ENABLED } from "@/lib/auth";
import { tEn } from "@/lib/errors";
import { getLibrary, type LibraryEntry } from "@/lib/library";
import { VoiceTestDialog } from "@/features/voice-test/VoiceTestDialog";
import { Dashboard } from "./Dashboard";
import { useJobStatusPoller } from "./JobStatusPoller";

/** /app?job=<id> (the editor's URL before UX5) → /app/edit/<id>; an
 *  `?editor=v1|v2` choice goes along (features/editor/v2/flag). */
export function legacyJobRedirect(search: string): string | null {
  const q = new URLSearchParams(search);
  const id = q.get("job");
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const editor = q.get("editor");
  return `/app/edit/${id}${editor === "v1" || editor === "v2" ? `?editor=${editor}` : ""}`;
}

export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="dashboard-skeleton" aria-busy="true">
      <div className="h-4 w-24 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="h-9 w-64 animate-pulse rounded bg-[var(--surface-2)]" />
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-1)]" />
        <div className="h-28 animate-pulse rounded-2xl bg-[var(--surface-1)]" />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const router = useRouter();
  const [recent, setRecent] = useState<LibraryEntry[] | null>(null);
  const [activeJobs, setActiveJobs] = useState<ActiveJobV2[]>([]);
  const [ready, setReady] = useState(false);
  const [playingJobId, setPlayingJobId] = useState<string | null>(null);
  const [showVoiceTest, setShowVoiceTest] = useState(false);

  // (Until one release after UX4: drop the old single-job store.)
  useEffect(() => dropLegacyActiveJob(), []);

  useEffect(() => {
    const legacy = legacyJobRedirect(window.location.search);
    if (legacy) {
      router.replace(legacy);
      return;
    }
    const rec = getLibrary().slice(0, 3);
    const jobs = getActiveJobs();
    // Read once after mount: the server render has no storage.
    /* eslint-disable react-hooks/set-state-in-effect */
    setRecent(rec);
    setActiveJobs(jobs);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (jobs.length > 0 || rec.length > 0) {
      setReady(true);
      return;
    }
    // Nothing on this device. Accounts on: the server may know projects
    // from other devices — ask before sending the user to the picker.
    if (!AUTH_ENABLED) {
      router.replace("/app/new");
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => !cancelled && setReady(true), 6000);
    void fetchServerJobs().then((list) => {
      if (cancelled) return;
      const known = (list ?? []).filter((s) =>
        ["pending", "processing", "awaiting_review"].includes(s.status) || s.has_output,
      );
      if (known.length === 0 && getActiveJobs().length === 0) {
        router.replace("/app/new");
      } else setReady(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [router]);

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
              : s.stage?.startsWith("render.") || s.message?.toLowerCase().includes("render")
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
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cards added / changed anywhere (uploads, the poll, other tabs).
  useEffect(() => subscribeActiveJobs(() => setActiveJobs(getActiveJobs())), []);

  // Upload cards left over from a reload / closed tab never finish —
  // flip them to error cards so the user can clear them and retry.
  useEffect(() => {
    markStaleUploads();
    const id = setInterval(() => markStaleUploads(), 10_000);
    return () => clearInterval(id);
  }, []);

  const jobStatuses = useJobStatusPoller(setRecent);

  const closeVoiceTest = () => {
    setShowVoiceTest(false);
    try {
      localStorage.setItem("cleocuts.voiceOnboardingSeen.v1", "1");
    } catch {
      // ignore
    }
  };

  return (
    <AppPage width="2xl">
      {ready ? (
        <Dashboard
          activeJobs={activeJobs}
          jobStatuses={jobStatuses}
          recent={recent}
          onNewVideo={() => router.push("/app/new")}
          onOpenJob={(jobId) => router.push(`/app/edit/${jobId}`)}
          onRemoveJob={(jobId) => {
            removeActiveJob(jobId);
            setActiveJobs(getActiveJobs());
          }}
          onPlay={setPlayingJobId}
          onVoiceTest={() => setShowVoiceTest(true)}
        />
      ) : (
        <DashboardSkeleton />
      )}
      {/* Dialogs outside the view: a card update never unmounts them. */}
      {playingJobId && <VideoModal jobId={playingJobId} onClose={() => setPlayingJobId(null)} />}
      {showVoiceTest && <VoiceTestDialog onClose={closeVoiceTest} />}
    </AppPage>
  );
}
