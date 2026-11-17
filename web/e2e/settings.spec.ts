/**
 * Einstellungen (/app/settings, PR3 plan D16): the app's language, the
 * voice test ("Try “Cleo cut”"), the legal pages and the beta note; no
 * upload defaults, and without accounts no account group. v2 only.
 */
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";
import { WEB } from "./support/env";

test("the app's language, the voice test, the legal pages, the beta note", { tag: "@editor-v2" }, async ({ page }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app/settings");
  const settings = page.getByTestId("settings");
  await expect(settings).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(1);

  // Language: the whole app follows, the menu too.
  const select = page.getByTestId("language-switcher");
  await expect(select).toHaveValue("en");
  await select.selectOption("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { level: 1, name: "Einstellungen" })).toHaveCount(1);
  await expect(page.getByTestId(mobile ? "tabbar" : "sidebar").locator('a[href="/app/settings"]')).toHaveText("Einstellungen");
  await expect(settings).toContainText("App-Sprache");
  await page.reload();
  await expect(page.getByTestId("language-switcher")).toHaveValue("de");
  await page.getByTestId("language-switcher").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  // The voice test opens from its row and gives focus back on Escape.
  const voice = page.getByTestId("settings-voice");
  await expect(voice).toHaveText(/Try “Cleo cut”/);
  await voice.click();
  const dialog = page.getByTestId("dialog-voice-test");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(voice).toBeFocused();

  // The legal pages and the beta note; no account without accounts.
  for (const [name, href] of [
    ["Imprint", "/imprint"],
    ["Privacy", "/privacy"],
    ["Terms", "/terms"],
  ] as const) {
    await expect(settings.getByRole("link", { name })).toHaveAttribute("href", href);
  }
  await expect(settings).toContainText("You're using the CleoCuts beta.");
  await expect(page.getByTestId("settings-account")).toHaveCount(0);
  // Rows a thumb can hit.
  for (const row of await settings.locator("a, button, label").all()) {
    const box = await row.boundingBox();
    if (box) expect(box.height, (await row.textContent()) ?? "").toBeGreaterThanOrEqual(44);
  }
  await settings.getByRole("link", { name: "Imprint" }).click();
  await expect(page).toHaveURL(`${WEB}/imprint`);
});
