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
import { headlineLines, type HeadlineLine } from "./headline";

const LANDING: Record<Lang, Partial<Record<keyof typeof enLanding, string>>> = {
  en: enLanding, de: deLanding, es: esLanding, fr: frLanding, pt: ptLanding, it: itLanding, tr: trLanding,
  pl: plLanding, nl: nlLanding, ru: ruLanding, ja: jaLanding, ko: koLanding, id: idLanding, hi: hiLanding,
};

const text = (lines: HeadlineLine[]) => lines.map((l) => l.before + l.cut + l.after).join("");

describe("headlineLines", () => {
  it.each(Object.keys(LANGS) as Lang[])("%s: marks the cut word once and keeps the title exact", (lang) => {
    const title = LANDING[lang]["site.hero.title"]!;
    const cutWord = LANDING[lang]["site.hero.cutWord"]!;
    const lines = headlineLines(title, cutWord);
    expect(text(lines)).toBe(title);
    expect(lines.filter((l) => l.cut).map((l) => l.cut)).toEqual([cutWord]);
    // a two-sentence title sets as two lines, the one-sentence ones (ko, tr) as one
    expect(lines.length).toBe(lang === "ko" || lang === "tr" ? 1 : 2);
  });

  it("splits after each sentence and keeps the space in the first line", () => {
    expect(headlineLines("You talk. Cleo cuts.", "cuts.")).toEqual([
      { before: "You talk. ", cut: "", after: "" },
      { before: "Cleo ", cut: "cuts.", after: "" },
    ]);
    expect(headlineLines("말은 내가, 컷은 Cleo가.", "컷은")).toEqual([{ before: "말은 내가, ", cut: "컷은", after: " Cleo가." }]);
  });

  // empty, the key itself (t() without the string), a word from another
  // translation, one that spans both sentences
  it.each(["", "site.hero.cutWord", "schneidet.", "talk. Cleo"])("highlights nothing for %j", (cutWord) => {
    const lines = headlineLines("You talk. Cleo cuts.", cutWord);
    expect(text(lines)).toBe("You talk. Cleo cuts.");
    expect(lines.every((l) => !l.cut)).toBe(true);
  });
});
