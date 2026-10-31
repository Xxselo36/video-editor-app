// The limits line under "Video wählen" (MP4 · MOV · WebM · …): a line
// break never comes before a "·", so a wrapped line never starts with one
// (Hindi at 320 px did). Every language keeps each "·" with the word
// before it (a no-break space).
import { describe, expect, it } from "vitest";
import { deApp } from "@/i18n/messages/de/app";
import { enApp } from "@/i18n/messages/en/app";
import { esApp } from "@/i18n/messages/es/app";
import { frApp } from "@/i18n/messages/fr/app";
import { hiApp } from "@/i18n/messages/hi/app";
import { idApp } from "@/i18n/messages/id/app";
import { itApp } from "@/i18n/messages/it/app";
import { jaApp } from "@/i18n/messages/ja/app";
import { koApp } from "@/i18n/messages/ko/app";
import { nlApp } from "@/i18n/messages/nl/app";
import { plApp } from "@/i18n/messages/pl/app";
import { ptApp } from "@/i18n/messages/pt/app";
import { ruApp } from "@/i18n/messages/ru/app";
import { trApp } from "@/i18n/messages/tr/app";

const APPS: Record<string, Partial<Record<keyof typeof enApp, string>>> = {
  de: deApp,
  en: enApp,
  es: esApp,
  fr: frApp,
  hi: hiApp,
  id: idApp,
  it: itApp,
  ja: jaApp,
  ko: koApp,
  nl: nlApp,
  pl: plApp,
  pt: ptApp,
  ru: ruApp,
  tr: trApp,
};

describe("the limits line", () => {
  for (const [lang, app] of Object.entries(APPS)) {
    it(`${lang}: no line break before a "·"`, () => {
      for (const key of ["app.start.limits", "app.start.limitsNoLength"] as const) {
        const v = app[key];
        expect(v, key).toBeTruthy();
        expect(v!.includes("·"), key).toBe(true);
        // Only a no-break space (or nothing) before each "·".
        expect(v!.match(/[^\S ]·/g), `${key}: ${v}`).toBeNull();
      }
    });
  }
});
