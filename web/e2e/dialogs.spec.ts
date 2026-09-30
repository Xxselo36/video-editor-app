/**
 * Dialogs cover the viewport (scratchpad audit/techtmp/modal.mjs and the
 * overlay probe of audit/stub/verify.mjs). Every /app dialog used to be
 * mispositioned: it rendered inside the animated `.phase-fade` container,
 * whose finished animation left a transform — a containing block for
 * `position: fixed` (tech.md T1). Since UX3 they render through
 * components/ui/Dialog (a portal into <body>, focus trap, Escape).
 */
import { expect, test } from "./support/fixtures";
import { LIBRARY, libEntry, openWithStorage } from "./support/app";
import type { Locator, Page } from "@playwright/test";

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

test("a dialog keeps focus inside, closes on Escape and gives focus back", async ({ page }) => {
  await openWithStorage(page, "/app");
  const teaser = page.getByTestId("voice-teaser");
  await teaser.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("dialog-voice-test");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByRole("dialog", { name: /./ })).toBeVisible();
  // Focus moved in, and Tab cycles without leaving the dialog.
  const inside = () => dialog.evaluate((d) => d.contains(document.activeElement));
  expect(await inside()).toBe(true);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await inside()).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await inside()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(teaser).toBeFocused();
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
