// Moved from app/app/page.tsx (UX4).
import { useLang, useT } from "@/i18n";
import { fmtMinutes, useBillingConfig, useMe } from "@/lib/account";

/** Billing on: minutes left this period (→ account), or — when uploads
 *  need a plan — the way to one (→ pricing). Null otherwise. */
export function useBillingHint(): { href: string; text: string } | null {
  const t = useT();
  const lang = useLang();
  const { me } = useMe();
  const billing = useBillingConfig();
  if (!billing?.enabled || !me?.billing?.enabled) return null;
  if (me.minutes) {
    return {
      href: "/app/account",
      text: t("app.billing.minutesLeft", { n: fmtMinutes(Math.max(0, me.minutes.remaining), lang) }),
    };
  }
  if (!me.plan && me.billing.enforce) return { href: "/pricing", text: t("app.billing.choosePlan") };
  return null;
}
