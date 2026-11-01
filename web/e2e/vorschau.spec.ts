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
 * preview the server still builds, offline. Back from Fine-tune: the
 * edit as the server stores it once the editor's last saves are in (its
 * length, its preview, its captions), never the old cut while the new
 * preview is built (the Vorschau asks for it, again when the server lost
 * the build), a preview that can't be built. Changes the server doesn't
 * have yet (a save that failed or is slow, another tab's editor, copies
 * left by a closed tab): never exported without them, Fine-tune brings
 * them back (or offers them, and they go when left alone); sentence
 * edits only Fine-tune's export has.
 * Desktop and pixel7, a v2 build (E2E_EDITOR_V2=1). The stub runs
 * CLEO_CAPTION_ENGINE=optin: ?captions=v2 opts the browser in to the v2
 * captions (drawn live over the preview); without it the preview says
 * they come with the export.
 */
import type { Page, Route } from "@playwright/test";
import { expect, test, type Stub } from "./support/fixtures";
import { openWithStorage, readStorage } from "./support/app";
import { API, WEB } from "./support/env";
import {
  cutWords,
  fixWord,
  holdRequests,
  lengthOf,
  openRefine,
  openVorschau,
  pickStyle,
  previewPosts,
  renderPosts,
  TOUR_DONE,
  unsavedTimeline,
  vorschau,
} from "./support/vorschau";

const TAG = { tag: "@editor-v2" };
const FAILED_NOTE = "Exporting didn't work. Your edits are saved. Try again.";

type Hook = { ready: boolean; page: string | null; preset: string | null };
const captionLayer = (page: Page) => page.evaluate(() => (window as unknown as { __captionLayer?: Hook }).__captionLayer ?? null);

test.describe("the Vorschau", TAG, () => {
  test("ready: the captions over the preview; Export renders the edit as stored, then Download", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 5 });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("preview-title")).toHaveText("tiktok_3_mistakes");
    // The stored edit's length, its seconds rounded down as the editor
    // shows it (the speech clip's 28.6 s of clips: 0:28 on both).
    await expect(page.getByTestId("preview-length")).toHaveText(lengthOf((await stub.job(job.id))!.edit_segments));
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
    // (its first answer waits up to 8 s for the editor's saves)
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });

    const finish = page.getByTestId("preview-finish");
    await finish.click();
    await expect(page.getByTestId("preview-saving")).toHaveText("Saving changes…");
    // Nothing exports yet: the button keeps its name, unavailable; no Fine-tune meanwhile.
    await expect(finish).toHaveAttribute("data-state", "waiting");
    await expect(finish).toHaveText("Export");
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
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
    const held = Date.now();
    await expect(frame).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("preview-preparing")).toHaveCount(0);
    await expect(page.getByTestId("preview-preparing")).toHaveText("The preview is still being prepared.", { timeout: 15_000 });
    // after about 10 s (D13), not before
    expect(Date.now() - held).toBeGreaterThanOrEqual(8_000);
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

test.describe("the Vorschau shows the edit as stored (back from Fine-tune)", TAG, () => {
  // "Nobody waits ten seconds for you to get to the point." (the speech clip, 11 to 14 s)
  const CUT_AT = 11.5;
  const covered = (tl: number[][], t: number) => tl.some(([a, b]) => a <= t && t <= b);

  test("saves that land after it loaded: the stored cut's length, preview and caption style come in", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off" });
    await openVorschau(page, job.id, { query: "?captions=v2" });
    const length = page.getByTestId("preview-length");
    const video = page.getByTestId("preview-video");
    const before = (await stub.job(job.id))!;
    await expect(length).toHaveText(lengthOf(before.edit_segments));
    await expect(video).toHaveAttribute("src", /[?&]v=1$/);
    await expect.poll(async () => (await captionLayer(page))?.preset ?? null, { timeout: 30_000 }).toBe("clipper");

    await openRefine(page, job.id);
    // The editor's saves stay out (a slow connection, a save retried after a failure).
    const timeline = await holdRequests(page, `${API}/jobs/${job.id}/edit-segments`, "POST");
    const doc = await holdRequests(page, `${API}/jobs/${job.id}/doc`, "PATCH");
    await cutWords(page, "Nobody", "point.");
    await pickStyle(page, "karaoke");
    await timeline.held;
    await doc.held;
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}?captions=v2`);
    // It waits 8 s for them, then shows the job as the server has it.
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect(length).toHaveText(lengthOf(before.edit_segments));

    await timeline.release();
    await doc.release();
    await expect.poll(async () => covered(await stub.timeline(job.id), CUT_AT), { timeout: 30_000 }).toBe(false);
    // The stored cut: its length at once, its preview once built, the captions in its style.
    await expect(length).toHaveText(lengthOf((await stub.job(job.id))!.edit_segments), { timeout: 15_000 });
    await expect.poll(async () => (await stub.job(job.id))!.preview_version, { timeout: 60_000 }).toBeGreaterThan(1);
    const built = (await stub.job(job.id))!.preview_version;
    await expect(video).toHaveAttribute("src", new RegExp(`[?&]v=${built}$`), { timeout: 30_000 });
    await expect.poll(async () => (await captionLayer(page))?.preset ?? null, { timeout: 20_000 }).toBe("karaoke");
  });

  test("a caption style saved after it loaded (the timeline unchanged): the captions come in that style", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off" });
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect.poll(async () => (await captionLayer(page))?.preset ?? null, { timeout: 30_000 }).toBe("clipper");
    const rev = (await stub.job(job.id))!.edit_rev;

    await openRefine(page, job.id);
    const doc = await holdRequests(page, `${API}/jobs/${job.id}/doc`, "PATCH");
    await pickStyle(page, "karaoke");
    await doc.held;
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect.poll(async () => (await captionLayer(page))?.preset ?? null, { timeout: 15_000 }).toBe("clipper");

    await doc.release();
    await expect.poll(async () => (await stub.doc(job.id)).doc.style.presetId, { timeout: 15_000 }).toBe("karaoke");
    // Read again once the editor's saves settled (no newer timeline to say so).
    await expect.poll(async () => (await captionLayer(page))?.preset ?? null, { timeout: 15_000 }).toBe("karaoke");
    expect((await stub.job(job.id))!.edit_rev).toBe(rev);
  });

  test("a fresh job without a preview (the editor plays the proxy): asked for, nothing played until it is built", async ({
    page,
    stub,
  }) => {
    // Its build takes 14 s here.
    const job = await stub.seed("review_speech", { proxy: "on", first_preview: false, slow_rebuild: 14 });
    const posts = previewPosts(page, job.id);
    await openVorschau(page, job.id);
    const frame = page.getByTestId("preview-frame");
    const video = page.getByTestId("preview-video");
    await expect(frame).toHaveAttribute("data-held", "building");
    const held = Date.now();
    await expect(frame).toHaveAttribute("aria-busy", "true");
    await expect(video).not.toHaveAttribute("src");
    // Still not built after about 10 s (D13): it says so.
    await expect(page.getByTestId("preview-preparing")).toHaveText("The preview is still being prepared.", { timeout: 15_000 });
    expect(Date.now() - held).toBeGreaterThanOrEqual(8_000);
    await expect(video).toHaveAttribute("src", /[?&]v=1$/, { timeout: 45_000 });
    await expect(page.getByTestId("preview-preparing")).toHaveCount(0);
    await expect(frame).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    expect(posts).toHaveLength(1);
    await page.getByTestId("preview-play").click();
    await expect(frame).toHaveAttribute("data-playing", "true");
  });

  test("on the proxy (a save doesn't rebuild the preview): asked for once after a cut, none of the old cut meanwhile, then the new one", async ({
    page,
    stub,
  }) => {
    // No page.route here: the browser may answer the old file's requests
    // from its cache, so they can't be what starts the build.
    const job = await stub.seed("review_speech", { proxy: "on", first_preview: false, slow_rebuild: 4 });
    const posts = previewPosts(page, job.id);
    await openVorschau(page, job.id);
    const frame = page.getByTestId("preview-frame");
    const video = page.getByTestId("preview-video");
    await expect(video).toHaveAttribute("src", /[?&]v=1$/, { timeout: 45_000 });
    await expect(frame).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

    await openRefine(page, job.id);
    await cutWords(page, "Nobody", "point.");
    await expect.poll(async () => covered(await stub.timeline(job.id), CUT_AT), { timeout: 30_000 }).toBe(false);
    const asked = posts.length;
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    // Nothing of the old cut while the new preview is built: busy, no file; Export stays.
    await expect(frame).toHaveAttribute("data-held", "building");
    await expect(frame).toHaveAttribute("aria-busy", "true");
    await expect(video).not.toHaveAttribute("src");
    await expect(page.getByTestId("preview-finish")).not.toHaveAttribute("aria-disabled", "true");
    await expect(video).toHaveAttribute("src", /[?&]v=2$/, { timeout: 45_000 });
    await expect(frame).not.toHaveAttribute("data-held");
    await expect(frame).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    expect(posts.length - asked).toBe(1);
    await page.getByTestId("preview-play").click();
    await expect(frame).toHaveAttribute("data-playing", "true");
  });

  test("a build the server lost (a restart or deploy): asked for again, then the new preview plays", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "on", first_preview: false, slow_rebuild: 4 });
    const posts = previewPosts(page, job.id);
    await openVorschau(page, job.id);
    const frame = page.getByTestId("preview-frame");
    const video = page.getByTestId("preview-video");
    await expect(video).toHaveAttribute("src", /[?&]v=1$/, { timeout: 45_000 });

    await openRefine(page, job.id);
    await cutWords(page, "Nobody", "point.");
    await expect.poll(async () => covered(await stub.timeline(job.id), CUT_AT), { timeout: 30_000 }).toBe(false);
    const asked = posts.length;
    // The server takes the first ask ("building") and loses that build (a
    // restart keeps none): the job says "stale" again, same revision.
    let lost = false;
    await page.route(`${API}/jobs/${job.id}/preview`, (route) => {
      if (route.request().method() !== "POST" || lost) return route.fallback();
      lost = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preview_status: "building" }) });
    });
    await page.getByTestId("editor-back").click();
    await expect(frame).toHaveAttribute("data-held", "building", { timeout: 30_000 });
    // Asked for again: the new preview comes in, no note that it failed.
    await expect(video).toHaveAttribute("src", /[?&]v=2$/, { timeout: 45_000 });
    expect(posts.length - asked).toBe(2);
    await expect(page.getByTestId("preview-unavailable")).toHaveCount(0);
    await expect(frame).not.toHaveAttribute("data-held");
  });

  test("a newer cut while it plays: its length at once, the playing file until the pause, then none until the new one", async ({
    page,
    stub,
  }) => {
    // The server rebuilds the preview for a save (8 s here).
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: 8 });
    await openVorschau(page, job.id);
    const frame = page.getByTestId("preview-frame");
    const video = page.getByTestId("preview-video");
    const play = page.getByTestId("preview-play");
    await expect(video).toHaveAttribute("src", /[?&]v=1$/);
    await expect(frame).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
    await play.click();
    await expect(frame).toHaveAttribute("data-playing", "true");
    // Another device stores a cut; this page asks again when it shows again.
    const j = (await stub.job(job.id))!;
    const segments = j.edit_segments.filter((x) => !(x.start <= CUT_AT && CUT_AT <= x.end));
    const rev = j.edit_rev ?? 0;
    const saved = await page.request.post(`${API}/jobs/${job.id}/edit-segments`, { data: { segments, base_rev: rev, rev: rev + 1 } });
    expect(saved.ok()).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByTestId("preview-length")).toHaveText(lengthOf(segments));
    // No change mid-play: the file it plays stays.
    await expect(frame).toHaveAttribute("data-playing", "true");
    await expect(video).toHaveAttribute("src", /[?&]v=1$/);
    await play.click();
    await expect(frame).not.toHaveAttribute("data-playing", "true");
    // Paused: none of the old cut until the new preview is there.
    await expect(frame).toHaveAttribute("data-held", "building");
    await expect(video).not.toHaveAttribute("src");
    await expect(video).toHaveAttribute("src", /[?&]v=2$/, { timeout: 45_000 });
  });

  test("a preview that can't be built: asked once more, then a note instead of the old cut; Export stays", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 20 });
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    await cutWords(page, "Nobody", "point.");
    await expect.poll(async () => covered(await stub.timeline(job.id), CUT_AT), { timeout: 30_000 }).toBe(false);
    // From here every build fails: the job says "failed", a retry starts and fails too.
    const posts: number[] = [];
    await page.route(`${API}/jobs/${job.id}/preview`, (route) => {
      posts.push(Date.now());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preview_status: "building" }) });
    });
    await page.route(`${API}/jobs/${job.id}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      if (body.preview_status !== "ready") Object.assign(body, { preview_status: "failed", preview_error: "encode_failed" });
      return route.fulfill({ response: res, body: JSON.stringify(body) });
    });
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    const frame = page.getByTestId("preview-frame");
    await expect(page.getByTestId("preview-unavailable")).toHaveText("The preview couldn't be made. Your edits are saved.", {
      timeout: 20_000,
    });
    await expect(frame).toHaveAttribute("data-held", "failed");
    await expect(frame).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("preview-video")).not.toHaveAttribute("src");
    await expect(page.getByTestId("preview-play")).toHaveAttribute("aria-disabled", "true");
    expect(posts).toHaveLength(1);
    // given up: nothing more is asked for
    await page.waitForTimeout(5000);
    expect(posts).toHaveLength(1);
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Export");
    await expect(finish).not.toHaveAttribute("aria-disabled", "true");
    // Exporting (nothing builds a preview then): still the note, not the old cut.
    await finish.click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await expect(frame).toHaveAttribute("data-held", "failed");
    await expect(page.getByTestId("preview-video")).not.toHaveAttribute("src");
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
  });

  test("Export while the new preview is built: none of the old cut while it exports either, then the new preview", async ({
    page,
    stub,
  }) => {
    // The preview of a cut takes 8 s to build here, the export 30 s.
    const job = await stub.seed("review_speech", { proxy: "on", slow_rebuild: 8, render_seconds: 30 });
    await openVorschau(page, job.id);
    const frame = page.getByTestId("preview-frame");
    const video = page.getByTestId("preview-video");
    await expect(video).toHaveAttribute("src", /[?&]v=1$/);

    await openRefine(page, job.id);
    await cutWords(page, "Nobody", "point.");
    await expect.poll(async () => covered(await stub.timeline(job.id), CUT_AT), { timeout: 30_000 }).toBe(false);
    await page.getByTestId("editor-back").click();
    await expect(frame).toHaveAttribute("data-held", "building", { timeout: 30_000 });
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await expect(frame).toHaveAttribute("data-held", "building");
    await expect(frame).toHaveAttribute("aria-busy", "true");
    await expect(video).not.toHaveAttribute("src");
    // The build goes on while it exports: the new preview comes in.
    await expect(video).toHaveAttribute("src", /[?&]v=2$/, { timeout: 45_000 });
    await expect(frame).not.toHaveAttribute("data-held");
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
  });
});

test.describe("the Vorschau and changes the server doesn't have yet", TAG, () => {
  // "Nobody waits ten seconds for you to get to the point." (the speech clip, 11 to 14 s)
  const CUT_AT = 11.5;
  const covered = (tl: number[][], t: number) => tl.some(([a, b]) => a <= t && t <= b);
  const UNSAVED = "This device has changes that aren't saved yet. Open Fine-tune so they're included.";
  // The editor's copies of what the server hasn't acknowledged (editor/session/unsavedKey, unsavedDoc).
  const timelineKey = (id: string) => `cleocuts.editor.unsaved.v1.${id}`;
  const docKey = (id: string) => `cleocuts.editor.unsavedDoc.v1.${id}`;
  const docText = async (stub: Stub, id: string) => (await stub.doc(id)).doc.words.map((w) => w.text).join(" ");

  /** The text's saves fail (500): PATCH /doc and its sentence copy, POST
   *  /phrases (each answer after `delayMs`). Returns: the connection is fine again. */
  async function failTextSaves(page: Page, jobId: string, delayMs = 0) {
    const fail = (method: string) => async (route: Route) => {
      if (route.request().method() !== method) return route.fallback();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await route
        .fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "server_error" }) })
        .catch(() => undefined);
    };
    await page.route(`${API}/jobs/${jobId}/doc`, fail("PATCH"));
    await page.route(`${API}/jobs/${jobId}/phrases`, fail("POST"));
    return async () => {
      await page.unroute(`${API}/jobs/${jobId}/doc`);
      await page.unroute(`${API}/jobs/${jobId}/phrases`);
    };
  }

  test("a text fix whose save fails, Export as soon as it is there: it waits for the editor's tries, then Open Fine-tune, nothing rendered", async ({
    page,
    stub,
  }) => {
    const job = await stub.seed("review_speech", { render_seconds: 1 });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    // Each failed answer takes 1.5 s: the editor's last tries go on after the Vorschau's 8 s wait.
    await failTextSaves(page, job.id, 1500);
    await fixWord(page, "ten", "zehn");
    await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "retrying", { timeout: 15_000 });
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Export", { timeout: 30_000 });
    await finish.click();
    // It waits for those saves: still "Export" (unavailable), no Fine-tune meanwhile.
    await expect(page.getByTestId("preview-saving")).toHaveText("Saving changes…");
    await expect(finish).toHaveText("Export");
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    // They gave up: the fix is only on this device. Never exported without it.
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED, { timeout: 25_000 });
    await expect(finish).toHaveCount(0);
    await expect(page.getByTestId("preview-refine")).toHaveText("Open Fine-tune");
    await page.waitForTimeout(1000);
    expect(renders).toEqual([]);
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");
    expect(await docText(stub, job.id)).not.toContain("zehn");
    expect(await readStorage(page, docKey(job.id))).not.toBeNull();
  });

  test("a text fix whose save fails, 9 s later: Open Fine-tune, nothing rendered; Fine-tune brings it back and saves it, Export has it", async ({
    page,
    stub,
  }) => {
    test.setTimeout(180_000);
    const job = await stub.seed("review_speech", { render_seconds: 1 });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    const online = await failTextSaves(page, job.id);
    await fixWord(page, "ten", "zehn");
    await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "retrying", { timeout: 15_000 });
    await page.getByTestId("editor-back").click();
    await expect(page).toHaveURL(`${WEB}/app/p/${job.id}`);
    await page.waitForTimeout(9000);
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED, { timeout: 15_000 });
    await expect(page.getByTestId("preview-finish")).toHaveCount(0);
    expect(renders).toEqual([]);
    expect(await docText(stub, job.id)).not.toContain("zehn");

    // The connection is fine again: Fine-tune brings the fix back by itself (one undo step) and saves it.
    await online();
    const open = page.getByTestId("preview-refine");
    await expect(open).toHaveText("Open Fine-tune");
    await open.click();
    await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("ed-toast")).toContainText("Your last edit hadn't reached the server", { timeout: 30_000 });
    await expect.poll(() => docText(stub, job.id), { timeout: 30_000 }).toContain("zehn");
    await expect.poll(() => readStorage(page, docKey(job.id)), { timeout: 15_000 }).toBeNull();
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    expect(renders).toHaveLength(1);
    const srt = await page.request.get(`${API}/jobs/${job.id}/captions.srt`);
    expect(await srt.text()).toContain("zehn");
  });

  test("a timeline save slower than 8 s: Export waits for it (saving, then still saving), never 'unsaved'; once it lands, the new length and Export", async ({
    page,
    stub,
  }) => {
    test.setTimeout(180_000);
    const job = await stub.seed("review_speech", { proxy: "off", render_seconds: 1 });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    const length = page.getByTestId("preview-length");
    const before = (await stub.job(job.id))!;
    await expect(length).toHaveText(lengthOf(before.edit_segments));
    await openRefine(page, job.id);
    const timeline = await holdRequests(page, `${API}/jobs/${job.id}/edit-segments`, "POST");
    await cutWords(page, "Nobody", "point.");
    await timeline.held;
    await page.getByTestId("editor-back").click();
    // After its 8 s wait it shows the job as stored and goes on waiting: Export, not "unsaved".
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Export", { timeout: 30_000 });
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    await finish.click();
    await expect(page.getByTestId("preview-saving")).toHaveText("Saving changes…");
    await expect(finish).toHaveText("Export");
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    // Still out after 8 s: it says so (D12) and renders nothing; still not "unsaved".
    await expect(page.getByTestId("preview-error")).toHaveText("Your last changes are still being saved. Try again in a moment.", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    await expect(finish).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-refine")).toHaveText("Fine-tune");
    expect(renders).toEqual([]);

    // The save lands: the stored cut's length, Export, nothing left on the device, no
    // "still being saved" any more; no render until tapped.
    await timeline.release();
    await expect.poll(async () => covered(await stub.timeline(job.id), CUT_AT), { timeout: 30_000 }).toBe(false);
    await expect(length).toHaveText(lengthOf((await stub.job(job.id))!.edit_segments), { timeout: 30_000 });
    // (the save's answer comes after the server's preview build)
    await expect(page.getByTestId("preview-error")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    await expect(finish).toHaveText("Export");
    expect(await readStorage(page, timelineKey(job.id))).toBeNull();
    expect(renders).toEqual([]);
    await finish.click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    expect(renders).toHaveLength(1);
  });

  test("a timeline save refused while Export waits for it: Open Fine-tune at once, nothing rendered", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off" });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    await openRefine(page, job.id);
    // The timeline's saves stay out, then the server refuses them (not retried; their copy stays here).
    const held: Route[] = [];
    await page.route(`${API}/jobs/${job.id}/edit-segments`, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      held.push(route);
    });
    await cutWords(page, "Nobody", "point.");
    await expect.poll(() => held.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByTestId("editor-back").click();
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Export", { timeout: 30_000 });
    await finish.click();
    await expect(page.getByTestId("preview-saving")).toHaveText("Saving changes…");
    for (const r of held.splice(0)) {
      await r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: "invalid_segments" }) });
    }
    // Settled, but not stored: well before the 8 s wait ends, Open Fine-tune.
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED, { timeout: 5_000 });
    await expect(page.getByTestId("preview-error")).toHaveCount(0);
    await page.waitForTimeout(3000);
    expect(renders).toEqual([]);
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");
  });

  test("copies of changes the server already has (saves that landed after the tab closed): Export, and the copies go", async ({
    page,
    stub,
  }) => {
    const job = await stub.seed("review_speech");
    const stored = (await stub.job(job.id))!;
    const doc = (await stub.doc(job.id)).doc;
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id, {
      storage: {
        [timelineKey(job.id)]: {
          segs: stored.edit_segments.map((x, i) => ({ id: `seg-${i}`, ...x })),
          base: 0,
          known: [],
          at: Date.now(),
        },
        [docKey(job.id)]: { base: 0, known: [], upsert: [doc.words[2]], delete: [], at: Date.now() },
      },
    });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("preview-finish")).toHaveText("Export");
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    await expect.poll(() => readStorage(page, timelineKey(job.id))).toBeNull();
    await expect.poll(() => readStorage(page, docKey(job.id))).toBeNull();
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", /finishing|done/);
    expect(renders).toHaveLength(1);
  });

  test("a text change kept from before another device saved: the editor keeps the server's text and says so", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    const doc = (await stub.doc(job.id)).doc;
    const ten = doc.words.find((w) => w.text === "ten")!;
    // made on rev 1; the server has moved on since (another device saved: rev 0 is not one of this device's)
    const copy = { base: 1, known: [2], upsert: [{ ...ten, text: "zehn" }], delete: [], at: Date.now() };
    await openVorschau(page, job.id, { storage: { [docKey(job.id)]: copy } });
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED);
    await page.getByTestId("preview-refine").click();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("ed-toast")).toContainText("Changed in another tab or on another device", { timeout: 30_000 });
    await expect.poll(() => readStorage(page, docKey(job.id))).toBeNull();
    expect(await docText(stub, job.id)).not.toContain("zehn");
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect(page.getByTestId("preview-finish")).toHaveText("Export");
  });

  test("a timeline change kept from before another device saved: Fine-tune offers it; left alone, it goes and Export comes back", async ({
    page,
    stub,
  }) => {
    const job = await stub.seed("review_speech");
    const stored = (await stub.job(job.id))!;
    const renders = renderPosts(page, job.id);
    // made on a rev the server has moved on from (another device saved since): the editor only offers it
    const segs = stored.edit_segments.slice(0, 2).map((x, i) => ({ id: `seg-${i}`, ...x }));
    const copy = { segs, base: 999, known: [], at: Date.now() };
    await openVorschau(page, job.id, { storage: { [timelineKey(job.id)]: copy } });
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED);
    await page.getByTestId("preview-refine").click();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("ed-toast")).toContainText("Unsaved timeline changes from your last visit", { timeout: 30_000 });
    // Left alone (no Restore): the newer timeline stays, the copy goes with the editor.
    await page.getByTestId("editor-back").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect(page.getByTestId("preview-finish")).toHaveText("Export");
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    expect(await readStorage(page, timelineKey(job.id))).toBeNull();
    expect(await stub.timeline(job.id)).toHaveLength(stored.edit_segments.length);
    expect(renders).toEqual([]);
  });

  test("an editor of this job in another tab holds a change: this Vorschau says so; once it is saved there, Export", async ({
    page,
    stub,
    context,
  }) => {
    const job = await stub.seed("review_speech", { proxy: "off" });
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    await expect(page.getByTestId("preview-finish")).toHaveText("Export");
    const other = await context.newPage();
    const timeline = await holdRequests(other, `${API}/jobs/${job.id}/edit-segments`, "POST");
    await other.goto(`${WEB}/app/edit/${job.id}`);
    await expect(other.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await cutWords(other, "Nobody", "point.");
    await timeline.held;
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED, { timeout: 15_000 });
    await expect(page.getByTestId("preview-finish")).toHaveCount(0);
    await timeline.release();
    await expect(page.getByTestId("preview-finish")).toHaveText("Export", { timeout: 30_000 });
    await expect(page.getByTestId("preview-unsaved")).toHaveCount(0);
    expect(renders).toEqual([]);
    await other.close();
  });

  test("a change kept on this device after the Vorschau loaded: Export reads the copies right before it posts, nothing rendered", async ({
    page,
    stub,
  }) => {
    const job = await stub.seed("review_speech");
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Export");
    // Written by this page (no storage event here), as by an editor this page didn't hear from.
    const copy = JSON.stringify(unsavedTimeline(job.id)[timelineKey(job.id)]);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [timelineKey(job.id), copy] as const);
    await finish.click();
    await expect(page.getByTestId("preview-unsaved")).toHaveText(UNSAVED);
    await page.waitForTimeout(1500);
    expect(renders).toEqual([]);
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");
  });

  test("from the tap until the export runs: no Fine-tune; Exporting… once the request is out", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 2 });
    await openVorschau(page, job.id);
    const post = await holdRequests(page, `${API}/jobs/${job.id}/render`, "POST");
    const finish = page.getByTestId("preview-finish");
    await finish.click();
    await post.held;
    await expect(finish).toHaveText("Exporting…");
    await expect(finish).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    await post.release();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(page.getByTestId("preview-refine")).toHaveText("Fine-tune");
  });

  test("sentence edits on a project without an edit document: Export says they are exported from Fine-tune; nothing rendered", async ({
    page,
    stub,
  }) => {
    const job = await stub.seed("review_speech", { doc: false });
    // The editor's sentence view saved an edit (POST /phrases).
    const saved = await stub.api.post(`/jobs/${job.id}/phrases`, {
      data: { rev: Date.now(), phrases: [{ start: 0.2, end: 1, original_start: 0.2, original_end: 1, text: "Hallo Welt." }] },
    });
    expect(saved.ok()).toBe(true);
    const renders = renderPosts(page, job.id);
    await openVorschau(page, job.id);
    const finish = page.getByTestId("preview-finish");
    await expect(finish).toHaveText("Export");
    await finish.click();
    await expect(page.getByTestId("preview-needs-editor")).toHaveText("Export your text edits from Fine-tune.");
    await expect(finish).toHaveCount(0);
    await expect(page.getByTestId("preview-error")).toHaveCount(0);
    const open = page.getByTestId("preview-refine");
    await expect(open).toHaveText("Open Fine-tune");
    expect(renders).toHaveLength(1);
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");
    await open.click();
    await expect(page).toHaveURL(`${WEB}/app/edit/${job.id}`);
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  });
});
