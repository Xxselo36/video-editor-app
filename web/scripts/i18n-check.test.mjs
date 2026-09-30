import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  avoidRegex,
  checkCodes,
  checkDicts,
  checkGlossary,
  checkParts,
  loadMessages,
  loadTs,
  parseGlossary,
  placeholders,
  readLangs,
  stripLiterals,
  unusedKeys,
} from "./i18n-check.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("placeholders", () => {
  it("lists each {name} once, sorted", () => {
    expect(placeholders("{b} of {a}, {b} again")).toEqual(["a", "b"]);
    expect(placeholders("none")).toEqual([]);
  });
});

describe("checkDicts", () => {
  const en = { "a.one": "One {n}", "a.two": "Two", "a.three": "Three {x} {y}" };

  it("passes a complete translation", () => {
    expect(checkDicts({ en, de: { "a.one": "Eins {n}", "a.two": "Zwei", "a.three": "{y} drei {x}" } })).toEqual([]);
  });

  it("reports missing and extra keys, placeholder mismatches and empty messages", () => {
    const errors = checkDicts({ en, de: { "a.one": "Eins", "a.three": " ", "a.four": "Vier" } });
    expect(errors).toEqual([
      { rule: "missing", lang: "de", key: "a.two" },
      { rule: "placeholders", lang: "de", key: "a.one", detail: "none instead of {n}" },
      { rule: "empty", lang: "de", key: "a.three" },
      { rule: "extra", lang: "de", key: "a.four" },
    ]);
  });
});

describe("checkParts", () => {
  it("reports a key filed in another part than English files it in", () => {
    const parts = {
      en: { site: ["s.a"], app: ["a.b", "a.c"], editor: ["e.d"], mail: [] },
      de: { site: ["s.a", "a.c"], app: ["a.b"], editor: ["e.d"], mail: [] },
    };
    expect(checkParts(parts)).toEqual([
      { rule: "misplaced", lang: "de", key: "a.c", detail: "in site.ts, English has it in app.ts" },
    ]);
  });
});

describe("checkCodes", () => {
  const en = { "k.speech": "No speech", "k.stage": "Transcribing" };
  it("passes when every code maps to an English key", () => {
    const codes = { errors: ["no_speech"], warnings: [], audio_warnings: [], stages: ["analyze.transcribe"] };
    const maps = { ERROR_KEYS: { no_speech: "k.speech" }, STAGE_KEYS: { "analyze.transcribe": "k.stage" } };
    expect(checkCodes(codes, maps, en)).toEqual([]);
  });

  it("reports codes without a key and keys English lacks", () => {
    const codes = { errors: ["no_speech", "no_video"], stages: ["queued"] };
    const maps = { ERROR_KEYS: { no_speech: "k.gone" }, STAGE_KEYS: {} };
    expect(checkCodes(codes, maps, en)).toEqual([
      { rule: "codes", lang: "en", key: "no_speech", detail: "ERROR_KEYS maps it to k.gone, which English lacks" },
      { rule: "codes", lang: "-", key: "no_video", detail: "errors: no key in ERROR_KEYS" },
      { rule: "codes", lang: "-", key: "queued", detail: "stages: no key in STAGE_KEYS" },
    ]);
  });

  it("the app's catalogue: every backend code has a key in every language", () => {
    const { dicts } = loadMessages();
    const codes = JSON.parse(fs.readFileSync(path.join(HERE, "../src/lib/errorCodes.json"), "utf8"));
    const maps = loadTs(path.join(HERE, "../src/lib/errorKeys.ts"));
    expect(checkCodes(codes, maps, dicts.en)).toEqual([]);
    expect(checkDicts(dicts)).toEqual([]);
  });
});

describe("unusedKeys", () => {
  it("counts string literals and dynamically built keys as used", () => {
    const sources = ['t("a.used")', "const k = 'b.quoted';", "t(`stage.${id}`)", 'x("pre." + id)'];
    expect(unusedKeys(["a.used", "b.quoted", "stage.upload", "pre.fix", "c.dead"], sources)).toEqual(["c.dead"]);
  });
});

describe("glossary", () => {
  const md = [
    "# Glossary",
    "## Terms",
    "| Concept | en | de | ja |",
    "|---|---|---|---|",
    "| Export | export | Export (exportieren) | 書き出し |",
    "| Cut | cut | Schnitt | カット |",
    "## Avoid",
    "| Lang | Concept | Avoid |",
    "|---|---|---|",
    "| de | Export | `render*`, `gerendert` |",
    "| de | Cut | `Cut` |",
    "| ja | Export | `レンダリング` |",
    "## Next",
    "| not | part | of it |",
  ].join("\n");

  it("parses the Terms and Avoid tables", () => {
    const g = parseGlossary(md);
    expect(g.terms.Export).toEqual({ en: "export", de: "Export (exportieren)", ja: "書き出し" });
    expect(g.avoid).toEqual([
      { lang: "de", concept: "Export", term: "render*" },
      { lang: "de", concept: "Export", term: "gerendert" },
      { lang: "de", concept: "Cut", term: "Cut" },
      { lang: "ja", concept: "Export", term: "レンダリング" },
    ]);
  });

  it("matches whole words, `*` allowing more letters", () => {
    expect(avoidRegex("render*", "it").test("Il rendering è fallito")).toBe(true);
    expect(avoidRegex("render*", "it").test("prendere i sottotitoli")).toBe(false);
    expect(avoidRegex("Cut", "de").test("Cut / Neustart")).toBe(true);
    expect(avoidRegex("Cut", "de").test("Cutter")).toBe(false);
    expect(avoidRegex("レンダリング", "ja").test("適用してレンダリング")).toBe(true);
  });

  it("ignores placeholders and voice commands", () => {
    expect(stripLiterals("Sag {cut} oder „Cleo cut“")).not.toMatch(/cut/i);
  });

  it("reports the messages that use a term to avoid", () => {
    const dicts = {
      de: { "a.render": "Übernehmen & rendern", "a.ok": "Exportieren", "a.cmd": "„Cleo cut“ an", "a.cut": "SAG CUT" },
      ja: { "a.render": "レンダリング中" },
    };
    expect(checkGlossary(dicts, parseGlossary(md))).toEqual([
      { lang: "de", concept: "Export", term: "render*", use: "Export (exportieren)", keys: ["a.render"] },
      { lang: "de", concept: "Cut", term: "Cut", use: "Schnitt", keys: ["a.cut"] },
      { lang: "ja", concept: "Export", term: "レンダリング", use: "書き出し", keys: ["a.render"] },
    ]);
  });

  it("docs/i18n-glossary.md stays machine-readable: 8 concepts in every language", () => {
    const langs = readLangs(fs.readFileSync(path.join(HERE, "../src/i18n/langs.ts"), "utf8"));
    const g = parseGlossary(fs.readFileSync(path.join(HERE, "../../docs/i18n-glossary.md"), "utf8"));
    expect(Object.keys(g.terms)).toEqual([
      "Take",
      "Cut",
      "Caption style",
      "Minutes",
      "Export",
      "Project",
      "Preview",
      "Edit again",
    ]);
    for (const [concept, byLang] of Object.entries(g.terms)) {
      for (const lang of langs) expect(byLang[lang], `${concept} in ${lang}`).toBeTruthy();
    }
    expect(g.avoid.length).toBeGreaterThan(0);
    for (const a of g.avoid) {
      expect(langs, `Avoid row ${JSON.stringify(a)}`).toContain(a.lang);
      expect(Object.keys(g.terms)).toContain(a.concept);
    }
  });
});
