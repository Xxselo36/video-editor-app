import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata: Metadata = { title: "Sign in – CleoCuts" };

// Catch-all: Clerk's <SignIn> routes its own steps below /sign-in.
export default function SignInPage() {
  if (!AUTH_ENABLED) notFound();
  return <AuthScreen mode="sign-in" />;
}
