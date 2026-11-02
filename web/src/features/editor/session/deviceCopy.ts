/**
 * Where the editor keeps a job's changes the server hasn't acknowledged:
 * the timeline's copy (unsavedKey.ts, unsaved.ts) and the text's
 * (unsavedDoc.ts). localStorage under the job's keys; when storage
 * refuses a copy (full, blocked as with Safari's "Block All Cookies", or
 * too big for it), this document's memory instead. The editor and the
 * Vorschau run in one document (Feinschliff and back), so the Vorschau
 * and Fertigstellen's check still see what the editor couldn't store; a
 * reload or another tab don't. Every storage access is guarded.
 *
 * Kept small and free of the editor's code: the projects store
 * (features/jobs/jobsStore) drops a project's copies with it.
 */

export function unsavedKey(jobId: string): string {
  return `cleocuts.editor.unsaved.v1.${jobId}`;
}

export function unsavedDocKey(jobId: string): string {
  return `cleocuts.editor.unsavedDoc.v1.${jobId}`;
}

/** The v2 editor's title field (EditorShell): the name it showed last. */
export function titleKey(jobId: string): string {
  return `cleocuts.editor.title.${jobId}`;
}

// Copies storage didn't take, by key.
const memory = new Map<string, string>();

function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

/**
 * The copy under `key` as `parse` reads it (null: none that counts):
 * storage's, else this document's. One in storage that doesn't count
 * (unreadable, invalid, too old) goes: nothing else would ever remove it.
 */
export function readCopy<T>(key: string, parse: (text: string) => T | null): T | null {
  let text: string | null = null;
  try {
    text = localStorage.getItem(key);
  } catch {
    /* storage blocked */
  }
  if (text !== null) {
    const c = parse(text);
    if (c !== null) return c;
    removeStored(key);
  }
  const kept = memory.get(key);
  return kept === undefined ? null : parse(kept);
}

/**
 * Keep `text` under `key` (null: none). In storage when it takes it
 * (`fits`: not too big for the storage the app shares); else in this
 * document's memory, and no older copy stays in storage in its place.
 */
export function writeCopy(key: string, text: string | null, fits = true): void {
  let stored = false;
  try {
    if (text !== null && fits) {
      localStorage.setItem(key, text);
      stored = true;
    } else localStorage.removeItem(key);
  } catch {
    removeStored(key);
  }
  if (text !== null && !stored) memory.set(key, text);
  else memory.delete(key);
}

/** Remove the copy under `key` where it is still the one `same` knows (one written since stays). */
export function dropCopy(key: string, same: (text: string) => boolean): void {
  try {
    const text = localStorage.getItem(key);
    if (text !== null && same(text)) localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
  const kept = memory.get(key);
  if (kept !== undefined && same(kept)) memory.delete(key);
}

/** A project gone from this device (deleted, expired, not this account's): what the editor kept of it goes too. */
export function forgetCopies(jobId: string): void {
  for (const key of [unsavedKey(jobId), unsavedDocKey(jobId), titleKey(jobId)]) {
    removeStored(key);
    memory.delete(key);
  }
}
