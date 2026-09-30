// Accounts on (audit/stub s6_auth.mjs; E2E_MODE=auth: test auth replaces
// the fake Clerk key the audit used). /billing/config is simulated with
// the draft prices of docs/plan/ROADMAP.md.
import { expect, signedIn, test } from "../support/fixtures";
import { hideDevIndicator, shot, VISUAL } from "./shot";

const PLANS = {
  enabled: true,
  enforce: true,
  test_mode: true,
  plans: [
    { id: "starter", name: "Starter", minutes: 90, retention_days: 14, price_formatted: "€9.00", price: 900, currency: "EUR", interval: "month", available: true },
    { id: "pro", name: "Pro", minutes: 300, retention_days: 30, price_formatted: "€24.00", price: 2400, currency: "EUR", interval: "month", available: true },
    { id: "studio", name: "Studio", minutes: 900, retention_days: 90, price_formatted: "€59.00", price: 5900, currency: "EUR", interval: "month", available: true },
  ],
};

test("accounts on: landing, pricing, sign-in, gate, account, terms", { tag: ["@auth", ...VISUAL.tag] }, async ({ page }) => {
  await hideDevIndicator(page);
  await page.context().route("**/billing/config", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PLANS) }),
  );
  const go = async (path: string) => {
    await page.goto(path, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle");
  };
  await page.goto("/imprint");
  await page.evaluate(() => localStorage.clear());
  await go("/");
  await shot(page, "60-auth-landing-fold", { settleMs: 1000 });
  await go("/pricing");
  await shot(page, "61-auth-pricing-full", { full: true, settleMs: 1000 });
  await go("/sign-in");
  await expect(page.getByTestId("mock-sign-in")).toBeVisible();
  await shot(page, "62-auth-sign-in");
  await go("/sign-up");
  await shot(page, "63-auth-sign-up");
  await go("/app");
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 30_000 });
  await shot(page, "64-auth-app-gate");
  await signedIn(page, { plan: "pro" });
  await go("/app/account");
  await shot(page, "65-auth-account", { settleMs: 1500 });
  await go("/terms");
  await shot(page, "66-auth-terms-full", { full: true });
});
