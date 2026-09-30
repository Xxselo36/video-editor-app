/**
 * Node smoke test: every preset draws with @napi-rs/canvas (the render
 * worker's backend, UT4) through the same engine code and the same font
 * files the browser loads. Asserts non-empty pixels inside the frame and
 * that the bitmap cache draws the same pixels as the direct path.
 *
 * CAPTIONS_SMOKE_OUT=<dir> writes the frames as PNGs for a visual check.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";
import { CaptionRenderer } from "../cache";
import { drawCaptions, frameState } from "../engine";
import { ensureFonts, setDefaultFontLoader } from "../fonts";
import { buildPages } from "../layout";
import { nodeFontLoader } from "../node/fonts";
import { LAUNCH_PRESETS, resolveStyle } from "../presets";
import type { CaptionStyle, Ctx2D, Surface } from "../types";
import { AUDIT_WORDS, FONTS_DIR, loadRealFonts } from "./helpers";

const W = 540;
const H = 960;
const OUT = process.env.CAPTIONS_SMOKE_OUT;

function nodeSurface(w: number, h: number): Surface {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext("2d") as unknown as Ctx2D };
}

function inkPixels(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n;
}

beforeAll(() => {
  loadRealFonts();
  setDefaultFontLoader(nodeFontLoader(GlobalFonts, { fontsDir: FONTS_DIR }));
});

describe("node smoke (@napi-rs/canvas)", () => {
  it.each(LAUNCH_PRESETS)("%s draws a page", async (id) => {
    const style = resolveStyle(id, {}, { W, H }) as CaptionStyle;
    const status = await ensureFonts(style, { lang: "en", text: AUDIT_WORDS.map((w) => w.text) });
    expect(status.ok).toBe(true);
    const pages = buildPages(AUDIT_WORDS, style, { W, H, lang: "en" });
    expect(pages.length).toBeGreaterThan(0);
    const t = 1.2;
    const direct = createCanvas(W, H);
    const res = drawCaptions(direct.getContext("2d") as unknown as Ctx2D, pages, t, style, { W, H, lang: "en" });
    expect(res).not.toBeNull();
    const a = direct.getContext("2d").getImageData(0, 0, W, H).data;
    expect(inkPixels(a)).toBeGreaterThan(500);

    const cached = createCanvas(W, H);
    const r = new CaptionRenderer({ words: AUDIT_WORDS, style, W, H, lang: "en", surface: nodeSurface });
    r.drawFrame(cached.getContext("2d") as unknown as Ctx2D, t);
    const b = cached.getContext("2d").getImageData(0, 0, W, H).data;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeLessThanOrEqual(2);
    expect(frameState(pages, t, style)?.page).toBe(res?.state.page);

    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      const frame = createCanvas(W, H);
      const fctx = frame.getContext("2d");
      const g = fctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#39414f");
      g.addColorStop(1, "#141821");
      fctx.fillStyle = g;
      fctx.fillRect(0, 0, W, H);
      fctx.drawImage(cached, 0, 0);
      fs.writeFileSync(path.join(OUT, `${id}.png`), frame.toBuffer("image/png"));
    }
  });
});
