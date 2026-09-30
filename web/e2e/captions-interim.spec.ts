/**
 * Interim preview captions (UT1): the caption engine draws the job's
 * captions on a canvas over the editor video. Needs a build with
 * NEXT_PUBLIC_CAPTIONS_INTERIM=1 and NEXT_PUBLIC_TEST_PAGES=1 (the test
 * hook window.__captionsInterim); playwright.config.ts and CI build so.
 *
 * Grid clip (backend/tests/stub_media.py): clips [0,6] [7,14] [15,22]
 * [23,30], "Satz N hier." at clip start +0.5 … +2.5 s, one unit per line,
 * split by the overlay into words by length: "Satz" +0.5–1.3, "N"
 * +1.3–1.5, "hier." +1.5–2.5 (source time).
 */
import { expect, test } from "./support/fixtures";
import { editorVideo, openEditor, playbackMode, userSeek, waitForMetadata } from "./support/app";
import type { Page, Route } from "@playwright/test";

type Hook = {
  fontsReady: boolean;
  fontsOk: boolean;
  preset: string;
  draws: number;
  t: number | null;
  page: string | null;
  active: string | null;
  W: number;
  H: number;
};

const hook = (page: Page) => page.evaluate(() => (window as unknown as { __captionsInterim?: Hook }).__captionsInterim ?? null);
const canvas = (page: Page) => page.getByTestId("caption-canvas");

/** Opaque pixels on the caption canvas, and a hash of them. */
const pixels = (page: Page) =>
  canvas(page).evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let h = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 0) n++;
      h = (h * 31 + d[i] + d[i - 1] + d[i - 2]) | 0;
    }
    return { opaque: n, hash: h };
  });

async function editor(page: Page, jobId: string, mode: "proxy" | "preview") {
  await openEditor(page, jobId);
  await expect.poll(() => playbackMode(page), { timeout: 15_000 }).toBe(mode);
  await waitForMetadata(page);
}

/** Seek (paused) and wait until the overlay drew that time. */
async function activeAt(page: Page, t: number, source = t) {
  await userSeek(page, t);
  await expect.poll(async () => (await hook(page))?.t ?? null).toBeCloseTo(source, 1);
  return (await hook(page))!;
}

test.describe("interim preview captions", () => {
  test("the canvas covers the video's picture, aria-hidden, at × min(DPR, 2)", async ({ page, stub }) => {
    for (const [seed, mode] of [
      ["review", "preview"],
      ["review_speech", "proxy"],
    ] as const) {
      const job = await stub.seed(seed);
      await editor(page, job.id, mode);
      await expect(canvas(page)).toHaveAttribute("aria-hidden", "true");
      await expect.poll(async () => (await hook(page))?.fontsReady).toBe(true);
      const geo = await page.evaluate(() => {
        const v = document.querySelector('[data-testid="editor-video"]') as HTMLVideoElement;
        const c = document.querySelector('[data-testid="caption-canvas"]') as HTMLCanvasElement;
        const r = v.getBoundingClientRect();
        const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
        const w = v.videoWidth * s;
        const h = v.videoHeight * s;
        const content = { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, w, h };
        const cr = c.getBoundingClientRect();
        return {
          content,
          canvas: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
          backing: { W: c.width, H: c.height },
          dpr: Math.min(window.devicePixelRatio, 2),
        };
      });
      expect(geo.canvas.w).toBeGreaterThan(50);
      for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(geo.canvas[k] - geo.content[k])).toBeLessThan(1.5);
      expect(Math.abs(geo.backing.W - geo.canvas.w * geo.dpr)).toBeLessThan(1.5);
      expect(Math.abs(geo.backing.H - geo.canvas.h * geo.dpr)).toBeLessThan(1.5);
      // Clipper: the look of the export, no "Preview" chip.
      expect((await hook(page))!.preset).toBe("clipper");
      await expect(page.getByTestId("caption-preview-chip")).toHaveCount(0);
      await expect(page.getByTestId("caption-overlay")).toHaveCount(0);
    }
  });

  test("the active word changes at the stub's word times (preview and proxy)", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "off" });
    await editor(page, job.id, "preview");
    await expect.poll(async () => (await hook(page))?.fontsReady).toBe(true);
    // ±1 frame (30 fps) around the word starts 0.5, 1.3, 1.5
    expect((await activeAt(page, 0.45)).page).toBeNull();
    expect((await activeAt(page, 0.54)).active).toBe("Satz");
    expect((await activeAt(page, 1.26)).active).toBe("Satz");
    expect((await activeAt(page, 1.34)).active).toBe("1");
    expect((await activeAt(page, 1.46)).active).toBe("1");
    const h = await activeAt(page, 1.54);
    expect(h.active).toBe("hier.");
    expect(h.page).toBe("Satz 1 hier.");
    // After the 6–7 cut the preview's 6.9 s is source 7.9 s.
    const next = await activeAt(page, 6.9, 7.9);
    expect([next.page, next.active]).toEqual(["Satz 2 hier.", "Satz"]);

    const proxyJob = await stub.seed("review", { proxy: "on" });
    await editor(page, proxyJob.id, "proxy");
    await expect.poll(async () => (await hook(page))?.fontsReady).toBe(true);
    expect((await activeAt(page, 8.26)).active).toBe("Satz");
    expect((await activeAt(page, 8.34)).active).toBe("2");
    expect((await activeAt(page, 8.54)).active).toBe("hier.");
  });

  test("editing a sentence changes the drawn caption", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "on" });
    await editor(page, job.id, "proxy");
    await expect.poll(async () => (await hook(page))?.fontsReady).toBe(true);
    await activeAt(page, 1.0);
    await expect.poll(async () => (await hook(page))?.page).toBe("Satz 1 hier.");
    const before = await pixels(page);
    expect(before.opaque).toBeGreaterThan(100);

    await page.getByTestId("editor-tab-transcript").click();
    await page.getByTestId("transcript-line").first().getByRole("textbox").fill("Hallo Welt");
    await expect.poll(async () => (await hook(page))?.page).toBe("Hallo Welt");
    await expect.poll(async () => (await pixels(page)).hash).not.toBe(before.hash);
    expect((await pixels(page)).opaque).toBeGreaterThan(100);
  });

  test("nothing is drawn before the caption fonts are loaded", async ({ page, stub }) => {
    const held: Route[] = [];
    let release = false;
    await page.route("**/fonts/captions/**", (route) => (release ? route.continue() : void held.push(route)));
    const job = await stub.seed("review", { proxy: "on" });
    await editor(page, job.id, "proxy");
    await userSeek(page, 1.0);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const h = await hook(page);
    expect(h?.fontsReady).toBe(false);
    expect(h?.draws).toBe(0);
    expect((await pixels(page)).opaque).toBe(0);

    release = true;
    for (const r of held.splice(0)) await r.continue();
    await expect.poll(async () => (await hook(page))?.draws ?? 0).toBeGreaterThan(0);
    const after = (await hook(page))!;
    expect(after.fontsOk).toBe(true);
    expect(after.page).toBe("Satz 1 hier.");
    // Drawn in the style's font, not a fallback.
    const bangers = await page.evaluate(() =>
      [...document.fonts].some((f) => f.family.replace(/"/g, "") === "cc-bangers-400-latin" && f.status === "loaded"),
    );
    expect(bangers).toBe(true);
    expect((await pixels(page)).opaque).toBeGreaterThan(100);
  });

  test("caption fonts that fail (offline): nothing drawn, no error; back online: drawn", async ({ page, stub }) => {
    let fail = true;
    await page.route("**/fonts/captions/**", (route) => (fail ? route.abort("internetdisconnected") : route.continue()));
    const job = await stub.seed("review", { proxy: "on" });
    await editor(page, job.id, "proxy");
    await userSeek(page, 1.0);
    await page.waitForTimeout(800);
    const h = await hook(page);
    expect(h?.fontsReady).toBe(false);
    expect(h?.draws).toBe(0);
    expect((await pixels(page)).opaque).toBe(0);
    // Back online: the overlay asks again and draws (pageErrors: no throw).
    fail = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await hook(page))?.draws ?? 0).toBeGreaterThan(0);
    expect((await hook(page))?.fontsOk).toBe(true);
  });

  test("a clean job: Minimal style at the export's position, with the Preview chip", async ({ page, stub }) => {
    const job = await stub.seed("review", { proxy: "on", caption_preset: "clean" });
    await editor(page, job.id, "proxy");
    await expect.poll(async () => (await hook(page))?.fontsReady).toBe(true);
    expect((await hook(page))!.preset).toBe("minimal");
    const chip = page.getByTestId("caption-preview-chip");
    await expect(chip).toHaveText(/preview/i);
    await expect(chip).toHaveAttribute("title", /export may differ slightly/);
    await activeAt(page, 1.0);
    // Pixels only in a band around y = 0.70 of the picture.
    const rows = await canvas(page).evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let top = c.height;
      let bottom = -1;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++)
          if (d[(y * c.width + x) * 4 + 3] > 0) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
      return { top: top / c.height, bottom: bottom / c.height };
    });
    expect(rows.bottom).toBeGreaterThan(rows.top);
    expect((rows.top + rows.bottom) / 2).toBeGreaterThan(0.6);
    expect((rows.top + rows.bottom) / 2).toBeLessThan(0.8);
    await expect(editorVideo(page)).toBeVisible();
  });
});
