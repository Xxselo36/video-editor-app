/**
 * Browser side of the caption parity suite (parity.test.ts): the editor's
 * caption path — FontFace loading, CaptionRenderer with the bitmap cache
 * on a <canvas> — in real Chromium. Bundled by esbuild at test time
 * (harfbuzzjs stays an import-map module, so its WASM loads like in the
 * app). Not part of the app.
 */
import { CaptionRenderer, browserSurface } from "../../cache";
import { ensureFonts, registerCaptionFont } from "../../fonts";
import { layoutJSON } from "../../layout";
import { setFontTables, type FontJson, type FontTables } from "../../metrics";
import { resolveStyle } from "../../presets";
import type { CaptionWord, Ctx2D } from "../../types";
import fontsJson from "../../fonts.json";

export type CellRequest = {
  preset: string;
  lang: string;
  words: CaptionWord[];
  times: number[];
  W: number;
  H: number;
  band: { top: number; height: number };
  cjk?: { id: string; json: FontJson; baseUrl: string };
};

function toBase64(bytes: Uint8ClampedArray): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const registered = new Set<string>();

async function cell(req: CellRequest) {
  setFontTables(fontsJson as unknown as FontTables);
  if (req.cjk && !registered.has(req.cjk.id)) {
    registerCaptionFont(req.cjk.id, req.cjk.json, req.cjk.baseUrl);
    registered.add(req.cjk.id);
  }
  const { W, H, lang, band } = req;
  const style = resolveStyle(req.preset, {}, { W, H });
  if (!style) throw new Error(`no style ${req.preset}`);
  const fonts = await ensureFonts(style, { lang, text: req.words.map((w) => w.text) });
  const r = new CaptionRenderer({ words: req.words, style, W, H, lang, surface: browserSurface });
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const frames = req.times.map((t) => {
    r.drawFrame(ctx as unknown as Ctx2D, t, { force: true });
    const state = r.state(t);
    return {
      t,
      key: state?.key ?? null,
      rgba: toBase64(ctx.getImageData(0, band.top, W, band.height).data),
    };
  });
  const layout = r.pages.map((p, i) => layoutJSON(p, r.layout(i)));
  r.dispose();
  return { fonts, layout, frames };
}

(window as unknown as { __parity: unknown }).__parity = { cell };
