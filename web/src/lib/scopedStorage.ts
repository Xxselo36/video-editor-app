/**
 * The project lists kept in localStorage (library, active jobs) live
 * under per-user keys (`<key>:<user id>`, see storageScope) when accounts
 * are on, and under the plain key when they are off. Switching between
 * the two must never hide a project: signing in merges the plain list
 * into the user's (lib/account adoptLegacyLocalData), and switching
 * accounts off again (rollback) merges the per-user lists back.
 */
import { AUTH_ENABLED } from "@/lib/auth";

type Stored = { jobId?: unknown; timestamp?: unknown };

function entries(raw: string | null): Stored[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    const list = Array.isArray(v) ? v : [v];
    return list.filter((e): e is Stored => Boolean(e) && typeof e === "object");
  } catch {
    return [];
  }
}

const stamp = (e: Stored) => (typeof e.timestamp === "number" ? e.timestamp : 0);

/** Stored values (lists or single entries) merged into one list: one
 *  entry per jobId (the newest), newest first. */
export function mergeStored(...raws: (string | null)[]): Stored[] {
  const byId = new Map<string, Stored>();
  for (const e of raws.flatMap(entries)) {
    if (typeof e.jobId !== "string") continue;
    const prev = byId.get(e.jobId);
    if (!prev || stamp(e) > stamp(prev)) byId.set(e.jobId, e);
  }
  return [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
}

/** Merged entries in the shape the key stores: a list, or (`single`)
 *  just the newest entry. */
export function storedValue(list: Stored[], single: boolean): string | null {
  if (single) return list.length ? JSON.stringify(list[0]) : null;
  return JSON.stringify(list);
}

const folded = new Set<string>();

/**
 * Accounts were on and are off again: projects saved under per-user
 * keys would be invisible, since only `base` is read now. Merge them
 * into `base` once per page load and drop the per-user keys (so a
 * project deleted now doesn't come back). Without accounts every
 * project on the device is listed, as in the anonymous beta. No-op with
 * accounts on, and when there are no per-user keys.
 */
export function foldScopedKeys(base: string, single = false): void {
  if (AUTH_ENABLED || typeof window === "undefined" || folded.has(base)) return;
  folded.add(base);
  try {
    const scoped: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`${base}:`)) scoped.push(k);
    }
    if (!scoped.length) return;
    const merged = mergeStored(
      localStorage.getItem(base),
      ...scoped.map((k) => localStorage.getItem(k)),
    );
    const value = storedValue(merged, single);
    if (value === null) localStorage.removeItem(base);
    else localStorage.setItem(base, value);
    for (const k of scoped) localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
}
