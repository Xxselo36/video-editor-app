/**
 * Projects with accounts on (E2E_MODE=auth): a project deleted while
 * Cleo works on it. Deleted on another device, its row goes here too (the
 * account's list is asked again: one status answer doesn't decide it).
 * The last one deleted on the visit's first screen: the page stays — it
 * says so and shows the empty list — instead of going on to New video as
 * for a visit that starts with nothing.
 */
import { expect, signedIn, test } from "./support/fixtures";
import { API, WEB } from "./support/env";

test.describe("deleting while Cleo works on it, accounts on", { tag: "@auth" }, () => {
  test("deleted on another device: the row goes here too", async ({ page, stub }, info) => {
    // An account of this test alone (the default id is shared by a file's tests).
    const user = await signedIn(page, { plan: "pro", id: `e2e_${info.project.name}_delete_elsewhere` });
    await page.evaluate(() => localStorage.setItem("cleocuts.editor.version.v1", "v2"));
    const gone = await stub.seed("analyzing", { owner: user.id, filename: "anderswo.mp4" });
    await stub.seed("review", { owner: user.id, filename: "bleibt.mp4" });
    await page.goto("/app");
    const row = page.getByTestId("job-card").filter({ hasText: "anderswo" });
    await expect(row).toHaveAttribute("data-state", "processing", { timeout: 30_000 });
    // Another device of the same account deletes it.
    const r = await fetch(`${API}/jobs/${gone.id}`, { method: "DELETE", headers: { "X-Test-User": user.header } });
    expect(r.status).toBe(200);
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("job-card").filter({ hasText: "bleibt" })).toBeVisible();
  });

  test("the last one deleted on the visit's first screen: the page stays and says so", async ({ page, stub }, info) => {
    const user = await signedIn(page, { plan: "pro", id: `e2e_${info.project.name}_delete_last` });
    await page.evaluate(() => localStorage.setItem("cleocuts.editor.version.v1", "v2"));
    await stub.seed("analyzing", { owner: user.id, filename: "einzig.mp4" });
    await page.goto("/app");
    const row = page.getByTestId("job-card").filter({ hasText: "einzig" });
    await expect(row).toHaveAttribute("data-state", "processing", { timeout: 30_000 });
    await row.getByTestId("job-card-delete").click();
    await page.getByTestId("delete-confirm").click();
    await expect(page.getByTestId("projects-empty")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("projects-announce")).toHaveText("“einzig.mp4” deleted");
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(`${WEB}/app`);
  });
});
