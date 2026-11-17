/**
 * Einstellungen with accounts (PR3 plan D16): the account's email, plan
 * and minutes, "Account & plan" to /app/account, which counts as
 * Einstellungen in the menu. The auth run's build is v1 by default:
 * ?editor=v2 switches this browser to v2 (and its shell).
 */
import { expect, signedIn, test } from "./support/fixtures";
import { API, WEB } from "./support/env";

test.describe("accounts on (test auth)", { tag: "@auth" }, () => {
  test("Settings shows the account and leads to Account & plan", async ({ page }, info) => {
    const mobile = Boolean(info.project.use.isMobile);
    const user = await signedIn(page, { plan: "pro" });
    // The account as the server tells it, with billing on (the stub has
    // none): its email, plan and minutes.
    await page.route(`${API}/me`, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      Object.assign(body, {
        user: { ...((body.user as object) ?? {}), id: user.id, email: "creator@example.com" },
        billing: { enabled: true, enforce: true },
        plan: "pro",
        minutes: { limit: 300, used: 42, remaining: 258 },
      });
      return route.fulfill({ response: res, body: JSON.stringify(body) });
    });
    await page.goto("/app/settings?editor=v2");
    const settings = page.getByTestId("settings");
    await expect(settings).toBeVisible({ timeout: 30_000 });
    const account = page.getByTestId("settings-account");
    await expect(account).toHaveText(/Account & plan/);
    const row = page.getByTestId("settings-account-info");
    await expect(row).toContainText("creator@example.com");
    await expect(row).toContainText("Pro · 42 of 300 min used");
    // Billing on: the way to the plans instead of the beta note.
    await expect(settings.getByRole("link", { name: "Pricing" })).toBeVisible();
    await expect(settings).not.toContainText("You're using the CleoCuts beta.");
    // Its avatar menu (sign out: the shell has no header) is big enough
    // to tap.
    await expect.poll(async () => (await settings.getByTestId("mock-sign-out").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await account.click();
    await expect(page).toHaveURL(`${WEB}/app/account`);
    // In the shell: no page header of its own, Settings marked in the menu.
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId(mobile ? "tabbar" : "sidebar").locator('a[href="/app/settings"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toHaveCount(1);
  });
});
