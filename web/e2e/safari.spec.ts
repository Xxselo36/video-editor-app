/**
 * Safari on an iPhone: the Vorschau's video frame in every state (the
 * owner's iPhone, 2026-11: no picture, no play button, in any state).
 * WebKit sized the frame's auto width, with max-width: 100% inside the
 * page's shrink-to-fit boxes, to 0, so the box kept its height and showed
 * nothing; Chromium drew it, and CI ran Chromium only. The frame now has
 * its width said (player.module.css), and so has the frame the page shows
 * while it loads (preview.module.css frameSkeleton).
 *
 *   before the export  a 9:16 frame of the page's height, its video as
 *                      wide, the play button on it (the topmost thing at
 *                      the frame's centre, so it can be tapped)
 *   finished           the same frame, showing the export's still
 *   no preview         the note inside the frame
 *   loading            the frame's placeholder, the same size
 *   16:9 "Original"    the wide frame, 16:9, as wide as the column
 *
 * CI: the safari-iphone entry runs this file in WebKit as an iPhone
 * (project "iphone"); the editor-v2 entries run it in Chromium too.
 */
import type { Locator, Page } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { expect, test } from "./support/fixtures";
import { API } from "./support/env";
import { holdRequests, openVorschau, vorschau } from "./support/vorschau";

const TAG = { tag: ["@editor-v2", "@safari"] };

/** A movie's settings exported as "Original" (a landscape upload keeps its frame). */
const ORIGINAL = {
  caption_preset: "clean",
  style: "smooth",
  voice_triggers: true,
  remove_fillers: true,
  smartcam_enabled: false,
  smartcam_format: "landscape",
  resolution: "1080",
  output_formats: [],
};

const frame = (page: Page) => page.getByTestId("preview-frame");

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b, "laid out").not.toBeNull();
  return b!;
}

/** A frame of `ratio` (w / h) and a real size, its video filling it. */
async function expectFrame(page: Page, ratio: number) {
  const f = await box(frame(page));
  expect(f.width, `frame ${f.width} x ${f.height}`).toBeGreaterThan(100);
  expect(f.height).toBeGreaterThan(100);
  expect(Math.abs(f.width / f.height - ratio), `frame ${f.width} x ${f.height}`).toBeLessThan(0.02);
  const v = await box(page.getByTestId("preview-video"));
  expect(Math.round(v.width)).toBe(Math.round(f.width));
  expect(Math.round(v.height)).toBe(Math.round(f.height));
  return f;
}

/** The play button is on the frame and the topmost thing there: a finger can tap it. */
async function expectPlayButtonOnTop(page: Page) {
  const play = page.getByTestId("preview-play");
  await expect(play).toBeVisible();
  const f = await box(frame(page));
  const p = await box(play);
  expect(p.x).toBeGreaterThanOrEqual(f.x);
  expect(p.x + p.width).toBeLessThanOrEqual(f.x + f.width + 0.5);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="preview-play"]') !== null, {
    x: p.x + p.width / 2,
    y: p.y + p.height / 2,
  });
  expect(hit, "the play button is the topmost thing at its centre").toBe(true);
}

/** The spread of luma (0..255) over the frame as painted, but its edges and
 *  the play button: a few units for an empty frame, far more for a picture. */
async function lumaSpread(el: Locator): Promise<number> {
  const b = await box(el);
  const img = await loadImage(await el.screenshot());
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = img.width / b.width;
  const edge = Math.ceil(8 * px);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const [bx, by, br] = [img.width / 2, img.height * 0.4, 40 * px];
  let min = 255;
  let max = 0;
  for (let y = edge; y < img.height - edge; y++) {
    for (let x = edge; x < img.width - edge; x++) {
      if (Math.abs(x - bx) < br && Math.abs(y - by) < br) continue;
      const i = (y * img.width + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      min = Math.min(min, l);
      max = Math.max(max, l);
    }
  }
  return Math.round(max - min);
}

test.describe("the Vorschau's frame", TAG, () => {
  test("before the export: a 9:16 frame of the page's height, its video and the play button on it", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expectFrame(page, 9 / 16);
    await expectPlayButtonOnTop(page);
  });

  test("finished: the same frame, showing the export's still", async ({ page, stub }) => {
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    await expect(frame(page)).toHaveAttribute("data-still", "thumbnail", { timeout: 15_000 });
    await expectFrame(page, 9 / 16);
    await expectPlayButtonOnTop(page);
    await expect.poll(() => lumaSpread(frame(page)), { timeout: 15_000 }).toBeGreaterThan(40);
  });

  test("a preview that couldn't be made: the note inside the frame", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await page.route(`${API}/jobs/${job.id}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      Object.assign(body, { status: "processing", stage: "render.encode", preview_status: "failed", preview_error: "encode_failed" });
      return route.fulfill({ response: res, body: JSON.stringify(body) });
    });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    const f = await box(frame(page));
    expect(f.width).toBeGreaterThan(100);
    const chip = await box(page.getByTestId("preview-unavailable"));
    expect(chip.x).toBeGreaterThanOrEqual(f.x);
    expect(chip.x + chip.width).toBeLessThanOrEqual(f.x + f.width + 0.5);
  });

  test("while the page loads: the frame's placeholder, as large as the frame", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    const held = await holdRequests(page, `${API}/jobs/${job.id}`, "GET");
    await page.goto(`/app/p/${job.id}`);
    await held.held;
    const placeholder = page.getByTestId("project-loading").locator("[data-shape] > div:first-child > div");
    await expect(placeholder).toBeVisible();
    const p = await box(placeholder);
    expect(p.width, `placeholder ${p.width} x ${p.height}`).toBeGreaterThan(100);
    expect(Math.abs(p.width / p.height - 9 / 16)).toBeLessThan(0.02);
    await held.release();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
    const f = await expectFrame(page, 9 / 16);
    expect(Math.abs(f.height - p.height)).toBeLessThan(2);
  });

  test("a landscape video exported as Original: the wide frame, 16:9", async ({ page, stub }) => {
    const job = await stub.seed("review_land", { settings: ORIGINAL });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await expectFrame(page, 16 / 9);
    await expectPlayButtonOnTop(page);
  });
});
