// The editor (audit/stub s3_editor.mjs).
import { expect, test } from "../support/fixtures";
import {
  ACTIVE_JOBS,
  card,
  clip,
  editorVideo,
  openFromDashboard,
  openWithStorage,
  selectClip,
  setRange,
} from "../support/app";
import { shot, TIKTOK_CARD as tiktok, VISUAL } from "./shot";

test("editor: player, timeline, effects, split, transcript, captions, landscape", VISUAL, async ({ page, stub }) => {
  const review = await stub.seed("review_speech");
  const land = await stub.seed("review_land");
  await openWithStorage(page, "/app", {
    [ACTIVE_JOBS]: [
      card(review.id, "reviewing", "tiktok_3_mistakes.mp4", tiktok),
      card(land.id, "reviewing", "podcast_ep12_clip.mp4", {
        presetId: "podcast",
        presetLabel: "Podcast Long-Form",
        captionPreset: "clean",
      }),
    ],
  });
  const openJob = async (name: string) => {
    await openFromDashboard(page, name);
    await expect
      .poll(() => editorVideo(page).evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1500);
  };

  await openJob("tiktok_3_mistakes.mp4");
  await shot(page, "20-editor-initial-fold");
  await shot(page, "20-editor-initial-full", { full: true });

  await editorVideo(page).evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    v.muted = true;
    await v.play().catch(() => {});
  });
  await page.waitForTimeout(3000);
  await editorVideo(page).evaluate((v) => (v as HTMLVideoElement).pause());
  await shot(page, "21-editor-playing-caption-preview", { settleMs: 500 });

  for (let i = 0; i < 4; i++) await page.getByTestId("timeline-zoom-in").click();
  await page.getByTestId("timeline-zoom-in").scrollIntoViewIfNeeded();
  await shot(page, "22-editor-timeline-zoomed-in", { settleMs: 500 });
  await page.getByTestId("timeline-zoom-fit").click();

  await selectClip(page, 1);
  await shot(page, "23-editor-clip-selected", { settleMs: 700 });
  await shot(page, "23-editor-clip-selected-full", { full: true });

  await page.getByTestId("clip-speed").selectOption("1.5");
  await setRange(page.getByTestId("clip-volume"), 0.7);
  await setRange(page.getByTestId("clip-fade-in"), 0.5);
  await shot(page, "24-editor-effects-speed-volume-fade", { full: true, settleMs: 2500 });

  await clip(page, 0).click();
  await editorVideo(page).evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    v.currentTime = v.currentTime + 1;
  });
  await page.getByTestId("timeline-split").click();
  await page.getByTestId("timeline-split").scrollIntoViewIfNeeded();
  await shot(page, "25-editor-after-split", { settleMs: 1200 });

  await page.getByTestId("editor-tab-transcript").click();
  await shot(page, "26-editor-transcript-tab", { settleMs: 600 });
  await shot(page, "26-editor-transcript-tab-full", { full: true });
  const line = page.getByTestId("transcript-line").nth(2).getByRole("textbox");
  await line.scrollIntoViewIfNeeded();
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (edited)");
  await shot(page, "27-editor-caption-text-edit", { settleMs: 800 });

  await page.getByTestId("editor-tab-style").click();
  await shot(page, "28-editor-captions-tab", { settleMs: 800 });

  await page.getByTestId("editor-back").click();
  await openJob("podcast_ep12_clip.mp4");
  await shot(page, "29-editor-landscape-podcast-audio-warning", { full: true });
});
