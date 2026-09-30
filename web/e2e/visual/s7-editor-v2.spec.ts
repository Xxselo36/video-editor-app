// The v2 editor shell (UX7): default, Style tab, clip selected, tour step
// 1 and (phone) the Text & cuts sheet, in German like the signed-off mock.
// Screenshots only (UX18 adds baselines). Needs E2E_EDITOR_V2=1.
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { LANG_KEY, openWithStorage } from "../support/app";
import { shot } from "./shot";

const TAG = { tag: ["@editor-v2", "@visual", "@nightly"] };

async function open(page: Page, id: string, tour: boolean) {
  await openWithStorage(page, `/app?job=${id}`, {
    [LANG_KEY]: "de",
    ...(tour ? {} : { "cleocuts.editor.tourDone.v1": "1" }),
  });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
  // A frame with a caption on it (3.2 s, as in the mock).
  await page.getByTestId("editor-video").evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    const seeked = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    v.currentTime = 3.2;
    await seeked;
  });
  await page.waitForTimeout(1200);
}

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`editor v2 screens (${vp.name})`, TAG, async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "viewport set per test");
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const job = await stub.seed("review_speech");
    await open(page, job.id, true);
    await shot(page, `${vp.name}-tour-step1`, { settleMs: 600 });
    await page.getByTestId("ed-tour-next").click();
    await shot(page, `${vp.name}-tour-step2`, { settleMs: 500 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ed-tour")).toBeHidden();
    await shot(page, `${vp.name}-default-after-tour`, { settleMs: 400 });

    await open(page, job.id, false);
    await shot(page, `${vp.name}-default`, { settleMs: 400 });
    if (vp.name === "desktop") {
      await page.getByTestId("ed-tab-style").click();
      await shot(page, `${vp.name}-style-tab`, { settleMs: 500 });
      await page.getByTestId("ed-tab-text").click();
    } else {
      await page.getByTestId("ed-tab-text").click();
      await shot(page, `${vp.name}-sheet-text`, { settleMs: 500 });
      await page.keyboard.press("Escape");
      await page.getByTestId("ed-tab-style").click();
      await shot(page, `${vp.name}-sheet-style`, { settleMs: 500 });
      await page.keyboard.press("Escape");
    }
    const clips = page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
    await clips.nth(1).click();
    await shot(page, `${vp.name}-clip-selected`, { settleMs: 400 });
    await page.getByTestId("ed-clip-menu").click();
    await shot(page, `${vp.name}-clip-popover`, { settleMs: 400 });
  });
}
