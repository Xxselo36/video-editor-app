/**
 * The settings of a new video (UX6, flows.md §2.3): what the start
 * screen shows and POST /jobs sends. One workflow — the old presets
 * (TikTok, Podcast, …) are these settings with other values.
 *
 * The caption style is not chosen here: the editor owns it. A new
 * browser sends none (the server's default, Power); a browser that has
 * projects already, and no saved defaults, keeps Clipper (review D11).
 */
import type { UploadSettings } from "@/features/upload/settings";

export type TargetAspect = "9:16" | "16:9" | "original";
export type Pace = "tight" | "smooth" | "none";

export type JobSettings = {
  targetAspect: TargetAspect;
  pace: Pace;
  removeFillers: boolean;
  voiceTriggers: boolean;
  /** ISO 639-1, or "auto" (Whisper detects it). */
  spokenLanguage: string;
};

export const ASPECTS: readonly TargetAspect[] = ["9:16", "16:9", "original"];
export const PACES: readonly Pace[] = ["tight", "smooth", "none"];

/** The first-ever defaults: the old TikTok workflow. */
export const DEFAULT_SETTINGS: JobSettings = {
  targetAspect: "9:16",
  pace: "tight",
  removeFillers: true,
  voiceTriggers: true,
  spokenLanguage: "auto",
};

/** The caption style a browser with earlier projects (and no saved
 *  defaults) keeps (PLAN 2.5). */
export const RETURNING_STYLE = "clipper";

/**
 * Settings from a stored or served prefs object (GET /me/prefs, the
 * localStorage copy): each known key that holds a valid value, else
 * null when nothing usable is there.
 */
export function settingsFromPrefs(v: unknown): Partial<JobSettings> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  const out: Partial<JobSettings> = {};
  if (ASPECTS.includes(p.target_aspect as TargetAspect)) out.targetAspect = p.target_aspect as TargetAspect;
  const style = p.style === "balanced" ? "smooth" : p.style;
  if (PACES.includes(style as Pace)) out.pace = style as Pace;
  if (typeof p.remove_fillers === "boolean") out.removeFillers = p.remove_fillers;
  if (typeof p.voice_triggers === "boolean") out.voiceTriggers = p.voice_triggers;
  if (typeof p.spoken_language === "string" && /^(auto|[a-z]{2})$/.test(p.spoken_language)) {
    out.spokenLanguage = p.spoken_language;
  }
  return Object.keys(out).length ? out : null;
}

/** The prefs object of `s` (GET/PUT /me/prefs keys). */
export function prefsFromSettings(s: JobSettings): Record<string, string | boolean> {
  return {
    target_aspect: s.targetAspect,
    style: s.pace,
    remove_fillers: s.removeFillers,
    voice_triggers: s.voiceTriggers,
    spoken_language: s.spokenLanguage,
  };
}

/**
 * The settings POST /jobs sends. `returning`: the browser has earlier
 * projects and no saved defaults → the Clipper hint (and the same v1
 * preset, which the v1 export engine reads). The legacy SmartCam keys
 * go along for a backend from before UX6 (target_aspect decides on a
 * current one). No extra letterbox formats any more.
 */
export function uploadSettings(s: JobSettings, { returning }: { returning: boolean }): UploadSettings {
  // "No cuts" turns both off on the server too.
  const cuts = s.pace !== "none";
  return {
    target_aspect: s.targetAspect,
    style: s.pace,
    remove_fillers: cuts && s.removeFillers,
    voice_triggers: cuts && s.voiceTriggers,
    ...(s.spokenLanguage !== "auto" ? { spoken_language: s.spokenLanguage } : {}),
    smartcam_enabled: s.targetAspect === "9:16",
    smartcam_format: "portrait",
    resolution: "1080",
    output_formats: [],
    ...(returning ? { caption_style_hint: RETURNING_STYLE, caption_preset: RETURNING_STYLE } : {}),
  };
}

/** Is `a` the same as `b`? */
export function sameSettings(a: JobSettings, b: JobSettings): boolean {
  return (
    a.targetAspect === b.targetAspect &&
    a.pace === b.pace &&
    a.removeFillers === b.removeFillers &&
    a.voiceTriggers === b.voiceTriggers &&
    a.spokenLanguage === b.spokenLanguage
  );
}
