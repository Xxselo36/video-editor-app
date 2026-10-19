/**
 * Timeline edits the server hasn't acknowledged, kept on this device per
 * job (save-11): the timeline autosave (timelineSave.ts) writes the newest
 * unacknowledged clip list here and clears it once the server has it. A
 * page closed, reloaded or killed (iOS discards hidden tabs) before that
 * leaves it behind; the next open compares it with what the server has:
 *
 *   none   the server has it (or nothing was left): the copy goes
 *   auto   the server is still at the rev the edit was made on: nobody
 *          saved since, so it comes back by itself (as an undo step)
 *   offer  the server moved on since (another tab or device saved): the
 *          editor offers it back, the user decides
 *
 * localStorage can be missing or full (private mode): every access is
 * guarded, and the editor works the same without it.
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { sameTimeline, type TimelineSeg } from "@/lib/editSave";
import { timelinePayload, type TimelineBackup } from "./timelineSave";

const KEY = (jobId: string) => `cleocuts.editor.unsaved.v1.${jobId}`;
/** A copy older than this is not offered (a week). */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export function writeUnsaved(jobId: string, b: TimelineBackup | null): void {
  try {
    if (b) localStorage.setItem(KEY(jobId), JSON.stringify(b));
    else localStorage.removeItem(KEY(jobId));
  } catch {
    /* storage blocked or full */
  }
}

const isSeg = (s: unknown): s is EditorSeg => {
  const x = s as EditorSeg | null;
  return !!x && typeof x.id === "string" && Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start;
};

export function readUnsaved(jobId: string, now = Date.now()): TimelineBackup | null {
  try {
    const raw = localStorage.getItem(KEY(jobId));
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

export type UnsavedDecision = { kind: "none" } | { kind: "auto" | "offer"; segs: EditorSeg[]; known: number[] };

/** What to do with a left-behind copy, given the timeline the server has (see the header). */
export function decideUnsaved(
  b: TimelineBackup | null,
  server: { rev: number; segments: TimelineSeg[] },
  duration: number,
): UnsavedDecision {
  if (!b) return { kind: "none" };
  const mine = timelinePayload(b.segs);
  if (!mine.length || sameTimeline(server.segments, mine, duration)) return { kind: "none" };
  // nobody saved since the edit was made (or only this device: a rev of its own)
  const ours = server.rev === b.base || b.known.includes(server.rev);
  return { kind: ours ? "auto" : "offer", segs: b.segs, known: b.known };
}
