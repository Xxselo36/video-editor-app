/** Test helpers for the caption engine (vitest, Node). */
import { fileURLToPath } from "node:url";
import fontsJson from "../fonts.json";
import { setFontTables, type FontTables } from "../metrics";
import type { CaptionWord } from "../types";

export const FONTS_DIR = fileURLToPath(new URL("../../../../public/fonts/captions/", import.meta.url));

export function useRealFonts(): FontTables {
  const tables = fontsJson as unknown as FontTables;
  setFontTables(tables);
  return tables;
}

/**
 * Words of `text` with made-up but regular timings: each word lasts
 * `dur` seconds, `gap` seconds apart, starting at `start`.
 */
export function timed(text: string, opts: { start?: number; dur?: number; gap?: number; prefix?: string } = {}): CaptionWord[] {
  const { start = 0, dur = 0.28, gap = 0.04, prefix = "w" } = opts;
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t, i) => ({
      id: `${prefix}${i}`,
      text: t,
      start: +(start + i * (dur + gap)).toFixed(3),
      end: +(start + i * (dur + gap) + dur).toFixed(3),
    }));
}

/** The audit clip sentence (word times from the lab's sample.mjs). */
export const AUDIT_WORDS: CaptionWord[] = (
  [
    ["Nobody", 0.0, 0.34],
    ["waits", 0.37, 0.663],
    ["ten", 0.693, 0.894],
    ["seconds", 0.924, 1.31],
    ["for", 1.34, 1.541],
    ["you", 1.571, 1.772],
    ["to", 1.802, 1.957],
    ["get", 1.987, 2.188],
    ["to", 2.218, 2.373],
    ["the", 2.403, 2.604],
    ["point.", 2.634, 2.974],
  ] as const
).map(([text, start, end], i) => ({ id: `a${i}`, text, start, end }));
