/**
 * Node side of font loading (tests; the render worker in UT4).
 *
 * Registers caption faces with @napi-rs/canvas under the same family names
 * the browser uses ("cc-<font>-<subset>"). By default it registers the very
 * files the browser loads — the web subsets in web/public/fonts/captions/
 * (@napi-rs/canvas reads woff2) — so glyphs, OpenType features and the
 * per-face fallback are identical in the editor and the render. The TTFs
 * in assets/caption-fonts/ are the sources those files are built from.
 *
 * `globalFonts` is passed in (import { GlobalFonts } from "@napi-rs/canvas")
 * so that this module does not depend on the native package.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FontLoader } from "../fonts";

export type GlobalFontsLike = {
  registerFromPath(fontPath: string, nameAlias?: string): unknown;
};

export function nodeFontLoader(globalFonts: GlobalFontsLike, opts: { fontsDir: string }): FontLoader {
  const registered = new Set<string>();
  const fileOf = (file: string) => (path.isAbsolute(file) ? file : path.join(opts.fontsDir, path.basename(file)));
  return {
    async load(face) {
      if (registered.has(face.family)) return;
      const file = fileOf(face.file);
      const key = globalFonts.registerFromPath(file, face.family);
      if (!key) throw new Error(`@napi-rs/canvas could not register ${file}`);
      registered.add(face.family);
    },
    async bytes(face) {
      return new Uint8Array(await readFile(fileOf(face.file)));
    },
  };
}
