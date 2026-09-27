/**
 * Saves (timeline / transcript) that may still be running for a job
 * after its editor was left. Re-entering the job waits for them so it
 * loads the state the user actually left, not the one before their
 * last edit.
 */
const pending = new Map<string, Set<Promise<unknown>>>();

export function trackSave(jobId: string, p: Promise<unknown>): void {
  let set = pending.get(jobId);
  if (!set) {
    set = new Set();
    pending.set(jobId, set);
  }
  set.add(p);
  const done = () => {
    set!.delete(p);
    if (set!.size === 0 && pending.get(jobId) === set) pending.delete(jobId);
  };
  p.then(done, done);
}

/** Resolves once every tracked save for the job settled, or after
 *  `timeoutMs` — a stuck request must not block opening the job. */
export async function waitForSaves(jobId: string, timeoutMs = 20_000): Promise<void> {
  const set = pending.get(jobId);
  if (!set || set.size === 0) return;
  await Promise.race([
    Promise.allSettled([...set]),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}
