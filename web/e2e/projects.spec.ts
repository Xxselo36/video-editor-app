/**
 * Projects / library (scratchpad bt/p4lib.mjs): a live project shows its
 * expiry countdown, a project the server no longer has shows "expired",
 * long languages don't overflow on a phone, and deleting a project
 * removes it on the server too. UX12 turns /app/library into /app.
 */
import { expect, test } from "./support/fixtures";
import { horizontalOverflow, LIBRARY, libEntry, openWithStorage } from "./support/app";

test("expiry countdown, expired projects, delete on the server", async ({ page, stub }, info) => {
  const done = await stub.seed("done");
  await openWithStorage(page, "/app/library", {
    [LIBRARY]: [libEntry(done.id, "live.mp4"), libEntry("000000000000", "old.mp4", 3_600_000)],
  });
  const live = page.getByTestId("library-card").filter({ hasText: "live.mp4" });
  const old = page.getByTestId("library-card").filter({ hasText: "old.mp4" });
  await expect(live.getByTestId("library-card-expiry")).toHaveText("Auto-deletes in 14 days");
  await expect(old.getByTestId("library-card-expiry")).toHaveText("Expired — files were deleted");
  await expect(live.getByTestId("library-download").first()).toBeVisible();
  await expect(old.getByTestId("library-download")).toHaveCount(0);

  if (info.project.use.isMobile) {
    for (const lang of ["de", "hi", "ja"]) {
      await page.getByTestId("language-switcher").first().selectOption(lang);
      await expect.poll(() => horizontalOverflow(page), { message: `library ${lang}` }).toBeLessThanOrEqual(1);
    }
    await page.getByTestId("language-switcher").first().selectOption("en");
  }

  page.once("dialog", (d) => void d.accept());
  await live.getByRole("button", { name: "Delete project" }).click();
  await expect(live).toHaveCount(0);
  await expect.poll(() => stub.job(done.id)).toBeNull();
});
