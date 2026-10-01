import { describe, expect, it } from "vitest";
import { isEmphasis } from "../emphasis";

// The language is only the label: digits are digits in every language.
const yes = (lang: string, words: string[]) => words.forEach((w) => expect(isEmphasis(w), `${lang}: ${w}`).toBe(true));
const no = (lang: string, words: string[]) => words.forEach((w) => expect(isEmphasis(w), `${lang}: ${w}`).toBe(false));

describe("isEmphasis: digits (any language)", () => {
  it("marks numbers with signs, currency, separators, ranges and units", () => {
    for (const lang of ["en", "de", "ru", "ja", "hi", "xx"]) {
      yes(lang, ["3", "10%", "100%", "2026", "$5", "5€", "€5", "1.000€", "2,5", "3,5", "1,000,000", "24/7", "3-4", "10:30",
        "3x", "10kg", "100km/h", "1st", "2nd", "#1", "+5", "-10%", "1990er", "3.", "(42)", "“7”", "50%,", "₹500", "₽100",
        "३", "५०", "３", "3人", "3개", "10분"]);
    }
  });

  it("does not mark words that merely contain digits", () => {
    no("en", ["mp4", "H2O", "COVID-19", "B2B", "iPhone15", "x", "", "  ", "%", "$"]);
  });
});

describe("isEmphasis: digits only (owner, UT5) — spelled-out numbers stay plain", () => {
  it("no number words in any language", () => {
    no("en", ["zero", "One", "TWO", "twelve", "twenty-one", "hundred", "fifty."]);
    no("de", ["null", "eins", "drei", "zwölf", "einundzwanzig", "dreißig", "hundert", "ZEHN"]);
    no("es", ["dos", "quince", "veintitrés", "cien"]);
    no("fr", ["deux", "dix-sept", "vingt-et-un", "cent"]);
    no("pt", ["dois", "três", "cem"]);
    no("it", ["tre", "ventuno", "cento"]);
    no("tr", ["iki", "İKİ", "yüz"]);
    no("pl", ["dwa", "pięć", "sto"]);
    no("nl", ["twee", "eenentwintig", "honderd"]);
    no("ru", ["Два", "ТРИ", "сто"]);
    no("id", ["dua", "seratus"]);
    no("hi", ["दो", "तीन", "सौ"]);
    no("ja", ["三", "二十", "三つ", "二人", "ひとつ"]);
    no("ko", ["하나", "스물"]);
  });

  it("the same word with a digit is marked", () => {
    expect(isEmphasis("drei")).toBe(false);
    expect(isEmphasis("3")).toBe(true);
    expect(isEmphasis("三")).toBe(false);
    expect(isEmphasis("3人")).toBe(true);
  });
});
