"use client";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { useInShell } from "@/components/shell/useShell";

/** Header of the pricing / account pages — same layout as the library's.
 *  None in the app shell (the account page there): the menu is the way
 *  back. */
export function SubpageHeader({ homeHref, title }: { homeHref: string; title: string }) {
  const t = useT();
  const shell = useInShell();
  if (shell) return null;
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
