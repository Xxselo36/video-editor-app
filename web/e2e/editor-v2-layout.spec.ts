/**
 * Editor shell v2 (UX7, PLAN_TECH "UX7 tests"): one screen without page
 * scroll at 1440×900, 1280×720 and 390×844, and the simplicity budget —
 * visible controls in the default state (Text tab, nothing selected,
 * outside the transcript and the style tiles): desktop ≤ 13 (the
 * signed-off mock: 12 + the visible search), phone ≤ 10 (mock: 9).
 * Runs against a build with NEXT_PUBLIC_EDITOR_V2=1 (E2E_EDITOR_V2=1).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };

async function openV2(page: Page, jobId: string, storage: Record<string, unknown> = TOUR_DONE) {
  await openWithStorage(page, `/app?job=${jobId}`, storage);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

/** Visible interactive controls outside the transcript and the tile grid. */
function countControls(page: Page) {
  return page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role=button], [role=tab], input, [role=slider]'),
    );
    const visible = els.filter((el) => {
      if (el.closest('[data-testid="ed-transcript"], [data-testid="ed-style"]')) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    });
    return visible.map((el) => el.getAttribute("aria-label") || el.textContent?.trim() || el.tagName);
  });
}

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  expect(b, testId).not.toBeNull();
  return b!;
};
const noDocumentScroll = (page: Page) =>
  page.evaluate(() => ({
    v: document.documentElement.scrollHeight - window.innerHeight,
    h: document.documentElement.scrollWidth - window.innerWidth,
  }));

test.describe("editor v2 layout", TAG, () => {
  test("1440×900: large stage, dock and Export in view, 13 controls", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "desktop sizes");
    await page.setViewportSize({ width: 1440, height: 900 });
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const frame = await box(page, "ed-frame");
    expect(frame.height).toBeGreaterThanOrEqual(560);
    expect(frame.width / frame.height).toBeCloseTo(9 / 16, 1);
    const dock = await box(page, "ed-timeline");
    expect(dock.y + dock.height).toBeLessThanOrEqual(900);
    const exp = await box(page, "ed-export");
    expect(exp.x + exp.width).toBeLessThanOrEqual(1440);
    expect(exp.y).toBeGreaterThanOrEqual(0);
    const side = await box(page, "ed-sidepanel");
    expect(side.width).toBeCloseTo(380, 0);
    expect(await noDocumentScroll(page)).toEqual({ v: 0, h: 0 });
    const controls = await countControls(page);
    test.info().annotations.push({ type: "controls", description: `${controls.length}: ${controls.join(" | ")}` });
    expect(controls.length, controls.join(" | ")).toBeLessThanOrEqual(13);
  });

  test("1280×720: stage ≥ 400 px, 340 px panel, no page scroll", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "desktop sizes");
    await page.setViewportSize({ width: 1280, height: 720 });
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    expect((await box(page, "ed-frame")).height).toBeGreaterThanOrEqual(400);
    expect((await box(page, "ed-sidepanel")).width).toBeCloseTo(340, 0);
    const dock = await box(page, "ed-timeline");
    expect(dock.y + dock.height).toBeLessThanOrEqual(720);
    expect(await noDocumentScroll(page)).toEqual({ v: 0, h: 0 });
  });

  test("390×844: stage, timeline and tab bar visible, ≤ 10 controls, sheet", async ({ page, stub }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-layout", "phone");
    const frame = await box(page, "ed-frame");
    expect(frame.width).toBeCloseTo(186, 0);
    expect(frame.height).toBeCloseTo(330, 0);
    const dock = await box(page, "ed-timeline");
    const tabs = await box(page, "ed-tab-text");
    expect(dock.y).toBeGreaterThan(frame.y + frame.height);
    expect(tabs.y + tabs.height).toBeLessThanOrEqual(844);
    expect(await noDocumentScroll(page)).toEqual({ v: 0, h: 0 });
    const controls = await countControls(page);
    test.info().annotations.push({ type: "controls", description: `${controls.length}: ${controls.join(" | ")}` });
    expect(controls.length, controls.join(" | ")).toBeLessThanOrEqual(10);

    // The Text & cuts sheet: preview keeps its size, focus goes in and back.
    await page.getByTestId("ed-tab-text").click();
    const sheet = page.getByTestId("ed-sheet-text");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("transcript-line").first()).toBeVisible();
    const f2 = await box(page, "ed-frame");
    expect(f2.height).toBeCloseTo(330, 0);
    expect(f2.y + f2.height).toBeLessThanOrEqual((await sheet.boundingBox())!.y);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId("ed-tab-text")).toBeFocused();
  });
});

test.describe("editor v2 on short and sideways phones", TAG, () => {
  for (const vp of [
    { width: 375, height: 550, layout: "phone" },
    { width: 844, height: 390, layout: "landscape" },
    { width: 667, height: 375, layout: "landscape" },
  ]) {
    test(`${vp.width}×${vp.height}: tab bar in view, strip ≥ 60 px, no page scroll`, async ({ page, stub }, info) => {
      test.skip(info.project.name !== "desktop", "viewport set per test");
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const job = await stub.seed("review_speech");
      await openV2(page, job.id);
      await expect(page.getByTestId("editor-v2")).toHaveAttribute("data-layout", vp.layout);
      for (const id of ["ed-tab-text", "ed-tab-style", "ed-tabbar"]) {
        const b = await box(page, id);
        expect(b.y, id).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height, id).toBeLessThanOrEqual(vp.height + 0.5);
        expect(b.x + b.width, id).toBeLessThanOrEqual(vp.width + 0.5);
      }
      const strip = await box(page, "timeline-scroll");
      expect(strip.height).toBeGreaterThanOrEqual(60);
      expect(strip.y + strip.height).toBeLessThanOrEqual(vp.height);
      const frame = await box(page, "ed-frame");
      expect(frame.height).toBeGreaterThanOrEqual(96);
      expect(frame.y + frame.height).toBeLessThanOrEqual(vp.height);
      // a clip is still tappable
      const clip = page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first();
      await clip.click({ position: { x: 6, y: 20 } });
      await expect(page.getByTestId("ed-split")).toBeVisible();
      expect(await noDocumentScroll(page)).toEqual({ v: 0, h: 0 });
    });
  }
});

test.describe("editor v2 behaviour", TAG, () => {
  test("phone: ⌘F opens the sheet with the find field focused; typing never edits", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard");
    await page.setViewportSize({ width: 390, height: 844 });
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const clips = page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
    const before = await clips.count();
    // a clip selected: s would split, Backspace would delete
    await clips.first().click({ position: { x: 6, y: 20 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("ControlOrMeta+f");
    const input = page.getByRole("textbox", { name: "Find in text" });
    await expect(input).toBeFocused();
    await page.keyboard.type("sales");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("s");
    await expect(input).toHaveValue("sales");
    await expect(clips).toHaveCount(before);
  });

  test("fullscreen: focus goes in, Space plays and stays in fullscreen", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard");
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const wrap = page.getByTestId("ed-fullscreen-wrap");
    await page.getByTestId("ed-fullscreen").click();
    await expect(wrap).toHaveAttribute("data-fullscreen", /real|pseudo/);
    await expect(wrap).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("ed-play")).toHaveAttribute("aria-label", "Pause");
    await expect(wrap).toHaveAttribute("data-fullscreen", /real|pseudo/);
    await page.keyboard.press("Space");
    await expect(page.getByTestId("ed-play")).toHaveAttribute("aria-label", "Play");
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await expect(wrap).toHaveAttribute("data-fullscreen", "");
    await expect(page.getByTestId("ed-fullscreen")).toBeFocused();
  });

  test("first open: 4-step tour, then the one-time hint; not again", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openV2(page, job.id, {});
    const tour = page.getByTestId("ed-tour");
    await expect(tour).toBeVisible();
    await expect(tour).toContainText("1/4");
    for (const n of [2, 3, 4]) {
      await page.getByTestId("ed-tour-next").click();
      await expect(tour).toContainText(`${n}/4`);
    }
    await page.getByTestId("ed-tour-next").click();
    await expect(tour).toBeHidden();
    if ((await page.getByTestId("editor-v2").getAttribute("data-layout")) === "phone") {
      await page.getByTestId("ed-tab-text").click();
    }
    await expect(page.getByTestId("ed-hint")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("ed-tour")).toBeHidden();
    await expect(page.getByTestId("ed-hint")).toBeHidden();
  });

  test("clip tools only on selection; split + top-bar undo use the timeline history", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard shortcuts are desktop");
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const clips = page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
    const before = await clips.count();
    await expect(page.getByTestId("ed-split")).toHaveCount(0);
    await clips.first().click({ position: { x: 30, y: 20 } });
    await expect(page.getByTestId("ed-split")).toBeVisible();
    await expect(page.getByTestId("ed-delete")).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("s");
    await expect(clips).toHaveCount(before + 1);
    await page.getByTestId("ed-undo").click();
    await expect(clips).toHaveCount(before);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ed-split")).toHaveCount(0);
  });

  test("a project deleted meanwhile: full-screen expired view, back to projects", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "one project is enough");
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const r = await stub.api.delete(`/jobs/${job.id}`);
    expect(r.ok()).toBeTruthy();
    // An edit: its save is refused (404) → the shell checks the job → gone.
    const clips = page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
    await clips.first().click({ position: { x: 30, y: 20 } });
    await page.getByTestId("ed-split").click();
    await expect(page.getByTestId("ed-expired")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Back to projects" }).click();
    await expect(page.getByTestId("editor-v2")).toBeHidden();
  });

  test("offline: banner, Export disabled; back online: enabled", async ({ page, stub, context }, info) => {
    test.skip(info.project.name !== "desktop", "one project is enough");
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    // Caption fonts first: the UT1 overlay doesn't survive losing the
    // network while its fonts load (a UT1/UT5 matter, not the shell's).
    await expect
      .poll(() => page.evaluate(() => (window as { __captionsInterim?: { fontsReady: boolean } }).__captionsInterim?.fontsReady ?? false), {
        timeout: 20_000,
      })
      .toBe(true);
    await context.setOffline(true);
    await expect(page.getByTestId("ed-offline")).toBeVisible();
    await expect(page.getByTestId("ed-export")).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByTestId("ed-offline")).toBeHidden();
    await expect(page.getByTestId("ed-export")).toBeEnabled();
  });

  test("the player clock runs on the cut timeline; Space plays and pauses", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard shortcuts are desktop");
    const job = await stub.seed("review_speech");
    await openV2(page, job.id);
    const clock = page.getByTestId("editor-cut-time");
    await expect(clock).toContainText("0:00.0");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await expect(page.getByTestId("ed-play")).toHaveAttribute("aria-label", "Pause");
    await expect.poll(() => clock.textContent(), { timeout: 10_000 }).not.toContain("0:00.0");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("ed-play")).toHaveAttribute("aria-label", "Play");
  });
});
