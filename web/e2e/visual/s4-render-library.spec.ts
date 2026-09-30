// Render flow and library (audit/stub s4_render_lib.mjs).
import { expect, test } from "../support/fixtures";
import { ACTIVE_JOBS, card, jobCard, LIBRARY, libEntry, openFromDashboard, openWithStorage } from "../support/app";
import { DONE_ENTRY, shot, TIKTOK_CARD as tiktok, VISUAL } from "./shot";

test("empty library, render to done, library grid, video dialog", VISUAL, async ({ page, stub }) => {
  const [review, done, doneLand] = await Promise.all([
    stub.seed("review_speech", { filename: "tiktok_3_mistakes_take2.mp4", render_seconds: 12 }),
    stub.seed("done"),
    stub.seed("done_land"),
  ]);
  await page.goto("/imprint");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/app/library", { waitUntil: "networkidle" });
  await shot(page, "40-library-empty", { settleMs: 800 });

  await openWithStorage(page, "/app", {
    [ACTIVE_JOBS]: [card(review.id, "reviewing", "tiktok_3_mistakes_take2.mp4", tiktok)],
    [LIBRARY]: [
      libEntry(done.id, "tiktok_3_mistakes_final.mp4", 7_200_000, DONE_ENTRY),
      libEntry(doneLand.id, "podcast_ep11_highlight.mp4", 2 * 86_400_000, {
        presetId: "podcast",
        presetLabel: "Podcast Long-Form",
        outputs: ["primary", "16:9", "9:16"],
      }),
      libEntry("00000000dead", "first_test_video.mp4", 20 * 86_400_000),
    ],
  });
  await openFromDashboard(page, "tiktok_3_mistakes_take2.mp4");
  await page.waitForTimeout(2000);
  await page.getByTestId("apply-render").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  const rendering = jobCard(page, "tiktok_3_mistakes_take2.mp4");
  await shot(page, "30-render-started", { settleMs: 2500 });
  await expect(rendering.getByText(/[4-9]\d%/)).toBeVisible({ timeout: 30_000 });
  await shot(page, "31-render-progress-mid");
  await expect.poll(async () => (await stub.job(review.id))!.status, { timeout: 60_000 }).toBe("done");
  await expect(rendering).toHaveCount(0, { timeout: 30_000 });
  await shot(page, "32-render-done-dashboard", { full: true, settleMs: 2000 });

  await page.goto("/app/library", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await shot(page, "41-library-grid-fold");
  await shot(page, "41-library-grid-full", { full: true });
  const hooks = page.getByTestId("library-card").filter({ hasText: "tiktok_3_mistakes_final.mp4" });
  await hooks.scrollIntoViewIfNeeded();
  await shot(page, "42-library-card-hooks-caption");
  await hooks.getByRole("button", { name: /Play preview/ }).click();
  await expect(page.getByTestId("dialog-video")).toBeVisible();
  await shot(page, "43-library-video-modal", { settleMs: 3000 });
});
