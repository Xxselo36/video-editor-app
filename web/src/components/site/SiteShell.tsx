"use client";
/**
 * Shell of the 404 and error pages: the site header (logo → home,
 * language switcher), a centred message and the legal footer (left out
 * under /app, whose layout adds it).
 */
import Link from "next/link";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import { SiteFooter } from "./SiteFooter";

export function SiteShell({ children, footer = true }: { children: React.ReactNode; footer?: boolean }) {
  const t = useT();
  return (
    <div className="relative z-10 flex min-h-screen flex-col" style={{ color: "var(--text-strong)" }}>
      <header
        className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="shrink-0 transition-opacity hover:opacity-80" aria-label={t("site.header.homeAria")}>
          <LogoWord />
        </Link>
        <LanguageSwitcher />
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-5 py-16 text-center">
        {children}
      </main>
      {footer && <SiteFooter />}
    </div>
  );
}

/** The filled primary action (white on --brand-solid: AA contrast). */
export const PRIMARY_BUTTON =
  "inline-flex items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-transform hover:scale-[1.02]";
export const PRIMARY_STYLE: React.CSSProperties = { background: "var(--brand-solid)", color: "white" };

/** The quiet secondary action. */
export const SECONDARY_BUTTON =
  "inline-flex items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold transition-colors hover:opacity-80";
export const SECONDARY_STYLE: React.CSSProperties = {
  background: "var(--surface-2)",
  color: "var(--text-strong)",
  border: "1px solid var(--border-hover)",
};
