/**
 * The remembered upload defaults (UX6, "Save as default"): on the server
 * for a signed-in user (GET/PUT /me/prefs — the same defaults on every
 * device), and always in this browser (localStorage cleocuts.prefs.v1) —
 * the only copy while signed out, and what shows at once before the
 * server answers. The v2 Style tab's saved caption style lives in the
 * same object (captionDefault.ts); saving the upload defaults keeps it.
 */
import { useEffect, useState } from "react";
import { useAuthState } from "@/lib/account";
import { apiFetch } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import { captionDefaultFromPrefs, PREFS_KEY, writeLocalPrefsPatch, type CaptionStyleDefault } from "./captionDefault";
import { prefsFromSettings, settingsFromPrefs, type JobSettings } from "./defaults";

export { PREFS_KEY };

export function readLocalPrefs(): Partial<JobSettings> | null {
  try {
    return settingsFromPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null"));
  } catch {
    return null;
  }
}

function readLocalCaptionStyle(): CaptionStyleDefault | null {
  try {
    return captionDefaultFromPrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null"));
  } catch {
    return null;
  }
}

/** The upload defaults into this browser's prefs (the saved caption style stays). */
function writeLocalPrefs(s: JobSettings): boolean {
  return writeLocalPrefsPatch(prefsFromSettings(s));
}

export type PrefsState = {
  /** The saved defaults (null: none saved). */
  saved: Partial<JobSettings> | null;
  /** The caption style saved in the v2 Style tab (captionDefault.ts; null: none). */
  captionStyle: CaptionStyleDefault | null;
  /** Read from this browser (and, signed in, the server's answer is in
   *  or failed). */
  ready: boolean;
};

/** The saved defaults, and `save` to remember new ones (resolves false
 *  when neither copy could be written). */
export function usePrefs(): PrefsState & { save: (s: JobSettings) => Promise<boolean> } {
  const auth = useAuthState();
  const [state, setState] = useState<PrefsState>({ saved: null, captionStyle: null, ready: false });
  const signedIn = AUTH_ENABLED && auth.signedIn;
  const authKnown = !AUTH_ENABLED || auth.loaded;

  useEffect(() => {
    const local = readLocalPrefs();
    const localStyle = readLocalCaptionStyle();
    // After mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ saved: local, captionStyle: localStyle, ready: authKnown && !signedIn });
    if (!signedIn) return;
    let alive = true;
    void (async () => {
      let server: Partial<JobSettings> | null = null;
      let serverStyle: CaptionStyleDefault | null = null;
      try {
        const r = await apiFetch("/me/prefs");
        if (r.ok) {
          const j = await r.json();
          server = settingsFromPrefs(j);
          serverStyle = captionDefaultFromPrefs(j);
        }
      } catch {
        /* offline: this browser's copy */
      }
      if (alive) setState({ saved: server ? { ...local, ...server } : local, captionStyle: serverStyle ?? localStyle, ready: true });
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
