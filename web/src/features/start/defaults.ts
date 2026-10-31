/**
 * The settings of a new video (UX6, flows.md §2.3): what POST /jobs
 * sends. The start screen's choices make them (choices.ts): one tight
 * cut for everyone, or none with "Nur Untertitel" (D6), and the caption
 * style picked there goes along whole (D7). Never a v1 caption preset:
 * the returning-browser Clipper rule is gone (D4).
 */
import type { UploadSettings } from "@/features/upload/settings";
import { isPresetId } from "@/lib/captions/presets";
import type { PresetId } from "@/lib/captions/types";

export type TargetAspect = "9:16" | "16:9" | "original";
/** One tight cut, or none ("Nur Untertitel"). */
export type Pace = "tight" | "none";

export type JobSettings = {
  targetAspect: TargetAspect;
  pace: Pace;
  removeFillers: boolean;
  voiceTriggers: boolean;
  /** ISO 639-1, or "auto" (Whisper detects it). */
  spokenLanguage: string;
};

/** What the prefs remember of the settings (D5): never the pace or the
 *  voice commands, as every video starts with cuts and voice commands. */
export type SavedSettings = Partial<Pick<JobSettings, "targetAspect" | "removeFillers" | "spokenLanguage">>;

export const ASPECTS: readonly TargetAspect[] = ["9:16", "16:9", "original"];

/** The first-ever defaults: the old TikTok workflow. */
export const DEFAULT_SETTINGS: JobSettings = {
  targetAspect: "9:16",
  pace: "tight",
  removeFillers: true,
  voiceTriggers: true,
  spokenLanguage: "auto",
};

function prefsObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The remembered settings of a stored or served prefs object (GET
 * /me/prefs, the localStorage copy): each of target_aspect,
 * remove_fillers and spoken_language that holds a valid value, else null
 * when none does. The style and voice_triggers older start screens saved
 * are ignored.
 */
export function settingsFromPrefs(v: unknown): SavedSettings | null {
  const p = prefsObject(v);
  if (!p) return null;
  const out: SavedSettings = {};
  if (ASPECTS.includes(p.target_aspect as TargetAspect)) out.targetAspect = p.target_aspect as TargetAspect;
  if (typeof p.remove_fillers === "boolean") out.removeFillers = p.remove_fillers;
  if (typeof p.spoken_language === "string" && /^(auto|[a-z]{2})$/.test(p.spoken_language)) {
    out.spokenLanguage = p.spoken_language;
  }
  return Object.keys(out).length ? out : null;
}

/** caption_style_last of a stored or served prefs object: the style the
 *  last upload started with ("none" included), or null. */
export function lastStyleFromPrefs(v: unknown): PresetId | null {
  const last = prefsObject(v)?.caption_style_last;
  return isPresetId(last) ? last : null;
}

/**
 * The settings POST /jobs sends. `captionStyle`: the style picked on the
 * start screen, whole (the server keeps it when it validates; the doc
 * starts with it) and its preset as the hint (all an older server
 * reads). The legacy SmartCam keys go along for a backend from before
 * UX6 (target_aspect decides on a current one). No extra letterbox
 * formats any more.
 */
export function uploadSettings(
  s: JobSettings,
  { captionStyle }: { captionStyle: NonNullable<UploadSettings["caption_style"]> },
): UploadSettings {
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
    caption_style_hint: captionStyle.presetId,
    caption_style: captionStyle,
  };
}
