/**
 * What the start screen remembers (D4, D5): the last used format, filler
 * choice, spoken language and caption style (lastUsed.ts writes them as
 * an upload starts), and "Dein Standard", the caption style saved in the
 * v2 Style tab (captionDefault.ts). On the server for a signed-in user
 * (GET /me/prefs: the same on every device), and always in this browser
 * (localStorage cleocuts.prefs.v1): the only copy while signed out, and
 * what shows at once before the server answers.
 */
import { useEffect, useState } from "react";
import { useAuthState } from "@/lib/account";
import { apiFetch } from "@/lib/api";
import { AUTH_ENABLED } from "@/lib/auth";
import type { PresetId } from "@/lib/captions/types";
import { captionDefaultFromPrefs, readLocalPrefs, type CaptionStyleDefault } from "./captionDefault";
import { lastStyleFromPrefs, settingsFromPrefs, type SavedSettings } from "./defaults";

export type PrefsState = {
  /** The last used format, filler choice and spoken language (null: none). */
  saved: SavedSettings | null;
  /** "Dein Standard" (null: none saved). */
  captionStyle: CaptionStyleDefault | null;
  /** "Zuletzt benutzt": the style the last upload started with (null: none). */
  lastStyle: PresetId | null;
  /** Read from this browser (and, signed in, the server's answer is in
   *  or failed). Prefs that come later apply to choices the user hasn't
   *  touched only. */
  ready: boolean;
};

function fromPrefs(v: unknown): Omit<PrefsState, "ready"> {
  return { saved: settingsFromPrefs(v), captionStyle: captionDefaultFromPrefs(v), lastStyle: lastStyleFromPrefs(v) };
}

export function usePrefs(): PrefsState {
  const auth = useAuthState();
  const [state, setState] = useState<PrefsState>({ saved: null, captionStyle: null, lastStyle: null, ready: false });
  const signedIn = AUTH_ENABLED && auth.signedIn;
  const authKnown = !AUTH_ENABLED || auth.loaded;

  useEffect(() => {
    const local = fromPrefs(readLocalPrefs());
    // After mount: the server render has no storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ ...local, ready: authKnown && !signedIn });
    if (!signedIn) return;
    let alive = true;
    void (async () => {
      let server: Omit<PrefsState, "ready"> | null = null;
      try {
        const r = await apiFetch("/me/prefs");
        if (r.ok) server = fromPrefs(await r.json());
      } catch {
        /* offline: this browser's copy */
      }
      if (!alive) return;
      setState({
        saved: server?.saved ? { ...local.saved, ...server.saved } : local.saved,
        captionStyle: server?.captionStyle ?? local.captionStyle,
        lastStyle: server?.lastStyle ?? local.lastStyle,
        ready: true,
      });
    })();
    return () => {
      alive = false;
    };
  }, [signedIn, authKnown]);

  return state;
}
