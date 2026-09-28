"use client";
/**
 * The only root-level module that imports Clerk. Loaded lazily by
 * AuthProvider, and only when accounts are on — with auth off no Clerk
 * code is downloaded or run.
 *
 * Wraps the app in <ClerkProvider> (localized to the UI language) and
 * mirrors Clerk's state into lib/auth + lib/account, so the rest of the
 * app can read it without touching Clerk (whose hooks throw outside
 * the provider).
 */
import { useEffect, useState } from "react";
import { ClerkFailed, ClerkProvider, useAuth, useClerk, useUser } from "@clerk/nextjs";
import type { LocalizationResource } from "@clerk/nextjs/types";
import { useLang, type Lang } from "@/i18n";
import {
  getAuthState,
  getAuthToken,
  publishAuthState,
  registerTokenGetter,
} from "@/lib/auth";
import { AUTH_REQUIRED_EVENT } from "@/lib/api";
import { adoptLegacyLocalData, clearMe, refreshMe } from "@/lib/account";

// One lazily-loaded chunk per language (English = Clerk's built-in).
const LOADERS: Partial<Record<Lang, () => Promise<LocalizationResource>>> = {
  de: () => import("@clerk/localizations/de-DE").then((m) => m.deDE),
  es: () => import("@clerk/localizations/es-ES").then((m) => m.esES),
  fr: () => import("@clerk/localizations/fr-FR").then((m) => m.frFR),
  pt: () => import("@clerk/localizations/pt-BR").then((m) => m.ptBR),
  it: () => import("@clerk/localizations/it-IT").then((m) => m.itIT),
  tr: () => import("@clerk/localizations/tr-TR").then((m) => m.trTR),
  pl: () => import("@clerk/localizations/pl-PL").then((m) => m.plPL),
  nl: () => import("@clerk/localizations/nl-NL").then((m) => m.nlNL),
  ru: () => import("@clerk/localizations/ru-RU").then((m) => m.ruRU),
  ja: () => import("@clerk/localizations/ja-JP").then((m) => m.jaJP),
  ko: () => import("@clerk/localizations/ko-KR").then((m) => m.koKR),
  id: () => import("@clerk/localizations/id-ID").then((m) => m.idID),
  hi: () => import("@clerk/localizations/hi-IN").then((m) => m.hiIN),
};

function useClerkLocalization(lang: Lang): LocalizationResource | undefined {
  const [loc, setLoc] = useState<{ lang: Lang; res: LocalizationResource } | null>(null);
  useEffect(() => {
    const load = LOADERS[lang];
    if (!load) return;
    let alive = true;
    load()
      .then((res) => {
        if (alive) setLoc({ lang, res });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lang]);
  return loc?.lang === lang ? loc.res : undefined;
}

// Matches the app's dark violet palette (globals.css).
const APPEARANCE = {
  variables: {
    colorPrimary: "#8b5cf6",
    colorBackground: "#131217",
    colorForeground: "#f5f3fa",
    colorMutedForeground: "#8b869a",
    colorInput: "#1b1a22",
    colorInputForeground: "#f5f3fa",
    colorNeutral: "#f5f3fa",
    borderRadius: "0.75rem",
  },
};

function AuthBridge() {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  useEffect(() => {
    registerTokenGetter((opts) => getToken(opts));
    return () => registerTokenGetter(null);
  }, [getToken]);

  useEffect(() => {
    publishAuthState({
      loaded: isLoaded,
      signedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      email,
    });
  }, [isLoaded, isSignedIn, userId, email]);

  // Per-user data: plan/minutes/media token, and the beta's local projects.
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && userId) {
      adoptLegacyLocalData(userId);
      void getAuthToken();
      void refreshMe();
    } else {
      clearMe();
    }
  }, [isLoaded, isSignedIn, userId]);

  // Keep the cached token fresh for saves sent while the page unloads
  // (tokens live ~60 s), and /me (minutes, daily media token) current.
  useEffect(() => {
    if (!isSignedIn) return;
    let lastMe = Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void getAuthToken();
      if (Date.now() - lastMe > 30 * 60_000) {
        lastMe = Date.now();
        void refreshMe();
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void getAuthToken();
      if (Date.now() - lastMe > 5 * 60_000) {
        lastMe = Date.now();
        void refreshMe();
      }
    };
    const id = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isSignedIn]);

  // The backend said 401. Signed out → sign-in modal (keeps the page);
  // signed in → the token was probably stale, fetch a new one.
  useEffect(() => {
    const onAuthRequired = () => {
      if (getAuthState().signedIn) void getAuthToken({ skipCache: true });
      else clerk.openSignIn({});
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, [clerk]);

  return null;
}

function FailedReporter() {
  useEffect(() => {
    publishAuthState({ failed: true });
  }, []);
  return null;
}

export default function ClerkShell({ children }: { children: React.ReactNode }) {
  const localization = useClerkLocalization(useLang());
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
      localization={localization}
      appearance={APPEARANCE}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      // Fallbacks only: a ?redirect_url= (e.g. back to /app?job=…) wins.
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      afterSignOutUrl="/"
    >
      <AuthBridge />
      <ClerkFailed>
        <FailedReporter />
      </ClerkFailed>
      {children}
    </ClerkProvider>
  );
}
