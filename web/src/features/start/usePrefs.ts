/**
 * The remembered upload defaults (UX6, "Save as default"): on the server
 * for a signed-in user (GET/PUT /me/prefs — the same defaults on every
 * device), and always in this browser (localStorage cleocuts.prefs.v1) —
 * the only copy while signed out, and what shows at once before the
 * server answers.
 */
import { useEffect, useState } from "react";
import { useAuthState } from "@/lib/account";
import { apiFetch } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import { prefsFromSettings, settingsFromPrefs, type JobSettings } from "./defaults";

export const PREFS_KEY = "cleocuts.prefs.v1";

export function readLocalPrefs(): Partial<JobSettings> | null {
  try {
    return settingsFromPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null"));
  } catch {
    return null;
  }
}

function writeLocalPrefs(s: JobSettings): boolean {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefsFromSettings(s)));
    return true;
  } catch {
    return false;
  }
}

export type PrefsState = {
  /** The saved defaults (null: none saved). */
  saved: Partial<JobSettings> | null;
  /** Read from this browser (and, signed in, the server's answer is in
   *  or failed). */
  ready: boolean;
};

/** The saved defaults, and `save` to remember new ones (resolves false
 *  when neither copy could be written). */
export function usePrefs(): PrefsState & { save: (s: JobSettings) => Promise<boolean> } {
  const auth = useAuthState();
  const [state, setState] = useState<PrefsState>({ saved: null, ready: false });
  const signedIn = AUTH_ENABLED && auth.signedIn;
  const authKnown = !AUTH_ENABLED || auth.loaded;

  useEffect(() => {
    const local = readLocalPrefs();
    // After mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ saved: local, ready: authKnown && !signedIn });
    if (!signedIn) return;
    let alive = true;
    void (async () => {
      let server: Partial<JobSettings> | null = null;
      try {
        const r = await apiFetch("/me/prefs");
        if (r.ok) server = settingsFromPrefs(await r.json());
      } catch {
        /* offline: this browser's copy */
      }
      if (alive) setState({ saved: server ? { ...local, ...server } : local, ready: true });
    })();
    return () => {
      alive = false;
    };
  }, [signedIn, authKnown]);

  const save = async (s: JobSettings): Promise<boolean> => {
    const local = writeLocalPrefs(s);
    let remote = !signedIn;
    if (signedIn) {
      try {
        const r = await apiFetch("/me/prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prefsFromSettings(s)),
        });
        remote = r.ok;
      } catch {
        remote = false;
      }
    }
    if (local || remote) setState((cur) => ({ ...cur, saved: { ...s } }));
    return local || remote;
  };

  return { ...state, save };
}
