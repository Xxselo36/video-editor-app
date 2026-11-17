/**
 * The Vorschau tab (/app/preview, plan D15): which project it opens. The
 * one last opened in this browser tab, unless a newer project came since
 * (the newest of those then); else the newest that has something to show
 * (being edited, ready, edited, being exported, exported). A video picked
 * here came when its job was made ("Los geht's", its upload done), not at
 * the pick. Pure; ./PreviewRoute asks.
 */
import type { Project, ProjectState } from "@/features/jobs/projects";

/** sessionStorage: the Vorschau last opened in this tab, and when. */
export const LAST_PREVIEW_KEY = "cleocuts.preview.last.v1";

export type LastPreview = { id: string; at: number };

const SHOWN: ReadonlySet<ProjectState> = new Set(["processing", "ready", "edited", "exporting", "exported"]);

type Candidate = Pick<Project, "id" | "state" | "createdAt" | "startedAt">;

const cameAt = (p: Candidate) => Math.max(p.createdAt, p.startedAt ?? 0);

export function pickPreview(projects: readonly Candidate[], last: LastPreview | null): string | null {
  let newest: Candidate | null = null;
  let lastOne: Candidate | null = null;
  let since: Candidate | null = null;
  for (const p of projects) {
    if (!SHOWN.has(p.state)) continue;
    if (!newest || p.createdAt > newest.createdAt) newest = p;
    if (!last) continue;
    if (p.id === last.id) lastOne = p;
    else if (cameAt(p) > last.at && (!since || cameAt(p) > cameAt(since))) since = p;
  }
  if (lastOne) return (since ?? lastOne).id;
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
