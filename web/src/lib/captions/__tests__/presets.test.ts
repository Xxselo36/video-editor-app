import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fontsJson from "../fonts.json";
import { V1_PRESETS, migratePresetId } from "../migrate";
import { PRESET_NAMES } from "../presetNames";
import {
  DEFAULT_LIVE_PRESETS,
  DEFAULT_PRESET,
  LAUNCH_PRESETS,
  PRESET_IDS,
  defaultY,
  getPreset,
  listPresets,
  parseLiveList,
  presetStatus,
  resolveStyle,
} from "../presets";
import { SUPPORT, presetSupport, scriptOfLang } from "../scripts";

describe("launch presets", () => {
  it("are exactly the owner's 12 plus none, default power", () => {
    expect([...LAUNCH_PRESETS].sort()).toEqual(
      ["boxed", "clipper", "elegant", "gradient", "karaoke", "mega", "minimal", "neon", "power", "punch", "reveal", "subtitle"],
    );
    expect(PRESET_IDS).toContain("none");
    expect(DEFAULT_PRESET).toBe("power");
    expect(getPreset("none")).toBeNull();
  });

  it("name no real person anywhere in the caption code", () => {
    const dir = fileURLToPath(new URL("../", import.meta.url));
    const files = fs.readdirSync(dir).filter((f) => /\.(ts|json)$/.test(f));
    // the forbidden names, assembled so this file does not contain them either
    const banned = [["hor", "mozi"], ["mr", "beast"], ["be", "ast"]].map((p) => p.join(""));
    for (const f of files) {
      const text = fs.readFileSync(dir + f, "utf8").toLowerCase();
      for (const b of banned) expect(text.includes(b), `${f} contains a real name`).toBe(false);
    }
  });

  it("use fonts that exist, the same ones the script table lists", () => {
    for (const id of LAUNCH_PRESETS) {
      const p = getPreset(id)!;
      expect(Object.keys(fontsJson.fonts)).toContain(p.font.id);
      expect(SUPPORT.presets[id].font, id).toBe(p.font.id);
    }
  });

  it("colour numbers only in power (green), punch (yellow) and elegant (gold)", () => {
    const withEmphasis = LAUNCH_PRESETS.filter((id) => getPreset(id)!.emphasis);
    expect(withEmphasis.sort()).toEqual(["elegant", "power", "punch"]);
    expect(getPreset("power")!.emphasis!.color).toBe("#22E55B");
    expect(getPreset("punch")!.emphasis!.color).toBe("#FFE600");
    expect(getPreset("elegant")!.emphasis!.color).toBe("#E8B04A");
  });

  it("have interim German and English names for every id", () => {
    for (const id of PRESET_IDS) {
      expect(PRESET_NAMES.en[id].name.length).toBeGreaterThan(1);
      expect(PRESET_NAMES.de[id].name.length).toBeGreaterThan(1);
    }
    expect(PRESET_NAMES.de.punch.name).toBe("Ein Wort");
    expect(PRESET_NAMES.de.reveal.name).toBe("Wort für Wort");
    expect(listPresets()[0]).toMatchObject({ id: "power", nameKey: "captions.preset.power.name" });
  });
});

describe("live list", () => {
  it("defaults to all twelve (UT5); 'all' opens every preset", () => {
    expect(parseLiveList(undefined)).toEqual([...LAUNCH_PRESETS, "none"]);
    expect(DEFAULT_LIVE_PRESETS).toBe(LAUNCH_PRESETS.join(","));
    expect(parseLiveList("all")).toEqual([...PRESET_IDS]);
    expect(parseLiveList(" power, neon ,bogus")).toEqual(["power", "neon", "none"]);
    const live = parseLiveList("clipper,power");
    expect(presetStatus("power", live)).toBe("live");
    expect(presetStatus("neon", live)).toBe("preview");
    expect(presetStatus("none", [])).toBe("live");
    expect(listPresets(live).filter((p) => p.status === "live").map((p) => p.id)).toEqual(["power", "clipper", "none"]);
  });
});

describe("resolveStyle", () => {
  it("places the block by frame shape: 9:16 preset y, 16:9 0.85, square 0.80", () => {
    expect(resolveStyle("power", {}, { W: 1080, H: 1920 })!.layout.y).toBe(0.68);
    expect(resolveStyle("subtitle", {}, { W: 1080, H: 1920 })!.layout.y).toBe(0.72);
    expect(resolveStyle("power", {}, { W: 1920, H: 1080 })!.layout.y).toBe(0.85);
    expect(resolveStyle("power", {}, { W: 1080, H: 1080 })!.layout.y).toBe(0.8);
    expect(defaultY(0.62, 720, 1280)).toBe(0.62);
  });

  it("applies the launch overrides", () => {
    const s = resolveStyle("power", {
      y: 0.5,
      sizeScale: 3,
      case: "none",
      textColor: "#00FF00",
      highlightColor: "#FF0000",
      animation: "fade",
      wordsPerPage: 2,
    })!;
    expect(s.layout.y).toBe(0.5);
    expect(s.font.size).toBeCloseTo(0.09 * 1.6, 9); // clamped to 1.6
    expect(s.font.case).toBe("none");
    expect(s.fill).toEqual({ color: "#00FF00" });
    expect(s.highlight.color).toBe("#FF0000");
    expect(s.animation.pageIn).toBe("fade");
    expect(s.layout.maxWords).toBe(2);
    // the gradient goes when a text colour is chosen; the box colour takes the highlight
    expect(resolveStyle("gradient", { textColor: "#FFFFFF" })!.fill.gradient).toBeUndefined();
    expect(resolveStyle("boxed", { highlightColor: "#22C55E" })!.highlight.boxColor).toBe("#22C55E");
    // one word per caption = one word per line, one line
    const one = resolveStyle("karaoke", { wordsPerPage: 1 })!;
    expect([one.layout.wordsPerLine, one.layout.maxLines, one.layout.maxWords]).toEqual([1, 1, 1]);
    // reveal styles: the animation choice applies to the words
    const rev = resolveStyle("reveal", { animation: "fade" })!;
    expect([rev.animation.pageIn, rev.animation.wordIn]).toEqual(["none", "fade"]);
    expect(resolveStyle("none")).toBeNull();
    expect(resolveStyle("does-not-exist")!.presetId).toBe("power");
  });

  it("ignores invalid colours and non-finite numbers", () => {
    const s = resolveStyle("power", { textColor: "red; x", y: Number.NaN, sizeScale: Number.POSITIVE_INFINITY })!;
    expect(s.fill.color).toBe("#FFFFFF");
    expect(s.layout.y).toBe(0.68);
    expect(s.font.size).toBe(0.09);
  });
});

describe("migrate (v1 preset ids)", () => {
  it("maps every v1 id as planned", () => {
    expect(migratePresetId("clean")).toEqual({ presetId: "minimal", overrides: {} });
    expect(migratePresetId("subtle")).toEqual({ presetId: "minimal", overrides: {} });
    expect(migratePresetId("classic")).toEqual({ presetId: "power", overrides: { highlightColor: "#FFFFFF" } });
    expect(migratePresetId("highlight")).toEqual({ presetId: "boxed", overrides: {} });
    expect(migratePresetId("flash")).toEqual({ presetId: "mega", overrides: {} });
    expect(migratePresetId("punch")).toEqual({ presetId: "punch", overrides: {} });
    expect(migratePresetId("elegant")).toEqual({ presetId: "elegant", overrides: {} });
    expect(migratePresetId("clipper")).toEqual({ presetId: "clipper", overrides: {} });
    expect(migratePresetId("none")).toEqual({ presetId: "none", overrides: {} });
    expect(Object.keys(V1_PRESETS)).toHaveLength(9);
  });

  it("classic keeps the active word white (power without highlight)", () => {
    const ref = migratePresetId("classic");
    const s = resolveStyle(ref.presetId, ref.overrides)!;
    expect(s.highlight.color).toBe(s.fill.color);
  });

  it("passes new ids through and defaults unknown ones to power", () => {
    expect(migratePresetId("neon").presetId).toBe("neon");
    expect(migratePresetId("  Karaoke ").presetId).toBe("karaoke");
    expect(migratePresetId("retro").presetId).toBe("power");
    expect(migratePresetId(undefined).presetId).toBe("power");
  });

  it("returns a fresh object (callers may mutate overrides)", () => {
    const a = migratePresetId("classic");
    a.overrides.y = 0.3;
    expect(migratePresetId("classic").overrides).toEqual({ highlightColor: "#FFFFFF" });
  });
});

describe("script support (spec table)", () => {
  it("matches the plan", () => {
    const lvl = (id: string, lang: string) => presetSupport(id, lang).level;
    for (const id of ["clipper", "mega", "punch"]) {
      expect(lvl(id, "de")).toBe("native");
      for (const l of ["ru", "hi", "ja", "ko"]) expect(lvl(id, l), `${id} ${l}`).toBe("unavailable");
    }
    expect(presetSupport("karaoke", "ru")).toMatchObject({ level: "fallback", font: "montserrat-800" });
    expect(presetSupport("gradient", "ru")).toMatchObject({ level: "fallback", font: "montserrat-900" });
    expect(presetSupport("karaoke", "hi")).toMatchObject({ level: "native", font: "poppins-800" });
    expect(presetSupport("subtitle", "hi")).toMatchObject({ level: "fallback", font: "poppins-800" });
    expect(presetSupport("power", "hi").level).toBe("unavailable");
    expect(presetSupport("power", "ru")).toMatchObject({ level: "native", font: "montserrat-900" });
    expect(presetSupport("power", "ja")).toMatchObject({ level: "fallback", font: "noto-sans-jp-800", deferred: true });
    expect(presetSupport("neon", "ko")).toMatchObject({ level: "fallback", font: "noto-sans-kr-800" });
    expect(presetSupport("elegant", "ja").level).toBe("unavailable");
    expect(presetSupport("elegant", "ru").level).toBe("native");
    for (const l of ["ar", "he", "fa", "ur"]) expect(presetSupport("minimal", l).level).toBe("unavailable");
    expect(presetSupport("none", "ar").level).toBe("native");
  });

  it("knows the 14 UI languages' scripts", () => {
    const s = (l: string) => scriptOfLang(l);
    expect(["en", "de", "es", "fr", "pt", "it", "tr", "pl", "nl", "id"].map(s).every((x) => x === "latin")).toBe(true);
    expect([s("ru"), s("hi"), s("ja"), s("ko"), s("pt-BR"), s("zh-Hant"), s("xx")]).toEqual([
      "cyrillic",
      "devanagari",
      "cjk",
      "cjk",
      "latin",
      "cjk",
      "latin",
    ]);
  });
});
