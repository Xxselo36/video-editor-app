// Refusals, the paywall, a failing autosave and the app in other
// languages (audit/stub s5_errors_i18n.mjs, s5b.mjs).
import { expect, test } from "../support/fixtures";
import { ACTIVE_JOBS, card, jobCard, openFromDashboard, openWithStorage, selectClip } from "../support/app";
import { shot, TIKTOK_CARD as tiktok, VISUAL } from "./shot";
import type { Page } from "@playwright/test";

async function upload(page: Page, name: string, buffer: Buffer) {
  if (await page.getByTestId("dashboard-new-video").isVisible()) await page.getByTestId("dashboard-new-video").click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("picker-card-tiktok").click()]);
  await chooser.setFiles({ name, mimeType: name.endsWith(".webm") ? "video/webm" : "video/mp4", buffer });
}

const refuse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ status, contentType: "application/json", body: JSON.stringify(body), headers });

test("upload refusals and the paywall", VISUAL, async ({ page, stub }) => {
  const [long, speech] = await Promise.all([stub.media("long.webm"), stub.media("speech.mp4")]);
  await openWithStorage(page, "/app");
  await upload(page, "full_livestream_recording.webm", long);
  await expect(jobCard(page, "full_livestream_recording.webm").getByTestId("job-card-remove")).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "50-error-upload-video-too-long");

  await page.route("**/uploads/multipart/init", (r) => r.fulfill(refuse(413, { detail: "file_too_large", max_gb: 4 })));
  await upload(page, "raw_4k_footage.mp4", speech);
  await expect(jobCard(page, "raw_4k_footage.mp4").getByTestId("job-card-remove")).toBeVisible({ timeout: 20_000 });
  await shot(page, "51-error-upload-file-too-large", { full: true });
  await page.unroute("**/uploads/multipart/init");

  for (const [name, detail] of [
    ["52-modal-paywall-subscription-required", { code: "subscription_required" }],
    ["53-modal-paywall-quota-exceeded", { code: "quota_exceeded", remaining_seconds: 120, needed_seconds: 640 }],
  ] as const) {
    await openWithStorage(page, "/app");
    await page.route("**/uploads/multipart/init", (r) => r.fulfill(refuse(402, { detail })));
    await upload(page, "new_upload.mp4", speech);
    await expect(page.getByTestId("dialog-paywall")).toBeVisible();
    await shot(page, name);
    await page.unroute("**/uploads/multipart/init");
  }

  await openWithStorage(page, "/app");
  await page.route("**/uploads/multipart/init", (r) =>
    r.fulfill(refuse(503, { detail: "server_busy" }, { "Retry-After": "60" })),
  );
  await upload(page, "new_upload.mp4", speech);
  await expect(jobCard(page, "new_upload.mp4").getByTestId("job-card-remove")).toBeVisible({ timeout: 20_000 });
  await shot(page, "54-error-server-busy");
});

test("failing autosave, the app in German and Russian", VISUAL, async ({ page, stub }) => {
  const review = await stub.seed("review_speech");
  await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(review.id, "reviewing", "tiktok_3_mistakes.mp4", tiktok)] });
  await page.route("**/edit-segments", (r) =>
    r.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"server_busy"}' }),
  );
  await openFromDashboard(page, "tiktok_3_mistakes.mp4");
  await selectClip(page, 2);
  await page.getByTestId("clip-delete").click();
  await expect(page.getByTestId("timeline-save-error")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("timeline-scroll").scrollIntoViewIfNeeded();
  await shot(page, "55-editor-autosave-failing");
  await page.unroute("**/edit-segments");
  await page.getByTestId("timeline-undo").click();
  await expect(page.getByTestId("timeline-save-error")).toBeHidden({ timeout: 20_000 });

  await page.getByTestId("editor-back").click();
  await page.getByTestId("language-switcher").first().selectOption("de");
  await shot(page, "56-app-dashboard-de", { settleMs: 800 });
  await openFromDashboard(page, "tiktok_3_mistakes.mp4");
  await shot(page, "57-editor-de-full", { full: true, settleMs: 2000 });
  await page.getByTestId("language-switcher").first().selectOption("ru");
  await shot(page, "58-editor-ru", { settleMs: 800 });
  await page.getByTestId("language-switcher").first().selectOption("en");
});
