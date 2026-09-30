/**
 * The UI languages and how the first visit picks one — no React, no
 * "use client": the root layout (a Server Component) renders
 * LANG_INIT_SCRIPT from here, i18n/index.tsx uses detectLang.
 */

export const LANGS = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  pt: "Português",
  it: "Italiano",
  tr: "Türkçe",
  pl: "Polski",
  nl: "Nederlands",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
  id: "Bahasa Indonesia",
  hi: "हिन्दी",
} as const;
export type Lang = keyof typeof LANGS;

/** localStorage key of the language the user picked. */
export const LANG_STORAGE_KEY = "cleocuts.lang";
/** The same choice as a cookie, for the server (emails, the /de landing)
 *  and as the fallback when localStorage is blocked. */
export const LANG_COOKIE = "cleo_lang";

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LANGS, value);
}

/**
 * The language to show: the one the user picked (stored), else the
 * first of the browser's preferred languages we have ("de-AT" → de,
 * "pt-BR" → pt), else English. The detected language is not stored, so
 * it follows the browser until the user picks one.
 */
export function detectLang(stored: string | null | undefined, preferred: readonly string[] | undefined): Lang {
  if (isLang(stored)) return stored;
  for (const tag of preferred ?? []) {
    const base = String(tag || "").toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return "en";
}

/**
 * Runs in <head> before anything renders (root layout): sets
 * <html lang> to detectLang's answer, so screen readers use the right
 * voice from the first paint and the legal pages show the right text
 * (globals.css). Same rules as detectLang (the stored choice: localStorage,
 * else the cookie), in plain ES5.
 */
export const LANG_INIT_SCRIPT = `(function(){try{var L=${JSON.stringify(
  Object.keys(LANGS),
)},s=null,l=null,p,i,b,c;try{s=localStorage.getItem(${JSON.stringify(
  LANG_STORAGE_KEY,
)})}catch(e){}if(L.indexOf(s)<0){c=document.cookie.match(/(?:^|;\\s*)${LANG_COOKIE}=([^;]*)/);s=c?c[1]:null}if(L.indexOf(s)>=0)l=s;else{p=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];for(i=0;i<p.length&&!l;i++){b=String(p[i]||"").toLowerCase().split(/[-_]/)[0];if(L.indexOf(b)>=0)l=b}}document.documentElement.lang=l||"en"}catch(e){}})();`;
