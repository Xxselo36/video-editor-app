/**
 * Writing systems: language → script, character → script, and which
 * preset can caption which script (review C6, C7).
 *
 * The support table lives in script-support.json so that
 * scripts/font-coverage.py can verify it against the fonts' real coverage
 * (0 missing glyphs for every supported preset × language).
 */
import supportJson from "./script-support.json";
import type { Script } from "./types";

export type SupportLevel = "native" | "fallback" | "unavailable";
export type FontScript = "latin" | "cyrillic" | "devanagari";

type SupportJson = {
  languages: Record<string, Script>;
  cjk: Record<string, string>;
  fallbacks: Record<string, Partial<Record<FontScript, string>>>;
  lastResort: Record<FontScript, string>;
  presets: Record<string, { font: string } & Record<"latin" | "cyrillic" | "devanagari" | "cjk", SupportLevel>>;
};

export const SUPPORT = supportJson as unknown as SupportJson;

/** The scripts fonts are subset for, in face order. */
export const FONT_SCRIPTS: readonly FontScript[] = ["latin", "cyrillic", "devanagari"];

/** "pt-BR" → "pt", "zh-Hant" → "zh", "" → "en". */
export function normLang(lang?: string | null): string {
  const base = (lang || "en").trim().toLowerCase().split(/[-_]/)[0];
  return base || "en";
}

/** Script of a transcript language; unknown languages are treated as Latin. */
export function scriptOfLang(lang?: string | null): Script {
  return SUPPORT.languages[normLang(lang)] ?? "latin";
}

/** Script of a character; null for script-neutral ones (digits, punctuation, symbols, spaces). */
export function scriptOfCodepoint(cp: number): Script | null {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "latin";
  if (cp < 0xc0) return null;
  if (cp === 0xd7 || cp === 0xf7) return null;
  if (cp <= 0x24f || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x2c60 && cp <= 0x2c7f) || (cp >= 0xa720 && cp <= 0xa7ff)) {
    return "latin";
  }
  if ((cp >= 0x0400 && cp <= 0x052f) || (cp >= 0x1c80 && cp <= 0x1c8f) || (cp >= 0x2de0 && cp <= 0x2dff) || (cp >= 0xa640 && cp <= 0xa69f)) {
    return "cyrillic";
  }
  if ((cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff)) {
    return "devanagari";
  }
  if ((cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return "rtl";
  if (isCjkCodepoint(cp) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) {
    return "cjk";
  }
  return null;
}

/** Han, kana and CJK punctuation / full-width forms: text written without spaces. */
export function isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  );
}

/** The script most letters of `text` belong to; `fallback` for digits/punctuation only. */
export function wordScript(text: string, fallback: Script): Script {
  const counts = new Map<Script, number>();
  for (const ch of text) {
    const s = scriptOfCodepoint(ch.codePointAt(0)!);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: Script = fallback;
  let n = 0;
  for (const [s, c] of counts) {
    if (c > n || (c === n && s === fallback)) {
      best = s;
      n = c;
    }
  }
  return best;
}

/** True if no space goes between these two words (both sides Han/kana). */
export function joinsWithoutSpace(left: string, right: string): boolean {
  const a = [...left].pop();
  const b = [...right][0];
  return !!a && !!b && isCjkCodepoint(a.codePointAt(0)!) && isCjkCodepoint(b.codePointAt(0)!);
}

/** Languages whose words are not separated by spaces (segmented with Intl.Segmenter). */
export function segmentsWithoutSpaces(lang?: string | null): boolean {
  const l = normLang(lang);
  return l === "ja" || l === "zh" || l === "yue";
}

export type PresetSupport = {
  level: SupportLevel;
  script: Script;
  /** The font that renders this script (the preset's own, or the fallback). */
  font: string | null;
  /** CJK: the font is subset per job (UT3); until it arrives the browser's font is used. */
  deferred: boolean;
};

/**
 * Can `presetId` caption a transcript in `lang`? RTL scripts: no preset at
 * launch (captions default to "none" with the script_unsupported notice).
 */
export function presetSupport(presetId: string, lang?: string | null): PresetSupport {
  const script = scriptOfLang(lang);
  if (presetId === "none") return { level: "native", script, font: null, deferred: false };
  const row = SUPPORT.presets[presetId];
  if (!row || script === "rtl") return { level: "unavailable", script, font: null, deferred: false };
  const level = row[script];
  if (level === "unavailable") return { level, script, font: null, deferred: false };
  if (script === "cjk") {
    return { level, script, font: SUPPORT.cjk[normLang(lang)] ?? SUPPORT.cjk.ja, deferred: true };
  }
  const font = level === "native" ? row.font : (SUPPORT.fallbacks[row.font]?.[script] ?? null);
  return { level, script, font, deferred: false };
}
