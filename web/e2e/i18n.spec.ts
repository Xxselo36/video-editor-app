/**
 * Languages (scratchpad bt/p3lang.mjs): the switcher changes the UI and
 * <html lang>, the choice carries over into /app, and no language makes
 * the landing, the dashboard or the editor overflow on a phone.
 * (UX3 adds: the browser language on the first load; UX16 the
 * pseudo-locale overflow pass.)
 */
import { expect, test } from "./support/fixtures";
import { ACTIVE_JOBS, card, horizontalOverflow, LANGS, openWithStorage } from "./support/app";

test("the language switcher changes the page and <html lang>; the choice persists", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const h1 = page.getByRole("heading", { level: 1 }).first();
  const english = await h1.innerText();
  await page.getByTestId("language-switcher").first().selectOption("de");
  await expect(h1).not.toHaveText(english);
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("de");

  await page.goto("/app");
  await expect(page.getByTestId("language-switcher").first()).toHaveValue("de");
  // Only the chosen language's messages were loaded (UX5).
  await expect(page.locator("html")).toHaveAttribute("data-i18n", "en de");
  expect(await page.evaluate(() => document.cookie)).toContain("cleo_lang=de");
});

test("no language overflows the landing, the dashboard or the editor on a phone", async ({ page, stub }, info) => {
  test.skip(!info.project.use.isMobile, "phone layouts only");
  const job = await stub.seed("review");
  await openWithStorage(page, "/", { [ACTIVE_JOBS]: [card(job.id, "reviewing", "test.mp4")] });
  const pages = [
    ["landing", "/"],
    ["dashboard", "/app"],
    ["editor", `/app/edit/${job.id}`],
  ] as const;
  const overflows: string[] = [];
  for (const [name, path] of pages) {
    await page.goto(path);
    if (name === "editor") await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
    else await page.waitForLoadState("networkidle");
    for (const lang of LANGS) {
      await page.getByTestId("language-switcher").first().selectOption(lang);
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(lang);
      // Its messages are loaded on demand (UX5): measure once they're in.
      if (lang !== "en") await expect(page.locator(`html[data-i18n~="${lang}"]`)).toHaveCount(1);
      const px = await horizontalOverflow(page);
      if (px > 1) overflows.push(`${name} ${lang}: +${px}px`);
    }
  }
  expect(overflows).toEqual([]);
});
