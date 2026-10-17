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
import {
  FIRST_WORD_AT,
  PHRASE_GAP,
  WORD_GAP,
  captionWords,
  splitPhrases,
  splitWords,
  spokenAt,
  spokenUntil,
  wordDuration,
} from "./words";

const LANDING: Record<Lang, Partial<Record<keyof typeof enLanding, string>>> = {
  en: enLanding,
  de: deLanding,
  es: esLanding,
  fr: frLanding,
  pt: ptLanding,
  it: itLanding,
  tr: trLanding,
  pl: plLanding,
  nl: nlLanding,
  ru: ruLanding,
  ja: jaLanding,
  ko: koLanding,
  id: idLanding,
  hi: hiLanding,
};
/** The hero's and the closing reprise's line. */
const demoCaption = (lang: Lang) => LANDING[lang]["site.demo.caption"] ?? "";
/** The lines without "|": that one and the ring's three. */
const PLAIN_KEYS = ["site.demo.caption", "site.captions.line1", "site.captions.line2", "site.captions.line3"] as const;
const plainLines = (lang: Lang) => PLAIN_KEYS.map((k) => LANDING[lang][k] ?? "");

/** captionWords as it was before phrases: one run of words, no breaks. */
function wordsBeforePhrases(text: string, lang: string) {
  let t = FIRST_WORD_AT;
  return splitWords(text, lang).map((w, i) => {
    const start = t;
    const end = start + wordDuration(w);
    t = end + WORD_GAP;
    return { id: `w${i}`, text: w, start, end };
  });
}

describe("landing caption words", () => {
  it("drops the highlight brackets and splits on spaces", () => {
    expect(splitWords("3 tips for better [hooks]", "en")).toEqual(["3", "tips", "for", "better", "hooks"]);
  });

  it("segments Japanese into several words", () => {
    expect(splitWords("フックを良くする3つのコツ", "ja").length).toBeGreaterThan(1);
  });

  it("keeps particles and counters with the word before them", () => {
    expect(splitWords("良いフックを作る3つの[コツ]", "ja")).toEqual(["良い", "フックを", "作る", "3つの", "コツ"]);
    expect(splitWords("做好开头的3个[技巧]", "zh")).toEqual(["做好", "开头的", "3个", "技巧"]);
  });

  it("times words back to back with a gap", () => {
    const w = captionWords("a bb", "en");
    expect(w[0].end - w[0].start).toBeCloseTo(wordDuration("a"));
    expect(w[1].start - w[0].end).toBeCloseTo(0.06);
    expect(spokenUntil(w)).toBe(w[1].end);
  });

  it("times a line without '|' exactly as before (the hero, the ring, the reprise)", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      for (const text of plainLines(lang)) {
        expect(text, lang).toBeTruthy();
        expect(text, lang).not.toContain("|");
        // the same words, times and ids, and no page break
        expect(captionWords(text, lang), lang).toStrictEqual(wordsBeforePhrases(text, lang));
        expect(splitPhrases(text), lang).toEqual([text.trim()]);
      }
    }
  });
});

describe("landing caption phrases ('|')", () => {
  const line = "My best [tip] | for more [views] | hook them [fast]";

  it("splits a line into its phrases, each with its mark", () => {
    expect(splitPhrases(line)).toEqual(["My best [tip]", "for more [views]", "hook them [fast]"]);
    expect(splitPhrases(" a |  | b ")).toEqual(["a", "b"]);
    expect(splitPhrases("")).toEqual([]);
    expect(captionWords("", "en")).toEqual([]);
  });

  it("starts each new phrase on its own page after a breath", () => {
    const w = captionWords(line, "en");
    expect(w.map((x) => x.text)).toEqual(["My", "best", "tip", "for", "more", "views", "hook", "them", "fast"]);
    expect(w.map((x) => x.id)).toEqual(w.map((_, i) => `w${i}`));
    // only the first word of phrases 2 and 3 breaks the page
    expect(w.filter((x) => x.breakBefore).map((x) => x.text)).toEqual(["for", "hook"]);
    expect(w[0].start).toBe(FIRST_WORD_AT);
    expect(w[3].start - w[2].end).toBeCloseTo(PHRASE_GAP);
    expect(w[6].start - w[5].end).toBeCloseTo(PHRASE_GAP);
    // inside a phrase, the usual gap
    expect(w[4].start - w[3].end).toBeCloseTo(WORD_GAP);
    expect(w[8].end - w[8].start).toBeCloseTo(wordDuration("fast"));
  });

  it("segments Japanese inside each phrase", () => {
    const w = captionWords("最強の[コツ] | 冒頭で[掴む]", "ja");
    expect(w.map((x) => x.text)).toEqual(["最強の", "コツ", "冒頭で", "掴む"]);
    expect(w.map((x) => !!x.breakBefore)).toEqual([false, false, true, false]);
  });
});

describe("landing caption stills", () => {
  it("settles a line on its last word spoken, as it always did", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      const w = captionWords(demoCaption(lang), lang);
      const last = w[w.length - 1];
      expect(spokenAt(w, w.length - 1), lang).toBe(Math.max(last.start + 0.3, last.end - 0.02));
    }
  });

  it("holds a word inside a line before the next word starts", () => {
    // a one-letter word: its entrance done, the next word not yet lit
    const w = captionWords("이걸로 다 바뀌어요", "ko");
    expect(spokenAt(w, 1)).toBeGreaterThanOrEqual(w[1].end - 0.02);
    expect(spokenAt(w, 1)).toBeGreaterThan(w[1].start + 0.2);
    expect(spokenAt(w, 1)).toBeLessThan(w[2].start);
  });
});
