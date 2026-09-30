/**
 * The metric tables reproduce what a shaper computes: widths from
 * fonts.json equal HarfBuzz (same font files as the browser) for words
 * without ligatures, in every shipped face; Devanagari is shaped.
 */
import fs from "node:fs";
import path from "node:path";
import * as hb from "harfbuzzjs";
import { beforeAll, describe, expect, it } from "vitest";
import { faceChain } from "../fonts";
import { getFont, measureText, type Face } from "../metrics";
import { hasShapingFont, loadShaper, registerShapingFont } from "../shape-hb";
import { FONTS_DIR, useRealFonts } from "./helpers";

const NO_LIGATURES = ["liga", "clig", "calt", "dlig", "rlig"].map((f) => new hb.Feature(f, 0));
const hbFonts = new Map<string, InstanceType<typeof hb.Font>>();

function hbWidth(face: Face, text: string, features = NO_LIGATURES): number {
  let font = hbFonts.get(face.key);
  if (!font) {
    const bytes = fs.readFileSync(path.join(FONTS_DIR, face.file));
    // woff2 is not readable by HarfBuzz: use the source TTF for those faces
    const data = face.format === "woff2" ? fs.readFileSync(path.join(FONTS_DIR, "../../../../assets/caption-fonts", ttfOf(face))) : bytes;
    font = new hb.Font(new hb.Face(new hb.Blob(new Uint8Array(data))));
    hbFonts.set(face.key, font);
  }
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font, buf, features);
  return buf.getGlyphPositions().reduce((s, p) => s + p.xAdvance, 0);
}

let ttfNames: Record<string, string> = {};
const ttfOf = (face: Face) => ttfNames[face.fontId];

beforeAll(() => {
  const tables = useRealFonts();
  ttfNames = Object.fromEntries(Object.entries(tables.fonts).map(([id, f]) => [id, f.ttf!]));
});

const LATIN = ["Nobody", "WAITS", "Tomorrow", "AVATAR", "Yesterday", "PRÄSIDENT", "Straße", "façon", "Gdańsk", "ZAŻÓŁĆ", "İSTANBUL", "Ağaç", "10%", "$5,000", "“quotes”", "it's", "L'année"];
const CYRILLIC = ["Привет,", "дела?", "ТЕЛЕВИЗОР", "съешь", "ещё", "«Да»", "Юля:"];

describe("metric tables vs HarfBuzz (kerning, no ligatures)", () => {
  const tables = () => Object.keys(useRealFonts().fonts);

  it.each(["latin", "cyrillic"] as const)("%s faces", (subset) => {
    let checked = 0;
    for (const id of tables()) {
      const face = getFont(id)!.face(subset);
      if (!face) continue;
      for (const word of subset === "latin" ? LATIN : CYRILLIC) {
        if (![...word].every((c) => face.cps.has(c.codePointAt(0)!))) continue;
        const ours = measureText(word, [face]);
        expect(ours.approximate).toBe(false);
        expect(Math.round(ours.em * face.metrics.upm), `${id} ${word}`).toBe(hbWidth(face, word));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(subset === "latin" ? 120 : 30);
  });

  it("kerning is applied (AV is narrower than A + V)", () => {
    const face = getFont("montserrat-900")!.face("latin")!;
    const av = measureText("AV", [face]).em;
    const a = measureText("A", [face]).em;
    const v = measureText("V", [face]).em;
    expect(av).toBeLessThan(a + v);
  });

  it("a word is measured in the face of its script, punctuation included", () => {
    // "дела?" in Montserrat: the cyrillic face (which carries "?") comes first,
    // so the а–? pair is kerned like in the full font
    const chain = faceChain("montserrat-900", "ru", "cyrillic");
    expect(chain[0].key).toBe("montserrat-900:cyrillic");
    const ours = measureText("дела?", chain);
    expect(Math.round(ours.em * 1000)).toBe(hbWidth(chain[0], "дела?"));
  });

  it("falls back per character and flags what no face covers", () => {
    const chain = faceChain("bangers-400", "de", "latin");
    const m = measureText("Hi 😀", chain);
    expect(m.approximate).toBe(true);
    const plain = measureText("Hi", chain);
    expect(plain.approximate).toBe(false);
  });
});

describe("Devanagari shaping (harfbuzzjs)", () => {
  beforeAll(async () => {
    await loadShaper();
    const face = getFont("poppins-800")!.face("devanagari")!;
    if (!hasShapingFont(face.key)) registerShapingFont(face.key, fs.readFileSync(path.join(FONTS_DIR, face.file)));
  });

  it("widths come from the shaper, equal to shaping the full font", () => {
    const face = getFont("poppins-800")!.face("devanagari")!;
    for (const word of ["नमस्ते", "क्षत्रिय", "हिन्दी", "प्रधानमंत्री", "श्री", "दुनिया,", "१२३"]) {
      const ours = measureText(word, [face]);
      expect(ours.approximate, word).toBe(false);
      const full = fs.readFileSync(path.join(FONTS_DIR, "../../../../assets/caption-fonts/Poppins-ExtraBold.ttf"));
      const font = new hb.Font(new hb.Face(new hb.Blob(new Uint8Array(full))));
      const buf = new hb.Buffer();
      buf.addText(word);
      buf.guessSegmentProperties();
      hb.shape(font, buf);
      const expected = buf.getGlyphPositions().reduce((s, p) => s + p.xAdvance, 0);
      expect(Math.round(ours.em * face.metrics.upm), word).toBe(expected);
    }
  });

  it("shaping differs from summing advances for conjuncts", () => {
    const face = getFont("poppins-800")!.face("devanagari")!;
    const shaped = measureText("क्षत्रिय", [face]).em;
    const summed = [..."क्षत्रिय"].reduce((s, c) => s + (face.metrics.advance(c.codePointAt(0)!) ?? 0), 0) / face.metrics.upm;
    expect(Math.abs(shaped - summed)).toBeGreaterThan(0.05);
  });
});
