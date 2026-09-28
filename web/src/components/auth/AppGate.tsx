"use client";
import { Fragment, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogoMark } from "@/components/Logo";
import { useT } from "@/i18n";
import { signInHref } from "@/lib/auth";
import { useAuthState } from "@/lib/account";

/**
 * /app/* with accounts on: signed-out visitors are sent to sign-in and
 * come back to the exact URL (so /app?job=… reopens that project).
 * Only mounted when AUTH_ENABLED (see app/app/layout.tsx).
 */
export function AppGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const auth = useAuthState();
  const router = useRouter();
  const needsSignIn = auth.loaded && !auth.signedIn && !auth.failed;

  useEffect(() => {
    if (needsSignIn) router.replace(signInHref(window.location.href));
  }, [needsSignIn, router]);

  // Keyed by user: switching accounts must not keep the last user's
  // editor state around.
  if (auth.signedIn) return <Fragment key={auth.userId ?? ""}>{children}</Fragment>;

  return (
    <main
      className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center"
      style={{ color: "var(--text-strong)" }}
    >
      <LogoMark size={36} />
      {auth.failed ? (
        <>
          <p className="max-w-sm text-sm" style={{ color: "var(--text-body)" }}>
            {t("app.auth.loadFailed")}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-full px-5 py-2 text-sm font-semibold"
            style={{ background: "var(--brand)", color: "white" }}
          >
            {t("app.errors.tryAgain")}
          </button>
        </>
      ) : needsSignIn ? (
        <>
          <p className="max-w-sm text-sm" style={{ color: "var(--text-body)" }}>
            {t("app.auth.signInToContinue")}
          </p>
          <Link
            href={signInHref()}
            className="rounded-full px-5 py-2 text-sm font-semibold"
            style={{ background: "var(--brand)", color: "white" }}
          >
            {t("common.auth.signIn")}
          </Link>
        </>
      ) : (
        <div className="skeleton h-3 w-24" />
      )}
    </main>
  );
}
