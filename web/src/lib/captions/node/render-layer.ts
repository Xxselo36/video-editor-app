/**
 * CLI of the render worker's caption layer (UT4), bundled by esbuild into
 * backend/captions/render_layer.mjs (backend/captions/build.mjs):
 *
 *   node render_layer.mjs plan   < input.json  > plan.json
 *   node render_layer.mjs render < input.json  | ffmpeg -f rawvideo -pix_fmt rgba …
 *
 * input.json: layer.ts LayerInput. `plan` prints the band, the page
 * layouts and the font status; `render` streams `frames` raw RGBA
 * (premultiplied) frames of W × band.height to stdout.
 *
 * Exit codes: 0 ok · 2 bad input · 3 a font failed to load · 1 anything
 * else (backend/captions_v2.py maps them to error codes).
 */
import { readFileSync, writeSync } from "node:fs";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { missingGlyphs, prepare, renderFrames, type LayerDeps, type LayerInput } from "./layer";

const deps = { createCanvas, GlobalFonts } as unknown as LayerDeps;

function writeAll(fd: number, buf: Uint8Array): void {
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
}

async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode !== "plan" && mode !== "render") {
    process.stderr.write("usage: render_layer.mjs plan|render < input.json\n");
    return 2;
  }
  let input: LayerInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as LayerInput;
    if (!(input.W > 0 && input.H > 0 && input.fps > 0) || !Array.isArray(input.words)) throw new Error("W, H, fps, words");
  } catch (e) {
    process.stderr.write(`bad input: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const t0 = performance.now();
  const prep = await prepare(input, deps);
  if (prep.plan.fonts && !prep.plan.fonts.ok) {
    process.stderr.write(`fonts failed: ${JSON.stringify(prep.plan.fonts.failed)}\n`);
    return 3;
  }
  // No shipped face (or the job's CJK subset) has these characters: the
  // render worker has no system fallback for them, an export would show
  // tofu. Never report success then.
  const missing = missingGlyphs(prep.plan.fonts);
  if (missing) {
    process.stderr.write(`uncovered characters: ${missing}\n`);
    return 4;
  }
  if (mode === "plan") {
    writeAll(1, Buffer.from(JSON.stringify(prep.plan)));
    return 0;
  }
  const t1 = performance.now();
  const stats = await renderFrames(prep, deps, (buf) => writeAll(1, buf));
  const t2 = performance.now();
  process.stderr.write(
    `[captions] ${stats.frames} frames, ${stats.drawn} drawn, ${stats.reused} reused; ` +
      `prepare ${(t1 - t0).toFixed(0)} ms, frames ${(t2 - t1).toFixed(0)} ms\n`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`caption layer failed: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  },
);
