/**
 * The trim flow round (owner report from his iPhone and Mac: "beim
 * Anpassen der Länge … Vorschau hat gedauert, Timeline entsprach nicht
 * mehr dem Video, Untertitel fielen aus … alles im Flow"):
 *   - a trim handle held and released without a move commits nothing (no
 *     undo step, no save, no preview rebuild);
 *   - the START handle stays under the finger like the end handle, and
 *     zoomed in the released edge stays where it was let go;
 *   - a second trim reaches the server as soon as the first is stored —
 *     not after the first one's preview re-encode — and "Saved" shows only
 *     once the server has the timeline on screen;
 *   - preview mode (production today: no proxy): while the rebuild runs,
 *     playing never shows the footage a trim removed; the rebuilt file
 *     comes in on the same source moment; the chip stays until it is
 *     there;
 *   - the timeline opens zoomed to its first minute (owner request; the
 *     test build shortens the span, the clips are 30 s), trims work at
 *     that zoom on touch and desktop;
 *   - phone: on a short clip the start handle is the start handle.
 * Desktop and pixel7 (touch via CDP touch events); a v2 build
 * (E2E_EDITOR_V2=1).
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test, type Stub } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1", "cleocuts.voiceOnboardingSeen.v1": "1" };
const SAVED = { timeout: 15_000 };

const isPhone = (page: Page) => page.getByTestId("editor-v2").evaluate((el) => el.getAttribute("data-layout") !== "desktop");
const clipsOf = (page: Page) => page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
const video = (page: Page) => page.getByTestId("editor-video");

async function open(page: Page, jobId: string, storage: Record<string, string> = {}) {
  await openWithStorage(page, `/app/edit/${jobId}`, { ...TOUR_DONE, ...storage });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(clipsOf(page).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => video(page).evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
}

/** Pointer down at (x, y); `to(x)` moves it; `up()` releases. Mouse on desktop, CDP touch on the phone. */
async function press(page: Page, x: number, y: number) {
  if (await isPhone(page)) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    return {
      to: async (nx: number, steps = 8) => {
        for (let i = 1; i <= steps; i++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + ((nx - x) * i) / steps, y }] });
          await page.waitForTimeout(16);
        }
        x = nx;
      },
      up: async () => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      },
    };
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  return {
    to: async (nx: number, steps = 8) => {
      await page.mouse.move(nx, y, { steps });
      x = nx;
    },
    up: async () => {
      await page.mouse.up();
    },
  };
}

async function select(page: Page, i: number) {
  const clip = clipsOf(page).nth(i);
  await clip.scrollIntoViewIfNeeded();
  const b = (await clip.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(clip).toHaveAttribute("data-selected", "true");
  return clip;
}

const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** The element's x once it stopped moving (a render behind a busy main thread). */
async function settledX(loc: Locator, tries = 20): Promise<number> {
  let last = (await loc.boundingBox())!.x;
  for (let i = 0; i < tries; i++) {
    await loc.page().waitForTimeout(60);
    const x = (await loc.boundingBox())!.x;
    if (Math.abs(x - last) < 0.25) return x;
    last = x;
  }
  return last;
}
const editPosts = (page: Page) => {
  const posts: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/edit-segments$/.test(r.url())) posts.push(Date.now());
  });
  return posts;
};

test.describe("editor v2: the trim flow (owner report)", TAG, () => {
  test("a trim handle held and released without a move commits nothing", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const posts = editPosts(page);
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    // held still: the magnifier opens (a look, not an edit)
    await expect(page.getByTestId("timeline-scroll")).toHaveAttribute("data-magnified", "true", { timeout: 3_000 });
    await p.up();
    await expect(page.getByTestId("timeline-scroll")).not.toHaveAttribute("data-magnified", "true", { timeout: 3_000 });
    await page.waitForTimeout(1500);
    expect(posts).toEqual([]);
    await expect(page.locator('[data-testid="ed-undo"]:visible').first()).toBeDisabled();
    expect(await stub.timeline(job.id)).toEqual(before);
  });

  test("the start handle follows the finger; zoomed in, the released edge stays put", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    // opens showing 8 s: zoomed in, scrollable
    await open(page, job.id, { "cleocuts.test.openSpanS": "8" });
    const before = await stub.timeline(job.id);
    const strip = page.getByTestId("timeline-scroll");
    const total = before.reduce((a, [s0, e0]) => a + e0 - s0, 0);
    const pxPerS = (await strip.evaluate((el) => el.scrollWidth)) / total;
    // clip 3 (17.063–20.84 s), later in the strip: scrolled to
    const clip = await select(page, 3);
    expect(await strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(pxPerS * 1.5);
    const h0 = center((await clip.getByTestId("clip-trim-start").boundingBox())!);
    const left0 = (await clip.boundingBox())!.x;
    const p = await press(page, h0.x, h0.y);
    const off: number[] = [];
    for (const sec of [0.3, 0.6, 0.9, 1.2]) {
      const dx = Math.round(sec * pxPerS);
      await p.to(h0.x + dx, 6);
      // (under 0.5 s still: no magnifier, whose 0.01 s grid is 10 px)
      const x = await settledX(clip, 5);
      const grid = (await strip.getAttribute("data-magnified")) ? 6 : 3;
      off.push(x - left0 - dx);
      // the clip's left edge moved with the pointer (the 0.01 s grid: ≤ ~2 px)
      expect(Math.abs(x - left0 - dx), off.join(" ")).toBeLessThanOrEqual(grid);
    }
    const released = await settledX(clip);
    await p.up();
    await page.waitForTimeout(300);
    // the strip closed up around the edge: it stays where it was let go
    expect(Math.abs((await settledX(clip)) - released)).toBeLessThanOrEqual(4);
    // stored (shorter: by 1.2 s, or less where a slow run held still long enough to magnify)
    await expect.poll(async () => (await stub.timeline(job.id))[3][0] > before[3][0] + 0.1, SAVED).toBe(true);
  });

  test("holding still magnifies around the edge: it stays under the finger, a 1 px move is a millisecond", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const clip = await select(page, 1);
    const handle = clip.getByTestId("clip-trim-end");
    const h = center((await handle.boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 30);
    const strip = page.getByTestId("timeline-scroll");
    await expect(strip).toHaveAttribute("data-magnified", "true", { timeout: 3_000 });
    await page.waitForTimeout(500); // the zoom animation (180 ms)
    const hx = center((await handle.boundingBox())!).x;
    // the edge stayed by the finger (it was drawn 140–750 px away)
    expect(Math.abs(hx - (h.x - 30))).toBeLessThanOrEqual(24);
    const readout = page.getByTestId("ed-trim-readout");
    const r1 = parseFloat(((await readout.textContent()) ?? "").replace(",", "."));
    await p.to(h.x - 31, 1);
    await page.waitForTimeout(100);
    const r2 = parseFloat(((await readout.textContent()) ?? "").replace(",", "."));
    // 1000 px/s: one pixel is a millisecond — the readout (the edge's frame,
    // 2 decimals) moves at most to the next frame; it jumped 0.13–0.17 s
    expect(Math.abs(r2 - r1)).toBeLessThanOrEqual(0.045);
    await p.up();
  });

  test("zoomed in, a trim at the view's edge scrolls the strip along", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id, { "cleocuts.test.openSpanS": "8" });
    const before = await stub.timeline(job.id);
    const strip = page.getByTestId("timeline-scroll");
    // clip 4 (21.74–29.304 s): its end handle mid-view, then dragged to the left edge and held
    const clip = await select(page, 4);
    const view = (await strip.boundingBox())!;
    const dx0 = (await clip.getByTestId("clip-trim-end").boundingBox())!.x - (view.x + view.width / 2);
    await strip.evaluate((el, d) => (el.scrollLeft += d), dx0);
    await page.waitForTimeout(200);
    const sl1 = await strip.evaluate((el) => el.scrollLeft);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(view.x + 6, 10);
    await page.waitForTimeout(1200);
    // the strip scrolled along (it stopped at the view's edge before)
    expect(await strip.evaluate((el) => el.scrollLeft)).toBeLessThan(sl1 - 30);
    await p.up();
    // shorter than the pointer alone could make it in the view
    const total = before.reduce((a, [s0, e0]) => a + e0 - s0, 0);
    const pxPerS = (await strip.evaluate((el) => el.scrollWidth)) / total;
    const dragged = (h.x - (view.x + 6)) / pxPerS;
    await expect.poll(async () => (await stub.timeline(job.id))[4][1], SAVED).toBeLessThan(before[4][1] - dragged - 0.1);
  });

  test("a second trim reaches the server once the first is stored, not after its preview re-encode; Saved means stored", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { slow_rebuild: 8 });
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const phone = await isPhone(page);
    const trimEnd = async (i: number, dx: number) => {
      const clip = await select(page, i);
      const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
      const p = await press(page, h.x, h.y);
      await p.to(h.x + dx);
      await p.up();
    };
    await trimEnd(1, -30);
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < before[1][1] - 0.05, SAVED).toBe(true);
    // the first save's rebuild takes 8 s; the second edit must not wait for it
    const t0 = Date.now();
    await trimEnd(3, -30);
    if (!phone) await expect(page.getByTestId("ed-save-status")).not.toHaveAttribute("data-state", "saved");
    await expect.poll(async () => (await stub.timeline(job.id))[3][1] < before[3][1] - 0.05, { timeout: 7_000 }).toBe(true);
    expect(Date.now() - t0).toBeLessThan(7_000);
    if (!phone) await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "saved", { timeout: 5_000 });
  });

  /** Preview mode: trim clip 1's end by ~1 s; the server's rebuild waits `slow` s. */
  async function previewTrim(page: Page, stub: Stub, slow: number) {
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: slow });
    await open(page, job.id);
    await expect(video(page)).toHaveAttribute("data-playback", "preview");
    const j0 = (await stub.job(job.id))!;
    const old = j0.preview_segments;
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    const total = old.reduce((a, [s0, e0]) => a + e0 - s0, 0);
    const pxPerS = (await page.getByTestId("timeline-scroll").evaluate((el) => el.scrollWidth)) / total;
    await p.to(h.x - Math.round(pxPerS * 1.0));
    await p.up();
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < old[1][1] - 0.5, SAVED).toBe(true);
    return { job, j0, old, newEnd: (await stub.timeline(job.id))[1][1] };
  }

  /** Source time on screen, through the segments of the file that plays. */
  const sourceNow = (page: Page, segs: [number, number][]) =>
    video(page).evaluate((el, ss) => {
      const v = el as HTMLVideoElement;
      let acc = 0;
      for (const [s0, e0] of ss) {
        if (v.currentTime <= acc + (e0 - s0)) return { src: s0 + (v.currentTime - acc), url: v.currentSrc };
        acc += e0 - s0;
      }
      return { src: -1, url: v.currentSrc };
    }, segs);

  test("preview mode: playing while the rebuild runs never shows the trimmed footage", async ({ page, stub }) => {
    // the rebuild doesn't come during this test: the old file plays
    const { old, newEnd } = await previewTrim(page, stub, 12);
    await expect(page.getByTestId("preview-updating")).toBeVisible();
    const seen = await video(page).evaluate(
      async (el, { oldSegs, from }) => {
        const v = el as HTMLVideoElement;
        const src = (t: number) => {
          let acc = 0;
          for (const [s, e] of oldSegs) {
            if (t <= acc + (e - s)) return s + (t - acc);
            acc += e - s;
          }
          return -1;
        };
        v.muted = true;
        v.currentTime = from;
        await new Promise((r) => setTimeout(r, 300));
        const out: number[] = [];
        const id = setInterval(() => out.push(src(v.currentTime)), 20);
        await v.play();
        await new Promise((r) => setTimeout(r, 2200));
        v.pause();
        clearInterval(id);
        return out;
      },
      { oldSegs: old, from: old[0][1] - old[0][0] + (newEnd - old[1][0]) - 0.8 },
    );
    // nothing between the new end and the old end played (one frame of slack)
    const removed = seen.filter((s) => s > newEnd + 0.08 && s < old[1][1] - 0.02);
    expect(removed, seen.map((s) => s.toFixed(2)).join(" ")).toEqual([]);
    expect(seen.some((s) => s >= old[2][0])).toBe(true);
    // still the old file: the chip stays
    await expect(page.getByTestId("preview-updating")).toBeVisible();
  });

  test("preview mode: the rebuilt file comes in on the same source moment", async ({ page, stub }) => {
    // the stub re-encodes the whole cut (VP8) in a pool shared with every
    // parallel test: the answer can take a while under load
    test.setTimeout(240_000);
    const { job, j0, old } = await previewTrim(page, stub, 1);
    // paused in clip 2 (after the trimmed end: the old cut time is off by the trim)
    const c2 = clipsOf(page).nth(2);
    const b2 = (await c2.boundingBox())!;
    await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.waitForTimeout(300);
    const before = await sourceNow(page, old);
    const oldFile = new RegExp(`[?&]v=${j0.preview_version}\\b`).test(before.url);
    await expect(page.getByTestId("preview-updating")).toBeHidden({ timeout: 200_000 });
    const j1 = (await stub.job(job.id))!;
    expect(j1.preview_version).toBeGreaterThan(j0.preview_version);
    await expect.poll(() => video(page).evaluate((el) => (el as HTMLVideoElement).readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);
    const after = await sourceNow(page, j1.preview_segments);
    expect(after.url).not.toBe(before.url);
    // (a server faster than the click: the new file was already there)
    if (oldFile) expect(Math.abs(after.src - before.src), `${before.src} → ${after.src}`).toBeLessThan(0.15);
  });

  test("preview mode: reopened while two rebuilds run, it follows them to the last one (not the first newer one)", async ({ page, stub }) => {
    test.setTimeout(240_000);
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: 4 });
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const trimEnd = async (i: number) => {
      const clip = await select(page, i);
      const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
      const p = await press(page, h.x, h.y);
      await p.to(h.x - 30);
      await p.up();
    };
    await trimEnd(1);
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < before[1][1] - 0.05, SAVED).toBe(true);
    await trimEnd(3);
    await expect.poll(async () => (await stub.timeline(job.id))[3][1] < before[3][1] - 0.05, SAVED).toBe(true);
    // both stored, both rebuilds still to come: reopen
    await page.reload();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(clipsOf(page).first()).toBeVisible({ timeout: 30_000 });
    // the server ends at the preview of the last save …
    await expect
      .poll(
        async () => {
          const j = (await stub.job(job.id))!;
          const ps = JSON.stringify(j.preview_segments.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]));
          return ps === JSON.stringify(j.edit_segments.map((x) => [+x.start.toFixed(3), +x.end.toFixed(3)]));
        },
        { timeout: 200_000 },
      )
      .toBe(true);
    const last = (await stub.job(job.id))!.preview_version;
    // … and so does the reopened editor (it stopped at the first newer one)
    await expect
      .poll(() => video(page).evaluate((el) => (el as HTMLVideoElement).currentSrc), { timeout: 30_000 })
      .toMatch(new RegExp(`[?&]v=${last}\\b`));
    await expect(page.getByTestId("preview-updating")).toBeHidden({ timeout: 10_000 });
  });

  test("at Fit an end trim's edge stays where it was let go (the zoom holds, no re-fit under the finger)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const clip = await select(page, 1);
    const handle = clip.getByTestId("clip-trim-end");
    const h = center((await handle.boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 80);
    const at = (await settledX(handle, 5)) + (await handle.boundingBox())!.width / 2;
    await p.up();
    await page.waitForTimeout(300);
    const after = (await settledX(handle)) + (await handle.boundingBox())!.width / 2;
    // it jumped ~29 px when the strip re-fitted to the shorter edit
    expect(Math.abs(after - at)).toBeLessThanOrEqual(3);
  });

  test("paused, a trim updates the player clock at once", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const clock = page.getByTestId("ed-playerbar");
    const total0 = ((await clock.textContent()) ?? "").match(/\/\s*(\d+:\d+)/)?.[1];
    const clip = await select(page, 4); // paused in clip 4
    await page.waitForTimeout(300);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 120);
    await p.up();
    // the clip shrank by seconds: the edit's length on the clock follows without a new frame
    await expect.poll(async () => ((await clock.textContent()) ?? "").match(/\/\s*(\d+:\d+)/)?.[1], { timeout: 2_000 }).not.toBe(total0);
  });

  test("export after a saved edit stores nothing again and waits for no preview rebuild (preview mode)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: 6 });
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 30);
    await p.up();
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < before[1][1] - 0.05, SAVED).toBe(true);
    if (!(await isPhone(page))) await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "saved", { timeout: 5_000 });
    const posts = editPosts(page);
    const render = page.waitForRequest((r) => r.method() === "POST" && /\/render$/.test(r.url()), { timeout: 30_000 });
    await page.getByTestId("ed-export").click();
    const t0 = Date.now();
    await page.getByTestId("export-confirm").click();
    await render;
    // the rebuild of the edit is still running (6 s): the export didn't wait for it, nor send it again
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(posts).toEqual([]);
  });

  test("a rebuild the server couldn't make says so, and Retry asks again (preview mode)", async ({ page, stub }) => {
    // the real rebuild after Retry shares the stub's pool with every parallel test
    test.setTimeout(240_000);
    const job = await stub.seed("review_speech", { proxy: "off" });
    await open(page, job.id);
    let fail = true;
    let posts = 0;
    await page.route(/\/edit-segments$/, async (route) => {
      posts++;
      if (!fail) return route.fallback();
      // stored on the server, answered at once as a rebuild that failed
      void route.fetch().catch(() => undefined);
      await page.waitForTimeout(300);
      await route.fulfill({ status: 200, json: { preview_ok: false, superseded: false } });
    });
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 30);
    await p.up();
    // not "Saved" and silence: the preview says it couldn't update
    const failed = page.getByTestId("preview-failed");
    await expect(failed).toBeVisible({ timeout: 30_000 });
    fail = false;
    const n = posts;
    await failed.click();
    await expect.poll(() => posts, { timeout: 10_000 }).toBeGreaterThan(n);
    await expect(failed).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("preview-updating")).toBeHidden({ timeout: 200_000 });
  });

  test("the page hidden (an iPhone app switch: no pagehide) sends a pending trim at once", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const posts = editPosts(page);
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 30);
    await p.up();
    const t0 = Date.now();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // before the 800 ms debounce
    await expect.poll(() => posts.length, { timeout: 2_000 }).toBeGreaterThan(0);
    expect(posts[0] - t0).toBeLessThan(600);
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < before[1][1] - 0.05, SAVED).toBe(true);
  });

  test("closing the tab while saves fail asks first (desktop)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "beforeunload is a desktop browser prompt");
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    await page.route(/\/edit-segments$/, (route) => route.abort("internetdisconnected"));
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 30);
    await p.up();
    await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "retrying", { timeout: 10_000 });
    const dialog = page.waitForEvent("dialog", { timeout: 5_000 });
    await page.close({ runBeforeUnload: true });
    const d = await dialog;
    expect(d.type()).toBe("beforeunload");
    await d.dismiss();
  });

  test("opens zoomed to its first part (the first minute; 10 s in this build); trims work at that zoom; Fit shows all", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id, { "cleocuts.test.openSpanS": "10" });
    const strip = page.getByTestId("timeline-scroll");
    const tl = await stub.timeline(job.id);
    const total = tl.reduce((a, [s, e]) => a + e - s, 0);
    const { sw, cw, sl } = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
    expect(sl).toBe(0);
    expect(sw / cw).toBeGreaterThan((total / 10) * 0.9);
    expect(sw / cw).toBeLessThan((total / 10) * 1.1);
    // a trim at this zoom (touch on the phone)
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - 40);
    await p.up();
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < tl[1][1] - 0.1, SAVED).toBe(true);
    // the zoom stays the user's: still zoomed in after the trim
    expect(await strip.evaluate((el) => el.scrollWidth / el.clientWidth)).toBeGreaterThan(2);
    if (!(await isPhone(page))) {
      await page.getByTestId("timeline-zoom-fit").click();
      await expect.poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
  });

  test("phone: on a short clip the start handle trims the start, not the end", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "phone handles (44 px targets) only");
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    // the shortest clip at Fit
    const widths = await clipsOf(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const i = widths.indexOf(Math.min(...widths));
    expect(widths[i]).toBeLessThan(72);
    const clip = await select(page, i);
    const b = (await clip.boundingBox())!;
    // the start handle's white bar and the clip's first third: the start handle is on top
    for (const x of [b.x + 2, b.x + b.width / 3]) {
      const hit = await page.evaluate(
        ([px, py]) => document.elementFromPoint(px, py)?.closest("[data-testid^='clip-trim-']")?.getAttribute("data-testid") ?? null,
        [x, b.y + b.height / 2],
      );
      expect(hit, `at ${x - b.x}px of a ${b.width}px clip`).toBe("clip-trim-start");
    }
  });
});

