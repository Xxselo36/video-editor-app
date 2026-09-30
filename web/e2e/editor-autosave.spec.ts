/**
 * Editor autosave (scratchpad bt/e2e.mjs): timeline edits reach the
 * server while editing (debounced POST /edit-segments), survive leaving
 * and re-entering, survive leaving within the debounce (flushOnLeave),
 * and trims can't grow into footage another clip uses. Grid clip: four
 * automatic clips [0,6] [7,14] [15,22] [23,30].
 *
 * The first test runs in preview mode (today's production default:
 * CLEO_PROXY_VIDEO off), the second in proxy mode (saveOutcome path).
 * A doRebuild that doesn't save turns both red.
 */
import { expect, test } from "./support/fixtures";
import {
  ACTIVE_JOBS,
  card,
  clip,
  clips,
  deleteClip,
  editorVideo,
  openFromDashboard,
  openWithStorage,
  playbackMode,
  selectClip,
} from "./support/app";
import type { Page } from "@playwright/test";

const SAVED = { timeout: 20_000 };
// A preview rebuild is real ffmpeg work (cut + VP8): slow on a busy machine.
const REBUILT = { timeout: 60_000 };

async function leave(page: Page) {
  await page.getByTestId("editor-back").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
}

test.describe("editor autosave", () => {
  test("edits are saved while editing, on re-entry and on a quick leave (preview mode)", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "off" });
    const server = async () => (await stub.job(job.id))!;
    await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "test.mp4")] });

    await test.step("session 1: the automatic cut (4 clips), preview mode", async () => {
      await openFromDashboard(page, "test.mp4");
      await expect(clips(page)).toHaveCount(4);
      expect(await playbackMode(page)).toBe("preview");
    });

    await test.step("delete clip 2 and mute clip 1: autosaved, preview rebuilt", async () => {
      await deleteClip(page, 1);
      await selectClip(page, 0);
      await page.getByTestId("clip-volume").focus();
      await page.keyboard.press("Home");
      await expect.poll(() => stub.timeline(job.id), SAVED).toEqual([
        [0, 6],
        [15, 22],
        [23, 30],
      ]);
      await expect.poll(async () => (await server()).edit_segments[0].volume, SAVED).toBe(0);
      await expect
        .poll(async () => {
          const j = await server();
          const edit = j.edit_segments.map((s) => [s.start, s.end]);
          return j.preview_version >= 2 && JSON.stringify(j.preview_segments) === JSON.stringify(edit);
        }, REBUILT)
        .toBe(true);
    });

    await test.step("edit a transcript line, leave", async () => {
      await page.getByTestId("editor-tab-transcript").click();
      await page.getByTestId("transcript-line").first().getByRole("textbox").fill("Satz eins korrigiert.");
      await page.waitForTimeout(1500); // the phrase save's debounce (800 ms)
      await leave(page);
    });

    await test.step("re-entry shows the edit, not the automatic cut", async () => {
      await openFromDashboard(page, "test.mp4");
      await expect(clips(page)).toHaveCount(3);
      await expect(clip(page, 0).getByText("M", { exact: true })).toBeVisible(); // mute badge
      const { preview_version } = await server();
      await expect(editorVideo(page)).toHaveAttribute("src", new RegExp(`\\?v=${preview_version}$`));
      await page.getByTestId("editor-tab-transcript").click();
      await expect(page.getByTestId("transcript-line").first().getByRole("textbox")).toHaveValue(
        "Satz eins korrigiert.",
      );
      await page.getByTestId("editor-tab-timeline").click();
    });

    await test.step("a delete right before leaving (within the 800 ms debounce) survives", async () => {
      await deleteClip(page, 2);
      await leave(page);
      await openFromDashboard(page, "test.mp4");
      await expect(clips(page)).toHaveCount(2);
      expect(await stub.timeline(job.id)).toEqual([
        [0, 6],
        [15, 22],
      ]);
    });

    await test.step("a trim can't grow into the next clip's footage; undo reverts it", async () => {
      // clip 1 = [0,6] (muted), clip 2 = [15,22]: drag clip 1's end far right.
      await selectClip(page, 0);
      const handle = clip(page, 0).getByTestId("clip-trim-end");
      const bb = (await handle.boundingBox())!;
      const y = bb.y + bb.height / 2;
      await page.mouse.move(bb.x + bb.width / 2, y);
      await page.mouse.down();
      for (let i = 1; i <= 20; i++) await page.mouse.move(bb.x + bb.width / 2 + 60 * i, y);
      await page.mouse.up();
      await expect.poll(async () => (await server()).edit_segments[0].end, SAVED).toBeGreaterThan(6);
      expect((await server()).edit_segments[0].end).toBeLessThanOrEqual(15.0001);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await server()).edit_segments[0].end, SAVED).toBeCloseTo(6, 2);
    });
  });

  test("proxy mode: autosave and a quick leave reach the server", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "on" });
    await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "test.mp4")] });
    await openFromDashboard(page, "test.mp4");
    expect(await playbackMode(page)).toBe("proxy");

    await deleteClip(page, 1);
    await expect.poll(() => stub.timeline(job.id), SAVED).toEqual([
      [0, 6],
      [15, 22],
      [23, 30],
    ]);
    // The editor doesn't wait for the preview rebuild in proxy mode.
    await expect(page.getByTestId("timeline-saving")).toBeHidden();

    await deleteClip(page, 0);
    await leave(page);
    await openFromDashboard(page, "test.mp4");
    await expect(clips(page)).toHaveCount(2);
    expect(await stub.timeline(job.id)).toEqual([
      [15, 22],
      [23, 30],
    ]);
  });
});
