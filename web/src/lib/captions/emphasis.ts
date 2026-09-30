/**
 * Emphasis at launch = numbers (review D12; PLAN 3.5 "Zahlen farbig").
 *
 * isEmphasis(word, lang) is true for:
 * - numbers written with digits in any script, with sign, currency, %,
 *   separators, ranges or a short unit/ordinal suffix: "3", "10%", "$5",
 *   "1.000€", "2,5", "24/7", "3x", "10kg", "1st", "3人", "3개", "#1";
 * - spelled-out numbers 0–100 from a per-language list for the 14 UI
 *   languages (plus Chinese numerals), incl. compounds ("twenty-one",
 *   "einundzwanzig", "vingt-et-un", "ventitré").
 *
 * Words that double as the indefinite article are left out on purpose
 * ("ein", "un/une", "um/uma", "een", "bir", "एक"): they would light up
 * half the sentences. Deterministic and the same in the editor and the
 * render. Only presets with an `emphasis` colour use it (power, punch,
 * elegant).
 */
import { normLang } from "./scripts";

const w = (s: string) => s.split(/\s+/).filter(Boolean);

function germanCompounds(): string[] {
  const units = w("ein zwei drei vier fünf sechs sieben acht neun");
  const tens = w("zwanzig dreißig dreissig vierzig fünfzig sechzig siebzig achtzig neunzig");
  return units.flatMap((u) => tens.map((t) => `${u}und${t}`));
}

function dutchCompounds(): string[] {
  const units = w("een twee drie vier vijf zes zeven acht negen");
  const tens = w("twintig dertig veertig vijftig zestig zeventig tachtig negentig");
  return units.flatMap((u) => tens.map((t) => `${u}${u.endsWith("e") ? "ën" : "en"}${t}`));
}

function italianCompounds(): string[] {
  const tens = w("venti trenta quaranta cinquanta sessanta settanta ottanta novanta");
  const units = w("uno due tre quattro cinque sei sette otto nove");
  return tens.flatMap((t) =>
    units.map((u) => {
      const stem = u === "uno" || u === "otto" ? t.slice(0, -1) : t;
      return stem + (u === "tre" ? "tré" : u);
    }),
  );
}

const LISTS: Record<string, () => string[]> = {
  en: () =>
    w(
      "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " +
        "seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred",
    ),
  de: () => [
    ...w(
      "null eins zwei zwo drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn " +
        "sechzehn siebzehn achtzehn neunzehn zwanzig dreißig dreissig vierzig fünfzig sechzig siebzig achtzig " +
        "neunzig hundert einhundert",
    ),
    ...germanCompounds(),
  ],
  es: () =>
    w(
      "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis " +
        "dieciseis diecisiete dieciocho diecinueve veinte veintiuno veintiún veintidós veintidos veintitrés " +
        "veintitres veinticuatro veinticinco veintiséis veintiseis veintisiete veintiocho veintinueve treinta " +
        "cuarenta cincuenta sesenta setenta ochenta noventa cien ciento",
    ),
  fr: () =>
    w(
      "zéro zero deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize vingt " +
        "vingts trente quarante cinquante soixante cent",
    ),
  pt: () =>
    w(
      "zero dois duas três tres quatro cinco seis sete oito nove dez onze doze treze catorze quatorze quinze " +
        "dezesseis dezasseis dezessete dezassete dezoito dezenove dezanove vinte trinta quarenta cinquenta " +
        "sessenta setenta oitenta noventa cem cento",
    ),
  it: () => [
    ...w(
      "zero uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici quattordici quindici " +
        "sedici diciassette diciotto diciannove venti trenta quaranta cinquanta sessanta settanta ottanta " +
        "novanta cento",
    ),
    ...italianCompounds(),
  ],
  tr: () => w("sıfır iki üç dört beş altı yedi sekiz dokuz on yirmi otuz kırk elli altmış yetmiş seksen doksan yüz"),
  pl: () =>
    w(
      "zero jeden jedna jedno dwa dwie trzy cztery pięć sześć siedem osiem dziewięć dziesięć jedenaście " +
        "dwanaście trzynaście czternaście piętnaście szesnaście siedemnaście osiemnaście dziewiętnaście " +
        "dwadzieścia trzydzieści czterdzieści pięćdziesiąt sześćdziesiąt siedemdziesiąt osiemdziesiąt " +
        "dziewięćdziesiąt sto",
    ),
  nl: () => [
    ...w(
      "nul één twee drie vier vijf zes zeven acht negen tien elf twaalf dertien veertien vijftien zestien " +
        "zeventien achttien negentien twintig dertig veertig vijftig zestig zeventig tachtig negentig honderd",
    ),
    ...dutchCompounds(),
  ],
  ru: () =>
    w(
      "ноль нуль один одна одно два две три четыре пять шесть семь восемь девять десять одиннадцать двенадцать " +
        "тринадцать четырнадцать пятнадцать шестнадцать семнадцать восемнадцать девятнадцать двадцать тридцать " +
        "сорок пятьдесят шестьдесят семьдесят восемьдесят девяносто сто двух трёх трех четырёх четырех пяти " +
        "шести семи восьми девяти десяти двадцати тридцати",
    ),
  id: () =>
    w("nol satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas belas puluh seratus"),
  hi: () =>
    w(
      "शून्य दो तीन चार पाँच पांच छह छः सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह पन्द्रह सोलह सत्रह अठारह " +
        "उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस " +
        "चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस " +
        "सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ " +
        "बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर " +
        "छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी " +
        "नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे सौ",
    ),
  ja: () => w("ひとつ ふたつ みっつ よっつ いつつ むっつ ななつ やっつ ここのつ とお"),
  ko: () => w("하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 스물 서른 마흔 쉰 예순 일흔 여든 아흔"),
};

/** Parts allowed inside hyphenated compounds only ("vingt-et-un", "twenty-one"). */
const COMPOUND_PARTS: Record<string, string[]> = {
  fr: w("et un une"),
  en: [],
};

const cache = new Map<string, Set<string>>();
function numberWords(lang: string): Set<string> {
  let set = cache.get(lang);
  if (!set) {
    set = new Set((LISTS[lang]?.() ?? []).map((x) => x.normalize("NFC")));
    cache.set(lang, set);
  }
  return set;
}

// Digits in any script, optionally signed/currency-prefixed, with
// separators, ranges, and a short suffix (%, currency, unit, ordinal,
// CJK counter, Korean counter).
const NUMERIC =
  /^[#№+\-−±~≈]?\p{Sc}?\p{Nd}(?:[\p{Nd}.,:'’/  ]|[-–]\p{Nd})*(?:%|‰|\p{Sc}|[\p{L}/²³]{1,6})?$/u;
// Han numerals + an optional counter, for ja / zh ("三つ", "二人", "十回";
// not "一緒").
const HAN_NUMERAL = /^[〇零一二三四五六七八九十百两兩]+[つ人回個个本枚匹年月日時时分秒円元歳岁度倍番位階件冊台杯名週周歩步点號号次块塊天张張只隻条條]?$/u;
const TRIM = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/** Is `word` a number (see the module comment)? */
export function isEmphasis(word: string, lang?: string | null): boolean {
  // glued punctuation ("100 % –", "« oui »", layout.ts) is not part of the word
  const parts = (word || "").normalize("NFC").trim().split(/[  ]/);
  const loose = (p: string) => /^[\p{P}\p{S}]+$/u.test(p) && !/^[%‰\p{Sc}]+$/u.test(p);
  while (parts.length > 1 && loose(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && loose(parts[0])) parts.shift();
  const raw = parts.join(" ");
  if (!raw) return false;
  // keep leading #/+/−/currency and trailing %/currency for the numeric test
  const numericCore = raw.replace(/^[("'“”„«‹\[¡¿]+|[)"'“”»›\].,!?;:…]+$/gu, "");
  if (NUMERIC.test(numericCore)) return true;
  const l = normLang(lang);
  const bare = raw.replace(TRIM, "");
  if (!bare) return false;
  if ((l === "ja" || l === "zh" || l === "yue") && HAN_NUMERAL.test(bare)) return true;
  let lower: string;
  try {
    lower = bare.toLocaleLowerCase(l);
  } catch {
    lower = bare.toLowerCase();
  }
  const words = numberWords(l);
  if (!words.size) return false;
  if (words.has(lower)) return true;
  if (/[-‐]/.test(lower)) {
    const parts = lower.split(/[-‐]/).filter(Boolean);
    const extra = COMPOUND_PARTS[l] ?? [];
    return parts.length > 1 && parts.some((p) => words.has(p)) && parts.every((p) => words.has(p) || extra.includes(p));
  }
  return false;
}
