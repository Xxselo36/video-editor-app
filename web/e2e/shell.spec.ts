/**
 * The app shell (PR3, plan §6.2): on phones a top bar per screen and the
 * tab bar (Projects, Upload, Preview, Settings), from 960 px a sidebar;
 * the current place marked; the legal footer reachable above the tab
 * bar; no sideways scroll at 320 px in any language; one document while
 * an upload runs; the Upload tab brings a video waiting for "Let's go"
 * back and, after "Let's go", starts anew; on short landscape phones
 * only the tab bar stays; the editor has none. v2 only (@editor-v2).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { chooseFile, horizontalOverflow, job, JOBS, jobCard, openWithStorage, startGo } from "./support/app";
import { WEB } from "./support/env";

const LANGS = ["en", "de", "es", "fr", "pt", "it", "tr", "pl", "nl", "ru", "ja", "ko", "id", "hi"];

/** The menu of this viewport: the tab bar on phones, the sidebar from 960 px. */
const menu = (page: Page, mobile: boolean) => page.getByTestId(mobile ? "tabbar" : "sidebar");

/** A place of the menu, by its href. */
const place = (page: Page, mobile: boolean, href: string) => menu(page, mobile).locator(`a[href="${href}"]`);

test("four places, the current one marked; the legal footer above the tab bar", { tag: "@editor-v2" }, async ({ page }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app/new");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(menu(page, mobile)).toBeVisible();
  await expect(menu(page, !mobile)).toBeHidden();
  // One main menu, by its name.
  await expect(page.getByRole("navigation", { name: "Main menu" })).toHaveCount(1);
  for (const href of ["/app", "/app/new", "/app/preview", "/app/settings"]) {
    await expect(place(page, mobile, href), href).toBeVisible();
  }
  await expect(place(page, mobile, "/app/new")).toHaveAttribute("aria-current", "page");
  await expect(place(page, mobile, "/app/new")).toHaveText(mobile ? "Upload" : "Upload video");
  // No page header of before.
  await expect(page.getByRole("link", { name: "CleoCuts home" })).toHaveCount(0);

  // Through the menu: Projects (empty: it says so), Preview, Settings.
  await place(page, mobile, "/app").click();
  await expect(page).toHaveURL(`${WEB}/app`);
  await expect(page.getByTestId("projects-empty")).toContainText("No projects yet");
  await expect(place(page, mobile, "/app")).toHaveAttribute("aria-current", "page");
  await place(page, mobile, "/app/preview").click();
  await expect(page.getByTestId("preview-empty")).toBeVisible();
  await expect(place(page, mobile, "/app/preview")).toHaveAttribute("aria-current", "page");
  await place(page, mobile, "/app/settings").click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await expect(place(page, mobile, "/app/settings")).toHaveAttribute("aria-current", "page");
  // The heading of the screen: above it on desktop; for screen readers
  // on phones, where the top bar shows the title.
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(1);
  // The page still reaches the screen's edges (safe areas) after going
  // from screen to screen: Next renders each screen's viewport anew.
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll('meta[name="viewport"]')].map((m) => (m as HTMLMetaElement).content)))
    .toEqual([expect.stringContaining("viewport-fit=cover")]);

  // The imprint link stays reachable: above the tab bar at the page's end.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const imprint = page.locator("[data-site-footer]").getByRole("link", { name: "Imprint" });
  await expect(imprint).toBeInViewport();
  if (mobile) {
    const bar = await page.getByTestId("tabbar").boundingBox();
    const link = await imprint.boundingBox();
    expect(link!.y + link!.height).toBeLessThanOrEqual(bar!.y);
  }
  // The skip link is the first thing Tab reaches on a screen just opened
  // (after a click, Tab goes on from there).
  await page.reload();
  await expect(page.getByTestId("settings")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute("href", "#main");
  // It leads to the screen, with no history entry.
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
  await expect(page).toHaveURL(`${WEB}/app/settings`);
});

test("320 px: no sideways scroll in any language (New video, Choose captions, the tab bar, Projects)", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  test.skip(!info.project.use.isMobile, "phones");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 320, height: 640 });
  const done = await stub.seed("done");
  await openWithStorage(page, "/app/new", { [JOBS]: [job(done.id, "Mein_sehr_langer_Projektname_ohne_Leerzeichen.mp4")] });
  await chooseFile(page, { name: "breit.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  const tabs = page.getByTestId("tabbar").getByRole("link");
  for (const lang of LANGS) {
    // The language changes in Settings; Upload brings the waiting video back.
    await place(page, true, "/app/settings").click();
    await page.getByTestId("language-switcher").selectOption(lang);
    await expect(page.locator("html")).toHaveAttribute("lang", lang);
    await expect.poll(() => horizontalOverflow(page), { message: `settings ${lang}` }).toBeLessThanOrEqual(1);
    await place(page, true, "/app").click();
    await expect(jobCard(page, "Mein_sehr_langer")).toHaveAttribute("data-state", "exported");
    await expect.poll(() => horizontalOverflow(page), { message: `projects ${lang}` }).toBeLessThanOrEqual(1);
    await place(page, true, "/app/new").click();
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
    await expect.poll(() => horizontalOverflow(page), { message: `choose captions ${lang}` }).toBeLessThanOrEqual(1);
    // Every tab label inside its tab (two lines at most).
    for (const tab of await tabs.all()) {
      const fits = await tab.evaluate((el) => {
        const label = el.lastElementChild as HTMLElement;
        return label.scrollWidth <= label.clientWidth + 1 && label.getClientRects().length > 0;
      });
      expect(fits, `${lang}: ${await tab.textContent()}`).toBe(true);
    }
  }
  // Neues Video in the last language, with the waiting video given up.
  await page.getByTestId("start-cancel").click();
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
  await expect.poll(() => horizontalOverflow(page), { message: "new video" }).toBeLessThanOrEqual(1);
});

test("desktop: the sidebar; one document from screen to screen while an upload runs", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  test.skip(Boolean(info.project.use.isMobile), "desktop");
  await openWithStorage(page, "/app/new");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("tabbar")).toBeHidden();
  await chooseFile(page, { name: "lang.mp4", mimeType: "video/mp4", buffer: await stub.media("speech.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  for (const href of ["/app", "/app/preview", "/app/settings", "/app/new"]) {
    await place(page, false, href).click();
    await expect(page).toHaveURL(`${WEB}${href}`);
  }
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  // The waiting video is still there, its upload going on.
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await expect(page.getByTestId("start-upload-status")).toBeVisible();
});

test("Upload with a waiting video brings it back; after Let's go it starts anew", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app/new");
  await chooseFile(page, { name: "warte.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await page.getByTestId("start-style-neon").click();
  await place(page, mobile, "/app").click();
  await expect(jobCard(page, "warte.mp4").getByTestId("job-card-status")).toHaveText("Waiting for “Let’s go”");
  await place(page, mobile, "/app/new").click();
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await expect(page.getByTestId("start-style-neon")).toHaveAttribute("aria-checked", "true");
  // Upload again on the screen itself: still the waiting video.
  await place(page, mobile, "/app/new").click();
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await startGo(page);
  await expect(page).toHaveURL(`${WEB}/app`, { timeout: 30_000 });
  await expect(jobCard(page, "warte.mp4")).toBeVisible();
  await place(page, mobile, "/app/new").click();
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
});

test("Upload after Let's go while its upload still goes: a new start, the video goes on", { tag: "@editor-v2" }, async ({ page, stub }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app/new");
  // The upload API answers once released: the upload is still going.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/uploads/**", async (r) => {
    await held;
    await r.continue().catch(() => {});
  });
  await chooseFile(page, { name: "weiter.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
  await startGo(page);
  await expect(page.getByTestId("start-go")).toHaveAttribute("data-state", "waiting");
  await place(page, mobile, "/app/new").click();
  await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "pick");
  release();
  await place(page, mobile, "/app").click();
  await expect(jobCard(page, "weiter.mp4")).not.toHaveAttribute("data-state", /^upload/, { timeout: 30_000 });
});

test("short landscape phones: only the tab bar stays", { tag: "@editor-v2" }, async ({ page }, info) => {
  test.skip(!info.project.use.isMobile, "phones");
  for (const size of [
    { width: 844, height: 390 },
    { width: 320, height: 256 },
  ]) {
    await page.setViewportSize(size);
    await openWithStorage(page, "/app/settings");
    await expect(page.getByTestId("settings")).toBeVisible();
    const positions = await page.evaluate(() => ({
      top: getComputedStyle(document.querySelector("[data-testid=topbar]")!).position,
      tabs: getComputedStyle(document.querySelector("[data-testid=tabbar]")!).position,
    }));
    expect(positions, `${size.width}x${size.height}`).toEqual({ top: "static", tabs: "fixed" });
    await expect.poll(() => horizontalOverflow(page), { message: `${size.width}x${size.height}` }).toBeLessThanOrEqual(1);
  }
});

test("the editor has no shell; its back goes to the Vorschau, which has", { tag: "@editor-v2" }, async ({ page, stub }) => {
  const review = await stub.seed("review");
  await openWithStorage(page, `/app/p/${review.id}`, { "cleocuts.editor.tourDone.v1": "1" });
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.getByTestId("preview-refine").click();
  await expect(page).toHaveURL(`${WEB}/app/edit/${review.id}`);
  await expect(page.getByTestId("app-shell")).toHaveCount(0);
  await expect(page.getByTestId("tabbar")).toHaveCount(0);
  await page.getByTestId("editor-back").click();
  await expect(page).toHaveURL(`${WEB}/app/p/${review.id}`);
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test("Projects with nothing: the first screen goes on to New video, the menu shows it empty", { tag: "@editor-v2" }, async ({ page }, info) => {
  const mobile = Boolean(info.project.use.isMobile);
  await openWithStorage(page, "/app");
  await expect(page).toHaveURL(`${WEB}/app/new`);
  await place(page, mobile, "/app").click();
  await expect(page).toHaveURL(`${WEB}/app`);
  const empty = page.getByTestId("projects-empty");
  await expect(empty).toContainText("Upload a video. Cleo cuts it and adds captions.");
  await empty.getByRole("link", { name: "Upload video" }).click();
  await expect(page).toHaveURL(`${WEB}/app/new`);
});
