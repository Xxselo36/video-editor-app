/**
 * Navigation inside /app (scratchpad bt/p2nav.mjs): the editor has its
 * own URL (/app?job=…), a reload reopens it, the back gesture returns to
 * the dashboard (not the landing page), and back from the file screen
 * stays in the app. UX5 replaces ?job= with routes; rewrite then.
 */
import { expect, test } from "./support/fixtures";
import { ACTIVE_JOBS, card, jobCard, openFromDashboard, openWithStorage } from "./support/app";

test("editor URL, reload, back to the dashboard, back from the file screen", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await page.goto("/");
  await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "echt.mp4")] });

  await openFromDashboard(page, "echt.mp4");
  expect(new URL(page.url()).searchParams.get("job")).toBe(job.id);

  await page.reload();
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });

  await page.goBack();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/app");
  expect(new URL(page.url()).searchParams.has("job")).toBe(false);
  await expect(jobCard(page, "echt.mp4")).toBeVisible();

  // New video → workflow card → the file chooser (cancelled) → the file screen.
  await page.getByTestId("dashboard-new-video").click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 5000 }),
    page.getByTestId("picker-card-tiktok").click(),
  ]);
  expect(chooser).toBeTruthy();
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId("upload-dropzone")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/app");
});
