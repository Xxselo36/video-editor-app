/**
 * Counts in every language (PLAN_TECH rule 0.8, review F9): the plural
 * category of `n` in `lang` by Intl.PluralRules — "one" for 1 in English
 * but also for 21 in Russian, "few" for 2–4 in Polish — never `n === 1`.
 *
 *   t(plural(lang, n, { one: "app.x.countOne", other: "app.x.countOther" }), { count: n })
 *
 * `forms` gives a value per category the language uses; a category
 * without one falls back to `other` (the message files have …One /
 * …Other keys today; add …Few / …Many where a language needs them).
 */
export type PluralForms<T> = {
  zero?: T;
  one?: T;
  two?: T;
  few?: T;
  many?: T;
  other: T;
};

const rules = new Map<string, Intl.PluralRules>();

function rulesFor(lang: string): Intl.PluralRules {
  let r = rules.get(lang);
  if (!r) {
    try {
      r = new Intl.PluralRules(lang);
    } catch {
      r = new Intl.PluralRules("en");
    }
    rules.set(lang, r);
  }
  return r;
}

/** The plural category of `n` in `lang` ("one", "few", "other", …). */
export function pluralCategory(lang: string, n: number): Intl.LDMLPluralRule {
  return rulesFor(lang).select(n);
}

/** The form of `forms` for `n` in `lang`. */
export function plural<T>(lang: string, n: number, forms: PluralForms<T>): T {
  return forms[pluralCategory(lang, n)] ?? forms.other;
}
