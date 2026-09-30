import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthScreen } from "@/components/auth/AuthScreen";

// Not a search result. The root title template adds " · CleoCuts".
export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

// Catch-all: Clerk's <SignIn> routes its own steps below /sign-in.
export default function SignInPage() {
  if (!AUTH_ENABLED) notFound();
  return <AuthScreen mode="sign-in" />;
}
