/**
 * The Vorschau (PR2, plan D11 to D14, D21; mockups docs/mockups/start
 * 4-vorschau, -fertigstellen, -sichern): /app/p/<id> of a project on the
 * v2 editor. Export ("Fertigstellen") renders the edit as the server
 * stores it, without the editor (POST /render, source "stored"), with
 * the captions the preview shows; it waits for the editor's last saves
 * and never exports an older cut or one that misses this device's
 * changes. Fine-tune opens the editor, whose back returns here. Also:
 * an export left in the editor, the previous version of an edited
 * project, failed exports and analyses, rename and delete through ⋯, a
 * preview the server still builds, offline.
 * Desktop and pixel7, a v2 build (E2E_EDITOR_V2=1). The stub runs
 * CLEO_CAPTION_ENGINE=optin: ?captions=v2 opts the browser in to the v2
 * captions (drawn live over the preview); without it the preview says
 * they come with the export.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { API, WEB } from "./support/env";
import {
  fixWord,
  holdRequests,
  openRefine,
  openVorschau,
  renderPosts,
  TOUR_DONE,
  unsavedTimeline,
  vorschau,
} from "./support/vorschau";

const TAG = { tag: "@editor-v2" };
const FAILED_NOTE = "Exporting didn't work. Your edits are saved. Try again.";

type Hook = { ready: boolean; page: string | null };
const captionLayer = (page: Page) => page.evaluate(() => (window as unknown as { __captionLayer?: Hook }).__captionLayer ?? null);

test.describe("the Vorschau", TAG, () => {
  test("ready: the captions over the preview; Export renders the edit as stored, then Download", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 5 });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("preview-title")).toHaveText("tiktok_3_mistakes");
    await expect(page.getByTestId("preview-length")).toHaveText(/^\d:\d\d$/);
    await expect(page.getByTestId("project-back")).toHaveCount(0);
    // The export's captions, drawn over the preview (a moment of the second sentence).
    await expect.poll(async () => (await captionLayer(page))?.ready, { timeout: 30_000 }).toBe(true);
    await page.getByTestId("preview-video").evaluate((v) => {
      (v as HTMLVideoElement).currentTime = 4.6;
    });
    await expect.poll(async () => (await captionLayer(page))?.page ?? null, { timeout: 15_000 }).not.toBeNull();
    await expect(page.getByTestId("preview-captions-after")).toHaveCount(0);

    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Exporting…");
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    // The edit as stored, with the captions this browser opted in to.
    expect(renders).toEqual([{ client: "v2", source: "stored", disabled_cuts: [], caption_engine: "v2" }]);

    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-video", "export");
    const download = page.getByTestId("done-download").first();
    await expect(download).toHaveText("Download");
    expect(await download.getAttribute("href")).toContain(`/jobs/${job.id}/download?format=primary`);
    const j = (await stub.job(job.id))!;
    expect(j.renders_ok).toBe(1);
    expect(j.caption_engine).toBe("v2");
  });

  test("no caption opt-in: the note under the frame; an untouched edit with its render ready is done at once", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { spec: "ready" });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("preview-captions-after")).toHaveText("You'll see the captions once it's exported.");
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    expect(renders).toEqual([{ client: "v2", source: "stored", disabled_cuts: [] }]);
    const j = (await stub.job(job.id))!;
    expect(j.spec_status).toBe("promoted");
    expect(j.caption_engine).not.toBe("v2");
    // The button pressed went away: the focus goes on to the download.
    await expect(page.getByTestId("done-download").first()).toBeFocused();
  });

  test("Export waits for the editor's last saves: still out, it says so and renders nothing; saved, it renders them", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 2 });
    // The edit document's saves stay out until released (a slow connection).
    const saves = await holdRequests(page, `${API}/jobs/${job.id}/doc`, "PATCH");
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    await fixWord(page, "ten", "zehn");
    await saves.held;
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");

    const finish = page.getByTestId("preview-finish");
    await finish.click();
    await expect(page.getByTestId("preview-saving")).toHaveText("Saving changes…");
    await expect(finish).toHaveAttribute("data-state", "working");
    // Still out after 8 s: nothing renders (never an older cut).
    await expect(page.getByTestId("preview-error")).toHaveText("Your last changes are still being saved. Try again in a moment.", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("preview-saving")).toHaveCount(0);
    await expect(finish).toHaveAttribute("data-state", "idle");
    expect(renders).toEqual([]);
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");

    // Saved: the export has the change.
    await saves.release();
    await expect
      .poll(async () => (await stub.doc(job.id)).doc.words.map((w) => w.text).join(" "), { timeout: 20_000 })
      .toContain("zehn");
    await finish.click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    expect(renders).toHaveLength(1);
    const srt = await page.request.get(`${API}/jobs/${job.id}/captions.srt`);
    expect(await srt.text()).toContain("zehn");
  });

  test("timeline changes this device hasn't saved: Open Fine-tune instead of Export, nothing rendered", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id, { storage: unsavedTimeline(job.id) });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("preview-unsaved")).toHaveText(
      "This device has changes that aren't saved yet. Open Fine-tune so they're included.",
    );
    await expect(page.getByTestId("preview-finish")).toHaveCount(0);
    const open = page.getByTestId("preview-refine");
    await expect(open).toHaveText("Open Fine-tune");
    await open.click();
    await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    expect(renders).toEqual([]);
  });

  test("Fine-tune opens the editor; its back returns to the Vorschau, and the next Back leaves", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    const back = page.getByTestId("editor-back");
    await expect(back).toHaveAttribute("aria-label", "Back to preview");
    await back.click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    // The editor's entry was left, not added again: Back goes where the
    // Vorschau was opened from.
    await page.goBack();
    await expect(page).toHaveURL(`${WEB}/imprint`);
  });

  test("an editor opened by its link: back opens the Vorschau", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openWithStorage(page, `/app/edit/${job.id}`, TOUR_DONE);
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await page.goBack();
    await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
  });

  test("leaving the editor's export while it renders: the Vorschau follows it", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 6 });
    await openWithStorage(page, `/app/edit/${job.id}`, TOUR_DONE);
    await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 45_000 });
    await page.getByTestId("ed-export").click();
    await page.getByTestId("export-confirm").click();
    await expect(page.getByTestId("export-sheet")).toHaveAttribute("data-phase", "rendering", { timeout: 20_000 });
    await page.getByTestId("export-close").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await expect(page.getByTestId("preview-finish")).toHaveText("Exporting…");
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
  });

  test("an export left in an editor that Fine-tune opened: back on that Vorschau, no second entry", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 6 });
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 45_000 });
    await page.getByTestId("ed-export").click();
    await page.getByTestId("export-confirm").click();
    await expect(page.getByTestId("export-sheet")).toHaveAttribute("data-phase", "rendering", { timeout: 20_000 });
    await page.getByTestId("export-close").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    // The editor's entry was left: Back goes where the Vorschau was opened from.
    await page.goBack();
    await expect(page).toHaveURL(`${WEB}/imprint`);
  });

  test("reopened after an export: edited, the previous version downloadable; Export makes the new one", async ({ page, stub }) => {
    const job = await stub.seed("done", { render_seconds: 2 });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    // Fine-tune on an export reopens it (POST /reopen); back is edited.
    await openRefine(page, job.id);
    await expect(page.getByTestId("ed-reedit")).toBeVisible();
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await expect(vorschau(page)).toHaveAttribute("data-state", "edited");
    const previous = page.getByTestId("done-download-previous");
    await expect(previous).toHaveText("Download the previous version");
    expect(await previous.getAttribute("href")).toContain(`/jobs/${job.id}/download?format=primary`);
    await expect(vorschau(page)).toContainText("Your previous export stays available until this one is done.");
    await expect(page.getByTestId("preview-refine")).toHaveText("Fine-tune");

    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(previous).toHaveCount(0);
    expect((await stub.job(job.id))!.renders_ok).toBe(2);
  });

  test("a failed export says so; Export tries again", async ({ page, stub }) => {
    const job = await stub.seed("render_failed", { render_seconds: 1 });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const alert = page.getByTestId("preview-failed");
    await expect(alert).toHaveText(FAILED_NOTE);
    await expect(alert).toHaveAttribute("role", "alert");
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(alert).toHaveCount(0);
    expect((await stub.job(job.id))!.renders_ok).toBe(1);
  });

  test("an export that fails while the page is open: back to Export, with the note", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render: "fail", render_seconds: 1 });
    await openVorschau(page, job.id);
    await expect(page.getByTestId("preview-failed")).toHaveCount(0);
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await expect(page.getByTestId("preview-failed")).toHaveText(FAILED_NOTE, { timeout: 45_000 });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("preview-finish")).toHaveAttribute("data-state", "idle");
  });

  test("a failed analysis: the reason, the refund, Try another video; delete through ⋯", async ({ page, stub }) => {
    const job = await stub.seed("err_unreadable");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("preview-reason")).toHaveText(
      "We couldn't read this video file. Please export it again as MP4 or MOV and upload it.",
    );
    await expect(page.getByTestId("preview-refund")).toHaveText("The minutes were credited back.");
    await expect(page.getByTestId("preview-finish")).toHaveCount(0);
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    await page.getByTestId("preview-another").click();
    await expect(page).toHaveURL(`${WEB}/app/new`);
    await page.goBack();
    await expect(vorschau(page)).toHaveAttribute("data-state", "failed");

    await page.getByTestId("job-card-menu").click();
    await page.getByTestId("job-card-delete").click();
    await expect(page.getByTestId("dialog-delete")).toContainText("prores_4444_master");
    await page.getByTestId("delete-confirm").click();
    await expect(page).toHaveURL(`${WEB}/app`);
    await expect.poll(() => stub.job(job.id)).toBeNull();
  });

  test("while it is analysed: ⋯ renames it; delete says it is still processing", async ({ page, stub }) => {
    const job = await stub.seed("analyzing");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "processing");
    await expect(page.getByTestId("preview-title")).toHaveText("day_in_berlin_vlog");
    await page.getByTestId("job-card-menu").click();
    await page.getByTestId("job-card-rename").click();
    await page.getByTestId("rename-input").fill("Morgenroutine");
    await page.getByTestId("rename-save").click();
    await expect(page.getByTestId("dialog-rename")).toHaveCount(0);
    await expect(page.getByTestId("preview-title")).toHaveText("Morgenroutine");
    await expect.poll(async () => (await stub.job(job.id))?.title).toBe("Morgenroutine");

    await page.getByTestId("job-card-menu").click();
    await page.getByTestId("job-card-delete").click();
    await page.getByTestId("delete-confirm").click();
    await expect(page.getByTestId("dialog-delete")).toContainText("It's still processing. You can delete it once it's done.");
    expect(await stub.job(job.id)).not.toBeNull();
    await expect(vorschau(page)).toHaveAttribute("data-state", "processing");
  });

  test("a preview the server still builds: busy at once, a note after 10 s, then it plays", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    const preview = await holdRequests(page, `${API}/jobs/${job.id}/preview-video**`);
    await openVorschau(page, job.id);
    const frame = page.getByTestId("preview-frame");
    await preview.held;
    await expect(frame).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("preview-preparing")).toHaveCount(0);
    await expect(page.getByTestId("preview-preparing")).toHaveText("The preview is still being prepared.", { timeout: 15_000 });
    await preview.release();
    await expect(page.getByTestId("preview-preparing")).toHaveCount(0, { timeout: 15_000 });
    await expect(frame).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    const play = page.getByTestId("preview-play");
    await expect(play).toHaveAttribute("aria-label", "Play");
    await play.click();
    await expect(frame).toHaveAttribute("data-playing", "true");
    await expect(play).toHaveAttribute("aria-label", "Pause");
  });

  test("offline: Export waits for the connection; a refusal says why", async ({ page, stub, context }) => {
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const finish = page.getByTestId("preview-finish");
    await context.setOffline(true);
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-offline")).toHaveText("You're offline. You can export again once you're back online.");
    await context.setOffline(false);
    await expect(finish).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-offline")).toHaveCount(0);
    // The servers are busy (503): why, and nothing started.
    await page.route(`${API}/jobs/${job.id}/render`, (r) =>
      r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "server_busy" }) }),
    );
    await finish.click();
    await expect(page.getByTestId("preview-error")).toHaveText("Our servers are busy right now. Please try again in a few minutes.");
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");
  });
});
