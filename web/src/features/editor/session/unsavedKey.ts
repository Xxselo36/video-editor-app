/**
 * Where this device keeps a job's timeline edits the server hasn't
 * acknowledged (save-11, unsaved.ts), and when such a copy counts: valid
 * clips, the rev they were made on, at most a week old, and a timeline
 * the server doesn't have. Apart from the editor's save code, so the
 * Vorschau can ask (unsavedTimeline) without loading it. Storage that
 * refuses a copy keeps it in this document (deviceCopy.ts).
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { sameTimeline, type TimelineSeg } from "@/lib/editSave";
import { dropCopy, readCopy, unsavedKey, writeCopy } from "./deviceCopy";
import type { TimelineBackup } from "./timelineSave";

export { unsavedKey };

/** A copy older than this is not offered (a week). */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const isSeg = (s: unknown): s is EditorSeg => {
  const x = s as EditorSeg | null;
  return !!x && typeof x.id === "string" && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start;
};

/** A stored copy as text: null when it is unreadable, invalid or too old. */
function parseBackup(raw: string, now: number): TimelineBackup | null {
  try {
    const b = JSON.parse(raw) as Partial<TimelineBackup> | null;
    if (!b || !Array.isArray(b.segs) || !b.segs.length || !b.segs.every(isSeg) || typeof b.base !== "number") return null;
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

/** The job's copy on this device; null without one, or when it is
 *  unreadable, invalid or too old (such a one goes). */
export function readUnsaved(jobId: string, now = Date.now()): TimelineBackup | null {
  return readCopy(unsavedKey(jobId), (raw) => parseBackup(raw, now));
}

/** Keep `b` as the job's copy (null: none). */
export function putUnsaved(jobId: string, b: TimelineBackup | null): void {
  writeCopy(unsavedKey(jobId), b ? JSON.stringify(b) : null);
}

/** Remove the job's copy while it is still `b` (one written since stays). */
export function dropUnsaved(jobId: string, b: TimelineBackup): void {
  const want = JSON.stringify(b);
  dropCopy(unsavedKey(jobId), (raw) => {
    const now = parseBackup(raw, b.at);
    return !!now && JSON.stringify(now) === want;
  });
}

/** Edits of this job on this device the server may not have: the editor
 *  brings them back on its next open (reads storage: client only). */
export function hasUnsavedTimeline(jobId: string, now = Date.now()): boolean {
  return readUnsaved(jobId, now) !== null;
}

/** The clips a save sends: enabled, over 0.05 s (the backend drops shorter), with effects. */
export function timelinePayload(segs: readonly EditorSeg[]): TimelineSeg[] {
  return segs
    .filter((s) => !s.disabled && s.end - s.start > 0.05)
    .map((s) => ({
      start: s.start,
      end: s.end,
      speed: s.speed,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      volume: s.volume,
    }));
}

/** The server has the copy's timeline, or the copy has no clip a save
 *  would send: nothing of it is missing there (the editor's rule,
 *  unsaved.ts decideUnsaved). */
export function copyIsStored(b: TimelineBackup, server: TimelineSeg[] | undefined, duration: number): boolean {
  const mine = timelinePayload(b.segs);
  return !mine.length || sameTimeline(server, mine, duration);
}

/**
 * The job's copy when it holds a timeline the server doesn't have
 * (`server`: the job's stored clips). One the server has (a keepalive
 * save that landed after the tab closed) doesn't count and goes, unless
 * a newer one was written meanwhile. For the Vorschau and Fertigstellen.
 */
export function unsavedTimeline(
  jobId: string,
  server: TimelineSeg[] | undefined,
  duration: number,
  now = Date.now(),
): TimelineBackup | null {
  const b = readUnsaved(jobId, now);
  if (!b || !copyIsStored(b, server, duration)) return b;
  dropUnsaved(jobId, b);
  return null;
}
