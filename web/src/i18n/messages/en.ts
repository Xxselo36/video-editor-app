/**
 * English — the default language and the source of truth for all keys.
 * Split by area so the files stay manageable:
 *   en.site.ts  landing page, library, shared components
 *   en.app.ts   the /app editor flow
 * Other languages are Partial<> of this; missing keys fall back here.
 */
import { enApp } from "./en.app";
import { enSite } from "./en.site";

export const en = { ...enSite, ...enApp };
export type MessageKey = keyof typeof en;
