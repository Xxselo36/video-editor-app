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
 *          editor offers it back, the user decides. Left alone until the
 *          editor is left in the app (no Restore, no edit), it goes
 *          (dropOffered): the user kept the newer timeline, and the
 *          Vorschau, which holds Fertigstellen for a copy, lets it be. A
 *          reload or a closed tab keeps it for the next open.
 *
 * localStorage can be missing, blocked or full (private mode): every
 * access is guarded, and a copy storage refuses stays in this document
 * (deviceCopy.ts), where the Vorschau still sees it. The key and when a
 * copy counts (readUnsaved, copyIsStored) live in unsavedKey.ts, which
 * the Vorschau reads too: a copy the server has counts there as nothing
 * unsaved, as here. The edit document's twin: unsavedDoc.ts.
 */
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { TimelineSeg } from "@/lib/editSave";
import type { TimelineBackup } from "./timelineSave";
import { copyIsStored, dropUnsaved, putUnsaved } from "./unsavedKey";

export { dropUnsaved, readUnsaved } from "./unsavedKey";

export function writeUnsaved(jobId: string, b: TimelineBackup | null): void {
  putUnsaved(jobId, b);
}

export type UnsavedDecision =
  | { kind: "none" }
  | { kind: "auto" | "offer"; segs: EditorSeg[]; known: number[]; copy: TimelineBackup };

/** What to do with a left-behind copy, given the timeline the server has (see the header). */
export function decideUnsaved(
  b: TimelineBackup | null,
  server: { rev: number; segments: TimelineSeg[] },
  duration: number,
): UnsavedDecision {
  if (!b || copyIsStored(b, server.segments, duration)) return { kind: "none" };
  // nobody saved since the edit was made (or only this device: a rev of its own)
  const ours = server.rev === b.base || b.known.includes(server.rev);
  return { kind: ours ? "auto" : "offer", segs: b.segs, known: b.known, copy: b };
}

/** An offered copy the user left alone: removed while it is still that
 *  copy (`copy`, as read at the editor's open). One written since (an
 *  edit, Restore: the autosave's) stays. */
export function dropOffered(jobId: string, copy: TimelineBackup): void {
  dropUnsaved(jobId, copy);
}
