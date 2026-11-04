/**
 * The way back from Feinschliff (plan D14): the Vorschau marks the job
 * right before it opens the editor; the editor takes the mark once when
 * it mounts. Marked, its back button is router.back() (the Vorschau is
 * the entry before it); else it pushes /app/p/{id}. One mark per tab
 * (sessionStorage), and any take clears it, so a mark never outlives
 * the editor it was meant for. Without storage (blocked) nothing is
 * marked: back pushes the Vorschau.
 */
const KEY = "cleocuts.refine.v1";

/** The editor is opened from this job's Vorschau (Feinschliff). */
export function markRefine(jobId: string): void {
  try {
    sessionStorage.setItem(KEY, jobId);
  } catch {
    /* storage blocked: back pushes the Vorschau */
  }
}

/** Whether this job's editor was opened from its Vorschau; clears the mark. */
export function takeRefine(jobId: string): boolean {
  try {
    const marked = sessionStorage.getItem(KEY);
    if (marked !== null) sessionStorage.removeItem(KEY);
    return marked === jobId;
  } catch {
    return false;
  }
}
