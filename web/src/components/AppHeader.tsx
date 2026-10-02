"use client";
// The /app header (moved from app/app/page.tsx in UX4).
import Link from "next/link";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import { LogoMark } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import { planName, useBillingConfig, useMe } from "@/lib/account";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";

export function AppHeader() {
  const t = useT();
  // Accounts + billing (all null / off with auth off).
  const { me } = useMe();
  const billing = useBillingConfig();
  const planBadge = billing?.enabled && me?.plan ? planName(me.plan, billing) : null;
  // v2 opt-in (UX12): the Projects page replaces the library.
  const projects = useProjectsV2() === true;

  return (
    <header
      className="flex flex-wrap items-center justify-between gap-y-2 px-6 py-4"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
          aria-label={t("app.header.homeAria")}
        >
          <LogoMark size={24} />
          <span className="text-xl font-bold tracking-tight">CleoCuts</span>
        </Link>
      </div>
      <div className="flex items-center gap-3 sm:gap-4">
        <PricingLink className="hidden sm:inline" />
        <Link
          href={projects ? "/app" : "/app/library"}
          className="text-xs transition-colors hover:opacity-70"
          style={{ color: "var(--text-body)" }}
        >
          {t(projects ? "app.header.projects" : "app.header.library")}
        </Link>
        <LanguageSwitcher />
        {planBadge ? (
          // Paid plans live: the "Beta" badge becomes the plan badge.
          <Link
            href="/app/account"
            className="hidden rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest sm:inline-block"
            style={{
              background: "var(--brand-tint)",
              color: "var(--brand-strong)",
            }}
          >
            {planBadge}
          </Link>
        ) : (
          <span
            className="hidden rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest sm:inline-block"
            style={{
              background: "var(--brand-tint)",
              color: "var(--brand-strong)",
            }}
          >
            {t("app.header.beta")}
          </span>
        )}
        <AccountMenu />
      </div>
    </header>
  );
}
