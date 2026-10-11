/**
 * English — the default language and the source of truth for all keys,
 * split by where the strings are used:
 *   site.ts    landing page, library, legal notes, shared components
 *   app.ts     the /app screens outside the editor
 *   editor.ts  the editor
 *   mail.ts    emails
 * English is bundled with every page (the fallback); the other languages
 * are loaded on first use (i18n/index.tsx). They are Partial<> of this;
 * missing keys fall back here.
 */
import { enApp } from "./app";
import { enEditor } from "./editor";
import { enMail } from "./mail";
import type { enLanding } from "./landing";
import { enSite } from "./site";

/** Bundled with every page. The landing page's strings (landing.ts) are
 *  not: the landing registers them (i18n registerEnglish). */
export const en = { ...enSite, ...enApp, ...enEditor, ...enMail };
export type LandingKey = keyof typeof enLanding;
export type MessageKey = keyof typeof en | LandingKey;
export type SiteKey = keyof typeof enSite;
export type AppKey = keyof typeof enApp;
export type EditorKey = keyof typeof enEditor;
export type MailKey = keyof typeof enMail;
/** A language's messages (the other languages: every key, landing.ts
 *  included, CI-checked). */
export type Dict = Partial<Record<MessageKey, string>>;
