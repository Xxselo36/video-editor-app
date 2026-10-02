/**
 * Emphasis at launch = numbers written with digits (review D12; PLAN 3.5
 * "Zahlen farbig"; owner, UT5: digits only, as in the approved DF mock).
 *
 * isEmphasis(word) is true for a number written with digits in any
 * script, with sign, currency, %, separators, ranges or a short
 * unit/ordinal suffix: "3", "10%", "$5", "1.000€", "2,5", "24/7", "3x",
 * "10kg", "1st", "3人", "3개", "#1".
 *
 * Spelled-out numbers ("drei", "hundert", "twenty-one", "三つ") are not
 * marked: words light up only where the transcript shows a digit, the
 * same in every language. Words that merely contain a digit ("mp4",
 * "COVID-19") aren't numbers either. Deterministic and the same in the
 * editor and the render. Only presets with an `emphasis` colour use it
 * (power, punch, elegant).
 */

// Digits in any script, optionally signed/currency-prefixed, with
// separators, ranges, and a short suffix (%, currency, unit, ordinal,
// CJK counter, Korean counter).
const NUMERIC =
  /^[#№+\-−±~≈]?\p{Sc}?\p{Nd}(?:[\p{Nd}.,:'’/\u00A0\u202F]|[-–]\p{Nd})*(?:%|‰|\p{Sc}|[\p{L}/²³]{1,6})?$/u;

/** Is `word` a number written with digits (see the module comment)? Any language. */
export function isEmphasis(word: string): boolean {
  // glued punctuation ("100 % –", "« 3 »", layout.ts) is not part of the word
  const parts = (word || "").normalize("NFC").trim().split(/[\u00A0\u202F]/);
  const loose = (p: string) => /^[\p{P}\p{S}]+$/u.test(p) && !/^[%‰\p{Sc}]+$/u.test(p);
  while (parts.length > 1 && loose(parts[parts.length - 1])) parts.pop();
  while (parts.length > 1 && loose(parts[0])) parts.shift();
  const raw = parts.join(" ");
  if (!raw) return false;
  // keep leading #/+/−/currency and trailing %/currency for the numeric test
  const numericCore = raw.replace(/^[("'“”„«‹\[¡¿]+|[)"'“”»›\].,!?;:…]+$/gu, "");
  return NUMERIC.test(numericCore);
}
