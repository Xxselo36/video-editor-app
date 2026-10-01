/**
 * A ~30-minute podcast in the Text tab (UX8, PLAN_TECH "UX8 tests", §1.7
 * row 21): the stub's review_long job has 10 000 words. The list is
 * virtualised (only the visible rows are in the DOM), scrolling it from
 * top to bottom keeps ≥ 50 fps in desktop Chromium (frame timing from
 * requestAnimationFrame deltas), and a word far down is still editable.
 * Device fps is checked in UX18.
 */
import { expect, test } from "../support/fixtures";
import { openWithStorage } from "../support/app";

test.describe("editor v2: long transcript", { tag: "@editor-v2" }, () => {
  test("10 000 words: virtualised, scrolls at ≥ 50 fps", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "desktop Chromium frame timing (devices: UX18)");
    const job = await stub.seed("review_long");
    await openWithStorage(page, `/app/edit/${job.id}`, { "cleocuts.editor.tourDone.v1": "1" });
    const list = page.getByTestId("ed-transcript");
    await expect(page.getByTestId("ed-word").first()).toBeVisible({ timeout: 45_000 });
    // only a window of rows is rendered
    expect(await page.getByTestId("transcript-line").count()).toBeLessThan(80);
    expect(await page.getByTestId("ed-word").count()).toBeLessThan(1200);

    const stats = await list.evaluate(
      (box) =>
        new Promise<{ frames: number; ms: number; worst: number; top: number; max: number }>((resolve) => {
          const max = box.scrollHeight - box.clientHeight;
          const deltas: number[] = [];
          let last = 0;
          const t0 = performance.now();
          const step = (now: number) => {
            if (last) deltas.push(now - last);
            last = now;
            box.scrollTop = Math.min(max, box.scrollTop + 160);
            if (box.scrollTop < max - 1 && now - t0 < 20_000) requestAnimationFrame(step);
            else {
              const ms = deltas.reduce((a, b) => a + b, 0);
              resolve({ frames: deltas.length, ms, worst: Math.max(...deltas), top: box.scrollTop, max });
            }
          };
          requestAnimationFrame(step);
        }),
    );
    const fps = (stats.frames / stats.ms) * 1000;
    test.info().annotations.push({ type: "fps", description: `${fps.toFixed(1)} fps over ${stats.frames} frames, worst ${stats.worst.toFixed(1)} ms` });
    expect(stats.max).toBeGreaterThan(20_000); // really long (~830 rows)
    expect(stats.top).toBeGreaterThanOrEqual(stats.max - 1); // reached the end
    expect(fps).toBeGreaterThanOrEqual(50);
    expect(await page.getByTestId("transcript-line").count()).toBeLessThan(80);

    // the last word is there and editable
    const last = page.getByTestId("ed-word").last();
    await last.dblclick();
    await page.getByTestId("ed-word-input").fill("finale");
    await page.getByTestId("ed-word-input").press("Enter");
    await expect.poll(async () => (await stub.doc(job.id)).doc.words.at(-1)?.text, { timeout: 10_000 }).toBe("finale");
  });
});
