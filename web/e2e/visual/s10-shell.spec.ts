// The app shell and its screens (PR3; the approved mockups
// docs/mockups/start/3-projekte and settings/S1-S3 for the shell), in
// German (the tab bar in Spanish too, its longest labels): Projekte with
// a row in each state (one just turned ready),
// Projekte and the Vorschau tab with nothing to show, the Vorschau tab
// with a video waiting for "Los geht’s", and Einstellungen, at the sizes
// the owner checks; phones on the pixel7 project (touch), the rest on
// desktop. Screenshots only (UX18 adds baselines). Needs E2E_EDITOR_V2=1.
import type { Page, Route } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { chooseFile, job, JOBS, LANG_KEY, libEntry, LIBRARY, openWithStorage } from "../support/app";
import { API } from "../support/env";
import { shot } from "./shot";

const TAG = { tag: ["@editor-v2", "@visual", "@nightly"] };

type Size = { width: number; height: number };
const PHONES: Size[] = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
];
const DESKTOPS: Size[] = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];

function skipUnlessOwnProject(size: Size, project: string) {
  test.skip(project !== (PHONES.includes(size) ? "pixel7" : "desktop"), "phones on pixel7, the rest on desktop");
}

async function snap(page: Page, size: Size, what: string) {
  await page.mouse.move(2, Math.round(size.height / 2));
  await shot(page, `${size.width}x${size.height}-${what}`, { settleMs: 700 });
}

/** The menu of this size: the tab bar below 960 px, else the sidebar. */
const place = (page: Page, size: Size, href: string) =>
  page.getByTestId(size.width < 960 ? "tabbar" : "sidebar").locator(`a[href="${href}"]`);

for (const size of [...PHONES, ...DESKTOPS]) {
  test(`shell ${size.width}×${size.height}`, TAG, async ({ page, stub }, info) => {
    skipUnlessOwnProject(size, info.project.name);
    test.setTimeout(180_000);
    const at = (s: number) => s * 1000;
    const fresh = await stub.seed("review", { filename: "Morgenroutine.mov" });
    const ready = await stub.seed("review", { filename: "Kaffee ohne Maschine.mp4" });
    const done = await stub.seed("done", { filename: "Mein Schreibtisch-Setup.mp4" });
    const edited = await stub.seed("edited", { filename: "Drei Fehler beim Joggen.mp4" });
    const exporting = await stub.seed("rendering", { filename: "Wochenplan am Sonntag.mp4" });
    const failed = await stub.seed("err_no_speech", { filename: "Stummfilm.mp4" });
    // "Morgenroutine" is worked on until the screen shows it, then ready.
    const state = { ready: false };
    await page.route(`${API}/jobs/status*`, async (route: Route) => {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      delete headers.etag;
      if (res.status() !== 200) return route.fulfill({ response: res, headers });
      const body = (await res.json()) as { jobs: Record<string, unknown>[] };
      if (!state.ready) {
        for (const j of body.jobs) {
          if (j.id === fresh.id) Object.assign(j, { status: "processing", stage: "analyze.transcribe", progress: 40, message: "…" });
        }
      }
      return route.fulfill({ response: res, headers, body: JSON.stringify(body) });
    });
    await page.setViewportSize(size);
    await openWithStorage(page, "/app", {
      [LANG_KEY]: "de",
      [JOBS]: [
        job(fresh.id, "Morgenroutine.mov", at(40)),
        job(ready.id, "Kaffee ohne Maschine.mp4", at(2 * 3600)),
        job(done.id, "Mein Schreibtisch-Setup.mp4", at(26 * 3600)),
        job(edited.id, "Drei Fehler beim Joggen.mp4", at(3 * 86_400)),
        job(exporting.id, "Wochenplan am Sonntag.mp4", at(4 * 86_400)),
        job(failed.id, "Stummfilm.mp4", at(6 * 86_400)),
      ],
      [LIBRARY]: [libEntry("000000000000", "Alter Clip.mp4", at(20 * 86_400))],
    });
    const rows = page.getByTestId("job-card");
    await expect(rows.first()).toHaveAttribute("data-state", "processing", { timeout: 20_000 });
    await expect(page.getByTestId("job-card").filter({ hasText: "Stummfilm" })).toHaveAttribute("data-state", "failed");
    await page.evaluate(() => document.fonts.ready);
    await snap(page, size, "1-projekte");
    state.ready = true;
    await expect(rows.first()).toHaveAttribute("data-fresh", "true", { timeout: 20_000 });
    await snap(page, size, "1b-projekte-bereit");
    // Scrolled: the top bar over the page, the expired ones open.
    await page.getByTestId("projects-expired").locator("summary").click();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await snap(page, size, "1c-projekte-unten");

    // Einstellungen.
    await page.evaluate(() => window.scrollTo(0, 0));
    await place(page, size, "/app/settings").click();
    await expect(page.getByTestId("settings")).toBeVisible();
    await snap(page, size, "2-einstellungen");

    // The Vorschau tab: the Vorschau of the newest.
    await place(page, size, "/app/preview").click();
    await expect(page.getByTestId("preview")).toBeVisible({ timeout: 20_000 });
    await snap(page, size, "3-vorschau-tab");
  });

  test(`shell, nothing yet ${size.width}×${size.height}`, TAG, async ({ page, stub }, info) => {
    skipUnlessOwnProject(size, info.project.name);
    await page.setViewportSize(size);
    await openWithStorage(page, "/app/preview", { [LANG_KEY]: "de" });
    await expect(page.getByTestId("preview-empty")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await snap(page, size, "4-vorschau-leer");
    await place(page, size, "/app").click();
    await expect(page.getByTestId("projects-empty")).toBeVisible();
    await snap(page, size, "5-projekte-leer");
    // A video waiting for "Los geht’s": its row, and the Vorschau tab.
    await page.route("**/uploads/**", () => new Promise<void>(() => {}));
    await place(page, size, "/app/new").click();
    await chooseFile(page, { name: "Interview.mp4", mimeType: "video/mp4", buffer: await stub.media("grid.mp4") });
    await expect(page.getByTestId("start-screen")).toHaveAttribute("data-screen", "style");
    await place(page, size, "/app").click();
    await expect(page.getByTestId("job-card")).toHaveAttribute("data-state", "uploading");
    await snap(page, size, "6-projekte-wartet");
    await place(page, size, "/app/preview").click();
    await expect(page.getByTestId("preview-uploading")).toBeVisible();
    await snap(page, size, "7-vorschau-wartet");
  });
}

for (const size of PHONES) {
  test(`the tab bar in Spanish ${size.width}×${size.height}`, TAG, async ({ page }, info) => {
    skipUnlessOwnProject(size, info.project.name);
    await page.setViewportSize(size);
    await openWithStorage(page, "/app/settings", { [LANG_KEY]: "es" });
    await expect(page.locator('html[data-i18n~="es"]')).toHaveCount(1);
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await snap(page, size, "8-ajustes-es");
  });
}
