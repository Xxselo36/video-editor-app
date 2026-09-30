// The app outside the editor: picker, upload, analysis, dashboard states
// (audit/stub s2_app.mjs).
import { expect, test } from "../support/fixtures";
import { ACTIVE_JOBS, card, jobCard, LIBRARY, libEntry, openWithStorage } from "../support/app";
import { DONE_ENTRY, shot, TIKTOK_CARD as tiktok, VISUAL } from "./shot";

test("first visit, voice test, file screen, configure", VISUAL, async ({ page, stub }) => {
  const speech = await stub.media("speech.mp4");
  await page.goto("/imprint");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/app", { waitUntil: "networkidle" });
  await shot(page, "10-app-first-visit-picker", { full: true });

  await page.getByTestId("voice-teaser").click();
  await expect(page.getByTestId("dialog-voice-test")).toBeVisible();
  await shot(page, "11-modal-voice-test", { settleMs: 1000 });
  await page.getByTestId("dialog-voice-test").getByTestId("dialog-close").click();

  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("picker-card-tiktok").click()]);
  expect(chooser).toBeTruthy(); // cancelled: the fallback file screen stays
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();
  await shot(page, "12-idle-upload-dropzone-tiktok");

  await page.goto("/app", { waitUntil: "networkidle" });
  const [custom] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("picker-card-custom").click()]);
  await custom.setFiles({ name: "new_upload.mp4", mimeType: "video/mp4", buffer: speech });
  await expect(page.getByTestId("configure-process")).toBeVisible();
  await shot(page, "13-configure-custom-fold", { settleMs: 1500 });
  await shot(page, "13-configure-custom-full", { full: true });
});

test("upload progress, analysis stages, ready for review", VISUAL, async ({ page, stub, browserName }) => {
  test.skip(browserName !== "chromium", "network throttling via CDP (Chromium only)");
  const speech = await stub.media("speech.mp4");
  await stub.config({ by_filename: { "my_tiktok_take3.mp4": { analysis_seconds: 25 } } });
  await openWithStorage(page, "/app");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 4e6,
    uploadThroughput: 22_000,
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("picker-card-tiktok").click()]);
  await chooser.setFiles({ name: "my_tiktok_take3.mp4", mimeType: "video/mp4", buffer: speech });
  const upload = jobCard(page, "my_tiktok_take3.mp4");
  await page.waitForTimeout(7000);
  await shot(page, "14-upload-progress-card");
  await page.waitForTimeout(9000);
  await shot(page, "14-upload-progress-card-later", { full: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await expect(upload).toHaveAttribute("data-phase", "analyzing", { timeout: 60_000 });
  await page.waitForTimeout(3000);
  await shot(page, "15-analyzing-card-early");
  await page.waitForTimeout(8000);
  await shot(page, "15-analyzing-card-mid", { full: true });
  await expect(upload).toHaveAttribute("data-phase", "reviewing", { timeout: 60_000 });
  await shot(page, "16-ready-for-review-card", { full: true, settleMs: 1500 });
});

test("dashboard with every card state, recent projects, video dialog", VISUAL, async ({ page, stub }) => {
  const [analyzing, queued, rendering, review, failed, error, done, doneLand] = await Promise.all([
    stub.seed("analyzing"),
    stub.seed("queued"),
    stub.seed("rendering"),
    stub.seed("review_speech"),
    stub.seed("render_failed"),
    stub.seed("error"),
    stub.seed("done"),
    stub.seed("done_land"),
  ]);
  await openWithStorage(page, "/app", {
    [ACTIVE_JOBS]: [
      card(analyzing.id, "analyzing", "day_in_berlin_vlog.mp4", { ...tiktok, presetId: "vlog", presetLabel: "Vlog Cleanup", ageMs: 120_000 }),
      card(queued.id, "analyzing", "q_and_a_livestream.mp4", { ...tiktok, presetId: "podcast", presetLabel: "Podcast Long-Form", ageMs: 60_000 }),
      card(rendering.id, "rendering", "product_demo_v2.mp4", { ...tiktok, ageMs: 900_000 }),
      card(review.id, "reviewing", "tiktok_3_mistakes.mp4", { ...tiktok, ageMs: 600_000 }),
      card(failed.id, "reviewing", "interview_cut_final.mp4", { ...tiktok, ageMs: 5_400_000 }),
      card(error.id, "analyzing", "screen_recording_no_mic.mov", { ...tiktok, ageMs: 300_000 }),
      card("0000deadbeef", "analyzing", "old_project_from_last_week.mp4", { ...tiktok, ageMs: 7 * 86_400_000 }),
    ],
    [LIBRARY]: [
      libEntry(done.id, "tiktok_3_mistakes_final.mp4", 7_200_000, DONE_ENTRY),
      libEntry(doneLand.id, "podcast_ep11_highlight.mp4", 2 * 86_400_000, {
        presetId: "podcast",
        presetLabel: "Podcast Long-Form",
        presetIcon: "🎙",
        outputs: ["primary", "16:9", "9:16"],
      }),
      libEntry("00000000dead", "first_test_video.mp4", 20 * 86_400_000),
    ],
  });
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.waitForTimeout(5000);
  await shot(page, "17-dashboard-all-states-fold");
  await shot(page, "17-dashboard-all-states-full", { full: true });

  await page.getByTestId("dashboard-new-video").click();
  await shot(page, "18-picker-from-dashboard", { full: true, settleMs: 800 });
  await page.getByTestId("picker-back").click();

  await page.getByTestId("recent-project").filter({ hasText: "tiktok_3_mistakes_final.mp4" }).click();
  await expect(page.getByTestId("dialog-video")).toBeVisible();
  await shot(page, "19-modal-recent-video-player", { settleMs: 3000 });
});
