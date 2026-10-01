/**
 * The render worker's caption layer (node/layer.ts, UT4): band, frame
 * stream, buffer reuse, trace — what backend/captions_v2.py pipes into
 * ffmpeg.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { bandAt, prepare, renderFrames, type LayerDeps, type LayerInput } from "../node/layer";
import { AUDIT_WORDS, FONTS_DIR } from "./helpers";

const deps = { createCanvas, GlobalFonts } as unknown as LayerDeps;
const base = (over: Partial<LayerInput> = {}): LayerInput => ({
  words: AUDIT_WORDS,
  style: { presetId: "power" },
  lang: "en",
  W: 540,
  H: 960,
  fps: 30,
  frames: 120,
  fontsDir: FONTS_DIR,
  ...over,
});

describe("caption layer (node/layer.ts)", () => {
  it("plans an even band that holds every page", async () => {
    const prep = await prepare(base(), deps);
    const band = prep.plan.band!;
    expect(prep.plan.fonts?.ok).toBe(true);
    expect(prep.plan.pages).toBeGreaterThan(1);
    expect(band.top % 2).toBe(0);
    expect(band.height % 2).toBe(0);
    expect(band.top + band.height).toBeLessThanOrEqual(960);
    // the page's ink sits inside the band, and nothing is drawn outside it
    const full = createCanvas(540, 960);
    prep.renderer!.drawFrame(full.getContext("2d") as never, 0.5, { force: true });
    const d = full.getContext("2d").getImageData(0, 0, 540, 960).data;
    for (let y = 0; y < 960; y++) {
      if (y >= band.top && y < band.top + band.height) continue;
      for (let x = 0; x < 540; x++) expect(d[(y * 540 + x) * 4 + 3]).toBe(0);
    }
    expect(prep.plan.layout.length).toBe(prep.plan.pages);
  });

  it("streams one band per frame, redrawing only on change, with a trace", async () => {
    const trace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-layer-")), "trace.json");
    const prep = await prepare(base({ trace }), deps);
    const band = prep.plan.band!;
    const sizes = new Set<number>();
    let ink = 0;
    const stats = await renderFrames(prep, deps, (buf) => {
      sizes.add(buf.length);
      for (let i = 3; i < buf.length; i += 4 * 97) if (buf[i]) ink++;
    });
    expect(stats.frames).toBe(120);
    expect([...sizes]).toEqual([540 * band.height * 4]);
    expect(stats.drawn).toBeLessThan(60);
    expect(stats.drawn + stats.reused).toBe(120);
    expect(ink).toBeGreaterThan(0);
    const t = JSON.parse(fs.readFileSync(trace, "utf8"));
    expect(t.frames[0].from).toBe(0);
    // every spoken word is active at the frame nearest its midpoint
    for (const w of AUDIT_WORDS) {
      const n = Math.round(((w.start + w.end) / 2) * 30);
      const row = t.frames.find((r: { from: number; to: number }) => r.from <= n && n <= r.to);
      expect(row?.id, w.text).toBe(w.id);
    }
    // the band at t equals the streamed frame (same code path)
    const one = bandAt(prep, deps, 1.0)!;
    expect(one.length).toBe(540 * band.height * 4);
  });

  it("draws nothing for 'none' and for no words", async () => {
    for (const over of [{ style: { presetId: "none" } }, { words: [] }, { style: null }]) {
      const prep = await prepare(base(over as Partial<LayerInput>), deps);
      expect(prep.plan.band).toBeNull();
      const stats = await renderFrames(prep, deps, () => {
        throw new Error("no frames expected");
      });
      expect(stats.frames).toBe(0);
    }
  });

  it("honours the band it is given (render mode)", async () => {
    const prep = await prepare(base({ band: { top: 600, height: 200 }, frames: 3 }), deps);
    const lens: number[] = [];
    await renderFrames(prep, deps, (b) => lens.push(b.length));
    expect(lens).toEqual([540 * 200 * 4, 540 * 200 * 4, 540 * 200 * 4]);
  });
});
