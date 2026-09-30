"use client";
/**
 * Slim legal footer: imprint, privacy policy and terms one click away
 * from every page (§ 5 DDG: the imprint must always be reachable; the
 * privacy information where videos — personal data — are uploaded).
 * On /app (via app/app/layout.tsx), the library, sign-in / sign-up,
 * pricing, the legal pages and the 404 / error pages. The landing has
 * its own, larger footer with the same links.
 */
import Link from "next/link";
import { useT } from "@/i18n";
import { COPYRIGHT } from "@/lib/legal";

export function SiteFooter({ className = "" }: { className?: string }) {
  const t = useT();
  return (
    <footer
      className={`relative z-10 px-4 py-5 text-xs sm:px-6 ${className}`}
      style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}
    >
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 sm:flex-row sm:justify-between">
        <nav aria-label={t("common.footer.legalAria")}>
          <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <li>
              <Link href="/imprint" className="underline-offset-2 hover:underline">
                {t("site.footer.imprint")}
              </Link>
            </li>
            <li>
              <Link href="/privacy" className="underline-offset-2 hover:underline">
                {t("site.footer.privacy")}
              </Link>
            </li>
            <li>
              <Link href="/terms" className="underline-offset-2 hover:underline">
                {t("site.footer.terms")}
              </Link>
            </li>
          </ul>
        </nav>
        <p>{COPYRIGHT}</p>
      </div>
    </footer>
  );
}
