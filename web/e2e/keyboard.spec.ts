/**
 * Keyboard in the editor (scratchpad audit/techtmp/keys.mjs). The
 * timeline's shortcuts used to listen on window and only spare inputs and
 * text areas, so Space on a focused button played the video instead of
 * pressing the button, and Backspace deleted the selected clip while a
 * button had focus (tech.md T4). Since UX3 they leave focused controls
 * alone and work on every editor tab.
 */
import { expect, test } from "./support/fixtures";
import { clips, openEditor, selectClip, videoPaused } from "./support/app";

test("Enter on a focused tab activates it", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openEditor(page, job.id);
  await page.getByTestId("editor-tab-transcript").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("transcript-line").first()).toBeVisible();
});

test.describe("shortcuts don't hijack focused controls", () => {
  test("Space on a focused tab activates the tab and doesn't play", async ({ page, stub }) => {
    const job = await stub.seed("review");
    await openEditor(page, job.id);
    await page.getByTestId("editor-tab-transcript").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("transcript-line").first()).toBeVisible();
    expect(await videoPaused(page)).toBe(true);
  });

  test("Backspace on a focused button doesn't delete the selected clip", async ({ page, stub }) => {
    const job = await stub.seed("review");
    await openEditor(page, job.id);
    await selectClip(page, 0);
    await page.getByTestId("timeline-split").focus();
    await page.keyboard.press("Backspace");
    await expect(clips(page)).toHaveCount(4);
  });
});

test("Space plays and pauses on the Transcript tab too", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openEditor(page, job.id);
  await page.getByTestId("editor-tab-transcript").click();
  await expect(page.getByTestId("transcript-line").first()).toBeVisible();
  // Focus back on the page (nothing focused), as after a click on the video area.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Space");
  await expect.poll(() => videoPaused(page)).toBe(false);
  await page.keyboard.press("Space");
  await expect.poll(() => videoPaused(page)).toBe(true);
});
