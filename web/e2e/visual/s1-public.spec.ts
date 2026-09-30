// Public pages (audit/stub s1_public.mjs).
import { expect, test } from "../support/fixtures";
import { shot, VISUAL } from "./shot";

test("public pages", VISUAL, async ({ page }) => {
  const go = async (path: string) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
  };
  await go("/");
  await shot(page, "01-landing-fold");
  await shot(page, "01-landing-full", { full: true });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await shot(page, "01-landing-midscroll", { settleMs: 600 });
  await page.evaluate(() => window.scrollTo(0, 0));

  const lang = page.getByTestId("language-switcher").first();
  await lang.selectOption("de");
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("de");
  await shot(page, "02-landing-de-fold", { settleMs: 800 });
  await lang.selectOption("ja");
  await shot(page, "02-landing-ja-full", { full: true, settleMs: 800 });
  await lang.selectOption("en");

  await go("/privacy");
  await shot(page, "03-legal-privacy-full", { full: true });
  await go("/imprint");
  await shot(page, "03-legal-imprint");
  await go("/terms"); // accounts off: 404
  await shot(page, "04-404-terms");
  await go("/pricing"); // accounts off: 404
  await shot(page, "04-404-pricing");

  await page.emulateMedia({ colorScheme: "light" });
  await go("/");
  await shot(page, "05-landing-prefers-light");
});
