/**
 * Shell of the legal pages (imprint, privacy, terms): header with the
 * language switcher, the German and the English text — globals.css shows
 * the one matching <html lang> (German for "de", English otherwise, set
 * before the first paint) — and the legal footer. Server Component: the
 * texts are static HTML, readable without JavaScript (English then).
 */
import Link from "next/link";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher } from "@/i18n";
import { SiteFooter } from "@/components/site/SiteFooter";
import { LEGAL_UPDATED } from "@/lib/legal";
import { LegalLangNote } from "./LegalLangNote";

export function LegalPage({ de, en }: { de: React.ReactNode; en: React.ReactNode }) {
  return (
    <div className="relative z-10 flex min-h-screen flex-col" style={{ color: "var(--text-body)" }}>
      <header
        className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="shrink-0 transition-opacity hover:opacity-80">
          <LogoWord />
        </Link>
        <LanguageSwitcher />
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10 text-sm leading-relaxed">
        <LegalLangNote />
        <article lang="de" data-legal-lang="de">
          {de}
        </article>
        <article lang="en" data-legal-lang="en">
          {en}
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}

/** Page title, subtitle, "Stand" line and — while the text is a draft —
 *  the draft banner. */
export function LegalTitle({
  lang,
  title,
  subtitle,
  draft,
}: {
  lang: "de" | "en";
  title: string;
  subtitle?: string;
  draft?: boolean;
}) {
  return (
    <>
      {draft && (
        <p
          className="mb-5 rounded-xl px-4 py-3 text-sm font-semibold"
          style={{
            background: "rgba(245, 158, 11, 0.12)",
            border: "1px solid rgba(245, 158, 11, 0.45)",
            color: "#fcd34d",
          }}
        >
          {lang === "de" ? "Entwurf – anwaltliche Prüfung ausstehend" : "Draft – pending legal review"}
        </p>
      )}
      <h1 className="mb-2 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>
        {title}
      </h1>
      {subtitle && <p style={{ color: "var(--text-muted)" }}>{subtitle}</p>}
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {lang === "de" ? `Stand: ${LEGAL_UPDATED.de}` : `Last updated: ${LEGAL_UPDATED.en}`}
      </p>
    </>
  );
}

export function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 mt-8 font-semibold" style={{ color: "var(--text-strong)" }}>
      {children}
    </h2>
  );
}

export function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

export function Mail({ address }: { address: string }) {
  return address.includes("@") && !address.startsWith("[") ? (
    <a href={`mailto:${address}`} className="underline underline-offset-2">
      {address}
    </a>
  ) : (
    <>{address}</>
  );
}
