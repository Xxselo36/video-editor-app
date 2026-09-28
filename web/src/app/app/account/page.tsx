import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { AccountView } from "@/components/billing/AccountView";

export const metadata: Metadata = { title: "Account – CleoCuts" };

// Behind the /app sign-in gate (app/app/layout.tsx).
export default function AccountPage() {
  if (!AUTH_ENABLED) notFound();
  return <AccountView />;
}
