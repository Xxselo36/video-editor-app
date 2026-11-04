/**
 * Fertigstellen on the Vorschau without React (useFinish wraps it), and
 * what it checks first (plan D12, never an older cut): changes this
 * device keeps for the job that the server doesn't have, the editor's
 * copies of the timeline (editor/session/unsavedKey) and of the edit
 * document (editor/session/unsavedDoc).
 *
 *   1. this job's saves are still out (the editor was just left): it
 *      waits for them, 8 s at most; still out then, nothing renders
 *      ("stillSaving": try again in a moment)
 *   2. right before every POST, the device copies: one the server
 *      doesn't have, nothing renders ("unsaved": the Vorschau offers
 *      Feinschliff, which brings it back); can't tell now (the server's
 *      doc couldn't be read), nothing renders either ("unknown")
 *   3. POST /render ("posted")
 *
 * The page went away meanwhile (Feinschliff opened): nothing starts
 * ("left").
 */
import { fetchDoc } from "@/features/editor/state/docFetch";
import { docHasCopy, dropDocCopy, readDocCopy } from "@/features/editor/session/unsavedDoc";
import { unsavedTimeline } from "@/features/editor/session/unsavedKey";
import type { EditDoc } from "@/features/editor/state/doc";
import type { JobStatus } from "@/features/jobs/types";

/** How long a render waits for the editor's last saves. */
export const SAVES_WAIT_MS = 8000;

/**
 * Whether this device keeps changes of the job that the server doesn't
 * have; null when that can't be told now (its doc couldn't be read).
 * A copy the server has (a keepalive save that landed after the tab
 * closed) doesn't count and goes. `job`: the job as last read (its
 * stored timeline).
 */
export async function unsavedOnDevice(
  job: Pick<JobStatus, "id" | "edit_segments" | "duration">,
  readDoc: (jobId: string) => Promise<{ doc: Pick<EditDoc, "words" | "style" | "format"> } | null> = fetchDoc,
): Promise<boolean | null> {
  if (unsavedTimeline(job.id, job.edit_segments, job.duration ?? 0)) return true;
  const copy = readDocCopy(job.id);
  if (!copy) return false;
  const server = await readDoc(job.id).catch(() => null);
  if (!server) return null;
  if (!docHasCopy(server.doc, copy)) return true;
  dropDocCopy(job.id, copy);
  return false;
}

export type FinishStep = "saving" | "checking" | "starting";

export type FinishDeps<T> = {
  /** This job's saves still out (lib/pendingSaves). */
  pending(): boolean;
  /** Settled in time (true) or still out (false). */
  waitForSaves(timeoutMs: number): Promise<boolean>;
  /** Changes on this device the server doesn't have (unsavedOnDevice). */
  unsaved(): Promise<boolean | null>;
  /** The page is still there. */
  live(): boolean;
  step(step: FinishStep): void;
  /** POST /render. */
  post(): Promise<T>;
};

export type FinishResult<T> =
  | { kind: "stillSaving" | "unsaved" | "unknown" | "left" }
  | { kind: "posted"; answer: T };

export async function runFinish<T>(d: FinishDeps<T>): Promise<FinishResult<T>> {
  if (d.pending()) {
    d.step("saving");
    if (!(await d.waitForSaves(SAVES_WAIT_MS))) return { kind: "stillSaving" };
  }
  if (!d.live()) return { kind: "left" };
  d.step("checking");
  const unsaved = await d.unsaved();
  if (unsaved === null) return { kind: "unknown" };
  if (unsaved) return { kind: "unsaved" };
  if (!d.live()) return { kind: "left" };
  d.step("starting");
  return { kind: "posted", answer: await d.post() };
}
