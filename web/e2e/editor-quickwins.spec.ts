/**
 * Editor quick wins (UX3, editor.md §8): the timeline opens at Fit, a
 * click on a clip seeks to the clicked point, Split says why it can't
 * split, and a chip on the video shows the time in the edit. Grid clip:
 * four clips [0,6] [7,14] [15,22] [23,30] (27 s of edit).
 */
import { expect, test } from "./support/fixtures";
import { clip, clips, openEditor, userSeek, videoTime, waitForMetadata } from "./support/app";

test("the timeline opens showing the whole edit", async ({ page, stub }) => {
  const job = await stub.seed("review");
  await openEditor(page, job.id);
  await expect(page.getByTestId("timeline-zoom-fit")).toBeDisabled();
  await expect(page.getByTestId("timeline-zoom-out")).toBeDisabled();
  await expect(page.getByTestId("timeline-zoom-in")).toBeEnabled();
  await expect(page.getByTestId("editor-cut-time")).toContainText("/ 0:27.0");
});

test("a click on a clip seeks there; Split explains when it can't split", async ({ page, stub }) => {
  const job = await stub.seed("review", { proxy: "on" });
  await openEditor(page, job.id);
  await waitForMetadata(page);

  const c = clip(page, 1);
  await c.scrollIntoViewIfNeeded();
  const box = (await c.boundingBox())!;
  await c.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
  // [7,14] at 75 % → 12.25 s of the source (the proxy's own timeline).
  await expect.poll(() => videoTime(page)).toBeGreaterThan(11.7);
  expect(await videoTime(page)).toBeLessThan(12.8);
  await expect(page.getByTestId("timeline-split")).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("timeline-split").click();
  await expect(clips(page)).toHaveCount(5);

  // At a clip's first frame there is nothing to split.
  await userSeek(page, 0);
  await expect(page.getByTestId("timeline-split")).toHaveAttribute("aria-disabled", "true");
  // aria-disabled (Playwright waits for "enabled"): a click still works.
  await page.getByTestId("timeline-split").click({ force: true });
  await expect(page.getByTestId("timeline-split-note")).toBeVisible();
  await expect(page.getByTestId("timeline-split-note")).not.toBeEmpty();
  await expect(clips(page)).toHaveCount(5);
});
