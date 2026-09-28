import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { PricingView } from "@/components/billing/PricingView";

export const metadata: Metadata = { title: "Pricing – CleoCuts" };

// Public. No accounts → no billing → no page (as in the beta).
export default function PricingPage() {
  if (!AUTH_ENABLED) notFound();
  return <PricingView />;
}
