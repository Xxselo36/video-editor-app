/**
 * TEMPORARY until UT5 wires i18n: German and English display names for
 * the caption presets. The product reads names through the i18n keys
 * `captions.preset.<id>.name` / `.desc` (presets.ts `listPresets`); the
 * 14 message files get these keys in UT5, then this file goes.
 * Names describe the look only — never a real person (PLAN 2.3).
 */
import type { PresetId } from "./types";

type Names = { name: string; desc: string };

export const PRESET_NAMES: Record<"de" | "en", Record<PresetId, Names>> = {
  en: {
    power: { name: "Power", desc: "Bold capitals, thick outline, the spoken word in yellow, numbers in green" },
    mega: { name: "Mega", desc: "Loud comic capitals with a hard shadow; the active word jumps bigger" },
    clipper: { name: "Clipper", desc: "Comic font, the active word in neon green" },
    karaoke: { name: "Karaoke", desc: "The whole line is visible; spoken words fill with yellow" },
    boxed: { name: "Highlight Box", desc: "The active word sits on a rounded violet box" },
    punch: { name: "One Word", desc: "One big word at a time; numbers in yellow" },
    reveal: { name: "Word by Word", desc: "Words appear as they are spoken; the active word in turquoise" },
    neon: { name: "Neon", desc: "Letters with a cyan glow" },
    gradient: { name: "Sunset", desc: "Yellow-to-coral gradient in heavy capitals" },
    elegant: { name: "Elegant", desc: "Serif italic, soft fade-in, numbers in gold" },
    subtitle: { name: "Subtitle Bar", desc: "Classic subtitles on a translucent black bar" },
    minimal: { name: "Minimal", desc: "Plain white text with a soft shadow" },
    none: { name: "Off", desc: "No captions" },
  },
  de: {
    power: { name: "Power", desc: "Fette Großbuchstaben, dicke Kontur, das gesprochene Wort gelb, Zahlen grün" },
    mega: { name: "Mega", desc: "Laute Comic-Großbuchstaben mit hartem Schatten; das aktive Wort springt größer" },
    clipper: { name: "Clipper", desc: "Comic-Schrift, das aktive Wort neongrün" },
    karaoke: { name: "Karaoke", desc: "Die ganze Zeile ist sichtbar; gesprochene Wörter füllen sich gelb" },
    boxed: { name: "Highlight-Box", desc: "Das aktive Wort liegt auf einem abgerundeten violetten Kasten" },
    punch: { name: "Ein Wort", desc: "Ein großes Wort nach dem anderen; Zahlen gelb" },
    reveal: { name: "Wort für Wort", desc: "Wörter erscheinen, wie sie gesprochen werden; das aktive Wort türkis" },
    neon: { name: "Neon", desc: "Schrift mit cyanfarbenem Leuchten" },
    gradient: { name: "Sunset", desc: "Farbverlauf von Gelb zu Koralle in fetten Großbuchstaben" },
    elegant: { name: "Elegant", desc: "Serifen-Kursive, weiches Einblenden, Zahlen in Gold" },
    subtitle: { name: "Untertitel-Balken", desc: "Klassische Untertitel auf halbtransparentem schwarzem Balken" },
    minimal: { name: "Minimal", desc: "Schlichte weiße Schrift mit weichem Schatten" },
    none: { name: "Aus", desc: "Keine Untertitel" },
  },
};

export function presetName(id: PresetId, lang: string): Names {
  return (lang.toLowerCase().startsWith("de") ? PRESET_NAMES.de : PRESET_NAMES.en)[id];
}
