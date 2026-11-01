/**
 * The poll behind /app/p/[jobId] (useJobPoll), without React: GET
 * /jobs/{id}, again every 2 s while it runs (pending / processing),
 * paused while the tab is hidden (the hook asks again when it shows).
 *
 * Back from Feinschliff, the Vorschau shows what the server has after
 * the editor's last saves (lib/pendingSaves):
 * - the first GET waits for this job's saves still out (SAVES_WAIT_MS,
 *   as the editor's own load does); while any are out the poll goes on,
 *   and once they settle it asks again at once (also when that first
 *   wait ran out). `settled` comes with the first job asked for after
 *   them: the Vorschau reads the doc again then.
 * - in review, a preview that doesn't show the stored timeline yet
 *   (previewBehind) is followed until it does: "building" every 2 s.
 *   "stale" (none being built: an editor on the proxy skips the
 *   rebuilds, or a fresh job has none yet) asks for one, POST
 *   /jobs/{id}/preview, once per timeline revision (edit_rev). The
 *   player's own request for the file can't start it: the browser
 *   answers that from its cache. "stale" again after its build started
 *   (the POST said so, or a GET said "building"): the build was lost (a
 *   backend restart or deploy keeps none) and is asked for again, at
 *   most LOST_ASKS times. "failed" asks once more. Failed again, or
 *   lost too often, the poll gives up on that revision
 *   (`previewFailed`: the Vorschau says so).
 *
 * setJob(job): a newer job than the last answer (POST /render's): shown
 * at once, polled again from there; an answer to a request sent before
 * it is dropped. One GET at a time: one asked for while another is out
 * goes when it is back.
 *
 * A job seen in review or exported marks this tab's export hint
 * (features/jobs/localJobs): a later queued run of it can only be an
 * export (previewStateOf).
 */
import { apiFetch } from "@/lib/api";
import { sameTimeline } from "@/lib/editSave";
import { hasPendingSaves, waitForSaves } from "@/lib/pendingSaves";
import { setExportHint } from "@/features/jobs/localJobs";
import type { JobStatus } from "@/features/jobs/types";

const POLL_MS = 2000;
// After an answer that isn't a job (a 502 / 503 while the backend
// restarts on a deploy, offline), or a preview nothing is building:
// again after 2 s, doubling to 30 s.
const RETRY_MAX_MS = 30_000;
/** How long the first GET waits for the editor's last saves (the editor's own load waits as long). */
export const SAVES_WAIT_MS = 8000;
/** How often a revision's preview is asked for again after its build was lost. */
export const LOST_ASKS = 2;
// Saves still out after that are waited for this long at a time.
const SAVES_WATCH_MS = 60_000;

/** The wait before the next try after `failures` failed ones in a row. */
function retryDelay(failures: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

export type Load =
  | { state: "loading" }
  | { state: "job"; job: JobStatus }
  | { state: "gone" }
  | { state: "failed"; status: number };

const running = (job: JobStatus) => job.status === "pending" || job.status === "processing";

/**
 * A preview that doesn't show the job's stored timeline (yet): the
 * server isn't done with it (a preview_status other than "ready"), or
 * the preview's clips aren't the stored ones (the editor's sameTimeline
 * rule, on start and end: the file has the clips' volume and fades
 * baked in, the player applies their speed). The Vorschau plays none
 * such, in review and while Fertigstellen runs (PreviewVideo).
 */
export function previewOutdated(job: JobStatus): boolean {
  if (job.preview_status && job.preview_status !== "ready") return true;
  return !sameTimeline(
    (job.preview_segments ?? []).map(([start, end]) => ({ start, end })),
    (job.edit_segments ?? []).map((x) => ({ start: x.start, end: x.end })),
    job.duration ?? 0,
  );
}

/** A job in review whose preview is outdated: the poll follows it
 *  until it isn't, and asks for it (only a job in review can build one). */
export function previewBehind(job: JobStatus): boolean {
  return job.status === "awaiting_review" && previewOutdated(job);
}

export type PollEvents = {
  /** The v2 Vorschau shows every state; v1 opens the editor on review (toEditor). */
  v2: boolean;
  load(load: Load): void;
  /** This job's pending saves settled; the job shown with it was asked for after them. */
  settled(): void;
  /** true: the preview of the stored timeline couldn't be built (asked once more, it failed
   *  again); false: a newer timeline, or a preview that shows it. */
  previewFailed(failed: boolean): void;
  toEditor(): void;
};

export type JobPollControl = {
  setJob(job: JobStatus): void;
  /** GET /jobs/{id} now (the first one waits for the saves all the same). */
  refresh(): void;
  stop(): void;
};

export function startJobPoll(jobId: string, on: PollEvents): JobPollControl {
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A GET is out; one asked for meanwhile goes when it is back.
  let busy = false;
  let queued = false;
  let failures = 0;
  // Answers in a row whose preview is behind with nothing building.
  let idle = 0;
  // Bumped by setJob: answers to requests sent before are older.
  let shown = 0;
  let hadJob = false;
  // The editor's saves: how often they settled, and the last of those
  // reported (with the first job asked for after it).
  let settles = 0;
  let reported = 0;
  let watching = false;
  // The preview of the stored timeline, per revision: asked for
  // ("stale"), its build started, asked again after a lost build (how
  // often), asked once more after a failure, given up.
  const forRev = (rev: number) => ({ rev, asked: false, started: false, lost: 0, retried: false, gaveUp: false });
  let rebuild = forRev(NaN);
  let failedNow = false;

  const hidden = () => typeof document !== "undefined" && document.hidden;
  const setFailed = (failed: boolean) => {
    if (failed === failedNow) return;
    failedNow = failed;
    on.previewFailed(failed);
  };

  const next = (again: boolean) => {
    if (!again || stopped || hidden()) return;
    const backoff = failures || idle;
    timer = setTimeout(() => void tick(), backoff ? retryDelay(backoff) : POLL_MS);
  };

  const show = (job: JobStatus, fresh: boolean) => {
    hadJob = true;
    const nothingBuilds = job.preview_status === "stale" || job.preview_status === "failed";
    idle = previewBehind(job) && nothingBuilds ? idle + 1 : 0;
    if (job.status === "awaiting_review" || job.status === "done") setExportHint(jobId);
    on.load({ state: "job", job });
    if (fresh) on.settled();
  };

  /** A build of this revision failed (the job says so, or the server refused one): asked once more, then given up. */
  const failedBuild = (): "retry" | null => {
    if (!rebuild.retried) {
      rebuild.retried = true;
      return "retry";
    }
    rebuild.gaveUp = true;
    setFailed(true);
    return null;
  };

  /** Whether the shown job's preview is to be asked for: "ask" (stale), "retry" (failed). */
  const wanted = (job: JobStatus): "ask" | "retry" | null => {
    if (!previewBehind(job)) {
      rebuild = forRev(NaN);
      setFailed(false);
      return null;
    }
    const rev = job.edit_rev ?? 0;
    if (rev !== rebuild.rev) {
      rebuild = forRev(rev);
      setFailed(false);
    }
    if (rebuild.gaveUp) return null;
    if (job.preview_status === "building") rebuild.started = true;
    if (job.preview_status === "stale") {
      if (!rebuild.asked) {
        rebuild.asked = true;
        return "ask";
      }
      if (rebuild.started) {
        // Its build is gone without a preview or a failure: lost.
        rebuild.started = false;
        if (rebuild.lost < LOST_ASKS) {
          rebuild.lost++;
          return "ask";
        }
        rebuild.gaveUp = true;
        setFailed(true);
      }
      return null;
    }
    return job.preview_status === "failed" ? failedBuild() : null;
  };

  /** POST /jobs/{id}/preview: "started" (building, or ready already),
   *  "refused" (410: nothing to build from, or the server started none),
   *  null (no answer: asked again with a later "stale" or "failed"). */
  const askForPreview = async (): Promise<"started" | "refused" | null> => {
    try {
      const r = await apiFetch(`/jobs/${jobId}/preview`, { method: "POST" });
      if (r.status === 410) return "refused";
      if (!r.ok) return null;
      const a = (await r.json()) as { preview_status?: string };
      return a.preview_status === "building" || a.preview_status === "ready" ? "started" : "refused";
    } catch {
      return null;
    }
  };

  /** Show the job and ask for the preview it wants. Whether to poll
   *  again; null: setJob showed a newer one meanwhile. */
  const settle = async (job: JobStatus, asked: number, fresh: boolean): Promise<boolean | null> => {
    show(job, fresh);
    let want = wanted(job);
    while (want) {
      const res = await askForPreview();
      if (stopped || asked !== shown) return null;
      if (res === "started") {
        // something builds it now: followed every 2 s
        rebuild.started = true;
        idle = 0;
        break;
      }
      if (res === null) {
        if (want === "ask") rebuild.asked = false;
        else rebuild.retried = false;
        break;
      }
      want = failedBuild();
    }
    return running(job) || hasPendingSaves(jobId) || (previewBehind(job) && !rebuild.gaveUp);
  };

  /** One GET /jobs/{id}. Whether to poll again; null: nothing to schedule from it. */
  const poll = async (): Promise<boolean | null> => {
    const asked = shown;
    const settledBefore = settles;
    try {
      const r = await apiFetch(`/jobs/${jobId}`);
      if (stopped || asked !== shown) return null;
      if (r.status === 404) {
        on.load({ state: "gone" });
        return false;
      }
      if (r.status === 401 || r.status === 403) {
        // Sign-in opens (apiFetch); nothing to poll meanwhile.
        if (!hadJob) on.load({ state: "failed", status: r.status });
        return false;
      }
      if (!r.ok) {
        // A hiccup (5xx, 429): keep what is shown, try again later.
        failures++;
        return true;
      }
      failures = 0;
      const job: JobStatus = await r.json();
      if (stopped || asked !== shown) return null;
      if (!on.v2 && job.status === "awaiting_review") {
        on.toEditor();
        return null;
      }
      const fresh = settledBefore > reported;
      if (fresh) reported = settledBefore;
      return await settle(job, asked, fresh);
    } catch {
      if (stopped || asked !== shown) return null;
      failures++;
      return true; // offline: try again
    }
  };

  const tick = async (): Promise<void> => {
    clearTimeout(timer);
    if (stopped) return;
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    let again: boolean | null = null;
    try {
      again = await poll();
    } finally {
      busy = false;
    }
    if (stopped) return;
    if (queued) {
      queued = false;
      void tick();
      return;
    }
    if (again !== null) next(again);
    if (hasPendingSaves(jobId)) watch();
  };

  /** Saves of this job still out: asked again as soon as they settle. */
  const watch = () => {
    if (watching || stopped) return;
    watching = true;
    void waitForSaves(jobId, SAVES_WATCH_MS).then((done) => {
      watching = false;
      if (stopped) return;
      if (!done) {
        watch();
        return;
      }
      settles++;
      void tick();
    });
  };

  void (async () => {
    // A save the editor sent as it closed may still be on its way: the
    // first answer shows the state the user left.
    if (hasPendingSaves(jobId)) {
      if (await waitForSaves(jobId, SAVES_WAIT_MS)) settles++;
      if (stopped) return;
    }
    started = true;
    void tick();
  })();

  return {
    setJob(job) {
      shown++;
      clearTimeout(timer);
      failures = 0;
      void settle(job, shown, false).then((again) => {
        if (again !== null && started) next(again);
      });
    },
    refresh() {
      if (started) void tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
