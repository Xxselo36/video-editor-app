/**
 * Layout snapshots per preset from the real metric tables (fonts.json):
 * pages, line breaks and word positions at 540×960 (the parity size) for
 * en/de/ru/hi where the preset supports the script. A change here means
 * captions move on screen — review it like a visual change.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPages, layoutJSON, layoutPage } from "../layout";
import { getFont } from "../metrics";
import { LAUNCH_PRESETS, resolveStyle } from "../presets";
import samplesJson from "../samples.json";
import { presetSupport } from "../scripts";
import { loadShaper, registerShapingFont } from "../shape-hb";
import type { CaptionStyle } from "../types";
import { AUDIT_WORDS, FONTS_DIR, timed, useRealFonts } from "./helpers";

const W = 540;
const H = 960;
const SAMPLES = samplesJson.samples as Record<string, string>;

function describeLayout(id: string, lang: string): string[] {
  const style = resolveStyle(id, {}, { W, H }) as CaptionStyle;
  const words = lang === "en" ? AUDIT_WORDS : timed(SAMPLES[lang]);
  const pages = buildPages(words, style, { W, H, lang });
  return pages.map((p) => {
    const j = layoutJSON(p, layoutPage(p, style, { W, H, lang }));
    const lines = j.lines.map((l) => l.map((w) => `${w.text}@${w.x}+${w.w}`).join(" ")).join(" / ");
    return `${j.start}-${j.end} px${j.px} y${j.lines.map((l) => l[0].y).join(",")} | ${lines}`;
  });
}

beforeAll(async () => {
  useRealFonts();
  await loadShaper();
  for (const id of ["poppins-800", "poppins-900"]) {
    const face = getFont(id)!.face("devanagari")!;
    registerShapingFont(face.key, fs.readFileSync(path.join(FONTS_DIR, face.file)));
  }
});

describe("layout snapshots (real fonts.json)", () => {
  it.each(LAUNCH_PRESETS)("%s", (id) => {
    const out: Record<string, string[]> = {};
    for (const lang of ["en", "de", "ru", "hi"]) {
      if (presetSupport(id, lang).level === "unavailable") continue;
      out[lang] = describeLayout(id, lang);
    }
    expect(out).toMatchSnapshot();
  });
});
