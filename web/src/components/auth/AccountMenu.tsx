"use client";
/**
 * Header pieces for accounts + billing. They import no Clerk code (the
 * avatar menu is its own lazy chunk) and render nothing with auth off,
 * so the headers look exactly like before.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useT } from "@/i18n";
import { AUTH_ENABLED, signInHref } from "@/lib/auth";
import { useAuthState, useBillingEnabled } from "@/lib/account";

function AvatarPlaceholder() {
  return (
    <span
      aria-hidden
      className="inline-block h-7 w-7 shrink-0 rounded-full"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
    />
  );
}

const ClerkUserButton = dynamic(() => import("./ClerkUserButton"), {
  ssr: false,
  loading: () => <AvatarPlaceholder />,
});

/**
 * Signed in: "Account" link (hidden on phones) + avatar menu.
 * Signed out: "Sign in" — back to this page afterwards, or to the
 * editor (Clerk's fallback) when `returnHere` is false.
 */
export function AccountMenu({ returnHere = true }: { returnHere?: boolean }) {
  const t = useT();
  const auth = useAuthState();
  if (!AUTH_ENABLED || auth.failed) return null;
  if (!auth.loaded) return <AvatarPlaceholder />;
  if (!auth.signedIn) {
    return (
      <Link
        href={returnHere ? signInHref() : "/sign-in"}
        className="whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-opacity hover:opacity-80"
        style={{
          background: "var(--surface-2)",
          color: "var(--text-strong)",
          border: "1px solid var(--border-hover)",
        }}
      >
        {t("common.auth.signIn")}
      </Link>
    );
  }
  return (
    <>
      <Link
        href="/app/account"
        className="hidden text-xs transition-colors hover:opacity-70 sm:inline"
        style={{ color: "var(--text-body)" }}
      >
        {t("common.auth.account")}
      </Link>
      <ClerkUserButton accountLabel={t("common.auth.account")} />
    </>
  );
}

/** "Pricing" — only once the backend reports billing as enabled. */
export function PricingLink({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  const t = useT();
  const on = useBillingEnabled();
  if (!on) return null;
  return (
    <Link
      href="/pricing"
      className={`text-xs transition-colors hover:opacity-70 ${className}`}
      style={{ color: "var(--text-body)", ...style }}
    >
      {t("common.auth.pricing")}
    </Link>
  );
}
