/**
 * Caption fonts: manifest, fallback chains, loading (UT2).
 *
 * - fonts.json (scripts/build-caption-fonts.py) lists every shipped font
 *   with one FACE per script subset (latin, cyrillic, devanagari), each its
 *   own CSS family "cc-<font>-<subset>". Faces load separately, so a user
 *   only downloads the scripts the captions use.
 * - A word is drawn with a face list (the CSS family list in ctx.font):
 *   the face for the word's script first, then the preset font's other
 *   faces, then per-script fallbacks (script-support.json), the job's CJK
 *   face (UT3) and a generic family. metrics.ts measures with the same list,
 *   so measured and drawn fonts agree.
 * - ensureFonts() loads what a text needs before the first draw: canvas
 *   text never triggers a web font download, and a draw before the load
 *   would use a system font (the lab saw fallback-font tiles until fixed).
 *   Loading goes through a FontLoader adapter: FontFace in the browser
 *   (browserFontLoader), GlobalFonts in Node (node/fonts.ts).
 */
import {
  deferredFont,
  getFont,
  loadFontTables,
  registerFont,
  requireFont,
  type Face,
  type FontJson,
  type FontMetrics,
} from "./metrics";
import { hasShapingFont, loadShaper, registerShapingFont } from "./shape-hb";
import {
  FONT_SCRIPTS,
  SUPPORT,
  normLang,
  scriptOfCodepoint,
  scriptOfLang,
  wordScript,
  type FontScript,
} from "./scripts";
import type { CaptionStyle, Script } from "./types";

// ---------------------------------------------------------------- chains

function faceOf(fontId: string | undefined, subset: string): Face | undefined {
  if (!fontId) return undefined;
  return getFont(fontId)?.face(subset);
}

/** The job's CJK face (registered by UT5 from the job's font subset), if any. */
function cjkFaces(lang: string): Face[] {
  const id = SUPPORT.cjk[normLang(lang)];
  const f = id ? getFont(id) : undefined;
  return f ? f.faces : [];
}

const chainCache = new Map<string, Face[]>();
let fontsRevision = 0;

/**
 * Face list for a word of `script` in a caption set in `fontId`, for a
 * transcript in `lang`. Deterministic; cached until fonts are registered.
 */
export function faceChain(fontId: string, lang: string | undefined, script: Script): Face[] {
  const key = `${fontId}|${normLang(lang)}|${script}|${fontsRevision}`;
  const hit = chainCache.get(key);
  if (hit) return hit;
  const primary = requireFont(fontId);
  const out: Face[] = [];
  const push = (f: Face | undefined) => {
    if (f && !out.includes(f)) out.push(f);
  };
  const forScript = (s: FontScript) =>
    primary.face(s) ?? faceOf(SUPPORT.fallbacks[fontId]?.[s], s) ?? faceOf(SUPPORT.lastResort[s], s);
  if (script === "cjk") for (const f of cjkFaces(lang ?? "")) push(f);
  else if (script !== "rtl") push(forScript(script));
  for (const f of primary.faces) push(f);
  for (const s of FONT_SCRIPTS) push(forScript(s));
  for (const f of cjkFaces(lang ?? "")) push(f);
  chainCache.set(key, out);
  return out;
}

// Emoji, pictographs, dingbats and other symbols, private use, keycaps,
// regional indicators and tags: characters no caption font is expected
// to have.
const SYMBOL = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\p{So}\p{Co}⃣\u{E0020}-\u{E007F}]/u;
// What glues an emoji sequence together (ZWJ, variation selectors): it
// goes with the symbol it belongs to, and only then (ZWJ also shapes
// Indic text).
const EMOJI_GLUE = /[‍︎️\u{E0100}-\u{E01EF}\u{1F3FB}-\u{1F3FF}]/u;

/**
 * `text` without the symbols no face of the caption's chain can draw
 * (emoji, pictographs, dingbats, private use …) and the joiners and
 * variation selectors around them. The editor preview and the render
 * worker (UT4) both lay out and draw only what this returns, so neither
 * shows tofu or a system emoji the other doesn't have. Letters of any
 * script are never stripped: missing ones are a font problem (the job's
 * CJK subset), reported by ensureFonts as `uncovered`.
 */
export function stripUndrawable(text: string, fontId: string, lang?: string): { text: string; removed: number } {
  if (!SYMBOL.test(text) && !EMOJI_GLUE.test(text)) return { text, removed: 0 };
  const chars = [...text];
  const faces = faceChain(fontId, lang, wordScript(text, scriptOfLang(lang)));
  const drop = chars.map((ch) => SYMBOL.test(ch) && !faces.some((f) => f.cps.has(ch.codePointAt(0)!)));
  // glue next to a dropped symbol (or next to glue that goes) goes too
  for (let changed = true; changed; ) {
    changed = false;
    chars.forEach((ch, i) => {
      if (drop[i] || !EMOJI_GLUE.test(ch)) return;
      if (drop[i - 1] || drop[i + 1]) {
        drop[i] = true;
        changed = true;
      }
    });
  }
  const removed = drop.filter(Boolean).length;
  if (!removed) return { text, removed: 0 };
  return { text: chars.filter((_, i) => !drop[i]).join(""), removed };
}

/** CSS font shorthand for ctx.font. */
export function cssFont(faces: readonly Face[], px: number): string {
  const families = faces.map((f) => `"${f.family}"`).join(", ");
  return `${Math.round(px * 100) / 100}px ${families ? families + ", " : ""}sans-serif`;
}

/**
 * Registers a font at runtime — a job's CJK subset (UT3: woff2 for the
 * browser, metrics in the fonts.json entry format) — and refreshes the
 * face chains.
 */
export function registerCaptionFont(id: string, json: FontJson, baseUrl = ""): FontMetrics {
  const m = registerFont(id, json, baseUrl);
  fontsRevision++;
  chainCache.clear();
  return m;
}

// ---------------------------------------------------------------- loading

export interface FontLoader {
  /** Makes `face` available to the canvas under `face.family`. */
  load(face: Face): Promise<void>;
  /**
   * The bytes of a face, for HarfBuzz shaping (Devanagari). Optional: a
   * loader that returns them from load() may register them itself.
   */
  bytes?(face: Face): Promise<ArrayBuffer | Uint8Array>;
}

export type FontStatus = {
  /** Every face the text needs is loaded. */
  ok: boolean;
  loaded: string[];
  failed: { face: string; error: string }[];
  /** Characters no shipped face covers (CJK before the job's subset, emoji): drawn with a system font. */
  uncovered: string[];
  /** A deferred CJK font is needed but not registered yet (tile: "fallback font"). */
  deferred: string[];
};

// one load per face and loader (a loader stands for one font set)
const loadsByLoader = new WeakMap<FontLoader, Map<string, Promise<void>>>();

function loadFace(face: Face, loader: FontLoader): Promise<void> {
  const loads = loadsByLoader.get(loader) ?? new Map<string, Promise<void>>();
  loadsByLoader.set(loader, loads);
  const key = `${face.key}|${face.url}`;
  let p = loads.get(key);
  if (!p) {
    // one retry (review F10 row 20), then report
    p = loader.load(face).catch(() => loader.load(face));
    loads.set(key, p);
    p.catch(() => loads.delete(key));
  }
  return p;
}

let defaultLoader: FontLoader | null = null;
/** Sets the loader ensureFonts() uses when none is passed (Node: node/fonts.ts). */
export function setDefaultFontLoader(loader: FontLoader | null): void {
  defaultLoader = loader;
}

/**
 * Loads every face `text` needs in `style` for a transcript in `lang`, plus
 * HarfBuzz when Devanagari appears. Without `text`, loads the faces for the
 * language's script. Never throws for a missing font: the status says what
 * is missing and the caller decides (UT5 shows "Preview font didn't load").
 */
export async function ensureFonts(
  style: Pick<CaptionStyle, "font" | "presetId">,
  opts: { lang?: string; text?: string | readonly string[]; loader?: FontLoader } = {},
): Promise<FontStatus> {
  await loadFontTables();
  const status: FontStatus = { ok: true, loaded: [], failed: [], uncovered: [], deferred: [] };
  if (style.presetId === "none") return status;
  const loader = opts.loader ?? defaultLoader ?? browserFontLoader();
  const lang = opts.lang;
  const langScript = scriptOfLang(lang);
  const texts = opts.text === undefined ? [] : typeof opts.text === "string" ? [opts.text] : opts.text;
  const upper = style.font.case === "upper";
  const needed = new Map<string, Face>();
  if (!texts.length) {
    // no text yet (e.g. a tile before the transcript): the script's face + Latin
    for (const s of new Set<Script>(["latin", langScript])) {
      if (s === "rtl") continue;
      const f = faceChain(style.font.id, lang, s)[0];
      if (f) needed.set(f.key, f);
    }
  }
  const uncovered = new Set<string>();
  let devanagari = false;
  for (const raw of texts) {
    const text = upper ? safeUpper(raw, lang) : raw;
    for (const full of text.normalize("NFC").split(/\s+/)) {
      // what the layout will draw: emoji and symbols no face has are
      // stripped there (stripUndrawable), so they're not "uncovered"
      const word = stripUndrawable(full, style.font.id, lang).text;
      if (!word) continue;
      const faces = faceChain(style.font.id, lang, wordScript(word, langScript));
      for (const ch of word) {
        const cp = ch.codePointAt(0)!;
        const face = faces.find((f) => f.cps.has(cp));
        if (face) {
          needed.set(face.key, face);
          if (face.subset === "devanagari" && scriptOfCodepoint(cp) === "devanagari") devanagari = true;
        } else if (cp > 0x20 && !/\p{Default_Ignorable_Code_Point}|\p{M}/u.test(ch)) {
          uncovered.add(ch);
        }
      }
    }
  }
  if (langScript === "devanagari") devanagari = true;
  const cjkId = SUPPORT.cjk[normLang(lang)];
  if ((langScript === "cjk" || [...uncovered].some((c) => scriptOfCodepoint(c.codePointAt(0)!) === "cjk")) && cjkId) {
    if (!getFont(cjkId) && deferredFont(cjkId)) status.deferred.push(cjkId);
  }
  status.uncovered = [...uncovered];
  if (devanagari) {
    try {
      await loadShaper();
    } catch (e) {
      status.failed.push({ face: "harfbuzz", error: String(e) });
    }
  }
  await Promise.all(
    [...needed.values()].map(async (face) => {
      try {
        await loadFace(face, loader);
        if (face.subset === "devanagari" && devanagari && !hasShapingFont(face.key) && loader.bytes) {
          registerShapingFont(face.key, await loader.bytes(face));
        }
        status.loaded.push(face.key);
      } catch (e) {
        status.failed.push({ face: face.key, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  status.loaded.sort();
  status.ok = status.failed.length === 0;
  return status;
}

function safeUpper(text: string, lang?: string): string {
  try {
    return text.toLocaleUpperCase(lang ? normLang(lang) : undefined);
  } catch {
    return text.toUpperCase();
  }
}

// ---------------------------------------------------------------- browser

type FontFaceCtor = new (
  family: string,
  source: string | ArrayBuffer | ArrayBufferView,
  descriptors?: { unicodeRange?: string; weight?: string; style?: string; display?: string },
) => { load(): Promise<unknown>; family: string };

type FontSetLike = { add(face: unknown): unknown };

/**
 * FontFace-based loader. The DOM stays in here: the rest of the engine
 * only sees the FontLoader interface. Faces are registered with weight 400
 * and style normal (each family has exactly one face), so the browser
 * never synthesizes bold or italic. Devanagari faces are .ttf: the same
 * bytes feed FontFace and HarfBuzz, one download.
 */
export function browserFontLoader(
  opts: { fontSet?: FontSetLike; FontFace?: FontFaceCtor; fetch?: typeof fetch } = {},
): FontLoader {
  const g = globalThis as unknown as { FontFace?: FontFaceCtor; document?: { fonts?: FontSetLike }; fonts?: FontSetLike };
  const FF = opts.FontFace ?? g.FontFace;
  const set = opts.fontSet ?? g.document?.fonts ?? g.fonts;
  const doFetch = opts.fetch ?? globalThis.fetch?.bind(globalThis);
  const bytes = new Map<string, Promise<ArrayBuffer>>();
  const getBytes = (face: Face) => {
    let p = bytes.get(face.url);
    if (!p) {
      if (!doFetch) return Promise.reject(new Error("fetch is not available"));
      p = doFetch(face.url).then((r) => {
        if (!r.ok) throw new Error(`${face.url}: HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      bytes.set(face.url, p);
      p.catch(() => bytes.delete(face.url));
    }
    return p;
  };
  return {
    async load(face) {
      if (!FF || !set) throw new Error("FontFace API is not available");
      const descriptors = { unicodeRange: face.unicodeRange, weight: "400", style: "normal", display: "block" };
      const source = face.format === "truetype" ? await getBytes(face) : `url(${JSON.stringify(face.url)}) format("woff2")`;
      const ff = new FF(face.family, source, descriptors);
      await ff.load();
      set.add(ff);
    },
    bytes: getBytes,
  };
}
