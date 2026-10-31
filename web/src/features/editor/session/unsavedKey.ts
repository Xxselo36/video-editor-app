/**
 * Where this device keeps a job's timeline edits the server hasn't
 * acknowledged (save-11, unsaved.ts), and when such a copy counts: valid
 * clips, the rev they were made on, at most a week old. Apart from the
 * editor's save code, so the Vorschau can ask (hasUnsavedTimeline)
 * without loading it.
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { TimelineBackup } from "./timelineSave";

export function unsavedKey(jobId: string): string {
  return `cleocuts.editor.unsaved.v1.${jobId}`;
}

/** A copy older than this is not offered (a week). */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const isSeg = (s: unknown): s is EditorSeg => {
  const x = s as EditorSeg | null;
  return !!x && typeof x.id === "string" && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start;
};

/** The job's copy on this device; null without one, or when it is unreadable, invalid or too old. */
export function readUnsaved(jobId: string, now = Date.now()): TimelineBackup | null {
  try {
    const raw = localStorage.getItem(unsavedKey(jobId));
    if (!raw) return null;
    const b = JSON.parse(raw) as Partial<TimelineBackup>;
    if (!Array.isArray(b.segs) || !b.segs.length || !b.segs.every(isSeg) || typeof b.base !== "number") return null;
    if (typeof b.at === "number" && now - b.at > MAX_AGE_MS) return null;
    return {
      segs: b.segs,
      base: b.base,
      known: Array.isArray(b.known) ? b.known.filter((r): r is number => typeof r === "number") : [],
      at: typeof b.at === "number" ? b.at : 0,
    };
  } catch {
    return null;
  }
}

/** Edits of this job on this device the server may not have: the editor
 *  brings them back on its next open (reads storage: client only). */
export function hasUnsavedTimeline(jobId: string, now = Date.now()): boolean {
  return readUnsaved(jobId, now) !== null;
}
