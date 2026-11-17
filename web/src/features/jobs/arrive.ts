/**
 * A video whose start was just created (features/start/pendingStart,
 * "Los geht's"): its row on Projekte enters once, 280 ms of opacity and
 * an 8 px rise (projects.module.css; none under reduced motion).
 */
const arriving = new Set<string>();

export function markArriving(jobId: string): void {
  arriving.add(jobId);
}

/** Whether row `jobId` enters now (read while it mounts). */
export function isArriving(jobId: string): boolean {
  return arriving.has(jobId);
}

/** It entered: a later mount of the row (Projekte again) doesn't. */
export function forgetArriving(jobId: string): void {
  arriving.delete(jobId);
}
