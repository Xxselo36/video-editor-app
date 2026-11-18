/**
 * Browsers off the v2 editor (the v1 runs' optin build): no app shell,
 * the page header of before, and the shell's own places lead to /app
 * (PR3 plan D15, D16). Not tagged @editor-v2: the v1 runs execute it.
 */
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { WEB } from "./support/env";

test("no shell: the header of before; Preview and Settings lead to /app", async ({ page }) => {
  await openWithStorage(page, "/app/new");
  await expect(page.getByRole("link", { name: "CleoCuts home" })).toBeVisible();
  await expect(page.getByTestId("app-shell")).toHaveCount(0);
  await expect(page.getByTestId("tabbar")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  for (const path of ["/app/preview", "/app/settings"]) {
    await page.goto(path);
    // To /app, and from there to New video (nothing on this device yet:
    // DashboardPage): the whole way before the next goto. A redirect the
    // page still has going when the next goto starts becomes a full
    // navigation in WebKit (its fetch is refused as the page is left),
    // which cuts that goto off.
    await expect(page, path).toHaveURL(`${WEB}/app/new`);
    await expect(page.getByTestId("picker"), path).toBeVisible();
  }
});
