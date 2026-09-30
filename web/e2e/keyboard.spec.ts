/**
 * Keyboard in the editor (scratchpad audit/techtmp/keys.mjs). The
 * timeline's shortcuts listen on window and only spare inputs and text
 * areas, so Space on a focused button plays the video instead of
 * pressing the button, and Backspace deletes the selected clip while a
 * button has focus (tech.md T4). UX3 scopes the shortcuts and removes the
 * fixme marker.
 */
import { expect, test } from "./support/fixtures";
import { clips, openEditor, selectClip, videoPaused } from "./support/app";
import { SKIP_KNOWN_BUGS } from "./support/fixme";

test("Enter on a focused tab activates it", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openEditor(page, job.id);
  await page.getByTestId("editor-tab-transcript").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("transcript-line").first()).toBeVisible();
});

test.describe("shortcuts don't hijack focused controls", () => {
  test.fixme(SKIP_KNOWN_BUGS, "T4: window-level shortcuts (fixed by UX3)");

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
