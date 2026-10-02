/**
 * Projects with accounts on (UX12 re-review, E2E_MODE=auth): the account's
 * list couldn't be loaded (a 5xx) — no redirect to the start screen as if
 * there were no projects; the page says so with Try again, which loads
 * the (really empty) list and goes on to /app/new.
 */
import { expect, signedIn, test } from "./support/fixtures";
import { API, WEB } from "./support/env";

test.describe("projects list errors", { tag: "@auth" }, () => {
  test("a failed list shows a retry, not the start screen", async ({ page }) => {
    await signedIn(page, { plan: "pro" });
    await page.evaluate(() => localStorage.setItem("cleocuts.editor.version.v1", "v2"));
    const isList = (u: URL) => u.href.startsWith(`${API}/jobs?`) && u.searchParams.get("fields") === "summary";
    await page.route(isList, (r) =>
      r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "unavailable" }) }),
    );
    await page.goto("/app");
    await expect(page.getByTestId("projects-load-failed")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(`${WEB}/app`);
    await expect(page.getByTestId("projects-empty")).toHaveCount(0);

    await page.unroute(isList);
    await page.getByTestId("projects-retry").click();
    await expect(page).toHaveURL(`${WEB}/app/new`, { timeout: 30_000 });
  });
});
