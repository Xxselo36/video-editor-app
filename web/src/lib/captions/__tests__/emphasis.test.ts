import { describe, expect, it } from "vitest";
import { isEmphasis } from "../emphasis";

const yes = (lang: string, words: string[]) => words.forEach((w) => expect(isEmphasis(w, lang), `${lang}: ${w}`).toBe(true));
const no = (lang: string, words: string[]) => words.forEach((w) => expect(isEmphasis(w, lang), `${lang}: ${w}`).toBe(false));

describe("isEmphasis: digits (any language)", () => {
  it("marks numbers with signs, currency, separators, ranges and units", () => {
    for (const lang of ["en", "de", "ru", "ja", "hi", "xx"]) {
      yes(lang, ["3", "10%", "$5", "5€", "€5", "1.000€", "2,5", "1,000,000", "24/7", "3-4", "10:30", "3x", "10kg", "100km/h",
        "1st", "2nd", "#1", "+5", "-10%", "1990er", "3.", "(42)", "“7”", "50%,", "₹500", "₽100", "३", "५०", "３"]);
    }
  });

  it("does not mark words that merely contain digits", () => {
    no("en", ["mp4", "H2O", "COVID-19", "B2B", "iPhone15", "x", "", "  ", "%", "$"]);
  });
});

describe("isEmphasis: spelled-out numbers 0–100", () => {
  it("en", () => {
    yes("en", ["zero", "One", "TWO", "seven,", "twelve", "twenty", "twenty-one", "Ninety-Nine", "hundred", "fifty."]);
    no("en", ["someone", "none", "tone", "often", "twentyish", "a"]);
  });
  it("de", () => {
    yes("de", ["null", "eins", "zwei", "zwölf", "zwanzig", "einundzwanzig", "neunundneunzig", "dreißig", "hundert", "ZEHN"]);
    no("de", ["ein", "eine", "einen", "einer", "zweite", "Einheit"]);
  });
  it("es", () => {
    yes("es", ["uno", "dos", "quince", "veintitrés", "cincuenta", "cien"]);
    no("es", ["un", "una"]);
  });
  it("fr", () => {
    yes("fr", ["deux", "dix-sept", "vingt-et-un", "quatre-vingt-dix", "cent", "soixante-dix"]);
    no("fr", ["un", "une", "et"]);
  });
  it("pt", () => {
    yes("pt", ["dois", "duas", "três", "vinte", "cem"]);
    no("pt", ["um", "uma"]);
  });
  it("it", () => {
    yes("it", ["uno", "tre", "ventuno", "ventotto", "trentatré", "novantanove", "cento"]);
    no("it", ["un", "una"]);
  });
  it("tr (Turkish case folding)", () => {
    yes("tr", ["iki", "İKİ", "üç", "ALTI", "yirmi", "yüz"]);
    no("tr", ["bir", "BİR", "iyi"]);
  });
  it("pl", () => yes("pl", ["jeden", "dwa", "pięć", "dwadzieścia", "sto"]));
  it("nl", () => {
    yes("nl", ["één", "twee", "eenentwintig", "tweeëntwintig", "honderd"]);
    no("nl", ["een"]);
  });
  it("ru", () => {
    yes("ru", ["один", "Два", "ТРИ", "двадцать", "сто", "пяти", "трёх"]);
    no("ru", ["это", "дом"]);
  });
  it("id", () => yes("id", ["satu", "dua", "sepuluh", "seratus", "puluh"]));
  it("hi", () => {
    yes("hi", ["दो", "तीन", "पाँच", "दस", "पच्चीस", "सौ"]);
    no("hi", ["एक", "नमस्ते"]);
  });
  it("ja (Han numerals, counters, native counting)", () => {
    yes("ja", ["三", "十", "二十", "三つ", "二人", "十回", "ひとつ", "3人"]);
    no("ja", ["一緒", "天気", "は"]);
  });
  it("ko", () => {
    yes("ko", ["하나", "둘", "셋", "스물", "3개", "10분"]);
    no("ko", ["사람", "이"]);
  });
  it("uses the language: a German number word is not an English one", () => {
    expect(isEmphasis("zwei", "en")).toBe(false);
    expect(isEmphasis("zwei", "de")).toBe(true);
    expect(isEmphasis("zwei", "de-AT")).toBe(true);
  });
});
