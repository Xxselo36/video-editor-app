/**
 * Einstellungen with accounts (PR3 plan D16): the account's email, plan
 * and minutes, "Account & plan" to /app/account, which counts as
 * Einstellungen in the menu. The auth run's build is v1 by default:
 * ?editor=v2 switches this browser to v2 (and its shell).
 */
import { expect, signedIn, test } from "./support/fixtures";
import { WEB } from "./support/env";

test.describe("accounts on (test auth)", { tag: "@auth" }, () => {
  test("Settings shows the account and leads to Account & plan", async ({ page }, info) => {
    const mobile = Boolean(info.project.use.isMobile);
    const user = await signedIn(page, { plan: "pro" });
    await page.goto("/app/settings?editor=v2");
    const settings = page.getByTestId("settings");
    await expect(settings).toBeVisible({ timeout: 30_000 });
    const account = page.getByTestId("settings-account");
    await expect(account).toHaveText(/Account & plan/);
    await expect(settings).toContainText(user.id);
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
