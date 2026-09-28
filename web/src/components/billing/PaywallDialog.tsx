"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useLang, useT } from "@/i18n";
import { fmtMinutes, type Paywall } from "@/lib/account";

/** Upload refused with 402: no plan, or not enough minutes left. */
export function PaywallDialog({ paywall, onClose }: { paywall: Paywall; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const quota = paywall.code === "quota_exceeded";
  // Seconds from the backend → minutes, one decimal, rounded so "needs"
  // never reads smaller than it is.
  const min = (s: number, up: boolean) =>
    fmtMinutes((up ? Math.ceil(s / 6) : Math.floor(s / 6)) / 10, lang);
  const body = !quota
    ? t("app.paywall.subscriptionBody")
    : paywall.remainingSeconds !== null && paywall.neededSeconds !== null
      ? t("app.paywall.quotaBody", {
          left: min(Math.max(0, paywall.remainingSeconds), false),
          needed: min(paywall.neededSeconds, true),
        })
      : t("app.paywall.quotaBodyUnknown");

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="paywall-title"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl p-6"
        style={{
          background: "var(--surface-1)",
          border: "1px solid var(--border-hover)",
          boxShadow: "var(--shadow-glow)",
        }}
      >
        <div
          id="paywall-title"
          className="mb-2 text-lg font-bold"
          style={{ color: "var(--text-strong)" }}
        >
          {t(quota ? "app.paywall.quotaTitle" : "app.paywall.subscriptionTitle")}
        </div>
        <p className="mb-6 text-sm leading-relaxed" style={{ color: "var(--text-body)" }}>
          {body}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Link
            href="/pricing"
            className="flex-1 rounded-xl px-4 py-3 text-center text-sm font-semibold"
            style={{ background: "var(--brand)", color: "white" }}
          >
            {t(quota ? "app.paywall.upgrade" : "app.paywall.seePlans")}
          </Link>
          <button
            onClick={onClose}
            className="flex-1 rounded-xl px-4 py-3 text-sm"
            style={{
              background: "var(--surface-2)",
              color: "var(--text-body)",
              border: "1px solid var(--border)",
            }}
          >
            {t("app.paywall.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
