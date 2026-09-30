import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthScreen } from "@/components/auth/AuthScreen";

// Not a search result. The root title template adds " · CleoCuts".
export const metadata: Metadata = { title: "Sign up", robots: { index: false, follow: false } };

// Catch-all: Clerk's <SignUp> routes its own steps below /sign-up.
export default function SignUpPage() {
  if (!AUTH_ENABLED) notFound();
  return <AuthScreen mode="sign-up" />;
}
