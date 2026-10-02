/**
 * Editor v2 on phones (UX7c): the iPhone pseudo-fullscreen, the on-screen
 * keyboard, touch targets, landscape sheets, safe areas and the browser
 * defaults the editor turns off (pull-to-refresh, double-tap zoom).
 *
 * WebKit can't be installed here (playwright CDN blocked), so the iPhone
 * runs are Chromium with the iPhone viewports, touch and mobile emulation;
 * iPhone Safari's missing element Fullscreen API is removed by hand and
 * its keyboard (it shrinks only the visual viewport) is a fake
 * visualViewport. They run in the pixel7 project only (one run each).
 */
import { devices, type Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };
const { defaultBrowserType: _iphone, ...IPHONE_13 } = devices["iPhone 13"];
const { defaultBrowserType: _iphoneL, ...IPHONE_13_LANDSCAPE } = devices["iPhone 13 landscape"];
void _iphone;
void _iphoneL;

async function openV2(page: Page, jobId: string) {
  await openWithStorage(page, `/app?job=${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

/** iPhone Safari: no element Fullscreen API (only <video> has its own). */
const noElementFullscreen = (page: Page) =>
  page.addInitScript(() => {
    for (const k of ["requestFullscreen", "webkitRequestFullscreen"]) {
      Object.defineProperty(Element.prototype, k, { value: undefined, configurable: true });
    }
  });

/** A visualViewport the test can shrink, as the iOS keyboard does. */
const fakeVisualViewport = (page: Page) =>
  page.addInitScript(() => {
    const vv = new EventTarget() as EventTarget & Record<string, number>;
    const w = window as unknown as { __kb: number };
    w.__kb = 0;
    Object.defineProperties(vv, {
      height: { get: () => window.innerHeight - w.__kb },
      width: { get: () => window.innerWidth },
      offsetTop: { get: () => 0 },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => 0 },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  });
const setKeyboard = (page: Page, px: number) =>
  page.evaluate((h) => {
    (window as unknown as { __kb: number }).__kb = h;
    window.visualViewport!.dispatchEvent(new Event("resize"));
  }, px);

/** Visible controls in `scope` smaller than 44×44 (touch targets). */
const smallTargets = (page: Page, scope: string) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return ["no " + sel];
    return Array.from(root.querySelectorAll<HTMLElement>("button, [role=menuitem], input"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height < 44 || r.width < 44;
      })
      .map((el) => `${el.getAttribute("aria-label") || el.textContent?.trim()} ${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}`);
  }, scope);

test.describe("editor v2 on an iPhone (portrait)", TAG, () => {
  test.use(IPHONE_13);
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "pixel7", "phone emulation, one run");
  });

  test("pseudo-fullscreen: whole screen, captions kept, tap plays, Escape / exit leave", async ({ page, stub }) => {
    await noElementFullscreen(page);
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const wrap = page.getByTestId("ed-fullscreen-wrap");
    await page.getByTestId("ed-fullscreen").tap();
    await expect(wrap).toHaveAttribute("data-fullscreen", "pseudo");
    const vp = page.viewportSize()!;
    const b = (await wrap.boundingBox())!;
    expect(b).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    expect(await wrap.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    // the editor's own captions stay (native video fullscreen would drop them)
    await expect(wrap.getByTestId("ed-caption-slot")).toBeAttached();
    // nothing of the editor chrome on top of it
    const top = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 30);
      return !!el?.closest('[data-testid="ed-fullscreen-wrap"]');
    });
    expect(top).toBe(true);
    // no player bar in it: a tap anywhere plays, a play glyph while paused
    const tap = wrap.getByRole("button", { name: "Play" });
    await expect(tap).toBeVisible();
    await tap.tap();
    await expect.poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false);
    await wrap.getByRole("button", { name: "Pause" }).tap();
    await expect.poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true);
    const exit = page.getByRole("button", { name: "Exit full screen" });
    expect(((await exit.boundingBox())!).width).toBeGreaterThanOrEqual(44);
    await exit.tap();
    await expect(wrap).toHaveAttribute("data-fullscreen", "");
    await page.getByTestId("ed-fullscreen").tap();
    await expect(wrap).toHaveAttribute("data-fullscreen", "pseudo");
    await page.keyboard.press("Escape");
    await expect(wrap).toHaveAttribute("data-fullscreen", "");
  });

  test("the keyboard: the editor fits above it, the word field stays in view", async ({ page, stub }) => {
    await fakeVisualViewport(page);
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await page.getByTestId("ed-tab-text").tap();
    const sheet = page.getByTestId("ed-sheet-text");
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("ed-word").nth(3).tap();
    await page.getByTestId("ed-word-edit").tap();
    const input = page.getByTestId("ed-word-input");
    await expect(input).toBeFocused();
    const kb = 300; // an iPhone keyboard with its suggestion bar
    await setKeyboard(page, kb);
    const root = page.getByTestId("editor-v2");
    await expect(root).toHaveAttribute("data-keyboard", "");
    const visible = page.viewportSize()!.height - kb;
    await expect.poll(async () => (await root.boundingBox())!.height).toBeCloseTo(visible, 0);
    const ib = (await input.boundingBox())!;
    expect(ib.y + ib.height).toBeLessThanOrEqual(visible);
    const sb = (await sheet.boundingBox())!;
    expect(sb.y).toBeGreaterThanOrEqual(44);
    // iOS zooms into inputs under 16 px
    expect(parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    // keyboard gone: the full height again
    await setKeyboard(page, 0);
    await expect(root).not.toHaveAttribute("data-keyboard", "");
    await expect.poll(async () => (await root.boundingBox())!.height).toBeCloseTo(page.viewportSize()!.height, 0);
  });

  test("44 px targets: clip popover, cuts menu, find bar", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first().tap({ position: { x: 10, y: 20 } });
    await page.getByTestId("ed-clip-menu").tap();
    const pop = page.locator('[role=dialog][class*="menu"]');
    await expect(pop).toBeVisible();
    // the speed segments: 40 px inside a 2 px well (44 with it)
    const small = (await smallTargets(page, '[role=dialog][class*="menu"]')).filter((x) => !/×\s\d+×4[0-3]$/.test(x));
    expect(small, small.join(" | ")).toEqual([]);
    for (const r of await pop.locator("input[type=range]").all()) {
      expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press("Escape");
    await page.getByTestId("ed-tab-text").tap();
    await expect(page.getByTestId("ed-cuts")).toBeVisible();
    expect((await page.getByTestId("ed-cuts").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId("ed-cuts").tap();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    expect(await smallTargets(page, "[role=menu]")).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByTestId("ed-search").tap();
    await expect(page.getByTestId("ed-find")).toBeVisible();
    expect(await smallTargets(page, '[data-testid="ed-find"]')).toEqual([]);
  });

  test("safe areas and browser defaults: viewport-fit=cover, no pull-to-refresh, no double-tap zoom", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await expect.poll(() => page.locator('meta[name="viewport"]').getAttribute("content")).toContain("viewport-fit=cover");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe("none");
    const root = page.getByTestId("editor-v2");
    expect(await root.evaluate((el) => getComputedStyle(el).touchAction)).toBe("manipulation");
    expect(await page.getByTestId("ed-frame").evaluate((el) => getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect)).toBe("none");
  });
});

// ── live captions (UT5 layer, ?captions=v2) on touch ────────────────────
const LIVE = { ...TOUR_DONE, "cleocuts.captions.engine.v1": "v2" };
type LiveHook = { ready: boolean; page: string | null; selected: string | null };
const live = (page: Page) => page.evaluate(() => (window as unknown as { __captionLayer?: LiveHook }).__captionLayer ?? null);
async function openLive(page: Page, jobId: string) {
  await openWithStorage(page, `/app/edit/${jobId}?captions=v2`, LIVE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("caption-layer")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await live(page))?.ready, { timeout: 30_000 }).toBe(true);
}
/** Paused on a moment with a caption (the second sentence). */
async function atCaption(page: Page) {
  await page.getByTestId("editor-video").evaluate((v) => {
    const el = v as HTMLVideoElement;
    el.pause();
    el.currentTime = 4.6;
  });
  await expect.poll(async () => (await live(page))?.page ?? null, { timeout: 15_000 }).not.toBeNull();
}
const paused = (page: Page) => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).paused);

test.describe("editor v2 on an iPhone: captions, title, Stil sheet", TAG, () => {
  test.use(IPHONE_13);
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "pixel7", "phone emulation, one run");
  });

  test("pseudo-fullscreen: a tap on the caption selects it, anywhere else plays / pauses", async ({ page, stub }) => {
    await noElementFullscreen(page);
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await atCaption(page);
    await page.getByTestId("ed-fullscreen").tap();
    const wrap = page.getByTestId("ed-fullscreen-wrap");
    await expect(wrap).toHaveAttribute("data-fullscreen", "pseudo");
    // away from the caption (upper third): play, then pause
    const vp = page.viewportSize()!;
    await page.touchscreen.tap(vp.width / 2, vp.height * 0.3);
    await expect.poll(() => paused(page)).toBe(false);
    await page.touchscreen.tap(vp.width / 2, vp.height * 0.3);
    await expect.poll(() => paused(page)).toBe(true);
    // on the caption: selected, still paused
    await atCaption(page);
    await page.getByTestId("caption-hit").tap();
    await expect.poll(async () => (await live(page))?.selected ?? null).not.toBeNull();
    await expect(page.getByTestId("caption-box")).toBeVisible();
    expect(await paused(page)).toBe(true);
  });

  test("phone sheet open: the caption on the small preview is selectable too", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await atCaption(page);
    await page.getByTestId("ed-tab-text").tap();
    await expect(page.getByTestId("ed-sheet-text")).toBeVisible();
    await page.getByTestId("caption-hit").tap();
    await expect.poll(async () => (await live(page))?.selected ?? null).not.toBeNull();
    expect(await paused(page)).toBe(true);
  });

  test("title field 44 px; the Stil sheet opens at 54 %, the preview stays visible", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await page.getByTestId("ed-title").tap();
    const input = page.getByRole("textbox", { name: "Project name" });
    await expect(input).toBeFocused();
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    const vh = page.viewportSize()!.height;
    expect(vh).toBeGreaterThan(600); // iPhone 13 in Safari: 664
    await page.getByTestId("ed-tab-style").tap();
    const sheet = page.getByTestId("ed-sheet-style");
    await expect(sheet).toBeVisible();
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(Math.round(vh * 0.54));
    // a style tap shows its result right away: the preview is above the sheet
    const frame = (await page.getByTestId("ed-frame").boundingBox())!;
    expect(frame.y + frame.height).toBeLessThanOrEqual((await sheet.boundingBox())!.y + 0.5);
  });
});

test.describe("editor v2 on an iPhone SE", TAG, () => {
  const { defaultBrowserType: _se, ...IPHONE_SE } = devices["iPhone SE"];
  void _se;
  test.use(IPHONE_SE);
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "pixel7", "phone emulation, one run");
  });

  test("short screen (≤ 600 px): the Stil sheet opens at 90 %, the Text sheet at 54 %", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const vh = page.viewportSize()!.height;
    expect(vh).toBeLessThanOrEqual(600); // 568
    await page.getByTestId("ed-tab-style").tap();
    const sheet = page.getByTestId("ed-sheet-style");
    await expect(sheet).toBeVisible();
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(Math.round(vh * 0.9));
    await page.getByRole("button", { name: "Close" }).first().tap();
    await page.getByTestId("ed-tab-text").tap();
    const text = page.getByTestId("ed-sheet-text");
    await expect.poll(async () => Math.round((await text.boundingBox())!.height)).toBe(Math.round(vh * 0.54));
  });
});

test.describe("editor v2 on a tablet (desktop layout, touch)", TAG, () => {
  const { defaultBrowserType: _ipad, ...IPAD } = devices["iPad (gen 7) landscape"];
  void _ipad;
  test.use(IPAD);
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "pixel7", "touch emulation, one run");
  });

  test("caption handles: 44 px hit areas, the knobs keep their size", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openLive(page, job.id);
    await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-layout", "desktop");
    await atCaption(page);
    await page.getByTestId("caption-hit").tap();
    await expect(page.getByTestId("caption-box")).toBeVisible();
    for (const id of ["caption-move", "caption-size"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.width, id).toBeGreaterThanOrEqual(44);
      expect(b.height, id).toBeGreaterThanOrEqual(44);
    }
    const knob = (await page.getByTestId("caption-move").locator("span").first().boundingBox())!;
    expect(knob.width).toBeLessThan(30);
  });
});

test.describe("editor v2 on an iPhone (landscape)", TAG, () => {
  test.use(IPHONE_13_LANDSCAPE);
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "pixel7", "phone emulation, one run");
  });

  test("the sheet leaves the tab bar free: Text → Style without closing", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-layout", "landscape");
    await page.getByTestId("ed-tab-text").tap();
    const sheet = page.getByTestId("ed-sheet-text");
    await expect(sheet).toBeVisible();
    const tabs = (await page.getByTestId("ed-tabbar").boundingBox())!;
    // (after the slide-in)
    await expect.poll(async () => {
      const b = (await sheet.boundingBox())!;
      return b.y + b.height;
    }).toBeLessThanOrEqual(tabs.y + 0.5);
    const sb = (await sheet.boundingBox())!;
    // the preview stays visible left of the sheet
    const frame = (await page.getByTestId("ed-frame").boundingBox())!;
    expect(frame.x + frame.width).toBeLessThanOrEqual(sb.x);
    await page.getByTestId("ed-tab-style").tap();
    await expect(page.getByTestId("ed-sheet-style")).toBeVisible();
    await expect(sheet).toBeHidden();
  });

  test("the keyboard: the word field and the find field stay visible and ≥ 44 px", async ({ page, stub }) => {
    await fakeVisualViewport(page);
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const vh = page.viewportSize()!.height;
    const kb = 200; // a landscape iPhone keyboard with its suggestion bar
    const inView = async (testId: string) => {
      const input = page.getByTestId(testId);
      await expect(input).toBeFocused();
      await setKeyboard(page, kb);
      await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-keyboard", "");
      await expect
        .poll(async () => {
          const b = (await input.boundingBox())!;
          return b.y >= 0 && b.y + b.height <= vh - kb + 0.5 && b.height >= 44;
        })
        .toBe(true);
      // nothing covers it
      const b = (await input.boundingBox())!;
      const hit = await page.evaluate(
        ([x, y, id]) => !!document.elementFromPoint(x as number, y as number)?.closest(`[data-testid="${id}"]`),
        [b.x + 8, b.y + b.height / 2, testId] as const,
      );
      expect(hit, testId).toBe(true);
      await setKeyboard(page, 0);
    };
    await page.getByTestId("ed-tab-text").tap();
    const sheet = page.getByTestId("ed-sheet-text");
    await expect(sheet).toBeVisible();
    // the word field
    await sheet.getByTestId("ed-word").nth(3).tap();
    await page.getByTestId("ed-word-edit").tap();
    await inView("ed-word-input");
    await page.keyboard.press("Escape");
    // the find field
    await page.getByTestId("ed-search").tap();
    await inView("ed-find-input");
  });
});
