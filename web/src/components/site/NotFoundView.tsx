"use client";
import Link from "next/link";
import { useT } from "@/i18n";
import { PRIMARY_BUTTON, PRIMARY_STYLE, SECONDARY_BUTTON, SECONDARY_STYLE, SiteShell } from "./SiteShell";

/** The branded 404 (app/not-found.tsx): unknown URLs and notFound(). */
export function NotFoundView() {
  const t = useT();
  return (
    <SiteShell>
      <p className="mb-3 font-mono text-sm font-semibold" style={{ color: "var(--brand-strong)" }}>
        404
      </p>
      <h1 className="mb-3 text-3xl font-bold tracking-tight">{t("common.notFound.title")}</h1>
      <p className="mb-8 text-base" style={{ color: "var(--text-body)" }}>
        {t("common.notFound.body")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className={PRIMARY_BUTTON} style={PRIMARY_STYLE}>
          {t("common.backHome")}
        </Link>
        <Link href="/app" className={SECONDARY_BUTTON} style={SECONDARY_STYLE}>
          {t("site.header.openEditor")}
        </Link>
      </div>
    </SiteShell>
  );
}
