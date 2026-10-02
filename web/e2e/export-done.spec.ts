/**
 * UX11: export, Done view, re-edit, instant export (PLAN_TECH §UX11
 * "export-done.spec.ts"). UX11's screens belong to the v2 editor opt-in
 * (useEditorV2).
 *
 * Flag-off build: the v1 export flow is unchanged — the v1 Done screen,
 * Apply & render back to the dashboard (also when a speculative render
 * makes the export instant on the server).
 *
 * Editor-v2 build (@editor-v2): the Done view of a finished project —
 * one download per distinct file, SRT / VTT, the post text saved, Save /
 * Share on phones, the survey from the 2nd export — Edit again → export
 * again with the previous export downloadable meanwhile; Export stays in
 * the editor (cost, localized stage, Done view); failures; the instant
 * export.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { ACTIVE_JOBS, card, openWithStorage } from "./support/app";
import { API, WEB } from "./support/env";

const V2 = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };

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

test.describe("Done view (editor v2)", V2, () => {
  test("downloads, SRT / VTT, post text, Edit again → export again", async ({ page, stub }) => {
    const job = await stub.seed("done", { render_seconds: 3 });
    await openWithStorage(page, `/app/p/${job.id}`, TOUR_DONE);
    const done = page.getByTestId("done-view");
    await expect(done).toBeVisible({ timeout: 30_000 });

    // One download per distinct file; bonus clips in their own list.
    const { downloads } = await jobJson(page, job.id);
    await expect(page.getByTestId("done-download")).toHaveCount(downloads.length);
    await expect(page.getByTestId("done-hooks")).toBeVisible();
    const href = await page.getByTestId("done-download").first().getAttribute("href");
    expect(href).toContain(`/jobs/${job.id}/download?format=primary`);

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

    // Edit again → the editor, with the re-edit note.
    await page.getByTestId("done-edit-again").click();
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
    await expect(page.getByTestId("done-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("done-survey")).toHaveCount(0);
    await page.goto(`/app/p/${b.id}`);
    await expect(page.getByTestId("done-survey")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("done-survey-yes").click();
    await page.getByRole("textbox", { name: "What did you change? (optional)" }).fill("music");
    await page.getByTestId("done-survey-send").click();
    await expect(page.getByTestId("done-survey")).toContainText("Thanks");
    // Answered: not again this week.
    await page.goto(`/app/p/${a.id}`);
    await expect(page.getByTestId("done-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("done-survey")).toHaveCount(0);
  });

  test("Save / Share on a phone: prefetched, shared from the tap", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "phones only");
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: string[] };
      w.__shared = [];
      Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
      Object.defineProperty(navigator, "share", {
        value: (d: ShareData) => {
          w.__shared.push(d.files?.[0]?.name ?? "");
          return Promise.resolve();
        },
        configurable: true,
      });
    });
    const job = await stub.seed("done");
    await openWithStorage(page, `/app/p/${job.id}`);
    const share = page.getByTestId("done-share");
    await expect(share).toBeEnabled({ timeout: 30_000 });
    await expect(share).toHaveText(/Save \/ Share/);
    await share.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __shared: string[] }).__shared))
      .toEqual(["tiktok_3_mistakes_final_cleocuts_9x16.mp4"]);
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
