// Types of the helpers vitest re-exports from app/app/page.tsx (see
// vitest.config.ts). Keep in sync with page.tsx until UX4 moves them.
declare module "virtual:page-internals" {
  import type { TFn } from "@/i18n";

  export type Subtitle = {
    start: number;
    end: number;
    text: string;
    original_start?: number;
    original_end?: number;
    confidence?: number;
  };

  export type Phrase = {
    start: number;
    end: number;
    original_start: number;
    original_end: number;
    text: string;
    confidence: number;
  };

  export function buildPhrases(subs: Subtitle[]): Phrase[];
  export function friendlyError(raw: unknown, t: TFn): string;
  export function jobErrorText(
    s: { error?: string | null; message?: string | null; error_code?: string | null; refunded?: boolean | null },
    t: TFn,
  ): string;
  export function localizeKnown(text: string, t: TFn): string;
  export function matchTemplate(tpl: string, text: string): Record<string, string> | null;
}
