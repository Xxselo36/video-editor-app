import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS, type Lang } from "@/i18n/langs";
import { deLanding } from "@/i18n/messages/de/landing";
import { enLanding } from "@/i18n/messages/en/landing";
import { esLanding } from "@/i18n/messages/es/landing";
import { frLanding } from "@/i18n/messages/fr/landing";
import { hiLanding } from "@/i18n/messages/hi/landing";
import { idLanding } from "@/i18n/messages/id/landing";
import { itLanding } from "@/i18n/messages/it/landing";
import { jaLanding } from "@/i18n/messages/ja/landing";
import { koLanding } from "@/i18n/messages/ko/landing";
import { nlLanding } from "@/i18n/messages/nl/landing";
import { plLanding } from "@/i18n/messages/pl/landing";
import { ptLanding } from "@/i18n/messages/pt/landing";
import { ruLanding } from "@/i18n/messages/ru/landing";
import { trLanding } from "@/i18n/messages/tr/landing";
import { fitCss, headlineEms, titleEms } from "./heroFit";

const LANDING: Record<Lang, Partial<Record<keyof typeof enLanding, string>>> = {
  en: enLanding, de: deLanding, es: esLanding, fr: frLanding, pt: ptLanding, it: itLanding, tr: trLanding,
  pl: plLanding, nl: nlLanding, ru: ruLanding, ja: jaLanding, ko: koLanding, id: idLanding, hi: hiLanding,
};
const TITLES = Object.fromEntries((Object.keys(LANGS) as Lang[]).map((l) => [l, LANDING[l]["site.hero.title"]!]));

/** The --h1-em rows of Landing.module.css, in file order. */
function cssTable(): string {
  const css = fs.readFileSync(path.join(__dirname, "Landing.module.css"), "utf8");
  return (css.match(/^\.h1(?::lang\([a-z]+\))? \{ --h1-em: [\d.]+; \}$/gm) ?? []).join("\n");
}

describe("hero headline fit", () => {
  // On failure the expected value is the new table: paste it over the
  // rows in Landing.module.css.
  it("Landing.module.css has the estimate of every language's title", () => {
    expect(cssTable()).toBe(fitCss(TITLES));
  });

  it("estimates by letter: marks free, CJK and Hangul a full em", () => {
    expect(headlineEms("Cleo cuts.")).toBeCloseTo(5.54);
    expect(headlineEms("कि")).toBeCloseTo(0.78); // the vowel sign rides on its consonant
    expect(headlineEms("カット")).toBe(3);
    expect(titleEms("말은 내가, 컷은 Cleo가.")).toBe(Number((headlineEms("말은 내가, 컷은 Cleo가.") / 2 + 0.5).toFixed(2)));
  });

  // At the smallest size (2rem) a word that cannot break must still fit a
  // 320 px phone's column (288 px), or the page would scroll sideways.
  // Japanese breaks between phrases, so only spaced scripts count.
  it.each(Object.keys(LANGS).filter((l) => l !== "ja") as Lang[])("%s: every word fits a 320 px phone", (lang) => {
    for (const word of TITLES[lang].split(/\s+/)) expect(headlineEms(word) * 32).toBeLessThanOrEqual(288);
  });
});
