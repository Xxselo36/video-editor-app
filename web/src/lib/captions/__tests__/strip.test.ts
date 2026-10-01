/**
 * Emoji and symbols no caption font has are left out of the drawn text —
 * the same in the editor preview and the render worker (UT4), never tofu
 * or a system emoji only one side has.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ensureFonts, stripUndrawable, type FontLoader } from "../fonts";
import { buildPages } from "../layout";
import { resolveStyle } from "../presets";
import type { CaptionStyle } from "../types";
import { loadRealFonts, timed } from "./helpers";

const style = resolveStyle("power", {}, { W: 1080, H: 1920 }) as CaptionStyle;
const F = style.font.id;
const noop: FontLoader = { async load() {} };

beforeAll(() => {
  loadRealFonts();
});

describe("stripUndrawable", () => {
  it.each([
    ["fire🔥", "fire", 1],
    ["👍🏽", "", 2], // with its skin tone
    ["👨‍👩‍👧", "", 5], // ZWJ family
    ["1️⃣", "1", 2], // keycap: the digit stays
    ["🇩🇪", "", 2],
    ["ok❤️", "ok", 2],
    ["x", "x", 1], // private use
    ["plain", "plain", 0],
    ["100%", "100%", 0],
    ["©2026", "©2026", 0], // a symbol the font has stays
    ["€5", "€5", 0],
  ])("%s → %s", (input, text, removed) => {
    expect(stripUndrawable(input, F, "en")).toEqual({ text, removed });
  });

  it("keeps the ZWJ that shapes Indic text", () => {
    const hi = "क्‍ष";
    expect(stripUndrawable(hi, "poppins-800", "hi")).toEqual({ text: hi, removed: 0 });
  });

  it("never strips letters, even without a font (a font problem, reported)", () => {
    expect(stripUndrawable("成果", F, "ja").text).toBe("成果");
  });
});

describe("layout and font status leave them out", () => {
  it("pages hold the words without emoji; an emoji-only word is gone", () => {
    const words = timed("Big 🔥 news 🎉🎉 today👍");
    const pages = buildPages(words, style, { W: 1080, H: 1920, lang: "en" });
    const texts = pages.flatMap((p) => p.words.map((w) => w.source));
    expect(texts).toEqual(["Big", "news", "today"]);
    expect(pages.every((p) => p.words.every((w) => !w.approximate))).toBe(true);
  });

  it("ensureFonts doesn't report them as uncovered", async () => {
    const st = await ensureFonts(style, { lang: "en", text: ["Big", "🔥", "today👍"], loader: noop });
    expect(st.uncovered).toEqual([]);
    expect(st.ok).toBe(true);
  });
});
