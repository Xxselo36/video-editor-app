import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cssFont, ensureFonts, faceChain, type FontLoader } from "../fonts";
import { fontTables, getFont, type Face } from "../metrics";
import { resolveStyle } from "../presets";
import { hasShapingFont, shaperReady } from "../shape-hb";
import type { CaptionStyle } from "../types";
import { FONTS_DIR, useRealFonts } from "./helpers";

const style = (id: string) => resolveStyle(id, {}, { W: 1080, H: 1920 }) as CaptionStyle;

function fakeLoader(fail: string[] = []) {
  const calls: string[] = [];
  const loader: FontLoader = {
    async load(face: Face) {
      calls.push(face.key);
      if (fail.includes(face.key)) throw new Error("network");
    },
    async bytes(face: Face) {
      return fs.readFileSync(path.join(FONTS_DIR, face.file));
    },
  };
  return { loader, calls };
}

beforeAll(() => {
  useRealFonts();
});

describe("fonts.json manifest", () => {
  it("lists the ten launch fonts with their subsets and the deferred CJK fonts", () => {
    const t = fontTables()!;
    expect(Object.keys(t.fonts).sort()).toEqual(
      [
        "anton-400",
        "bangers-400",
        "inter-display-700",
        "luckiest-guy-400",
        "montserrat-800",
        "montserrat-900",
        "playfair-display-800i",
        "poppins-800",
        "poppins-900",
        "rubik-800",
      ].sort(),
    );
    expect(Object.keys(t.deferred).sort()).toEqual(["noto-sans-jp-800", "noto-sans-kr-800", "noto-sans-sc-800"]);
    for (const [id, f] of Object.entries(t.fonts)) {
      expect(f.subsets.latin, id).toBeDefined();
      for (const s of Object.values(f.subsets)) {
        expect(fs.existsSync(path.join(FONTS_DIR, s.file)), s.file).toBe(true);
        expect(fs.statSync(path.join(FONTS_DIR, s.file)).size).toBe(s.bytes);
      }
    }
    expect(Object.keys(t.fonts["montserrat-900"].subsets)).toEqual(["latin", "cyrillic"]);
    expect(Object.keys(t.fonts["poppins-800"].subsets)).toEqual(["latin", "devanagari"]);
    expect(Object.keys(t.fonts["bangers-400"].subsets)).toEqual(["latin"]);
  });

  it("keeps the budgets: default style ≤ 60 KB, all latin tile fonts ≤ 600 KB", () => {
    const t = fontTables()!;
    expect(t.fonts[t.defaultFont].subsets.latin.bytes).toBeLessThanOrEqual(60 * 1024);
    const latin = Object.values(t.fonts).reduce((s, f) => s + f.subsets.latin.bytes, 0);
    expect(latin).toBeLessThanOrEqual(600 * 1024);
  });
});

describe("face chains", () => {
  it("puts the face of the word's script first", () => {
    const cyr = faceChain("poppins-800", "ru", "cyrillic").map((f) => f.key);
    expect(cyr[0]).toBe("montserrat-800:cyrillic"); // Poppins has no Cyrillic: same-weight fallback
    expect(cyr).toContain("poppins-800:latin");
    const lat = faceChain("poppins-800", "ru", "latin").map((f) => f.key);
    expect(lat[0]).toBe("poppins-800:latin");
    const hi = faceChain("inter-display-700", "hi", "devanagari").map((f) => f.key);
    expect(hi[0]).toBe("poppins-800:devanagari"); // Subtitle/Minimal in Hindi: Poppins
  });

  it("builds a CSS font list with a generic family last", () => {
    const f = cssFont(faceChain("montserrat-900", "en", "latin"), 97.2);
    expect(f.startsWith('97.2px "cc-montserrat-900-latin", "cc-montserrat-900-cyrillic"')).toBe(true);
    expect(f.endsWith(", sans-serif")).toBe(true);
  });
});

describe("ensureFonts", () => {
  it("loads only the faces the text needs", async () => {
    const { loader, calls } = fakeLoader();
    const st = await ensureFonts(style("power"), { lang: "ru", text: ["ПРИВЕТ, КАК ДЕЛА?"], loader });
    expect(st.ok).toBe(true);
    expect(calls).toEqual(["montserrat-900:cyrillic"]);
    const mixed = fakeLoader();
    await ensureFonts(style("power"), { lang: "ru", text: "привет hello", loader: mixed.loader });
    expect(mixed.calls.sort()).toEqual(["montserrat-900:cyrillic", "montserrat-900:latin"]);
  });

  it("without text loads the script's face and Latin", async () => {
    const { loader, calls } = fakeLoader();
    await ensureFonts(style("karaoke"), { lang: "ru", loader });
    expect(calls.sort()).toEqual(["montserrat-800:cyrillic", "poppins-800:latin"]);
  });

  it("loads HarfBuzz and the shaping bytes for Devanagari", async () => {
    const { loader, calls } = fakeLoader();
    const st = await ensureFonts(style("karaoke"), { lang: "hi", text: "नमस्ते दुनिया", loader });
    expect(st.ok).toBe(true);
    expect(calls).toEqual(["poppins-800:devanagari"]);
    expect(shaperReady()).toBe(true);
    expect(hasShapingFont("poppins-800:devanagari")).toBe(true);
  });

  it("reports a deferred CJK font instead of failing", async () => {
    const { loader } = fakeLoader();
    const st = await ensureFonts(style("power"), { lang: "ja", text: "こんにちは", loader });
    expect(st.ok).toBe(true);
    expect(st.deferred).toEqual(["noto-sans-jp-800"]);
    expect(st.uncovered.length).toBe(5);
  });

  it("retries a failed face once, then reports it", async () => {
    const { loader, calls } = fakeLoader(["anton-400:latin"]);
    const st = await ensureFonts(style("punch"), { lang: "en", text: "HELLO", loader });
    expect(st.ok).toBe(false);
    expect(st.failed.map((f) => f.face)).toEqual(["anton-400:latin"]);
    expect(calls).toEqual(["anton-400:latin", "anton-400:latin"]);
  });

  it("does nothing for captions off", async () => {
    const { loader, calls } = fakeLoader();
    const st = await ensureFonts({ presetId: "none", font: style("power").font }, { lang: "en", text: "x", loader });
    expect(st.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(getFont("montserrat-900")).toBeDefined();
  });
});
