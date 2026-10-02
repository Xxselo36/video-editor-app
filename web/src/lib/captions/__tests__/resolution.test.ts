/**
 * The editor's preview pages like the export at every canvas size (UT5
 * review 4/16): font sizes are snapped to whole device pixels for drawing
 * only; pages and line breaks come from em metrics, so the phone preview
 * (186×330 CSS at DPR 1 and 2), the desktop preview (338×600 at DPR 2)
 * and the 1080×1920 export show the same captions, just scaled.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildPages, layoutPage } from "../layout";
import { LAUNCH_PRESETS, resolveStyle } from "../presets";
import samplesJson from "../samples.json";
import { presetSupport } from "../scripts";
import type { CaptionStyle, StyleOverrides } from "../types";
import { AUDIT_WORDS, loadRealFonts, timed } from "./helpers";

const SAMPLES = samplesJson.samples as Record<string, string>;
const EXPORT = { W: 1080, H: 1920 };
const PREVIEWS = [
  { W: 186, H: 330 },
  { W: 372, H: 660 },
  { W: 676, H: 1200 },
  { W: 540, H: 960 },
];

beforeAll(() => {
  loadRealFonts();
});

function describeAt(id: string, lang: string, size: { W: number; H: number }, o: StyleOverrides = {}) {
  const style = resolveStyle(id, o, size) as CaptionStyle;
  const words = lang === "en" ? AUDIT_WORDS : timed(SAMPLES[lang]);
  const pages = buildPages(words, style, { ...size, lang });
  return pages.map((p) => {
    const l = layoutPage(p, style, { ...size, lang });
    return {
      words: p.words.map((w) => w.source),
      lines: l.lines.map((x) => x.words.length),
      // positions relative to the frame
      xs: l.lines.flatMap((x) => x.words.map((b) => b.x / size.W)),
      ys: l.lines.map((x) => x.baseline / size.H),
      px: l.px / Math.min(size.W, size.H),
    };
  });
}

describe("preview layout == export layout, scaled", () => {
  for (const id of LAUNCH_PRESETS) {
    for (const lang of ["en", "de", "ru"]) {
      if (presetSupport(id, lang).level === "unavailable") continue;
      it(`${id} · ${lang}`, () => {
        const want = describeAt(id, lang, EXPORT);
        for (const size of PREVIEWS) {
          const got = describeAt(id, lang, size);
          const at = `${size.W}×${size.H}`;
          expect(got.map((p) => p.words), at).toEqual(want.map((p) => p.words));
          expect(got.map((p) => p.lines), at).toEqual(want.map((p) => p.lines));
          got.forEach((p, i) => {
            // the font size is the export's within the pixel snap (≤ 1 px: a shrunk page rounds down)
            expect(Math.abs(p.px - want[i].px) * Math.min(size.W, size.H), at).toBeLessThanOrEqual(1 + 1e-9);
            // positions follow; a 1 px snap of a ~20 px font (186 px wide, DPR 1) moves a word ≤ 3 %
            p.xs.forEach((x, j) => expect(Math.abs(x - want[i].xs[j]), at).toBeLessThan(0.03));
            p.ys.forEach((y, j) => expect(Math.abs(y - want[i].ys[j]), at).toBeLessThan(0.02));
          });
        }
      });
    }
  }

  it("with a caption's own size: same pages and lines at every size", () => {
    const o: StyleOverrides = { captions: { a0: { sizeScale: 1.5, y: 0.3 } } };
    const want = describeAt("power", "en", EXPORT, o);
    for (const size of PREVIEWS) {
      const got = describeAt("power", "en", size, o);
      expect(got.map((p) => [p.words, p.lines])).toEqual(want.map((p) => [p.words, p.lines]));
    }
  });
});
