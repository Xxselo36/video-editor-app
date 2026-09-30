/**
 * HarfBuzz shaping for Devanagari widths (UT2, review C1).
 *
 * Hindi conjuncts and matras change advances, so summing per-codepoint
 * advances is wrong for Devanagari. `harfbuzzjs` (WASM, ~430 KB) is loaded
 * lazily — only when a caption text contains Devanagari (ensureFonts does
 * that) — in the browser and in Node alike, and shapes with the same font
 * bytes the browser draws with (the devanagari subset .ttf), so widths
 * match on every platform.
 *
 * The API is synchronous once loaded, so layout stays synchronous:
 * `await loadShaper()` + `registerShapingFont()` first, then measure.
 */
type HB = typeof import("harfbuzzjs");
type HBFont = InstanceType<HB["Font"]>;

let hb: HB | null = null;
let loading: Promise<HB> | null = null;
const faces = new Map<string, HBFont>();
const widths = new Map<string, number>();
const MAX_CACHE = 20000;

/** Loads the HarfBuzz module (WASM). Idempotent. */
export function loadShaper(): Promise<void> {
  if (hb) return Promise.resolve();
  if (!loading) {
    loading = import("harfbuzzjs").then((mod) => {
      hb = mod;
      return mod;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading.then(() => undefined);
}

export function shaperReady(): boolean {
  return hb !== null;
}

/** Registers the font bytes of a face ("<fontId>:<subset>") for shaping. */
export function registerShapingFont(faceKey: string, bytes: ArrayBuffer | Uint8Array): void {
  if (!hb) throw new Error("loadShaper() first");
  if (faces.has(faceKey)) return;
  const face = new hb.Face(new hb.Blob(bytes));
  faces.set(faceKey, new hb.Font(face));
}

export function hasShapingFont(faceKey: string): boolean {
  return faces.has(faceKey);
}

/**
 * Advance width of `text` shaped with the face's default features, in font
 * units; undefined until the shaper and the face are registered.
 */
export function shapeWidth(faceKey: string, text: string): number | undefined {
  const font = faces.get(faceKey);
  if (!hb || !font) return undefined;
  const key = `${faceKey}\u0000${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font, buf);
  let w = 0;
  for (const p of buf.getGlyphPositions()) w += p.xAdvance;
  if (widths.size >= MAX_CACHE) widths.clear();
  widths.set(key, w);
  return w;
}
