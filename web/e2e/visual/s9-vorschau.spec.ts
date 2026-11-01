// The Vorschau (PR2; the approved mockups docs/mockups/start/4-vorschau,
// -fertigstellen, -sichern), in German like them, at 390×844 (pixel7:
// touch, Android) and 1440×900 (desktop): every state of plan §5.2 the
// stub can reach. Loading; processing; ready with the live captions, a
// v1 project's note, a failed export, a landscape video exported as
// "Original" (a wide frame), changes only this device has, saves still
// out (and still out after 8 s), sentence edits only Feinschliff
// exports, a preview the server still builds (its file asked for, or
// none built yet), a preview that can't be built; edited; finishing;
// done with "Herunterladen" ("Video sichern" on an iPhone), "Mehr zum
// Video" open with the survey and the tip, the ⋯ menu, a wide frame;
// failed; gone. Screenshots only (UX18 adds baselines). Needs
// E2E_EDITOR_V2=1.
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { API } from "../support/env";
import { LANG_KEY, openWithStorage } from "../support/app";
import {
  fakeShareSheet,
  fixWord,
  holdRequests,
  IPHONE_UA,
  openRefine,
  openVorschau,
  unsavedTimeline,
  vorschau,
} from "../support/vorschau";
import { shot } from "./shot";

const TAG = { tag: ["@editor-v2", "@visual", "@nightly"] };

type Size = { width: number; height: number };
const PHONE: Size = { width: 390, height: 844 };
const DESKTOP: Size = { width: 1440, height: 900 };
// The mockups' video.
const NAME = "Morgenroutine.mp4";
const DE = { [LANG_KEY]: "de" };
// This browser saw an export before: the survey asks (done/Survey).
const SECOND_EXPORT = { "cleocuts.exports.v1": { seen: ["earlier:1"], lastSurvey: 0 } };

/** A screenshot named after the size, the pointer off the controls (no
 *  hover look). */
async function snap(page: Page, size: Size, what: string, opts?: { settleMs?: number }) {
  await page.mouse.move(2, Math.round(size.height / 2));
  await shot(page, `${size.width}x${size.height}-vorschau-${what}`, opts);
}

/** The whole page in one picture: the viewport as tall as the page. */
async function snapWhole(page: Page, size: Size, what: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.max(height, size.height) });
  await snap(page, size, what, { settleMs: 600 });
  await page.setViewportSize(size);
}

/** The Vorschau in German, its fonts loaded. */
async function open(page: Page, jobId: string, opts: { storage?: Record<string, unknown>; query?: string } = {}) {
  await openVorschau(page, jobId, { ...opts, storage: { ...DE, ...opts.storage } });
  await page.evaluate(() => document.fonts.ready);
}

type Hook = { ready: boolean; page: string | null };

/** The preview paused on a frame with a caption (the second sentence;
 *  the browser opted in to the live captions with ?captions=v2). */
async function captionFrame(page: Page) {
  const hook = () => page.evaluate(() => (window as unknown as { __captionLayer?: Hook }).__captionLayer ?? null);
  await expect.poll(async () => (await hook())?.ready, { timeout: 30_000 }).toBe(true);
  await page.getByTestId("preview-video").evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    const seeked = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    v.currentTime = 4.6;
    await seeked;
  });
  await expect.poll(async () => (await hook())?.page ?? null, { timeout: 15_000 }).not.toBeNull();
}

for (const size of [PHONE, DESKTOP]) {
  const project = size === PHONE ? "pixel7" : "desktop";
  test.describe(`Vorschau ${size.width}×${size.height}`, TAG, () => {
    test.beforeEach(async ({ page }, info) => {
      test.skip(info.project.name !== project, "the phone on pixel7, the desktop on desktop");
      await page.setViewportSize(size);
    });

    test("loading, processing, gone", async ({ page, stub }) => {
      const job = await stub.seed("analyzing", { filename: NAME });
      // Its shape until GET /jobs/{id} answers.
      const load = await holdRequests(page, `${API}/jobs/${job.id}`);
      await openWithStorage(page, `/app/p/${job.id}`, DE);
      await load.held;
      await expect(page.getByTestId("project-loading")).toBeVisible();
      await snap(page, size, "1-laedt");
      await load.release();
      await expect(vorschau(page)).toHaveAttribute("data-state", "processing");
      await page.evaluate(() => document.fonts.ready);
      await snap(page, size, "2-wird-bearbeitet");
      await page.goto("/app/p/doesnotexist1");
      await expect(page.getByTestId("project")).toHaveAttribute("data-status", "gone");
      await snap(page, size, "9-nicht-mehr-da");
    });

    test("ready: the live captions, a v1 project's note, a failed export", async ({ page, stub }) => {
      const ready = await stub.seed("review_speech", { filename: NAME });
      await open(page, ready.id, { query: "?captions=v2" });
      await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
      await captionFrame(page);
      await snap(page, size, "3-bereit", { settleMs: 800 });
      // Without the opt-in (the stub's engine is "optin"): the note.
      await open(page, ready.id);
      await expect(page.getByTestId("preview-captions-after")).toBeVisible();
      await snap(page, size, "3-bereit-hinweis-untertitel");
      const failed = await stub.seed("render_failed", { filename: NAME });
      await open(page, failed.id);
      await expect(page.getByTestId("preview-failed")).toBeVisible();
      await snap(page, size, "3-bereit-fertigstellen-fehlgeschlagen");
    });

    test("ready and done: a landscape video exported as Original (a wide frame)", async ({ page, stub }) => {
      const ready = await stub.seed("review_land", { filename: NAME });
      await open(page, ready.id);
      await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
      await expect(vorschau(page).locator("[data-shape]").first()).toHaveAttribute("data-shape", "wide");
      await snap(page, size, "3-bereit-original-quer");
      const done = await stub.seed("done_land", { filename: NAME });
      await open(page, done.id);
      await expect(vorschau(page)).toHaveAttribute("data-state", "done");
      await snap(page, size, "8-fertig-original-quer");
    });

    test("ready: changes only on this device; saves still out", async ({ page, stub }) => {
      const job = await stub.seed("review_speech", { filename: NAME });
      await open(page, job.id, { storage: unsavedTimeline(job.id) });
      await expect(page.getByTestId("preview-unsaved")).toBeVisible();
      await snap(page, size, "4-ungespeichert-auf-dem-geraet");

      // A change in Feinschliff whose save is still out: Fertigstellen waits.
      const other = await stub.seed("review_speech", { filename: NAME });
      await holdRequests(page, `${API}/jobs/${other.id}/doc`, "PATCH");
      await open(page, other.id);
      await openRefine(page, other.id);
      await fixWord(page, "ten", "zehn");
      await page.getByTestId("editor-back").click();
      // (its first answer waits up to 8 s for the editor's saves)
      await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
      await page.getByTestId("preview-finish").click();
      await expect(page.getByTestId("preview-saving")).toBeVisible();
      await snap(page, size, "4-aenderungen-werden-gespeichert");
      await expect(page.getByTestId("preview-error")).toBeVisible({ timeout: 15_000 });
      await snap(page, size, "4-noch-nicht-gespeichert");
    });

    test("ready: sentence edits that only Feinschliff exports", async ({ page, stub }) => {
      // A project from before the edit document whose sentences were edited (POST /phrases).
      const job = await stub.seed("review_speech", { filename: NAME, doc: false });
      const saved = await stub.api.post(`/jobs/${job.id}/phrases`, {
        data: { rev: Date.now(), phrases: [{ start: 0.2, end: 1, original_start: 0.2, original_end: 1, text: "Hallo Welt." }] },
      });
      expect(saved.ok()).toBe(true);
      await open(page, job.id);
      await page.getByTestId("preview-finish").click();
      await expect(page.getByTestId("preview-needs-editor")).toBeVisible();
      await snap(page, size, "4-im-feinschliff-fertigstellen");
    });

    test("ready: the preview still being built", async ({ page, stub }) => {
      const job = await stub.seed("review_speech", { filename: NAME });
      await holdRequests(page, `${API}/jobs/${job.id}/preview-video**`);
      await open(page, job.id);
      await expect(page.getByTestId("preview-preparing")).toBeVisible({ timeout: 15_000 });
      await snap(page, size, "5-vorschau-wird-vorbereitet");
    });

    test("ready: no preview of the stored edit yet (none of the old cut meanwhile); one that can't be built", async ({ page, stub }) => {
      // The editor played the proxy: no preview built yet; its build takes a minute here.
      const job = await stub.seed("review_speech", { filename: NAME, proxy: "on", first_preview: false, slow_rebuild: 60 });
      await open(page, job.id);
      await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-held", "building");
      await expect(page.getByTestId("preview-preparing")).toBeVisible({ timeout: 15_000 });
      await snap(page, size, "5-vorschau-wird-erstellt");

      // Every build of it fails: asked once more, then the note.
      const failing = await stub.seed("review_speech", { filename: NAME });
      await page.route(`${API}/jobs/${failing.id}/preview`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preview_status: "building" }) }),
      );
      await page.route(`${API}/jobs/${failing.id}`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const res = await route.fetch();
        const body = await res.json();
        Object.assign(body, { preview_status: "failed", preview_error: "encode_failed" });
        return route.fulfill({ response: res, body: JSON.stringify(body) });
      });
      await open(page, failing.id);
      await expect(page.getByTestId("preview-unavailable")).toBeVisible({ timeout: 20_000 });
      await snap(page, size, "5-vorschau-nicht-erstellt");
    });

    test("edited, finishing", async ({ page, stub }) => {
      // Exported before with the v1 captions (the stub's exports): it
      // keeps them, so the preview has the note, opt-in or not.
      const edited = await stub.seed("edited", { filename: NAME });
      await open(page, edited.id, { query: "?captions=v2" });
      await expect(vorschau(page)).toHaveAttribute("data-state", "edited");
      await expect(page.getByTestId("preview-captions-after")).toBeVisible();
      await snap(page, size, "6-geaendert");

      const job = await stub.seed("review_speech", { filename: NAME, render_seconds: 30 });
      await open(page, job.id, { query: "?captions=v2" });
      await captionFrame(page);
      await page.getByTestId("preview-finish").click();
      await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
      await snap(page, size, "7-wird-fertiggestellt", { settleMs: 800 });
    });

    test("done: Herunterladen; Mehr zum Video with the survey and the tip; the ⋯ menu", async ({ page, stub }) => {
      const job = await stub.seed("done", { filename: NAME });
      await open(page, job.id, { storage: SECOND_EXPORT });
      await expect(vorschau(page)).toHaveAttribute("data-state", "done");
      await expect(page.getByTestId("done-download").first()).toHaveText("Herunterladen");
      await snap(page, size, "8-fertig");
      await page.getByTestId("preview-more").click();
      await expect(page.getByTestId("done-post")).toBeVisible();
      await expect(page.getByTestId("done-survey")).toBeVisible();
      await expect(page.getByTestId("done-tip")).toBeVisible();
      await snap(page, size, "8-mehr-zum-video", { settleMs: 800 });
      await snapWhole(page, size, "8-mehr-zum-video-ganz");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByTestId("job-card-menu").click();
      await expect(page.getByTestId("job-card-menu-list")).toBeVisible();
      await snap(page, size, "8-menue");
    });

    test("failed", async ({ page, stub }) => {
      const job = await stub.seed("err_unreadable", { filename: NAME });
      await open(page, job.id);
      await expect(vorschau(page)).toHaveAttribute("data-state", "failed");
      await snap(page, size, "9-fehlgeschlagen");
    });
  });
}

test.describe(`Vorschau ${PHONE.width}×${PHONE.height} on an iPhone`, TAG, () => {
  test.use({ userAgent: IPHONE_UA });
  test("done: Video sichern", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "a phone");
    await page.setViewportSize(PHONE);
    await fakeShareSheet(page);
    const job = await stub.seed("done", { filename: NAME });
    await open(page, job.id);
    await expect(page.getByTestId("done-share")).toHaveText(/Video sichern/);
    await snap(page, PHONE, "8-fertig-iphone");
  });
});
