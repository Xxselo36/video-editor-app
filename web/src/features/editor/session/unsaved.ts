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
 * guarded, and the editor works the same without it. The key and when a
 * copy counts (readUnsaved) live in unsavedKey.ts, which the Vorschau
 * reads too.
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { sameTimeline, type TimelineSeg } from "@/lib/editSave";
import { timelinePayload, type TimelineBackup } from "./timelineSave";
import { unsavedKey } from "./unsavedKey";

export { readUnsaved } from "./unsavedKey";

export function writeUnsaved(jobId: string, b: TimelineBackup | null): void {
  try {
    if (b) localStorage.setItem(unsavedKey(jobId), JSON.stringify(b));
    else localStorage.removeItem(unsavedKey(jobId));
  } catch {
    /* storage blocked or full */
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
