/**
 * The saved caption style ("Save as default" in the v2 Style tab): a
 * preset plus the look's overrides — never a caption's own position /
 * size (overrides.captions: one video's captions). Kept with the other
 * upload defaults (usePrefs): prefs key caption_style_default, on the
 * server for a signed-in user (PUT /me/prefs; backend/prefs.py
 * validates it) and always in this browser (localStorage
 * cleocuts.prefs.v1).
 *
 * New uploads from the v2 start screen send it: the preset as the
 * caption_style_hint, and once the job exists the whole style as its
 * caption_style (PATCH /jobs/{id}: the doc built at analysis end has
 * it). A job whose PATCH didn't get through is remembered here
 * (PENDING_KEY) and the editor gives its doc the style on first open
 * (rev 0 only: a project someone edited keeps its own style).
 *
 * Framework-free and small: the editor's Style panel and the start
 * screen both import it.
 */
import { apiFetch } from "@/lib/api";
import { AUTH_ENABLED, getAuthState } from "@/lib/auth";

export const PREFS_KEY = "cleocuts.prefs.v1";
/** Jobs created with the saved style whose PATCH /jobs/{id} failed. */
export const PENDING_KEY = "cleocuts.captionDefault.pending.v1";
const PENDING_MAX = 20;
/** The backend's limit (prefs.CAPTION_STYLE_MAX_BYTES). */
const MAX_BYTES = 1000;

export type CaptionStyleDefault = { presetId: string; overrides: Record<string, unknown> };

/** The default of a doc style: its preset and look, without per-caption adjustments. */
export function defaultOfStyle(style: { presetId: string; overrides?: Record<string, unknown> | null }): CaptionStyleDefault {
  const overrides: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style.overrides ?? {})) {
    if (k !== "captions" && v !== undefined) overrides[k] = v;
  }
  return { presetId: style.presetId, overrides };
}

/** caption_style_default of a stored or served prefs object, or null. */
export function captionDefaultFromPrefs(v: unknown): CaptionStyleDefault | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = (v as Record<string, unknown>).caption_style_default;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const { presetId, overrides } = c as Record<string, unknown>;
  if (typeof presetId !== "string" || !/^[a-z0-9_-]{1,32}$/.test(presetId)) return null;
  const o = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? (overrides as Record<string, unknown>) : {};
  return defaultOfStyle({ presetId, overrides: o });
}

/** Same preset and look (key order aside)? */
export function sameCaptionStyle(a: CaptionStyleDefault | null, b: CaptionStyleDefault | null): boolean {
  if (!a || !b) return a === b;
  if (a.presetId !== b.presetId) return false;
  const ka = Object.keys(a.overrides).sort();
  const kb = Object.keys(b.overrides).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a.overrides[k] === b.overrides[k]);
}

function readRaw(): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into this browser's prefs object (null removes a key). */
export function writeLocalPrefsPatch(patch: Record<string, unknown>): boolean {
  try {
    const next: Record<string, unknown> = { ...readRaw() };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function readLocalCaptionDefault(): CaptionStyleDefault | null {
  return captionDefaultFromPrefs(readRaw());
}

/**
 * Remember `style` as the default: this browser, and the account when
 * signed in. Resolves false when neither copy could be written.
 */
export async function saveCaptionDefault(style: CaptionStyleDefault): Promise<boolean> {
  const value = defaultOfStyle(style);
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) return false;
  const local = writeLocalPrefsPatch({ caption_style_default: value });
  const signedIn = AUTH_ENABLED && getAuthState().signedIn;
  let remote = false;
  if (signedIn) {
    try {
      const r = await apiFetch("/me/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption_style_default: value }),
      });
      remote = r.ok;
    } catch {
      remote = false;
    }
  }
  return local || remote;
}

/** The saved default as this browser knows it, refreshed from the account when signed in. */
export async function loadCaptionDefault(): Promise<CaptionStyleDefault | null> {
  const local = readLocalCaptionDefault();
  if (!(AUTH_ENABLED && getAuthState().signedIn)) return local;
  try {
    const r = await apiFetch("/me/prefs");
    if (r.ok) return captionDefaultFromPrefs(await r.json()) ?? local;
  } catch {
    /* offline: this browser's copy */
  }
  return local;
}

// ── jobs created with the default ────────────────────────────────────

function readPending(): Record<string, CaptionStyleDefault> {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writePending(map: Record<string, CaptionStyleDefault>) {
  try {
    const ids = Object.keys(map);
    if (!ids.length) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(ids.slice(-PENDING_MAX).map((id) => [id, map[id]]))));
  } catch {
    /* ignore */
  }
}

/**
 * Job `jobId` was created with the saved style: give it the style now
 * (PATCH /jobs/{id} caption_style — the doc's style at analysis end);
 * when that fails the editor applies it on first open (takePending).
 */
export async function applyToNewJob(jobId: string, style: CaptionStyleDefault): Promise<boolean> {
  try {
    const r = await apiFetch(`/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption_style: style }),
    });
    if (r.ok) return true;
  } catch {
    /* below */
  }
  writePending({ ...readPending(), [jobId]: style });
  return false;
}

/** The style job `jobId` still waits for (and forget it). */
export function takePending(jobId: string): CaptionStyleDefault | null {
  const map = readPending();
  const style = map[jobId];
  if (!style) return null;
  delete map[jobId];
  writePending(map);
  return captionDefaultFromPrefs({ caption_style_default: style });
}
