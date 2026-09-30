import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/auth";
import { PricingView } from "@/components/billing/PricingView";

export const metadata: Metadata = {
  title: "Pricing",
  description: "CleoCuts plans: minutes of video per month for cuts, captions and 9:16 reframing. Monthly, cancel any time.",
};

// Public. No accounts → no billing → no page (as in the beta).
export default function PricingPage() {
  if (!AUTH_ENABLED) notFound();
  return <PricingView />;
}
