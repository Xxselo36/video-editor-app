/**
 * The real caption engine (lib/captions), loaded on demand: the landing
 * draws its captions with the same code as the editor and the export, so
 * pages, fonts, colours and animations are the product's own. Imported
 * module by module (never the barrel) and only when a caption is about to
 * show, so none of it is in the landing's first load. Devanagari brings
 * HarfBuzz with it (fonts.ts), only for Hindi pages.
 */
import type { CaptionRenderer } from "@/lib/captions/cache";
import type { ensureFonts } from "@/lib/captions/fonts";
import type { resolveStyle } from "@/lib/captions/presets";

export type Engine = {
  CaptionRenderer: typeof CaptionRenderer;
  resolveStyle: typeof resolveStyle;
  ensureFonts: typeof ensureFonts;
};

let loading: Promise<Engine> | null = null;

export function loadEngine(): Promise<Engine> {
  if (!loading) {
    loading = Promise.all([
      import("@/lib/captions/cache"),
      import("@/lib/captions/presets"),
      import("@/lib/captions/fonts"),
    ]).then(([cache, presets, fonts]) => ({
      CaptionRenderer: cache.CaptionRenderer,
      resolveStyle: presets.resolveStyle,
      ensureFonts: fonts.ensureFonts,
    }));
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
