/**
 * Dialogs cover the viewport (scratchpad audit/techtmp/modal.mjs and the
 * overlay probe of audit/stub/verify.mjs). Today every /app dialog is
 * mispositioned: it renders inside the animated `.phase-fade` container,
 * whose finished animation leaves a transform — a containing block for
 * `position: fixed` (tech.md T1). UX3 moves dialogs into a portal and
 * removes the fixme marker.
 */
import { expect, test } from "./support/fixtures";
import { LIBRARY, libEntry, openWithStorage } from "./support/app";
import { SKIP_KNOWN_BUGS } from "./support/fixme";
import type { Locator, Page } from "@playwright/test";

test.fixme(SKIP_KNOWN_BUGS, "T1: dialogs render inside .phase-fade (fixed by UX3)");

async function expectCoversViewport(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const vp = page.viewportSize()!;
  expect({ x: box.x, y: box.y, width: box.width, height: box.height }).toEqual({
    x: 0,
    y: 0,
    width: vp.width,
    height: vp.height,
  });
}

test("the video dialog covers the viewport", async ({ page, stub }) => {
  const done = await stub.seed("done");
  await openWithStorage(page, "/app", { [LIBRARY]: [libEntry(done.id, "fertig.mp4")] });
  await page.getByTestId("recent-project").first().click();
  await expectCoversViewport(page, page.getByTestId("dialog-video"));
});

test("the voice-test dialog covers the viewport", async ({ page }) => {
  await openWithStorage(page, "/app");
  await page.getByTestId("voice-teaser").click();
  await expectCoversViewport(page, page.getByTestId("dialog-voice-test"));
});

test("the paywall dialog covers the viewport", async ({ page }) => {
  await openWithStorage(page, "/app");
  await page.route("**/uploads/multipart/init", (r) =>
    r.fulfill({
      status: 402,
      contentType: "application/json",
      body: JSON.stringify({ detail: { code: "subscription_required" } }),
    }),
  );
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByTestId("picker-card-tiktok").click(),
  ]);
  await chooser.setFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(50_000, 1) });
  await expectCoversViewport(page, page.getByTestId("dialog-paywall"));
});
