"use client";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import { AccountMenu } from "@/components/auth/AccountMenu";

/** Header of the pricing / account pages — same layout as the library's. */
export function SubpageHeader({ homeHref, title }: { homeHref: string; title: string }) {
  const t = useT();
  return (
    <header
      className="relative z-10 flex items-center justify-between gap-2 px-4 py-4 sm:px-6"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href={homeHref}
          className="flex shrink-0 items-center gap-2 transition-opacity hover:opacity-80"
          aria-label={t("site.header.homeAria")}
        >
          <LogoMark size={24} />
          <span
            className="hidden text-xl font-bold tracking-tight sm:inline"
            style={{ color: "var(--text-strong)" }}
          >
            CleoCuts
          </span>
        </Link>
        <span style={{ color: "var(--text-faint)" }}>/</span>
        <span className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
          {title}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <LanguageSwitcher />
        <AccountMenu />
      </div>
    </header>
  );
}
