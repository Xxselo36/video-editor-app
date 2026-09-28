import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { AuthScreen } from "@/components/auth/AuthScreen";

export const metadata: Metadata = { title: "Sign up – CleoCuts" };

// Catch-all: Clerk's <SignUp> routes its own steps below /sign-up.
export default function SignUpPage() {
  if (!AUTH_ENABLED) notFound();
  return <AuthScreen mode="sign-up" />;
}
