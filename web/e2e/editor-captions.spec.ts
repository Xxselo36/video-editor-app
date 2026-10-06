/**
 * Live captions in the v2 editor (UT5): the Style tab switches the
 * preview's captions (the export's engine) and saves the doc's style; a
 * caption is moved and resized right in the preview, "Nur hier | Überall"
 * and "Zurücksetzen" write the per-caption or the style's position / size,
 * the Text tab marks the row; and the preview shows the first frame of the
 * cut before playback (poster, or a seek without one).
 * Desktop and pixel7; runs against a v2 build (NEXT_PUBLIC_EDITOR_V2 unset or 1)
 * (E2E_EDITOR_V2=1). The browser opts in to the v2 captions (?captions=v2;
 * the stub runs CLEO_CAPTION_ENGINE=optin, stub_server.py).
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Page } from "@playwright/test";
import { expect, test, type Stub } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const STORAGE = { "cleocuts.editor.tourDone.v1": "1", "cleocuts.captions.engine.v1": "v2" };

type Hook = {
  ready: boolean;
  preset: string | null;
  t: number | null;
  page: string | null;
  pageId: string | null;
  adjust: { y: number; sizeScale: number; own: boolean } | null;
  selected: string | null;
};
const hook = (page: Page) => page.evaluate(() => (window as unknown as { __captionLayer?: Hook }).__captionLayer ?? null);
const isPhone = (page: Page) => page.getByTestId("editor-v2").evaluate((el) => el.getAttribute("data-layout") !== "desktop");

type Overrides = { y?: number; sizeScale?: number; wordsPerPage?: number | string; captions?: Record<string, { y?: number; sizeScale?: number }> };
const savedStyle = async (stub: Stub, id: string) =>
  (await stub.doc(id)).doc.style as unknown as { presetId: string; overrides: Overrides };

async function openLive(page: Page, jobId: string) {
  await openWithStorage(page, `/app/edit/${jobId}?captions=v2`, STORAGE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("caption-layer")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await hook(page))?.ready, { timeout: 30_000 }).toBe(true);
}

/** Pause on a moment with a caption (the second sentence). */
async function showCaption(page: Page, t = 4.6) {
  await page.getByTestId("editor-video").evaluate((v, at) => {
    const el = v as HTMLVideoElement;
    el.pause();
    el.currentTime = at;
  }, t);
  await expect.poll(async () => (await hook(page))?.page ?? null, { timeout: 15_000 }).not.toBeNull();
}

async function openStyle(page: Page) {
  await page.getByTestId("ed-tab-style").click();
  await expect(page.getByTestId("ed-style")).toHaveAttribute("data-live", "1");
}

async function closeSheet(page: Page) {
  if (await isPhone(page)) await page.getByRole("button", { name: "Close" }).first().click();
}

/** Drag with the mouse (pointer events) from the centre of `testId` by dx, dy. */
async function drag(page: Page, testId: string, dx: number, dy: number) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test.describe("editor v2: live captions and the Style tab", TAG, () => {
  test("choose a style: the preview switches at once, the doc saves it, undo brings the old one back", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await showCaption(page);
    const before = (await hook(page))!.preset;
    await openStyle(page);
    // all twelve live, three recommended on top, nothing greyed for English
    await expect(page.getByTestId("ed-style-recommended").getByRole("button")).toHaveCount(3);
    await expect(page.locator("[data-testid^=ed-tile-]:not([data-testid=ed-tile-none])")).toHaveCount(12);
    await expect(page.locator("[data-testid^=ed-tile-]:disabled")).toHaveCount(0);
    // tiles are drawn by the engine (no PNG previews)
    await expect(page.getByTestId("ed-tile-power")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
    await page.getByTestId("ed-tile-karaoke").click();
    await expect(page.getByTestId("ed-tile-karaoke")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await hook(page))?.preset, { timeout: 5_000 }).toBe("karaoke");
    await expect.poll(async () => (await savedStyle(stub, job.id)).presetId, { timeout: 10_000 }).toBe("karaoke");
    // Off: no caption drawn
    await page.getByTestId("ed-tile-none").click();
    await expect.poll(async () => (await hook(page))?.preset).toBe("none");
    await expect.poll(async () => (await savedStyle(stub, job.id)).presetId, { timeout: 10_000 }).toBe("none");
    // undo twice (the editor's one history): karaoke, then the style it opened with
    await closeSheet(page);
    await page.getByTestId("ed-undo").click();
    await expect.poll(async () => (await hook(page))?.preset).toBe("karaoke");
    await page.getByTestId("ed-undo").click();
    await expect.poll(async () => (await hook(page))?.preset).toBe(before);
    await expect.poll(async () => (await savedStyle(stub, job.id)).presetId, { timeout: 10_000 }).toBe(before);
  });

  test("Customize: collapsed; words per caption and size change the preview and the doc", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await openStyle(page);
    await expect(page.getByTestId("ed-style-words")).toHaveCount(0);
    await page.getByTestId("ed-style-customize").click();
    await page.getByTestId("ed-style-words").getByRole("button", { name: "1", exact: true }).click();
    await expect.poll(async () => (await savedStyle(stub, job.id)).overrides.wordsPerPage, { timeout: 10_000 }).toBe(1);
    await page.getByTestId("ed-style-reset").click();
    await expect.poll(async () => (await savedStyle(stub, job.id)).overrides.wordsPerPage ?? null, { timeout: 10_000 }).toBeNull();
  });

  test("move a caption: Nur hier, the dot in the Text tab, after a reload; Überall; Zurücksetzen", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await showCaption(page);
    const id = (await hook(page))!.pageId!;
    const y0 = (await hook(page))!.adjust!.y;
    await page.getByTestId("caption-hit").click();
    await expect(page.getByTestId("caption-box")).toBeVisible();
    await expect(page.getByTestId("caption-zone")).toHaveCount(5); // button zones while selected
    await expect(page.getByTestId("caption-scope-here")).toHaveAttribute("aria-pressed", "true");
    const frameH = (await page.getByTestId("caption-layer").boundingBox())!.height;
    await drag(page, "caption-box", 0, -0.25 * frameH);
    // only this caption moved: the doc holds its own y under its first word's id
    await expect
      .poll(async () => (await savedStyle(stub, job.id)).overrides.captions?.[id]?.y ?? null, { timeout: 10_000 })
      .not.toBeNull();
    const own = (await savedStyle(stub, job.id)).overrides;
    expect(own.captions![id].y!).toBeLessThan(y0 - 0.15);
    expect(own.y).toBeUndefined();
    await expect.poll(async () => (await hook(page))?.adjust?.own).toBe(true);
    // the Text tab marks the row
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("caption-box")).toHaveCount(0);
    await page.getByTestId("ed-tab-text").click();
    await expect(page.getByTestId("ed-row-adjusted")).toHaveCount(1);
    await closeSheet(page);
    // after a reload the caption is still up there
    await page.reload();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect.poll(async () => (await hook(page))?.ready, { timeout: 30_000 }).toBe(true);
    await showCaption(page);
    await expect.poll(async () => (await hook(page))?.adjust).toMatchObject({ own: true, y: own.captions![id].y });
    // Überall: the style moves there, the caption follows the style again, no dot
    await page.getByTestId("caption-hit").click();
    await page.getByTestId("caption-scope-all").click();
    await expect
      .poll(async () => (await savedStyle(stub, job.id)).overrides.y ?? null, { timeout: 10_000 })
      .toBeCloseTo(own.captions![id].y!, 3);
    expect((await savedStyle(stub, job.id)).overrides.captions?.[id]).toBeUndefined();
    // Zurücksetzen (Überall): the style's own position again
    await page.getByTestId("caption-reset").click();
    await expect.poll(async () => (await savedStyle(stub, job.id)).overrides.y ?? null, { timeout: 10_000 }).toBeNull();
    await expect.poll(async () => (await hook(page))?.adjust).toMatchObject({ own: false, y: y0 });
    await page.keyboard.press("Escape");
    await page.getByTestId("ed-tab-text").click();
    await expect(page.getByTestId("ed-row-adjusted")).toHaveCount(0);
  });

  test("resize a caption with the corner: drag, then a click steps the size; reset", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await showCaption(page);
    const id = (await hook(page))!.pageId!;
    await page.getByTestId("caption-hit").click();
    await drag(page, "caption-size", 40, 20);
    await expect
      .poll(async () => (await savedStyle(stub, job.id)).overrides.captions?.[id]?.sizeScale ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(1.05);
    await expect.poll(async () => (await hook(page))?.adjust?.sizeScale ?? 0).toBeGreaterThan(1.05);
    // a click (no drag) steps to the next size: 90 / 100 / 115 %
    const was = (await hook(page))!.adjust!.sizeScale;
    await page.getByTestId("caption-size").click();
    await expect.poll(async () => (await hook(page))?.adjust?.sizeScale).not.toBe(was);
    // Zurücksetzen (Nur hier): the caption follows the style again
    await page.getByTestId("caption-reset").click();
    await expect
      .poll(async () => (await savedStyle(stub, job.id)).overrides.captions ?? null, { timeout: 10_000 })
      .toBeNull();
    await expect.poll(async () => (await hook(page))?.adjust?.own).toBe(false);
  });
});

test.describe("editor v2: a selected caption (review 7/8/9)", TAG, () => {
  test("a seek ends the selection; a drag never changes a caption that isn't on screen", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await showCaption(page);
    const first = (await hook(page))!.pageId!;
    await page.getByTestId("caption-hit").click();
    await expect(page.getByTestId("caption-box")).toBeVisible();
    // the playhead moves (a word in the Text tab, the timeline, a key): selection gone
    await page.getByTestId("editor-video").evaluate((v) => {
      (v as HTMLVideoElement).currentTime = 11.5;
    });
    await expect(page.getByTestId("caption-box")).toHaveCount(0);
    await expect.poll(async () => (await hook(page))?.pageId ?? null, { timeout: 15_000 }).not.toBe(first);
    // selecting now takes the caption on screen
    await page.getByTestId("caption-hit").click();
    const now = (await hook(page))!.pageId!;
    expect((await hook(page))!.selected).toBe(now);
    const frameH = (await page.getByTestId("caption-layer").boundingBox())!.height;
    await drag(page, "caption-box", 0, -0.2 * frameH);
    await expect.poll(async () => Object.keys((await savedStyle(stub, job.id)).overrides.captions ?? {}), { timeout: 10_000 }).toEqual([now]);
  });

  test("Escape mid-drag cancels it: nothing saved, no shifted preview", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await showCaption(page);
    await page.getByTestId("caption-hit").click();
    const box = (await page.getByTestId("caption-box").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.getByTestId("caption-box")).toHaveCount(0);
    expect(await page.getByTestId("caption-canvas").evaluate((c) => (c as HTMLCanvasElement).style.transform)).toBe("");
    await page.waitForTimeout(1200); // the debounced autosave would have run
    expect((await savedStyle(stub, job.id)).overrides.captions).toBeUndefined();
    // a new one-finger drag works again (no stale pointers)
    await page.getByTestId("caption-hit").click();
    const frameH = (await page.getByTestId("caption-layer").boundingBox())!.height;
    await drag(page, "caption-box", 0, -0.2 * frameH);
    await expect.poll(async () => Object.keys((await savedStyle(stub, job.id)).overrides.captions ?? {}).length, { timeout: 10_000 }).toBe(1);
  });

  test("Escape elsewhere is not the caption's: renaming the title can still be cancelled", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard");
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await showCaption(page);
    await page.getByTestId("caption-hit").click();
    const before = await page.getByTestId("ed-title").innerText();
    await page.getByTestId("ed-title").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Changed title");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ed-title")).toHaveText(before);
  });
});

test.describe("editor v2: the first frame before playback", TAG, () => {
  /** The video has a decoded frame of its own (not only the poster), and where. */
  const frameState = (page: Page) =>
    page.getByTestId("editor-video").evaluate((v) => {
      const el = v as HTMLVideoElement;
      return { ok: el.readyState >= 2 && el.videoWidth > 0, t: el.currentTime, paused: el.paused };
    });
  /** Mean luma of the preview as painted (the video is cross-origin: a screenshot, not getImageData). */
  async function luma(page: Page): Promise<number> {
    const img = await loadImage(await page.getByTestId("editor-video").screenshot());
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 4);
  }

  test("with the analysis' poster: shown until the video has its frame at the first clip", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    let posterAsked = false;
    page.on("request", (r) => {
      if (r.url().includes(`/jobs/${job.id}/poster`)) posterAsked = true;
    });
    // no caption opt-in: every v2 editor gets the still
    await openWithStorage(page, `/app/edit/${job.id}`, { "cleocuts.editor.tourDone.v1": "1" });
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("editor-video")).toHaveAttribute("preload", "metadata");
    await expect.poll(() => posterAsked, { timeout: 15_000 }).toBe(true);
    const first = (await stub.job(job.id))!.edit_segments[0]?.start ?? 0;
    await expect.poll(() => frameState(page), { timeout: 20_000 }).toMatchObject({ ok: true, paused: true });
    expect(Math.abs((await frameState(page)).t - Math.max(0.001, first))).toBeLessThan(0.05);
    // the poster goes once the video has a frame (after edits it may show an old first clip)
    await expect(page.getByTestId("editor-video")).not.toHaveAttribute("poster", /.+/);
    expect(await luma(page)).toBeGreaterThan(20); // a picture, not black
  });

  test("without a poster: the video preloads and seeks to the first clip, captions on the still", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { poster: false });
    await openLive(page, job.id);
    await expect(page.getByTestId("editor-video")).toHaveAttribute("preload", "auto");
    await expect(page.getByTestId("editor-video")).not.toHaveAttribute("poster", /.+/);
    await expect.poll(() => frameState(page), { timeout: 20_000 }).toMatchObject({ ok: true, paused: true });
    expect(await luma(page)).toBeGreaterThan(20);
    // the caption layer drew that still: output time 0, the start of the cut
    await expect.poll(async () => (await hook(page))?.t ?? null, { timeout: 15_000 }).toBeCloseTo(0, 2);
  });
});
