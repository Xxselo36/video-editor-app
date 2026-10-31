/**
 * "Zuletzt benutzt" (D4, D5): the choices an upload started with come
 * back for the next video. Written when its POST /jobs goes out, never
 * before (leaving the screen starts nothing): into this browser's prefs
 * (cleocuts.prefs.v1) and, signed in, the account's (PUT /me/prefs, the
 * same on every device). Read back by usePrefs (defaults.ts
 * settingsFromPrefs, lastStyleFromPrefs).
 */
import { apiFetch } from "@/lib/api";
import { AUTH_ENABLED, getAuthState } from "@/lib/auth";
import { writeLocalPrefsPatch } from "./captionDefault";
import type { TargetAspect } from "./defaults";

/** The prefs keys of the last used choices (choices.ts lastUsedPrefs). */
export type LastUsedPrefs = {
  target_aspect: TargetAspect;
  remove_fillers: boolean;
  /** ISO 639-1, or "auto". */
  spoken_language: string;
  /** A preset id, or "none". */
  caption_style_last: string;
};

const subs = new Set<(prefs: LastUsedPrefs) => void>();

/** Told of every save (usePrefs: the next pick of the same visit starts
 *  with them, as the next visit would). Returns the unsubscribe. */
export function onLastUsed(cb: (prefs: LastUsedPrefs) => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

/**
 * Remember `prefs`: this browser's copy at once, the account's when
 * signed in. Never fails: a refused or failed PUT (offline, a server
 * from before caption_style_last) leaves this browser's copy.
 */
export async function saveLastUsed(prefs: LastUsedPrefs): Promise<void> {
  writeLocalPrefsPatch(prefs);
  subs.forEach((f) => f(prefs));
  if (!(AUTH_ENABLED && getAuthState().signedIn)) return;
  try {
    await apiFetch("/me/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    });
  } catch {
    /* offline: this browser's copy */
  }
}
