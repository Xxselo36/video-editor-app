/**
 * English — the default language and the source of truth for all keys.
 * Split by area so the files stay manageable:
 *   en.site.ts  landing page, library, shared components
 *   en.app.ts   the /app editor flow
 *   en.editor.ts  the v2 editor shell (UX7)
 * Other languages are Partial<> of this; missing keys fall back here.
 */
import { enApp } from "./en.app";
import { enEditor } from "./en.editor";
import { enSite } from "./en.site";

export const en = { ...enSite, ...enApp, ...enEditor };
export type MessageKey = keyof typeof en;
