/**
 * The choices of "Untertitel wählen" (D4, D5): the caption style and,
 * under "Mehr Optionen", captions only, filler words, the format and the
 * spoken language. Pure: the start screen keeps them with its upload
 * (pendingStart.ts), and POST /jobs reads them when it goes out
 * (settingsOf, then defaults.ts uploadSettings).
 *
 * - The style: "Dein Standard" (the Style tab's saved default, drawn and
 *   sent with its look) wins, else the last used, else Power. A style
 *   that isn't live is ignored.
 * - "Nur Untertitel" is never carried over: every video starts with cuts
 *   and voice commands. It needs captions, and filler removal needs
 *   cuts; a switch that can't apply shows off and keeps what the user
 *   wanted, for when it can again.
 * - The format is kept as wanted. An upright video can't be made 16:9:
 *   it goes as original (the server would do the same).
 */
import type { UploadSettings } from "@/features/upload/settings";
import type { MessageKey } from "@/i18n/messages/en";
import { DEFAULT_PRESET, LAUNCH_PRESETS } from "@/lib/captions/presets";
import type { PresetId } from "@/lib/captions/types";
import { DEFAULT_SETTINGS, type JobSettings, type SavedSettings, type TargetAspect } from "./defaults";
import type { LastUsedPrefs } from "./lastUsed";
import { isPortrait, type VideoProbe } from "./probe";

/** A caption style with its look ("none": no captions). */
export type StyleChoice = NonNullable<UploadSettings["caption_style"]>;

export type Choices = {
  style: StyleChoice;
  /** "Nur Untertitel, nichts schneiden", as wanted. */
  captionsOnly: boolean;
  /** Filler words cut out, as wanted. */
  fillers: boolean;
  /** The format as wanted (effectiveAspect: what the video gets). */
  aspect: TargetAspect;
  /** ISO 639-1, or "auto". */
  language: string;
};

/** What a new video's choices start from. */
export type ChoiceSources = {
  /** The last used format, filler choice and language (usePrefs saved). */
  saved: SavedSettings | null;
  /** "Dein Standard" (usePrefs captionStyle). */
  standard: StyleChoice | null;
  /** "Zuletzt benutzt": a preset id or "none" (usePrefs lastStyle). */
  lastStyle: string | null;
  /** GET /config caption_styles_live (undefined: all twelve). */
  live: readonly string[] | undefined;
};

/** The style tiles in launch order: the live presets. "Ohne Untertitel"
 *  is the row below them, always there. */
export function styleTiles(live: readonly string[] | undefined): PresetId[] {
  return LAUNCH_PRESETS.filter((id) => !live || live.includes(id));
}

const offered = (id: string, live: readonly string[] | undefined) =>
  id === "none" || styleTiles(live).some((tile) => tile === id);

/** The style a tile picks: "Dein Standard" with its look, any other plain. */
export function tileStyle(presetId: string, standard: StyleChoice | null): StyleChoice {
  return { presetId, overrides: standard?.presetId === presetId ? standard.overrides : {} };
}

/** The choices a new video starts with. */
export function initialChoices({ saved, standard, lastStyle, live }: ChoiceSources): Choices {
  const std = standard && offered(standard.presetId, live) ? standard : null;
  const last = lastStyle && offered(lastStyle, live) ? lastStyle : null;
  const tiles = styleTiles(live);
  const first = tiles.includes(DEFAULT_PRESET) ? DEFAULT_PRESET : (tiles[0] ?? "none");
  return {
    style: tileStyle(std?.presetId ?? last ?? first, std),
    captionsOnly: false,
    fillers: saved?.removeFillers ?? DEFAULT_SETTINGS.removeFillers,
    aspect: saved?.targetAspect ?? DEFAULT_SETTINGS.targetAspect,
    language: saved?.spokenLanguage ?? DEFAULT_SETTINGS.spokenLanguage,
  };
}

/**
 * The tags of the styles, by preset id: "Dein Standard" on the saved
 * default, "Zuletzt benutzt" on the last used one when it is another
 * ("none": the "Ohne Untertitel" row's trailing chip). Live styles only.
 */
export function styleTags({ standard, lastStyle, live }: Omit<ChoiceSources, "saved">): Partial<Record<string, MessageKey>> {
  const tags: Partial<Record<string, MessageKey>> = {};
  if (standard && offered(standard.presetId, live)) tags[standard.presetId] = "app.start.yourDefault";
  if (lastStyle && !tags[lastStyle] && offered(lastStyle, live)) tags[lastStyle] = "app.start.lastUsed";
  return tags;
}

/** The format the video gets: as wanted, but never 16:9 for an upright
 *  video (original instead). */
export function effectiveAspect(c: Choices, probe: VideoProbe | null): TargetAspect {
  return c.aspect === "16:9" && isPortrait(probe) ? "original" : c.aspect;
}

/** The shape of the video it gets (only the ratio counts), where its
 *  captions are laid out. Null for Original while the size is unknown. */
export function outputShape(c: Choices, probe: VideoProbe | null): { width: number; height: number } | null {
  const aspect = effectiveAspect(c, probe);
  if (aspect === "9:16") return { width: 9, height: 16 };
  if (aspect === "16:9") return { width: 16, height: 9 };
  return probe?.width && probe.height ? { width: probe.width, height: probe.height } : null;
}

/** "Nur Untertitel" applies: it needs captions. */
const noCuts = (c: Choices) => c.captionsOnly && c.style.presetId !== "none";

/** The settings POST /jobs carries (defaults.ts uploadSettings): one
 *  tight cut with filler removal as wanted and voice commands, or no
 *  cuts and neither. */
export function settingsOf(c: Choices, probe: VideoProbe | null): JobSettings {
  const cuts = !noCuts(c);
  return {
    targetAspect: effectiveAspect(c, probe),
    pace: cuts ? "tight" : "none",
    removeFillers: cuts && c.fillers,
    voiceTriggers: cuts,
    spokenLanguage: c.language,
  };
}

/** A switch under "Mehr Optionen". Disabled, it shows off and the choice
 *  keeps the wanted value. */
export type SwitchRow = { checked: boolean; disabled: boolean; note: MessageKey | null };

/** "Nur Untertitel, nichts schneiden": not with "Ohne Untertitel". */
export function captionsOnlyRow(c: Choices): SwitchRow {
  const disabled = c.style.presetId === "none";
  const checked = !disabled && c.captionsOnly;
  return {
    checked,
    disabled,
    note: disabled ? "app.start.captionsOnlyNeedsCaptions" : checked ? "app.start.captionsOnlyNote" : null,
  };
}

/** Filler words: only when Cleo cuts. */
export function fillersRow(c: Choices): SwitchRow {
  const disabled = noCuts(c);
  return { checked: !disabled && c.fillers, disabled, note: disabled ? "app.start.fillersNeedCuts" : null };
}

/** A part of the "Mehr Optionen" summary: a message, or the spoken
 *  language (languages.ts languageName names it). */
export type SummaryPart = MessageKey | { language: string };

/**
 * The closed "Mehr Optionen" row's summary: what differs from the first
 * defaults, in the panel's order, plus "Hochkant" for a video that isn't
 * upright (9:16 crops it). Empty when there is nothing to say.
 */
export function moreSummary(c: Choices, probe: VideoProbe | null): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (noCuts(c)) parts.push("app.start.summaryCaptionsOnly");
  else if (!c.fillers) parts.push("app.start.summaryFillersKept");
  const aspect = effectiveAspect(c, probe);
  if (aspect === "16:9") parts.push("app.start.formatLandscape");
  else if (aspect === "original") parts.push("app.start.formatOriginal");
  else if (probe?.width && probe.height && !isPortrait(probe)) parts.push("app.start.formatPortrait");
  if (c.language !== "auto") parts.push({ language: c.language });
  return parts;
}

/** What the next video starts with (lastUsed.ts saveLastUsed): the
 *  format and filler choice as wanted, the language and the style;
 *  never "Nur Untertitel". */
export function lastUsedPrefs(c: Choices): LastUsedPrefs {
  return {
    target_aspect: c.aspect,
    remove_fillers: c.fillers,
    spoken_language: c.language,
    caption_style_last: c.style.presetId,
  };
}
