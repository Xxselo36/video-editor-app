/**
 * Projects with accounts on (E2E_MODE=auth): a project deleted while
 * Cleo works on it. Deleted on another device, its row goes here too (the
 * account's list is asked again: one status answer doesn't decide it) —
 * also on the device that uploaded it, where it is in this device's own
 * list as well: gone, not an "expired" row. Until then a status answer
 * (it has no file name) keeps the name the account's list gave. The last
 * one deleted on the visit's first screen: the page stays — it says so
 * and shows the empty list — instead of going on to New video as for a
 * visit that starts with nothing.
 */
import type { Page } from "@playwright/test";
import { expect, signedIn, test, type TestUser } from "./support/fixtures";
import { JOBS, job } from "./support/app";
import { API, WEB } from "./support/env";

/** Counts the status answers the page gets (the poll of running jobs). */
function countPolls(page: Page): () => number {
  let n = 0;
  page.on("response", (r) => {
    // 304: answered, nothing new since the last one.
    if (r.url().startsWith(`${API}/jobs/status`) && (r.ok() || r.status() === 304)) n += 1;
  });
  return () => n;
}

/** Another device of the same account deletes the job. */
async function deleteElsewhere(user: TestUser, id: string): Promise<void> {
  const r = await fetch(`${API}/jobs/${id}`, { method: "DELETE", headers: { "X-Test-User": user.header } });
  expect(r.status).toBe(200);
}

test.describe("deleting while Cleo works on it, accounts on", { tag: "@auth" }, () => {
  test("deleted on another device: the row goes here too", async ({ page, stub }, info) => {
    // An account of this test alone (the default id is shared by a file's tests).
    const user = await signedIn(page, { plan: "pro", id: `e2e_${info.project.name}_delete_elsewhere` });
    await page.evaluate(() => localStorage.setItem("cleocuts.editor.version.v1", "v2"));
    const gone = await stub.seed("analyzing", { owner: user.id, filename: "anderswo.mp4" });
    await stub.seed("review", { owner: user.id, filename: "bleibt.mp4" });
    const polls = countPolls(page);
    await page.goto("/app");
    const rows = page.getByTestId("job-card");
    const row = rows.filter({ hasText: "anderswo" });
    await expect(row).toHaveAttribute("data-state", "processing", { timeout: 30_000 });
    // Two status answers: the first one is applied by the time the second
    // is asked. It has no file name; the row keeps its own.
    await expect.poll(polls, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await expect(row).toHaveAttribute("data-state", "processing");
    await expect(rows).toHaveCount(2);
    await deleteElsewhere(user, gone.id);
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: "bleibt" })).toBeVisible();
  });

  test("deleted on another device: gone from the device that uploaded it too, not expired", async ({ page, stub }, info) => {
    const user = await signedIn(page, { plan: "pro", id: `e2e_${info.project.name}_delete_uploader` });
    await page.evaluate(() => localStorage.setItem("cleocuts.editor.version.v1", "v2"));
    const gone = await stub.seed("analyzing", { owner: user.id, filename: "hochgeladen.mp4" });
    await stub.seed("review", { owner: user.id, filename: "bleibt.mp4" });
    // This device uploaded it: it is in this device's own list as well.
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`${JOBS}:${user.id}`, JSON.stringify([job(gone.id, "hochgeladen.mp4")])]);
    await page.goto("/app");
    const rows = page.getByTestId("job-card");
    await expect(rows.filter({ hasText: "hochgeladen" })).toHaveAttribute("data-state", "processing", { timeout: 30_000 });
    await expect(rows).toHaveCount(2);
    await deleteElsewhere(user, gone.id);
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("projects-expired")).toHaveCount(0);
    // Off this device's list: a reload doesn't bring it back either.
    await page.reload();
    await expect(rows.filter({ hasText: "bleibt" })).toBeVisible({ timeout: 30_000 });
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId("projects-expired")).toHaveCount(0);
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
