"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import { useAuthState } from "@/lib/account";

const ClerkAuthForm = dynamic(() => import("./ClerkAuthForm"), {
  ssr: false,
  loading: () => <div className="skeleton h-[420px] w-full max-w-[400px] rounded-2xl" />,
});

/** Page shell around Clerk's <SignIn>/<SignUp> (sign-in / sign-up routes). */
export function AuthScreen({ mode }: { mode: "sign-in" | "sign-up" }) {
  const t = useT();
  const auth = useAuthState();
  return (
    <main className="relative z-10 flex min-h-screen flex-col" style={{ color: "var(--text-strong)" }}>
      <header
        className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="shrink-0 transition-opacity hover:opacity-80" aria-label={t("site.header.homeAria")}>
          <LogoWord />
        </Link>
        <LanguageSwitcher />
      </header>
      <div className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center">
        {auth.failed ? (
          <p className="max-w-sm text-center text-sm" style={{ color: "var(--text-body)" }}>
            {t("app.auth.loadFailed")}
          </p>
        ) : (
          <ClerkAuthForm mode={mode} />
        )}
      </div>
    </main>
  );
}
