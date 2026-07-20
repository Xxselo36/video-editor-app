/**
 * Job-history storage in localStorage.
 *
 * We save each finished render as a lightweight metadata entry — no
 * bytes, just IDs and labels. Downloads still hit the backend by job_id.
 * Backend evicts job files after some retention window, so the library
 * will occasionally show entries whose downloads 404; we surface that
 * gracefully.
 */

const KEY = "cleo-library-v1";
const MAX_ENTRIES = 30;

export type LibraryHookClip = {
  key: string;
  title: string;
  reason: string;
  start: number;
  end: number;
};

export type LibraryEntry = {
  jobId: string;
  timestamp: number;
  presetId: string | null;
  presetIcon: string | null;
  presetLabel: string | null;
  filename: string;
  outputs: string[];
  hookClips: LibraryHookClip[];
  socialCaption: string;
  socialHashtags: string[];
};

function readAll(): LibraryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries: LibraryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Quota exceeded — silently drop, library is nice-to-have not critical.
  }
}

export function getLibrary(): LibraryEntry[] {
  return readAll().sort((a, b) => b.timestamp - a.timestamp);
}

export function saveEntry(entry: LibraryEntry): void {
  const existing = readAll();
  // Dedupe by jobId (idempotent — same job saved multiple times = one entry)
  const filtered = existing.filter((e) => e.jobId !== entry.jobId);
  writeAll([entry, ...filtered]);
}

export function deleteEntry(jobId: string): void {
  writeAll(readAll().filter((e) => e.jobId !== jobId));
}

export function clearAll(): void {
  writeAll([]);
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString();
}
