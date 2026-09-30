/**
 * Screenshots of the visual suites (scratchpad audit/stub s1–s6). They
 * only record screens for now — attached to the report, no baselines:
 * UX18 turns them into toHaveScreenshot checks with dynamic regions
 * masked. Tagged @visual @nightly.
 */
import { test, type Page } from "@playwright/test";

export const VISUAL = { tag: ["@visual", "@nightly"] };

export const TIKTOK_CARD = { presetId: "tiktok", presetLabel: "TikTok / Reels", presetIcon: "📱" };

/** Library-entry fields of the stub's `done` seed (hook clips + caption). */
export const DONE_ENTRY = {
  ...TIKTOK_CARD,
  outputs: ["primary", "9:16", "hook_1", "hook_2"],
  hookClips: [
    {
      key: "hook_1",
      title: "Nobody waits ten seconds",
      reason: "Relatable pattern-interrupt in the first line — strong standalone opener.",
      start: 5,
      end: 11.4,
    },
    {
      key: "hook_2",
      title: "No captions? They're gone.",
      reason: "Clear takeaway with a punchline; high share and save potential.",
      start: 19.2,
      end: 28.3,
    },
  ],
  socialCaption: "3 mistakes that quietly kill your TikTok reach (and the 10-second fix for each) 👇",
  socialHashtags: ["tiktoktips", "contentcreator", "creatortips", "growonTikTok", "fyp"],
};

/** Hide the Next dev-tools badge (dev server runs, e.g. auth mode). */
export async function hideDevIndicator(page: Page) {
  await page.addInitScript(() => {
    const css = "nextjs-portal{display:none!important}";
    const add = () => {
      if (document.head && !document.getElementById("e2e-hide-devind")) {
        const s = document.createElement("style");
        s.id = "e2e-hide-devind";
        s.textContent = css;
        document.head.appendChild(s);
      }
    };
    document.addEventListener("DOMContentLoaded", add);
    add();
  });
}

/** A screenshot in the test's output folder (test-results/…), attached
 *  to the report. */
export async function shot(page: Page, name: string, opts: { full?: boolean; settleMs?: number } = {}) {
  await page.waitForTimeout(opts.settleMs ?? 400);
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: Boolean(opts.full), animations: "disabled" });
  await test.info().attach(`${name}.png`, { path, contentType: "image/png" });
}
