"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useLang, useT, type TFn } from "@/i18n";
import {
  fmtDate,
  fmtMinutes,
  openPortal,
  planName,
  refreshMe,
  useAuthState,
  useBillingConfig,
  useMe,
  type Me,
} from "@/lib/account";
import { track } from "@/lib/analytics";
import { SubpageHeader } from "./SubpageHeader";

/** Subscription status → one line (and whether it needs attention). */
function statusLine(me: Me, t: TFn, lang: string): { text: string; warn: boolean } | null {
  const s = me.subscription;
  if (me.comp) return { text: t("app.account.status.comp"), warn: false };
  if (!s) return null;
  const renews = fmtDate(s.renews_at, lang);
  const ends = fmtDate(s.ends_at, lang);
  switch (s.status) {
    case "active":
      return {
        text: renews ? t("app.account.status.active", { date: renews }) : t("app.account.status.activeNoDate"),
        warn: false,
      };
    case "on_trial":
      return {
        text: renews ? t("app.account.status.trial", { date: renews }) : t("app.account.status.activeNoDate"),
        warn: false,
      };
    case "cancelled":
      return { text: t("app.account.status.cancelled", { date: ends || renews }), warn: true };
    case "past_due":
    case "unpaid":
      return { text: t("app.account.status.pastDue"), warn: true };
    case "paused":
      return { text: t("app.account.status.paused"), warn: true };
    case "expired":
      return { text: t("app.account.status.expired"), warn: true };
    default:
      return { text: s.status, warn: false };
  }
}

/**
 * /app/account — plan, status, minutes used this period, and the ways
 * to Lemon Squeezy (portal) and /pricing. Back from checkout with
 * ?billing=success: wait for the webhook to land (poll /me, ~30 s).
 */
export function AccountView() {
  const t = useT();
  const lang = useLang();
  const auth = useAuthState();
  const { status, me } = useMe();
  const config = useBillingConfig();
  const [banner, setBanner] = useState<"pending" | "done" | "slow" | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState(false);

  // window.location, not useSearchParams: no Suspense boundary needed
  // for the static prerender.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("billing") !== "success") return;
    url.searchParams.delete("billing");
    window.history.replaceState(window.history.state, "", url);
    // Lemon Squeezy sends buyers here only after a completed payment.
    track("checkout_done");
    setBanner("pending");
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const m = await refreshMe();
      if (stopped) return;
      if (m?.plan && m.subscription && !m.comp) {
        setBanner("done");
        return;
      }
      if (++tries >= 15) {
        setBanner("slow");
        return;
      }
      timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const manage = async () => {
    setPortalBusy(true);
    setPortalError(false);
    try {
      await openPortal(); // navigates away
    } catch {
      setPortalError(true);
      setPortalBusy(false);
    }
  };

  const email = auth.email ?? me?.user?.email ?? null;
  const billingOn = Boolean(me?.billing?.enabled);
  const status1 = me ? statusLine(me, t, lang) : null;
  const minutes = me?.minutes ?? null;
  const usedPct = minutes && minutes.limit > 0 ? Math.min(100, (minutes.used / minutes.limit) * 100) : 0;

  return (
    <main className="relative flex min-h-screen flex-col" style={{ color: "var(--text-strong)" }}>
      <SubpageHeader homeHref="/app" title={t("app.account.title")} />

      <div className="phase-fade relative z-10 mx-auto w-full max-w-2xl flex-1 px-5 py-10">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">{t("app.account.title")}</h1>
        {email && (
          <p className="mb-8 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("app.account.signedInAs", { email })}
          </p>
        )}

        {banner && (
          <div
            role="status"
            className="mb-6 rounded-2xl px-4 py-3 text-sm"
            style={{
              background: banner === "slow" ? "var(--surface-2)" : "var(--brand-tint)",
              border: `1px solid ${banner === "slow" ? "var(--border)" : "var(--brand)"}`,
              color: "var(--text-strong)",
            }}
          >
            {banner === "pending"
              ? t("app.account.successPending")
              : banner === "done"
                ? t("app.account.successDone", { plan: planName(me?.plan, config) })
                : t("app.account.successSlow")}
          </div>
        )}

        {!me ? (
          status === "error" ? (
            <p className="text-sm" style={{ color: "var(--text-body)" }}>
              {t("app.account.loadFailed")}
            </p>
          ) : (
            <div className="skeleton h-48 rounded-2xl" />
          )
        ) : !billingOn ? (
          <div
            className="rounded-2xl p-5 text-sm"
            style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-body)" }}
          >
            {t("app.account.freeBeta")}
          </div>
        ) : (
          <div
            className="flex flex-col gap-6 rounded-2xl p-5 sm:p-6"
            style={{
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span
                  className="text-[11px] font-semibold uppercase tracking-[0.15em]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("app.account.plan")}
                </span>
                {me.subscription?.test_mode && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ background: "var(--accent-tint)", color: "var(--accent)" }}
                  >
                    {t("app.account.testMode")}
                  </span>
                )}
              </div>
              <div className="text-2xl font-bold">
                {me.plan ? planName(me.plan, config) : t("app.account.noPlan")}
              </div>
              {status1 && (
                <div
                  className="mt-1 text-sm"
                  style={{ color: status1.warn ? "var(--warn)" : "var(--text-body)" }}
                >
                  {status1.text}
                </div>
              )}
            </div>

            {minutes && (
              <div>
                <div
                  className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {t("app.account.usage")}
                </div>
                <div className="mb-2 text-sm" style={{ color: "var(--text-body)" }}>
                  {t("app.account.usageOf", {
                    used: fmtMinutes(minutes.used, lang),
                    limit: fmtMinutes(minutes.limit, lang),
                  })}
                </div>
                <div
                  className="h-2 w-full overflow-hidden rounded-full"
                  style={{ background: "var(--surface-2)" }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usedPct)}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${usedPct}%`,
                      background: usedPct >= 90 ? "var(--warn)" : "var(--brand)",
                    }}
                  />
                </div>
                {fmtDate(minutes.period_end, lang) && (
                  <div className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                    {t("app.account.resetsOn", { date: fmtDate(minutes.period_end, lang) })}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {me.subscription && (
                <button
                  onClick={() => void manage()}
                  disabled={portalBusy}
                  className="rounded-full px-5 py-2 text-sm font-semibold disabled:opacity-60"
                  style={{ background: "var(--brand)", color: "white" }}
                >
                  {t("app.account.manage")}
                </button>
              )}
              <Link
                href="/pricing"
                className="rounded-full px-5 py-2 text-sm font-semibold"
                style={
                  me.subscription
                    ? {
                        background: "var(--surface-2)",
                        color: "var(--text-strong)",
                        border: "1px solid var(--border-hover)",
                      }
                    : { background: "var(--brand)", color: "white" }
                }
              >
                {me.plan ? t("app.account.changePlan") : t("app.account.choosePlan")}
              </Link>
            </div>
            {portalError && (
              <p className="-mt-3 text-xs" style={{ color: "var(--danger)" }}>
                {t("app.account.portalFailed")}
              </p>
            )}
            {me.subscription && (
              <p className="-mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("app.account.manageHint")}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
