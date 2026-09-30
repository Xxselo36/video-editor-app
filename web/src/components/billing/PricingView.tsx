"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconCheck } from "@/components/Icons";
import { useLang, useT } from "@/i18n";
import { signUpHref } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import {
  fmtMinutes,
  loadBillingConfig,
  openPortal,
  PLAN_ORDER,
  startCheckout,
  useAuthState,
  useBillingConfig,
  useBillingLoadFailed,
  useMe,
  type BillingPlan,
  type PlanId,
} from "@/lib/account";
import { SubpageHeader } from "./SubpageHeader";

const FORMATS = "9:16, 1:1, 16:9";

/**
 * /pricing — plans and prices come from GET /billing/config (never
 * hard-coded). Signed out: sign up first, then back here to continue
 * (?checkout=<plan>). Signed in: Lemon Squeezy checkout; already
 * subscribed → the customer portal, where plans are switched.
 */
export function PricingView() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const config = useBillingConfig();
  const loadFailed = useBillingLoadFailed();
  const auth = useAuthState();
  const { status: meStatus, me } = useMe();
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A plan subscribed via Lemon Squeezy (comp accounts have a plan but
  // usually no subscription behind it and may still buy one; if they do
  // have one — or a paused / unpaid one — the backend answers 409 and
  // startCheckout opens the portal instead).
  const subscribedPlan = me?.subscription && me.plan && !me.comp ? me.plan : null;

  const choose = async (p: BillingPlan) => {
    if (!auth.signedIn) {
      // Come back here after sign-up and continue with this plan.
      router.push(signUpHref(`${window.location.origin}/pricing?checkout=${p.id}`));
      return;
    }
    setBusy(p.id);
    setError(null);
    try {
      if (subscribedPlan) await openPortal();
      else await startCheckout(p.id, auth.email);
      // Navigating away — leave the button in its busy state.
    } catch (e) {
      setError(
        t(
          e instanceof ApiError && e.code === "test_mode_testers_only"
            ? "site.pricing.testersOnly"
            : subscribedPlan
              ? "app.account.portalFailed"
              : "site.pricing.checkoutFailed",
        ),
      );
      setBusy(null);
    }
  };

  // Back from sign-up with ?checkout=<plan>: continue straight to it.
  const autoRef = useRef(false);
  useEffect(() => {
    if (autoRef.current || !auth.signedIn || !config || meStatus !== "ready") return;
    const url = new URL(window.location.href);
    const want = url.searchParams.get("checkout");
    if (!want) return;
    autoRef.current = true;
    url.searchParams.delete("checkout");
    window.history.replaceState(window.history.state, "", url);
    const plan = config.plans.find((p) => p.id === want && p.available);
    if (plan && config.enabled && !subscribedPlan) void choose(plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.signedIn, config, meStatus]);

  const plans = config
    ? [...config.plans].sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id))
    : [];

  return (
    <main className="relative flex min-h-screen flex-col" style={{ color: "var(--text-strong)" }}>
      <SubpageHeader homeHref="/" title={t("common.auth.pricing")} />

      <div className="phase-fade relative z-10 mx-auto w-full max-w-5xl flex-1 px-5 py-12">
        <h1 className="mb-3 text-4xl font-bold tracking-tight sm:text-5xl">{t("site.pricing.title")}</h1>
        <p className="mb-10 max-w-xl text-base" style={{ color: "var(--text-body)" }}>
          {t("site.pricing.subtitle")}
        </p>

        {config === null ? (
          loadFailed ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm" style={{ color: "var(--text-body)" }}>
                {t("site.pricing.loadFailed")}
              </p>
              <button
                onClick={() => void loadBillingConfig()}
                className="rounded-full px-5 py-2 text-sm font-semibold"
                style={{ background: "var(--brand-solid)", color: "white" }}
              >
                {t("app.errors.tryAgain")}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-80 rounded-2xl" />
              ))}
            </div>
          )
        ) : !config.enabled || plans.length === 0 ? (
          <div
            className="max-w-xl rounded-2xl p-6"
            style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
          >
            <div className="mb-2 text-lg font-bold">{t("site.pricing.betaTitle")}</div>
            <p className="mb-5 text-sm" style={{ color: "var(--text-body)" }}>
              {t("site.pricing.betaBody")}
            </p>
            <Link
              href="/app"
              className="inline-flex rounded-full px-5 py-2 text-sm font-semibold"
              style={{ background: "var(--brand-solid)", color: "white" }}
            >
              {t("site.header.openEditor")}
            </Link>
          </div>
        ) : (
          <>
            {config.test_mode && (
              <div
                className="mb-4 inline-flex rounded-full px-3 py-1 text-[11px] font-semibold"
                style={{ background: "var(--accent-tint)", color: "var(--accent)" }}
              >
                {t("site.pricing.testMode")}
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {plans.map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  popular={p.id === "pro"}
                  current={subscribedPlan === p.id || (!subscribedPlan && me?.plan === p.id)}
                  subscribed={Boolean(subscribedPlan)}
                  busy={busy === p.id}
                  disabled={busy !== null}
                  onChoose={() => void choose(p)}
                  lang={lang}
                />
              ))}
            </div>
            {error && (
              <p className="mt-4 text-sm" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}
            <div className="mt-8 flex max-w-2xl flex-col gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
              <p>{t("site.pricing.minutesHint")}</p>
              <p>{t("site.pricing.vatNote")}</p>
            </div>
          </>
        )}
      </div>

      <footer
        className="relative z-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 px-6 py-6 text-xs"
        style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}
      >
        <Link href="/imprint" className="hover:opacity-70">{t("site.footer.imprint")}</Link>
        <Link href="/privacy" className="hover:opacity-70">{t("site.footer.privacy")}</Link>
        <Link href="/terms" className="hover:opacity-70">{t("site.footer.terms")}</Link>
      </footer>
    </main>
  );
}

function PlanCard({
  plan,
  popular,
  current,
  subscribed,
  busy,
  disabled,
  onChoose,
  lang,
}: {
  plan: BillingPlan;
  popular: boolean;
  current: boolean;
  subscribed: boolean;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
  lang: string;
}) {
  const t = useT();
  const per =
    plan.interval === "year" ? t("site.pricing.perYear") : plan.interval ? t("site.pricing.perMonth") : "";
  const features = [
    t("site.pricing.minutes", { minutes: fmtMinutes(plan.minutes, lang) }),
    t("site.pricing.retention", { days: plan.retention_days }),
    t("site.pricing.featureWorkflows"),
    t("site.pricing.featureVoice"),
    t("site.pricing.featureFormats", { formats: FORMATS }),
  ];
  const label = !plan.available
    ? t("site.pricing.unavailable")
    : busy
      ? t("site.pricing.redirecting")
      : current
        ? subscribed
          ? t("site.pricing.manage")
          : t("site.pricing.current")
        : subscribed
          ? t("site.pricing.switch", { plan: plan.name })
          : t("site.pricing.choose", { plan: plan.name });
  const highlighted = popular || current;

  return (
    <div
      className="relative flex flex-col rounded-2xl p-6"
      style={{
        background: "var(--surface-1)",
        border: `1px solid ${highlighted ? "var(--brand)" : "var(--border)"}`,
        boxShadow: highlighted ? "var(--shadow-glow)" : "var(--shadow-sm)",
      }}
    >
      {(current || popular) && (
        <span
          className="absolute -top-3 left-6 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: "var(--brand-solid)", color: "white" }}
        >
          {current ? t("site.pricing.current") : t("site.pricing.popular")}
        </span>
      )}
      <div className="mb-1 text-lg font-bold">{plan.name}</div>
      <div className="mb-5 flex items-baseline gap-1.5">
        {plan.price_formatted ? (
          <>
            <span className="text-3xl font-bold tracking-tight">{plan.price_formatted}</span>
            <span className="text-sm" style={{ color: "var(--text-muted)" }}>
              {per}
            </span>
          </>
        ) : (
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>
            {t("site.pricing.priceAtCheckout")}
          </span>
        )}
      </div>
      <ul className="mb-6 flex flex-1 flex-col gap-2 text-sm" style={{ color: "var(--text-body)" }}>
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0" style={{ color: "var(--brand)" }}>
              <IconCheck size={14} strokeWidth={2.5} />
            </span>
            {f}
          </li>
        ))}
      </ul>
      <button
        onClick={onChoose}
        disabled={!plan.available || disabled || (current && !subscribed)}
        className="w-full rounded-xl px-4 py-3 text-sm font-semibold transition-transform hover:scale-[1.01] disabled:opacity-60 disabled:hover:scale-100"
        style={
          highlighted
            ? { background: "var(--brand-solid)", color: "white" }
            : {
                background: "var(--surface-2)",
                color: "var(--text-strong)",
                border: "1px solid var(--border-hover)",
              }
        }
      >
        {label}
      </button>
    </div>
  );
}
