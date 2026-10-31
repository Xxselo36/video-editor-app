/**
 * The spoken language of a new video ("Sprache im Video"): language names
 * in the UI language for the start screen's select and its "Mehr
 * Optionen" summary. Intl.DisplayNames names them; a browser without it
 * shows the codes.
 */

/** Names in `uiLang`, from one DisplayNames for a whole list. */
function namer(uiLang: string): (code: string) => string {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([uiLang], { type: "language" });
  } catch {
    /* no Intl.DisplayNames: the codes */
  }
  return (code) => {
    try {
      const name = names?.of(code);
      return name && name !== code ? name.charAt(0).toLocaleUpperCase(uiLang) + name.slice(1) : code;
    } catch {
      return code;
    }
  };
}

/** A language's name in the UI language (the code when the browser
 *  can't name it). */
export function languageName(code: string, uiLang: string): string {
  return namer(uiLang)(code);
}

/** The languages a video can be in (GET /config spoken_languages, "auto"
 *  left out: the select offers it first), by name in the UI language. */
export function spokenLanguages(codes: readonly string[], uiLang: string): { code: string; name: string }[] {
  const name = namer(uiLang);
  const collator = new Intl.Collator(uiLang);
  return codes
    .filter((code) => code !== "auto")
    .map((code) => ({ code, name: name(code) }))
    .sort((a, b) => collator.compare(a.name, b.name));
}
