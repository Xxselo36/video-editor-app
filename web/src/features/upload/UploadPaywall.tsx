"use client";
// The plan dialog of an upload billing refused (402), on whatever /app
// route the user is when the answer comes (uploadManager).
import { PaywallDialog } from "@/components/billing/PaywallDialog";
import { dismissPaywall, usePaywall } from "./uploadState";

export function UploadPaywall() {
  const paywall = usePaywall();
  return paywall ? <PaywallDialog paywall={paywall} onClose={dismissPaywall} /> : null;
}
