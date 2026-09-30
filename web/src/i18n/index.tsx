"use client";
/**
 * Minimal i18n for the web app — no dependency.
 *
 * - English is the default and the source of truth (messages/en). It is
 *   bundled with every page; every other language is its own chunk,
 *   loaded on first use (loadLang) — a page carries one language, not 14.
 * - First visit: the browser's language, if we have it (langs.ts
 *   detectLang); otherwise English.
 * - The user picks a language in the LanguageSwitcher; the choice is
 *   stored in localStorage and in the `cleo_lang` cookie (for the server:
 *   emails, the /de landing), shared across tabs/pages.
 * - <html lang> follows: set before the first paint by the root
 *   layout's inline script (LANG_INIT_SCRIPT), then on every change.
 * - Until a language's messages arrive, useT() answers in English (the
 *   same as the server render); missing keys fall back to English too.
 *
 * Usage:  const t = useT();  t("app.dashboard.newVideo")
 *         t("app.card.pct", { pct: 42 })   // "{pct}" placeholders
 * Counts: lib/i18n/plural.ts.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { LANGS, LANG_COOKIE, LANG_STORAGE_KEY, detectLang, isLang, type Lang } from "./langs";
import { en, type Dict, type MessageKey } from "./messages/en";

export { LANGS, type Lang };

type Loader = () => Promise<Dict>;

// One chunk per language (webpackChunkName-free: the bundler names them).
const LOADERS: Record<Exclude<Lang, "en">, Loader> = {
  de: () => import("./messages/de").then((m) => m.de),
  es: () => import("./messages/es").then((m) => m.es),
  fr: () => import("./messages/fr").then((m) => m.fr),
  pt: () => import("./messages/pt").then((m) => m.pt),
  it: () => import("./messages/it").then((m) => m.it),
  tr: () => import("./messages/tr").then((m) => m.tr),
  pl: () => import("./messages/pl").then((m) => m.pl),
  nl: () => import("./messages/nl").then((m) => m.nl),
  ru: () => import("./messages/ru").then((m) => m.ru),
  ja: () => import("./messages/ja").then((m) => m.ja),
  ko: () => import("./messages/ko").then((m) => m.ko),
  id: () => import("./messages/id").then((m) => m.id),
  hi: () => import("./messages/hi").then((m) => m.hi),
};

// Loaded dictionaries; English always.
const DICTS: Partial<Record<Lang, Dict>> = { en };
const pending = new Map<Lang, Promise<boolean>>();
const dictListeners = new Set<() => void>();

/** Load a language's messages (once); resolves true when they are there.
 *  A failed load (offline) is retried by the next call. */
export function loadLang(lang: Lang): Promise<boolean> {
  if (DICTS[lang]) return Promise.resolve(true);
  let p = pending.get(lang);
  if (!p) {
    p = LOADERS[lang as Exclude<Lang, "en">]()
      .then((dict) => {
        DICTS[lang] = dict;
        // For tests and debugging: <html data-i18n="en de"> lists the
        // languages whose messages are here.
        if (typeof document !== "undefined") document.documentElement.dataset.i18n = Object.keys(DICTS).join(" ");
        dictListeners.forEach((f) => f());
        return true;
      })
      .catch(() => false)
      .finally(() => pending.delete(lang));
    pending.set(lang, p);
  }
  return p;
}

/** Are this language's messages loaded? */
export function isLangLoaded(lang: Lang): boolean {
  return Boolean(DICTS[lang]);
}

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

function cookieLang(): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=([^;]*)`));
    return m && isLang(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

function readLang(): Lang {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  return detectLang(isLang(stored) ? stored : cookieLang(), browserLanguages());
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
  try {
    document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* ignore */
  }
  // Fetch the messages right away (the switch shows English meanwhile).
  void loadLang(lang);
  document.documentElement.lang = lang;
  window.dispatchEvent(new Event(EVENT));
}

// Start loading the visitor's language as soon as this module runs,
// before any component asks for it.
if (typeof window !== "undefined") void loadLang(readLang());

/** Current language: the stored choice, else the browser's language
 *  (langs.ts detectLang). Server render + hydration are English, the
 *  client switches right after. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, readLang, () => "en");
}

function subscribeDicts(cb: () => void): () => void {
  dictListeners.add(cb);
  return () => {
    dictListeners.delete(cb);
  };
}

/** The language whose messages are shown: `lang` once loaded, English
 *  until then. */
function useShownLang(lang: Lang): Lang {
  const shown = useSyncExternalStore(
    subscribeDicts,
    () => (DICTS[lang] ? lang : "en"),
    () => "en" as Lang,
  );
  useEffect(() => {
    void loadLang(lang);
  }, [lang]);
  return shown;
}

/** `key` in `lang` — English when that language isn't loaded (yet) or
 *  lacks the key. */
export function translate(
  lang: Lang,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  let s = DICTS[lang]?.[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function useT(): TFn {
  const shown = useShownLang(useLang());
  return useCallback<TFn>((key, vars) => translate(shown, key, vars), [shown]);
}

/** Compact language picker (native select: works well on phones). */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const lang = useLang();
  const t = useT();
  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{t("common.language")}</span>
      <span aria-hidden className="pointer-events-none absolute left-2 text-sm">🌐</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        data-testid="language-switcher"
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
