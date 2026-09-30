/**
 * v1 caption preset ids → v2 styles (PLAN 3.5 "Was aus den alten Stilen
 * wird"). Used where an old id reaches the new engine: the UT1 preview of
 * v1 jobs, a user's remembered style, `settings.caption_preset` of old
 * jobs rendered with the v2 engine (UT4).
 *
 *   clean, subtle → minimal        highlight → boxed
 *   classic       → power, no highlight (active word stays white)
 *   flash         → mega           punch → punch   elegant → elegant
 *   clipper       → clipper        none → none
 *
 * New ids pass through; anything unknown becomes the default (power).
 */
import { DEFAULT_PRESET, isPresetId } from "./presets";
import type { StyleRef } from "./types";

export const V1_PRESETS: Readonly<Record<string, StyleRef>> = {
  clean: { presetId: "minimal", overrides: {} },
  subtle: { presetId: "minimal", overrides: {} },
  classic: { presetId: "power", overrides: { highlightColor: "#FFFFFF" } },
  highlight: { presetId: "boxed", overrides: {} },
  flash: { presetId: "mega", overrides: {} },
  punch: { presetId: "punch", overrides: {} },
  elegant: { presetId: "elegant", overrides: {} },
  clipper: { presetId: "clipper", overrides: {} },
  none: { presetId: "none", overrides: {} },
};

export function migratePresetId(id: string | null | undefined): StyleRef {
  const key = (id ?? "").trim().toLowerCase();
  const v1 = V1_PRESETS[key];
  if (v1) return { presetId: v1.presetId, overrides: { ...v1.overrides } };
  if (isPresetId(key)) return { presetId: key, overrides: {} };
  return { presetId: DEFAULT_PRESET, overrides: {} };
}
