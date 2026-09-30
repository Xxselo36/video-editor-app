"use client"; // Error boundaries must be Client Components

import Link from "next/link";
import { useEffect } from "react";
import { useT } from "@/i18n";
import { reportError } from "@/components/ErrorReporting";
import {
  PRIMARY_BUTTON,
  PRIMARY_STYLE,
  SECONDARY_BUTTON,
  SECONDARY_STYLE,
  SiteShell,
} from "@/components/site/SiteShell";

/**
 * A page of the site crashed (landing, legal pages, pricing, sign-in):
 * the site header and footer stay, the page offers a retry. The editor
 * has its own boundary (app/app/error.tsx). Errors in the root layout
 * itself fall through to Next's built-in global error page.
 */
export default function SiteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const t = useT();
  useEffect(() => {
    console.error(error);
    reportError(error);
  }, [error]);

  return (
    <SiteShell>
      <h1 className="mb-3 text-3xl font-bold tracking-tight">{t("common.error.title")}</h1>
      <p className="mb-8 text-base" style={{ color: "var(--text-body)" }}>
        {t("common.error.body")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => unstable_retry()} className={PRIMARY_BUTTON} style={PRIMARY_STYLE}>
          {t("common.error.retry")}
        </button>
        <Link href="/" className={SECONDARY_BUTTON} style={SECONDARY_STYLE}>
          {t("common.backHome")}
        </Link>
      </div>
      {error.digest && (
        <p className="mt-8 font-mono text-xs" style={{ color: "var(--text-muted)" }}>
          {t("common.error.ref", { id: error.digest })}
        </p>
      )}
    </SiteShell>
  );
}
