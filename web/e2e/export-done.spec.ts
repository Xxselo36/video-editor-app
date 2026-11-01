/**
 * UX11: export, Done view, re-edit, instant export (PLAN_TECH §UX11
 * "export-done.spec.ts"). UX11's screens belong to the v2 editor opt-in
 * (useEditorV2).
 *
 * Flag-off build: the v1 export flow is unchanged — the v1 Done screen,
 * Apply & render back to the dashboard (also when a speculative render
 * makes the export instant on the server).
 *
 * Editor-v2 build (@editor-v2): the Vorschau of a finished project (PR2,
 * plan D11, D21) — one download per distinct file (the main one, the
 * others in "More for this video"), SRT / VTT, the post text saved, Save
 * video on an iPhone (Download on Android), the survey from the 2nd
 * export — Fine-tune → export again with the previous export
 * downloadable meanwhile; Export stays in the editor (cost, localized
 * stage, Done view, Save / Share on a phone); failures; the instant
 * export.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { ACTIVE_JOBS, card, openWithStorage } from "./support/app";
import { API, WEB } from "./support/env";
import { fakeShareSheet, IPHONE_UA, openVorschau, sharedFiles, TOUR_DONE, vorschau } from "./support/vorschau";

const V2 = { tag: "@editor-v2" };

/** When the fetch a tap started is done, the browser still counts that
 *  tap (true: a quick fetch) or no longer (false: a slow one), whatever
 *  the machine's load (navigator.userActivation). */
async function tapStillActive(page: Page, isActive: boolean) {
  await page.addInitScript((active) => {
    Object.defineProperty(navigator, "userActivation", { value: { isActive: active, hasBeenActive: true }, configurable: true });
  }, isActive);
}

/** One share and no second one a moment later. */
async function sharedOnce(page: Page, name: string) {
  await expect.poll(() => sharedFiles(page)).toEqual([name]);
  await page.waitForTimeout(1000);
  expect(await sharedFiles(page)).toEqual([name]);
}

type Downloads = { downloads: { format: string; bytes: number | null }[] };

async function jobJson(page: Page, id: string): Promise<Record<string, unknown> & Downloads> {
  const r = await page.request.get(`${API}/jobs/${id}`);
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function openV2(page: Page, jobId: string) {
  await openWithStorage(page, `/app/edit/${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
}

test.describe("v1 export flow unchanged (flag off)", () => {
  test("a finished project shows the v1 Done screen, no re-edit", async ({ page, stub }) => {
    const job = await stub.seed("done");
    await openWithStorage(page, `/app/p/${job.id}`);
    await expect(page.getByTestId("project")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(page.getByText("Ready to post")).toBeVisible();
    await expect(page.getByRole("link", { name: /Download primary/ })).toBeVisible();
    await expect(page.getByTestId("done-view")).toHaveCount(0);
    await expect(page.getByTestId("done-edit-again")).toHaveCount(0);
  });

  test("Apply & render goes back to the dashboard and renders as before", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { spec: "ready" });
    await openWithStorage(page, "/app", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "instant.mp4")] });
    await page.goto(`/app/edit/${job.id}`);
    await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("reedit-banner")).toHaveCount(0);
    await page.getByTestId("apply-render").click();
    await expect(page.getByTestId("dashboard")).toBeVisible();
    // A v1 export (no "client": "v2") never takes the speculative render:
    // it renders, exactly as before UX11.
    await expect.poll(async () => (await stub.job(job.id))!.status, { timeout: 30_000 }).toBe("done");
    const j = (await stub.job(job.id))!;
    expect(j.spec_status).toBe("stale");
    expect(j.renders_ok).toBe(1);
  });
});

test.describe("the Vorschau of a finished video (editor v2)", V2, () => {
  test("Download, More for this video (SRT / VTT, post text, bonus clips), Fine-tune → export again", async ({ page, stub }) => {
    const job = await stub.seed("done", { render_seconds: 3 });
    await openWithStorage(page, `/app/p/${job.id}`, TOUR_DONE);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-video", "export");

    // One download per distinct file: the main one under the video, the
    // others with the bonus clips in "More for this video", folded.
    const { downloads } = await jobJson(page, job.id);
    await expect(page.getByTestId("done-download")).toHaveCount(downloads.length);
    const main = page.getByTestId("done-download").first();
    await expect(main).toHaveText("Download");
    expect(await main.getAttribute("href")).toContain(`/jobs/${job.id}/download?format=primary`);
    const more = page.getByTestId("preview-more");
    await expect(more).toHaveText("More for this video");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("done-post")).toBeHidden();
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("done-hooks")).toBeVisible();

    // The export's captions as files, in output time.
    const srt = await page.request.get((await page.getByTestId("done-srt").getAttribute("href"))!);
    expect(srt.ok()).toBeTruthy();
    expect(await srt.text()).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> /);
    expect(srt.headers()["content-disposition"]).toContain("_cleocuts.srt");
    const vtt = await page.request.get((await page.getByTestId("done-vtt").getAttribute("href"))!);
    expect(await vtt.text()).toMatch(/^WEBVTT\n\n\d\d:\d\d:\d\d\.\d{3} --> /);

    // The post text: edited, saved on blur.
    const post = page.getByTestId("done-post");
    await expect(post).toHaveValue(/3 mistakes/);
    await post.fill("Mein eigener Text #ux11");
    await post.blur();
    await expect(page.getByTestId("done-post-state")).toHaveText("Saved");
    await expect.poll(async () => (await stub.job(job.id))!.social_caption_edited).toBe("Mein eigener Text #ux11");
    await expect(page.getByTestId("done-tip")).toBeVisible();

    // Fine-tune → reopened (POST /reopen), the editor with the re-edit note.
    await page.getByTestId("preview-refine").click();
    await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
    await expect(page.getByTestId("ed-reedit")).toBeVisible({ timeout: 45_000 });
    const before = (await stub.job(job.id))!;
    expect(before.status).toBe("awaiting_review");
    expect(before.renders_ok).toBe(1);

    await page.getByTestId("ed-export").click();
    await page.getByTestId("export-confirm").click();
    const sheet = page.getByTestId("export-sheet");
    await expect(sheet).toHaveAttribute("data-phase", /saving|rendering/);
    // The previous export stays downloadable while the new one renders.
    const old = await page.request.get(`${API}/jobs/${job.id}/download`, { maxRedirects: 0 });
    expect([200, 307]).toContain(old.status());
    await expect(sheet).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
    const after = (await stub.job(job.id))!;
    expect(after.renders_ok).toBe(2);
    expect(after.output_keys.primary).not.toBe(before.output_keys.primary);
    await expect(sheet.getByTestId("done-post")).toHaveValue("Mein eigener Text #ux11");
  });

  test("the survey asks from the 2nd export on, once", async ({ page, stub }) => {
    const a = await stub.seed("done");
    const b = await stub.seed("done");
    await openWithStorage(page, `/app/p/${a.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(page.getByTestId("done-survey")).toHaveCount(0);
    await page.goto(`/app/p/${b.id}`);
    await expect(page.getByTestId("done-survey")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("done-survey-yes").click();
    await page.getByRole("textbox", { name: "What did you change? (optional)" }).fill("music");
    await page.getByTestId("done-survey-send").click();
    await expect(page.getByTestId("done-survey")).toContainText("Thanks");
    // Answered: not again this week.
    await page.goto(`/app/p/${a.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(page.getByTestId("done-survey")).toHaveCount(0);
  });

  test.describe("on an iPhone", () => {
    test.use({ userAgent: IPHONE_UA });
    test("Save video: the first tap fetches the file, the share sheet gets it from that tap", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await fakeShareSheet(page);
      await tapStillActive(page, true);
      const job = await stub.seed("done");
      await openWithStorage(page, `/app/p/${job.id}`);
      const save = page.getByTestId("done-share");
      await expect(save).toHaveText(/Save video/, { timeout: 30_000 });
      // Exported before this visit: nothing fetched until the tap (D21).
      await expect(save).toHaveAttribute("data-state", "idle");
      await save.click();
      // Fetched, and shared from that one tap.
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await sharedOnce(page, "tiktok_3_mistakes_final_cleocuts_9x16.mp4");
    });

    test("Save video after a slow fetch: nothing shared without a tap, the next tap shares it", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await fakeShareSheet(page);
      await tapStillActive(page, false);
      const job = await stub.seed("done");
      await openWithStorage(page, `/app/p/${job.id}`);
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "idle", { timeout: 30_000 });
      await save.click();
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      await page.waitForTimeout(1000);
      expect(await sharedFiles(page)).toEqual([]);
      await save.click();
      await sharedOnce(page, "tiktok_3_mistakes_final_cleocuts_9x16.mp4");
    });

    test("Save video of an export finished during the visit: fetched ahead, the first tap shares it", async ({ page, stub }, info) => {
      test.skip(info.project.name !== "pixel7", "phones only");
      await fakeShareSheet(page);
      const job = await stub.seed("review_speech", { render_seconds: 1 });
      let fetched = 0;
      page.on("request", (r) => {
        if (r.url().startsWith(`${API}/jobs/${job.id}/download`)) fetched++;
      });
      await openVorschau(page, job.id);
      await page.getByTestId("preview-finish").click();
      await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
      // Finished while the page was open: fetched before any tap (D21).
      const save = page.getByTestId("done-share");
      await expect(save).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
      const ahead = fetched;
      expect(ahead).toBeGreaterThan(0);
      expect(await sharedFiles(page)).toEqual([]);
      // Shared inside the tap itself, the file fetched ahead.
      await save.click();
      await sharedOnce(page, "tiktok_3_mistakes_cleocuts_9x16.mp4");
      expect(fetched).toBe(ahead);
    });
  });

  test("Android: Download, no share sheet", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "phones only");
    // The browser could share the file: Android still downloads it (D21).
    await fakeShareSheet(page);
    const job = await stub.seed("done");
    await openWithStorage(page, `/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    const main = page.getByTestId("done-download").first();
    await expect(main).toHaveText("Download");
    await expect(page.getByTestId("done-share")).toHaveCount(0);
    const [file] = await Promise.all([page.waitForEvent("download"), main.click()]);
    expect(file.suggestedFilename()).toBe("tiktok_3_mistakes_final_cleocuts_9x16.mp4");
    expect(await sharedFiles(page)).toEqual([]);
  });
});

test.describe("export sheet (editor v2)", V2, () => {
  test("Export stays in the editor: cost, stage, Done view, Edit again", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 4 });
    await openV2(page, job.id);
    await page.getByTestId("ed-export").click();
    const sheet = page.getByTestId("export-sheet");
    await expect(sheet).toHaveAttribute("data-phase", "confirm");
    await expect(page.getByTestId("export-cost")).toHaveText("Free"); // billing off: no counter
    await expect(page.getByTestId("export-summary")).toContainText(/\d:\d\d/);
    await page.getByTestId("export-confirm").click();
    await expect(page.getByTestId("export-stage")).toContainText(/Saving|Starting|Preparing|Exporting|Finishing/, {
      timeout: 20_000,
    });
    expect(new URL(page.url()).pathname).toBe(`/app/edit/${job.id}`);
    await expect(sheet).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
    await expect(sheet.getByTestId("done-download").first()).toBeVisible();
    expect((await stub.job(job.id))!.renders_ok).toBe(1);

    await sheet.getByTestId("done-edit-again").click();
    await expect(page.getByTestId("ed-reedit")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("export-sheet")).toHaveCount(0);
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");

    // Export again: the previous export is mentioned, then replaced.
    await page.getByTestId("ed-export").click();
    await expect(sheet).toContainText("Your previous export stays available");
    await page.getByTestId("export-confirm").click();
    await expect(sheet).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
    expect((await stub.job(job.id))!.renders_ok).toBe(2);
  });

  test("phones: Save / Share in the Done view shares the export it fetched ahead, once", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "phones only");
    await fakeShareSheet(page);
    const job = await stub.seed("review_speech", { render_seconds: 1 });
    await openV2(page, job.id);
    await page.getByTestId("ed-export").click();
    await page.getByTestId("export-confirm").click();
    const sheet = page.getByTestId("export-sheet");
    await expect(sheet).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
    const share = sheet.getByTestId("done-share");
    await expect(share).toHaveText(/Save \/ Share/, { timeout: 30_000 });
    await expect(share).toBeEnabled();
    expect(await sharedFiles(page)).toEqual([]);
    await share.click();
    await sharedOnce(page, "tiktok_3_mistakes_cleocuts_9x16.mp4");
  });

  test("a failed export says why and tries again", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render: "fail", render_seconds: 1 });
    await openV2(page, job.id);
    await page.getByTestId("ed-export").click();
    await page.getByTestId("export-confirm").click();
    const sheet = page.getByTestId("export-sheet");
    await expect(sheet).toHaveAttribute("data-phase", "failed", { timeout: 45_000 });
    await expect(sheet).toContainText("Export failed");
    await expect(page.getByTestId("export-error")).toHaveText("Your edits are saved.");
    await page.getByTestId("export-retry").click();
    await expect(sheet).toHaveAttribute("data-phase", "failed", { timeout: 45_000 });
    await expect(page.getByTestId("export-error")).toContainText("failed again");
  });

  test("no edits + speculative render ready → done instantly", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { spec: "ready" });
    await openV2(page, job.id);
    await page.getByTestId("ed-export").click();
    await expect(page.getByTestId("export-cost")).toHaveText("Free · ready instantly");
    await page.getByTestId("export-confirm").click();
    await expect(page.getByTestId("export-instant")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("export-sheet")).toHaveAttribute("data-phase", "done");
    const j = (await stub.job(job.id))!;
    expect(j.spec_status).toBe("promoted");
    expect(j.renders_ok).toBe(0);
  });
});
