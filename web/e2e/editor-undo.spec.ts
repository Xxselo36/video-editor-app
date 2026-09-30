/**
 * Editor undo (scratchpad bt/p2edit.mjs): the timeline history survives a
 * tab switch, a slider drag is one undo step (server state checked), a
 * deleted transcript line comes back with its undo, and the live caption
 * preview shows the line under the playhead.
 */
import { expect, test } from "./support/fixtures";
import { clips, deleteClip, editorVideo, openEditor, selectClip } from "./support/app";

const SAVED = { timeout: 20_000 };

test.describe("editor undo", () => {
  test("timeline undo survives a tab switch; a slider drag is one undo step", async ({ page, stub }) => {
    const job = await stub.seed("review");
    await openEditor(page, job.id);
    await expect(clips(page)).toHaveCount(4);

    await deleteClip(page, 1);
    await expect(clips(page)).toHaveCount(3);
    await page.getByTestId("editor-tab-transcript").click();
    await page.getByTestId("editor-tab-timeline").click();
    await page.getByTestId("timeline-undo").click();
    await expect(clips(page)).toHaveCount(4);

    await selectClip(page, 0);
    await page.getByTestId("clip-volume").focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowLeft");
    const volume = async () => (await stub.job(job.id))!.edit_segments[0].volume ?? 1;
    await expect.poll(volume, SAVED).toBeLessThan(1);
    await page.getByTestId("timeline-undo").click();
    await expect.poll(volume, SAVED).toBe(1);
    // The twelve slider changes were one step: nothing left to undo.
    await expect(page.getByTestId("timeline-undo")).toBeDisabled();
    await expect(page.getByTestId("timeline-redo")).toBeEnabled();
  });

  test("a deleted transcript line comes back with undo", async ({ page, stub }) => {
    const job = await stub.seed("review");
    await openEditor(page, job.id);
    await page.getByTestId("editor-tab-transcript").click();
    const lines = page.getByTestId("transcript-line");
    await expect(lines).toHaveCount(4);
    await lines.first().getByRole("button", { name: "Delete sentence" }).click();
    await expect(lines).toHaveCount(3);
    await page.getByTestId("transcript-undo").click();
    await expect(lines).toHaveCount(4);
    await expect(lines.first().getByRole("textbox")).toHaveValue("Satz 1 hier.");
  });

  test("the caption preview shows the line under the playhead", async ({ page, stub }) => {
    const job = await stub.seed("review");
    await openEditor(page, job.id);
    await editorVideo(page).evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      v.muted = true;
      if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
      v.currentTime = 1.0;
      await v.play();
    });
    await expect(page.getByTestId("caption-overlay")).toContainText("Satz 1 hier.");
  });
});
