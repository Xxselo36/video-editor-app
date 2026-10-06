/**
 * Timeline filmstrip (UX7b): every clip shows the frames of its own source
 * range from the job's sprite (GET /jobs/{id}/filmstrip), at the clip's
 * height (52 px desktop, 80 px phone), drawn for the visible window only;
 * a job from before the filmstrip gets one made on request. Runs against a
 * v2 build (NEXT_PUBLIC_EDITOR_V2 unset or 1; E2E_EDITOR_V2=1).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { API } from "./support/env";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };

type Meta = { n: number; interval: number; tileW: number; tileH: number };

async function openV2(page: Page, jobId: string) {
  await openWithStorage(page, `/app?job=${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
}

/** Every drawn tile: its clip, sprite index, box and background. */
function tiles(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="ed-film"] [data-tile]')).map((el) => {
      const clip = el.closest<HTMLElement>("[data-seg]")!;
      const r = el.getBoundingClientRect();
      const film = el.parentElement!;
      return {
        clip: clip.dataset.testid!,
        idx: Number(el.dataset.tile),
        x: r.x,
        w: r.width,
        h: r.height,
        clipX: clip.getBoundingClientRect().x,
        clipH: clip.getBoundingClientRect().height,
        src: getComputedStyle(film).getPropertyValue("--film-src"),
        bg: getComputedStyle(el).backgroundImage,
      };
    }),
  );
}

test.describe("editor v2 filmstrip", TAG, () => {
  test("clips show the frames of their source range at the clip height", async ({ page, stub }, info) => {
    const job = await stub.seed("review_speech");
    const meta: Meta = (await (await page.request.get(`${API}/jobs/${job.id}`)).json()).filmstrip;
    expect(meta).toMatchObject({ interval: 1, tileH: 90 });
    const sprite: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes(`/jobs/${job.id}/filmstrip`)) sprite.push(r.url());
    });
    await openV2(page, job.id);
    await expect(page.getByTestId("ed-film").first()).toBeVisible({ timeout: 30_000 });

    const all = await tiles(page);
    const clipH = info.project.name === "pixel7" ? 80 : 52;
    expect(all.length).toBeGreaterThan(0);
    for (const t of all) {
      expect(t.h).toBeCloseTo(clipH, 0);
      expect(t.clipH).toBeCloseTo(clipH, 0);
      // the sprite tile scaled to the clip height
      expect(t.w).toBeCloseTo(Math.ceil((meta.tileW * clipH) / meta.tileH), 0);
      expect(t.bg).toContain(`/jobs/${job.id}/filmstrip`);
      expect(t.idx).toBeGreaterThanOrEqual(0);
      expect(t.idx).toBeLessThan(meta.n);
    }
    // each clip starts on the frame of its source start (in source order:
    // the tiles only move forward), and starts at the clip's left edge
    const segs = await stub.timeline(job.id);
    const firstOf = new Map<string, (typeof all)[number]>();
    for (const t of all) if (!firstOf.has(t.clip)) firstOf.set(t.clip, t);
    for (const [clip, t] of firstOf) {
      const k = Number(clip.replace("clip-", ""));
      const [start, end] = segs[k];
      expect(t.x).toBeCloseTo(t.clipX, 0);
      expect(t.idx).toBeGreaterThanOrEqual(Math.floor(start / meta.interval));
      expect(t.idx).toBeLessThanOrEqual(Math.floor(end / meta.interval));
    }
    const order = all.map((t) => t.idx);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // one sprite request (the image is reused for every tile)
    expect(new Set(sprite).size).toBe(1);
  });

  test("only the visible window gets tiles while zoomed in", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "zoom slider: desktop dock");
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await expect(page.getByTestId("ed-film").first()).toBeVisible({ timeout: 30_000 });
    const zoom = page.getByTestId("ed-zoom");
    await zoom.fill("100");
    const scroll = page.getByTestId("timeline-scroll");
    const widths = await scroll.evaluate((el) => ({ content: el.scrollWidth, view: el.clientWidth }));
    expect(widths.content).toBeGreaterThan(widths.view * 4);
    await expect
      .poll(async () => {
        const all = await tiles(page);
        return all.length * (all[0]?.w ?? 0);
      })
      .toBeLessThan(widths.view * 3 + 2 * 256 + 400);
    // scroll to the end: the tiles follow, and show the end of the video
    await scroll.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    const segs = await stub.timeline(job.id);
    const lastEnd = segs[segs.length - 1][1];
    const lastTile = async () => Math.max(...(await tiles(page)).map((t) => t.idx));
    await expect.poll(lastTile).toBeGreaterThanOrEqual(Math.floor(lastEnd) - 1);
    expect(await lastTile()).toBeLessThanOrEqual(Math.floor(lastEnd));
  });

  test("a job from before the filmstrip gets one made on request", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { filmstrip: false });
    expect((await (await page.request.get(`${API}/jobs/${job.id}`)).json()).filmstrip).toBeNull();
    await openV2(page, job.id);
    await expect(page.getByTestId("ed-film").first()).toBeVisible({ timeout: 45_000 });
    const meta = (await (await page.request.get(`${API}/jobs/${job.id}`)).json()).filmstrip;
    expect(meta).toMatchObject({ interval: 1, tileH: 90 });
  });

  test("no sprite, no tiles: the clips stay plain", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { filmstrip: false });
    await page.route(`**/jobs/${job.id}/filmstrip**`, (r) =>
      r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"filmstrip_unavailable"}' }),
    );
    await openV2(page, job.id);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("ed-film")).toHaveCount(0);
    await expect(page.getByTestId("ed-timeline").getByTestId("clip-0")).toBeVisible();
  });
});
