/**
 * The Vorschau's full screen (the owner, 2026-11: "Kann man auf der
 * Seite kein Vollbild machen?"): a round button in the frame's top
 * corner (ExportedVideo.tsx Player, player.ts fullscreenWay).
 *
 *   the button        in the corner, a 44 px target, on top, its glass
 *                     blurred; there while the video plays (a mouse: while
 *                     over the frame)
 *   Fullscreen API    (desktop, Android, iPad) the frame fills the
 *                     screen with the captions drawn over it, a modal
 *                     dialog with the focus; Space plays (also after a
 *                     click on the picture), Tab stays in it; a still
 *                     mouse hides the controls and the pointer but the
 *                     control the keyboard is on (a move or a key brings
 *                     them back, a click acts on the picture); the page
 *                     under it keeps its place; the button leaves, the
 *                     focus back on it; the export too
 *   16:9              the screen turned to landscape (Android), the play
 *                     button 40 % down the letterboxed picture
 *   an iPhone         no element Fullscreen API (removed by hand, as in
 *                     editor-v2-mobile): the preview (its captions drawn,
 *                     or to be drawn) lies over the page, the captions
 *                     kept; the button, Back and Escape leave, on the same
 *                     page, and so does the export finishing (its history
 *                     entry with it, a reload, Forward after leaving;
 *                     the focus back on the button, also where a tap
 *                     focuses none); also where a size
 *                     container contained layout (iOS 16 to 18.3); the
 *                     export (captions burned in) opens in the phone's
 *                     own player once it is loaded, else lies over the
 *                     page with its still
 *
 * CI: the iphone project (WebKit as an iPhone, @safari) and the
 * editor-v2 entries (desktop and pixel7, Chromium).
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openVorschau, vorschau } from "./support/vorschau";

const TAG = { tag: ["@editor-v2", "@safari"] };

/** A movie's settings exported as "Original" (a landscape upload keeps its 16:9 frame). */
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

type Hook = { ready: boolean };
const captionsReady = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => (window as unknown as { __captionLayer?: Hook }).__captionLayer?.ready ?? false), {
      timeout: 30_000,
    })
    .toBe(true);

const frame = (page: Page) => page.getByTestId("preview-frame");
const button = (page: Page) => page.getByTestId("preview-fullscreen");
const video = (page: Page) => page.getByTestId("preview-video");
const paused = (page: Page) => video(page).evaluate((v) => (v as HTMLVideoElement).paused);

async function box(el: Locator) {
  const b = await el.boundingBox();
  expect(b, "laid out").not.toBeNull();
  return b!;
}

/** The element at (x, y) is inside the frame (nothing of the page over it). */
const frameOnTopAt = (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="preview-frame"]'), { x, y });

/** A mouse that hovers (desktop) or a finger (phones). */
const mouse = (page: Page) => page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches);

const opacity = (el: Locator) => el.evaluate((e) => Number(getComputedStyle(e).opacity));

/** A tap on a phone, a click with a mouse. */
async function press(page: Page, el: Locator) {
  if (await mouse(page)) await el.click();
  else await el.tap();
}

/** iPhone Safari: no element Fullscreen API; a <video> has its own
 *  player (counted here instead of opened: window.__ownFullscreen). */
const asIPhone = (page: Page, own: { supported: boolean }) =>
  page.addInitScript((supported) => {
    for (const k of ["requestFullscreen", "webkitRequestFullscreen"]) {
      Object.defineProperty(Element.prototype, k, { value: undefined, configurable: true });
    }
    const w = window as unknown as { __ownFullscreen: number };
    w.__ownFullscreen = 0;
    Object.defineProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", { get: () => supported, configurable: true });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", {
      value: () => {
        w.__ownFullscreen += 1;
      },
      configurable: true,
    });
  }, own.supported);
/** The history entry the full screen over the page pushed (lib/useFullscreen) is the current one. */
const ownEntry = (page: Page) =>
  page.evaluate(() => Boolean((history.state as Record<string, unknown> | null)?.cleoPseudoFs));
const ownPlayerOpened = (page: Page) => page.evaluate(() => (window as unknown as { __ownFullscreen: number }).__ownFullscreen);

test.describe("the Vorschau in full screen", TAG, () => {
  test("the button: in the frame's top corner, a 44 px target, on top; there while it plays", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const f = await box(frame(page));
    const b = await box(button(page));
    await expect(button(page)).toHaveAttribute("aria-label", "Full screen");
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(f.x + f.width - (b.x + b.width), "at the right edge").toBeLessThanOrEqual(8);
    expect(f.x + f.width - (b.x + b.width)).toBeGreaterThanOrEqual(0);
    expect(b.y - f.y, "at the top").toBeLessThanOrEqual(8);
    expect(b.y).toBeGreaterThanOrEqual(f.y);
    const hit = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="preview-fullscreen"]'),
      { x: b.x + b.width / 2, y: b.y + b.height / 2 },
    );
    expect(hit, "the topmost thing at its centre").toBe(true);
    // its glass is blurred in every engine (the build dropped the unprefixed
    // property when the -webkit- one followed it: no blur in Chromium)
    const blur = await button(page)
      .locator("span")
      .first()
      .evaluate((e) => {
        const cs = getComputedStyle(e);
        return cs.getPropertyValue("backdrop-filter") || cs.getPropertyValue("-webkit-backdrop-filter");
      });
    expect(blur).toBe("blur(10px)");

    await press(page, page.getByTestId("preview-play"));
    await expect(frame(page)).toHaveAttribute("data-playing", "true");
    if (await mouse(page)) {
      // a mouse over the frame sees it, as the play button; away, it steps back
      await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
      await expect.poll(() => opacity(button(page))).toBe(1);
      await page.mouse.move(f.x + f.width + 200, f.y);
      await expect.poll(() => opacity(button(page))).toBe(0);
    } else {
      // a finger: there all the time, the way in without a pause
      await expect.poll(() => opacity(button(page))).toBe(1);
      await expect(button(page)).toBeVisible();
    }
  });

  test("the Fullscreen API: the frame fills the screen with its captions; Space plays, Tab stays in it, the button leaves", async ({
    page,
    stub,
  }, info) => {
    test.skip(info.project.name === "iphone", "an iPhone has no Fullscreen API for elements (the tests below)");
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await captionsReady(page);
    const inline = await box(frame(page));
    const canvas = frame(page).getByTestId("caption-canvas");
    const captionsInline = (await box(canvas)).width;
    const under = await box(page.getByTestId("preview-finish"));

    await press(page, button(page));
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "real");
    expect(await box(page.getByTestId("preview-finish")), "the page under it keeps its place").toEqual(under);
    expect(await page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid") ?? null)).toBe("preview-frame");
    const vp = page.viewportSize()!;
    expect(await box(frame(page))).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    await expect(button(page)).toHaveAttribute("aria-label", "Exit full screen");
    await expect(frame(page)).toHaveAttribute("role", "dialog");
    await expect(page.getByRole("dialog", { name: "Full screen" })).toHaveAttribute("aria-modal", "true");
    // the captions are drawn over it, bigger with the picture
    await expect.poll(async () => (await box(canvas)).width).toBeGreaterThan(captionsInline * 1.2);

    // the focus on the frame (the dialog), no ring on the picture: Space
    // plays and pauses; Tab goes round its two buttons, both ways
    await expect(frame(page)).toBeFocused();
    await page.keyboard.press("Space");
    await expect.poll(() => paused(page)).toBe(false);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("preview-play")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("preview-play")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(button(page)).toBeFocused();
    // a click on the picture pauses; Space plays again
    await press(page, video(page));
    await expect.poll(() => paused(page)).toBe(true);
    await page.keyboard.press("Space");
    await expect.poll(() => paused(page)).toBe(false);

    if (await mouse(page)) {
      // playing and the mouse still (on the play button's spot): the controls
      // and the pointer go
      const pb = await box(page.getByTestId("preview-play"));
      const at = { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 };
      await page.mouse.move(at.x, at.y);
      await expect(frame(page)).toHaveAttribute("data-idle", "true", { timeout: 6_000 });
      await expect.poll(() => opacity(page.getByTestId("preview-play"))).toBe(0);
      await expect.poll(() => opacity(button(page))).toBe(0);
      const cursorAt = () => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, at);
      expect(await cursorAt(), "no pointer over the picture").toBe("none");
      // a key brings them back
      await page.keyboard.press("Shift");
      await expect(frame(page)).not.toHaveAttribute("data-idle");
      await expect.poll(() => opacity(button(page))).toBe(1);
      // still again: a click without a move acts on the picture (pauses),
      // never on a control it can't see
      await expect(frame(page)).toHaveAttribute("data-idle", "true", { timeout: 6_000 });
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(() => paused(page)).toBe(true);
      await expect(frame(page)).not.toHaveAttribute("data-idle");
      await expect.poll(() => opacity(page.getByTestId("preview-play"))).toBe(1);
      await page.keyboard.press("Space");
      await expect.poll(() => paused(page)).toBe(false);
      // a move brings them back
      await expect(frame(page)).toHaveAttribute("data-idle", "true", { timeout: 6_000 });
      await page.mouse.move(at.x + 40, at.y + 40);
      await expect(frame(page)).not.toHaveAttribute("data-idle");
      await expect.poll(() => opacity(button(page))).toBe(1);
      // a control the keyboard is on stays (and its ring), the rest goes
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("preview-play")).toBeFocused();
      await expect(frame(page)).toHaveAttribute("data-idle", "true", { timeout: 6_000 });
      await expect.poll(() => opacity(button(page))).toBe(0);
      expect(await opacity(page.getByTestId("preview-play"))).toBe(1);
    }

    // out with the keyboard: the focus back on the button that went in
    await button(page).focus();
    await page.keyboard.press("Enter");
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    await expect(button(page)).toBeFocused();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(frame(page)).not.toHaveAttribute("role");
    await expect(button(page)).toHaveAttribute("aria-label", "Full screen");
    const back = await box(frame(page));
    expect(Math.round(back.width)).toBe(Math.round(inline.width));
    expect(Math.round(back.height)).toBe(Math.round(inline.height));
    // still playing: going in and out doesn't stop the video
    expect(await paused(page)).toBe(false);
  });

  test("a 16:9 video in full screen: landscape, the play button 40 % down the picture, not on its edge", async ({ page, stub }, info) => {
    test.skip(info.project.name === "iphone", "the Fullscreen API (an iPhone: below)");
    // the screen's turns, as Android Chrome allows them in full screen
    await page.addInitScript(() => {
      const w = window as unknown as { __turns: string[] };
      w.__turns = [];
      const o = screen.orientation as unknown as Record<string, unknown>;
      o.lock = (to: string) => {
        w.__turns.push(`lock ${to}`);
        return Promise.resolve();
      };
      o.unlock = () => {
        w.__turns.push("unlock");
      };
    });
    const turns = () => page.evaluate(() => (window as unknown as { __turns: string[] }).__turns);
    const job = await stub.seed("review_land", { settings: ORIGINAL });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await press(page, button(page));
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "real");
    // a phone held upright turns to landscape for it
    await expect.poll(turns).toEqual(["lock landscape"]);
    const vp = page.viewportSize()!;
    // the picture: as wide as the screen or as tall, 16:9, in the middle
    const h = Math.min(vp.height, (vp.width * 9) / 16);
    const top = (vp.height - h) / 2;
    const p = await box(page.getByTestId("preview-play"));
    expect(p.y - top, "inside the picture, clear of its edge").toBeGreaterThan(16);
    expect(Math.abs(p.y + p.height / 2 - (top + 0.4 * h)), "40 % down the picture").toBeLessThan(2);
    // and back as it was when it leaves
    await press(page, button(page));
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    await expect.poll(turns).toEqual(["lock landscape", "unlock"]);
  });

  test("an iPhone: the preview, its captions drawn, lies over the page; the button, Back and Escape leave, on the same page", async ({
    page,
    stub,
  }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await captionsReady(page);
    // the page scrolled a little: the frame still covers the screen
    await page.evaluate(() => window.scrollTo(0, 60));
    const scrolled = await page.evaluate(() => window.scrollY);
    const inline = await box(frame(page));
    const canvas = frame(page).getByTestId("caption-canvas");
    const captionsInline = (await box(canvas)).width;
    const under = await box(page.getByTestId("preview-finish"));
    await page.evaluate(() => {
      (window as unknown as { __samePage: boolean }).__samePage = true;
    });

    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    expect(await box(page.getByTestId("preview-finish")), "the page under it keeps its place").toEqual(under);
    // not the phone's own player: it would drop the drawn captions
    expect(await ownPlayerOpened(page)).toBe(0);
    // a modal dialog with the focus in it (VoiceOver stays in it)
    await expect(page.getByRole("dialog", { name: "Full screen" })).toHaveAttribute("aria-modal", "true");
    await expect(frame(page)).toBeFocused();
    const vp = page.viewportSize()!;
    expect(await box(frame(page))).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    expect(await frame(page).evaluate((e) => getComputedStyle(e).position)).toBe("fixed");
    for (const [x, y] of [
      [vp.width / 2, vp.height / 2],
      [8, 8],
      [vp.width - 8, vp.height - 8],
      [vp.width / 2, vp.height - 30],
    ]) {
      expect(await frameOnTopAt(page, x, y), `nothing of the page over it at ${x},${y}`).toBe(true);
    }
    await expect.poll(async () => (await box(canvas)).width).toBeGreaterThan(captionsInline * 1.2);
    // a tap plays and pauses, as in the page
    await page.getByTestId("preview-play").tap();
    await expect.poll(() => paused(page)).toBe(false);
    await video(page).tap();
    await expect.poll(() => paused(page)).toBe(true);

    // out with the button: the frame back where it was, the page where it was
    const exit = button(page);
    await expect(exit).toHaveAttribute("aria-label", "Exit full screen");
    const e = await box(exit);
    expect(e.width).toBeGreaterThanOrEqual(44);
    expect(e.y + e.height).toBeLessThanOrEqual(60);
    expect(vp.width - (e.x + e.width)).toBeLessThanOrEqual(12);
    await exit.tap();
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    await expect.poll(() => ownEntry(page)).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    const back = await box(frame(page));
    expect(Math.round(back.width)).toBe(Math.round(inline.width));
    expect(Math.round(back.y)).toBe(Math.round(inline.y));

    // Back (the iPhone's edge swipe) leaves it and stays on the Vorschau
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    const url = page.url();
    expect(await ownEntry(page)).toBe(true);
    await page.goBack();
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    expect(page.url()).toBe(url);
    expect(await ownEntry(page)).toBe(false);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage ?? false), "not reloaded").toBe(true);

    // Escape (a keyboard)
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    await page.keyboard.press("Escape");
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    await expect(button(page)).toBeFocused();
    // no entry of the full screen left over: the next Back leaves the page, as before
    expect(await ownEntry(page)).toBe(false);
  });

  test("an iPhone: a 16:9 preview lies over the page too, the play button in its letterboxed picture", async ({ page, stub }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_land", { settings: ORIGINAL });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    const vp = page.viewportSize()!;
    expect(await box(frame(page))).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    const h = Math.min(vp.height, (vp.width * 9) / 16);
    const top = (vp.height - h) / 2;
    const p = await box(page.getByTestId("preview-play"));
    expect(p.y - top, "inside the picture, clear of its edge").toBeGreaterThan(16);
    expect(p.y + p.height, "inside the picture").toBeLessThan(top + h);
  });

  test("the export through the Fullscreen API: the frame fills the screen and comes back", async ({ page, stub }, info) => {
    test.skip(info.project.name === "iphone", "an iPhone: the phone's own player (below)");
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    await expect(frame(page)).not.toHaveAttribute("data-still", "none", { timeout: 15_000 });
    const inline = await box(frame(page));
    await press(page, button(page));
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "real");
    const vp = page.viewportSize()!;
    expect(await box(frame(page))).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    await press(page, button(page));
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    const back = await box(frame(page));
    expect(Math.round(back.width)).toBe(Math.round(inline.width));
    expect(Math.round(back.height)).toBe(Math.round(inline.height));
  });

  test("an iPhone: a preview without drawn captions lies over the page too, never in the phone's own player", async ({ page, stub }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_speech");
    // no ?captions=v2: no captions drawn (yet); a preview gets them once its doc is in
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    expect(await ownPlayerOpened(page)).toBe(0);
  });

  test("an iPhone: the export finishing while the preview lies over the page ends it, its history entry with it", async ({ page, stub }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_speech", { render_seconds: 4 });
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await page.getByTestId("preview-finish").tap();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    expect(await ownEntry(page)).toBe(true);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(frame(page)).toHaveAttribute("data-video", "export");
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    // the next Back leaves the page, as before: no entry of the full screen left over
    await expect.poll(() => ownEntry(page)).toBe(false);
  });

  test("an iPhone: the export, its captions burned in, opens in the phone's own player", async ({ page, stub }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    await expect(frame(page)).not.toHaveAttribute("data-still", "none", { timeout: 15_000 });
    await expect.poll(() => video(page).evaluate((v) => (v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await button(page).tap();
    await expect.poll(() => ownPlayerOpened(page)).toBe(1);
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
  });

  test("an iPhone with the export not loaded (a stalled connection): the frame over the page with its still, not a black player", async ({
    page,
    stub,
  }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    // iOS offers its player from the start of the load
    await asIPhone(page, { supported: true });
    const job = await stub.seed("done");
    await page.route(/\/jobs\/[^/]+\/watch/, () => {
      /* never answered */
    });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    expect(await video(page).evaluate((v) => (v as HTMLVideoElement).readyState)).toBe(0);
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    expect(await ownPlayerOpened(page)).toBe(0);
    await button(page).tap();
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
  });

  test("an iPhone: a reload while the frame lies over the page leaves no history entry behind", async ({ page, stub }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const url = page.url();
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    expect(await ownEntry(page)).toBe(true);
    await page.reload();
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready", { timeout: 45_000 });
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    await expect.poll(() => ownEntry(page)).toBe(false);
    expect(page.url()).toBe(url);
    // one Back leaves the page, as before
    await page.goBack();
    await expect(page).not.toHaveURL(url);
  });

  test("an iPhone: Forward after leaving lands on no dead entry; the focus comes back to the button though a tap focused nothing", async ({
    page,
    stub,
  }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const url = page.url();
    // Safari focuses no button on a tap: another control keeps the focus
    await page.getByTestId("preview-finish").focus();
    await button(page).evaluate((b) => (b as HTMLButtonElement).click());
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    await page.keyboard.press("Escape");
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    await expect(button(page), "back on the button that went in").toBeFocused();
    await expect.poll(() => ownEntry(page)).toBe(false);
    // Forward onto the full screen's entry: stepped off, the page stays as it is
    await page.goForward();
    await expect.poll(() => ownEntry(page)).toBe(false);
    await expect(frame(page)).not.toHaveAttribute("data-fullscreen");
    expect(page.url()).toBe(url);
    // one Back leaves the page
    await page.goBack();
    await expect(page).not.toHaveURL(url);
  });

  test("an iPhone up to iOS 18.3 (a size container contained layout then): the frame still covers the screen", async ({
    page,
    stub,
  }, info) => {
    test.skip(!info.project.use.hasTouch, "a phone (taps)");
    await asIPhone(page, { supported: true });
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    // what those engines added to the Vorschau's container
    await page.addStyleTag({ content: 'section[data-testid="preview"] { contain: layout; }' });
    await page.evaluate(() => window.scrollTo(0, 60));
    await button(page).tap();
    await expect(frame(page)).toHaveAttribute("data-fullscreen", "pseudo");
    const vp = page.viewportSize()!;
    expect(await box(frame(page))).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    expect(await frameOnTopAt(page, vp.width / 2, 8), "over the site's header too").toBe(true);
  });
});
