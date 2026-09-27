"use client";
/**
 * Minimal i18n for the web app — no dependency.
 *
 * - English is the default and the source of truth (messages/en.ts).
 * - The user picks a language in the LanguageSwitcher; the choice is
 *   stored in localStorage and shared across tabs/pages.
 * - Missing keys in a translation fall back to English.
 *
 * Usage:  const t = useT();  t("app.dashboard.newVideo")
 *         t("app.card.pct", { pct: 42 })   // "{pct}" placeholders
 */
import { useCallback, useSyncExternalStore } from "react";
import { en, type MessageKey } from "./messages/en";
import { de } from "./messages/de";
import { es } from "./messages/es";
import { fr } from "./messages/fr";
import { pt } from "./messages/pt";
import { it } from "./messages/it";

export const LANGS = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  pt: "Português",
  it: "Italiano",
} as const;
export type Lang = keyof typeof LANGS;

const DICTS: Record<Lang, Partial<Record<MessageKey, string>>> = { en, de, es, fr, pt, it };
const KEY = "cleocuts.lang";
const EVENT = "cleocuts.lang.change";

function readLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v in LANGS) return v as Lang;
  } catch {
    /* storage blocked */
  }
  return "en";
}

function subscribe(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
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

/** Current language. Server render + first paint are English. */
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
      <span className="sr-only">Language</span>
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
