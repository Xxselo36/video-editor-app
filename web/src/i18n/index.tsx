"use client";
/**
 * Minimal i18n for the web app — no dependency.
 *
 * - English is the default and the source of truth (messages/en.ts).
 * - First visit: the browser's language, if we have it (langs.ts
 *   detectLang); otherwise English.
 * - The user picks a language in the LanguageSwitcher; the choice is
 *   stored in localStorage and shared across tabs/pages.
 * - <html lang> follows: set before the first paint by the root
 *   layout's inline script (LANG_INIT_SCRIPT), then on every change.
 * - Missing keys in a translation fall back to English.
 *
 * Usage:  const t = useT();  t("app.dashboard.newVideo")
 *         t("app.card.pct", { pct: 42 })   // "{pct}" placeholders
 */
import { useCallback, useSyncExternalStore } from "react";
import { LANGS, LANG_STORAGE_KEY, detectLang, type Lang } from "./langs";
import { en, type MessageKey } from "./messages/en";
import { de } from "./messages/de";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { pt } from "./messages/pt";
import { it } from "./messages/it";
import { tr } from "./messages/tr";
import { pl } from "./messages/pl";
import { nl } from "./messages/nl";
import { ru } from "./messages/ru";
import { ja } from "./messages/ja";
import { ko } from "./messages/ko";
import { id } from "./messages/id";
import { hi } from "./messages/hi";

export { LANGS, type Lang };

const DICTS: Record<Lang, Partial<Record<MessageKey, string>>> = { en, de, es, fr, pt, it, tr, pl, nl, ru, ja, ko, id, hi };
const KEY = LANG_STORAGE_KEY;
const EVENT = "cleocuts.lang.change";

/** The browser's preferred languages (read once per page). */
let preferred: readonly string[] | null = null;
function browserLanguages(): readonly string[] {
  if (preferred === null) {
    try {
      preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
    } catch {
      preferred = [];
    }
  }
  return preferred;
}

function readLang(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  return detectLang(stored, browserLanguages());
}

function subscribe(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    // Picked in another tab: this tab's <html lang> follows too.
    document.documentElement.lang = readLang();
    cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang;
  window.dispatchEvent(new Event(EVENT));
}

/** Current language: the stored choice, else the browser's language
 *  (langs.ts detectLang). Server render + hydration are English, the
 *  client switches right after. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, readLang, () => "en");
}

export function translate(
  lang: Lang,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  let s = DICTS[lang][key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useT(): TFn {
  const lang = useLang();
  return useCallback<TFn>((key, vars) => translate(lang, key, vars), [lang]);
}

/** Compact language picker (native select: works well on phones). */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const lang = useLang();
  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{translate(lang, "common.language")}</span>
      <span aria-hidden className="pointer-events-none absolute left-2 text-sm">🌐</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        className="appearance-none rounded-full py-1.5 pl-7 pr-3 text-base sm:text-xs"
        style={{
          background: "var(--surface-2)",
          color: "var(--text-body)",
          border: "1px solid var(--border)",
        }}
      >
        {(Object.keys(LANGS) as Lang[]).map((l) => (
          <option key={l} value={l}>
            {LANGS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
