/**
 * The Vorschau tab (/app/preview, plan D15): which project it opens. The
 * one last opened in this browser tab, unless a newer project came since;
 * else the newest that has something to show (being edited, ready,
 * edited, being exported, exported). Pure; ./PreviewRoute asks.
 */
import type { Project, ProjectState } from "@/features/jobs/projects";

/** sessionStorage: the Vorschau last opened in this tab, and when. */
export const LAST_PREVIEW_KEY = "cleocuts.preview.last.v1";

export type LastPreview = { id: string; at: number };

const SHOWN: ReadonlySet<ProjectState> = new Set(["processing", "ready", "edited", "exporting", "exported"]);

export function pickPreview(
  projects: readonly Pick<Project, "id" | "state" | "createdAt">[],
  last: LastPreview | null,
): string | null {
  let newest: (typeof projects)[number] | null = null;
  let lastOne: (typeof projects)[number] | null = null;
  for (const p of projects) {
    if (!SHOWN.has(p.state)) continue;
    if (!newest || p.createdAt > newest.createdAt) newest = p;
    if (last && p.id === last.id) lastOne = p;
  }
  if (lastOne && newest && newest.createdAt <= last!.at) return lastOne.id;
  return newest?.id ?? null;
}

/** A stored LastPreview, or null (none, or not one). */
export function parseLastPreview(raw: string | null): LastPreview | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastPreview> | null;
    return v && typeof v.id === "string" && v.id && typeof v.at === "number" ? { id: v.id, at: v.at } : null;
  } catch {
    return null;
  }
}

/** The Vorschau of `id` opened in this tab (PreviewScreen). */
export function rememberPreview(id: string, now = Date.now()): void {
  try {
    sessionStorage.setItem(LAST_PREVIEW_KEY, JSON.stringify({ id, at: now }));
  } catch {
    /* no storage: the tab opens the newest */
  }
}

export function readLastPreview(): LastPreview | null {
  try {
    return parseLastPreview(sessionStorage.getItem(LAST_PREVIEW_KEY));
  } catch {
    return null;
  }
}
