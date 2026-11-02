/**
 * The Vorschau's screen (PR2, plan D11 to D14; mockups docs/mockups/start
 * 4-vorschau, -fertigstellen, -sichern): the frame has the video's shape
 * (a landscape video exported as "Original" plays wide); the desktop
 * title breaks between words and hyphenates a long one (never a short
 * one; a line never starts with a long word's separator; a date, time
 * or number stays whole); a 16:9 frame leaves the title and both buttons
 * in view on a laptop screen (also under a two-line title or a notice)
 * and keeps its size from the tap on Export on; a preview that couldn't
 * be made says so inside its frame on any phone; an export finished
 * during the visit is announced. The ⋯ menu and its dialogs: the focus
 * goes back to ⋯ when they close (also on a tile of Projects), they name
 * the video as its title does, its items and the dialogs' buttons are
 * 44 px tall to a finger, the menu never covers ⋯ (a landscape phone),
 * no "Edit again" next to Fine-tune; pressed, ⋯, the quiet buttons, the
 * done state's small controls and the dialogs' buttons give a little; a
 * long press selects no control's label. The done state's structure
 * (Bonus clips under the title, SRT / VTT spelled out). German: deleting and the refusals of Fertigstellen
 * say it without "Export", dashes or "verarbeitet"; the delete button's
 * text reaches AA on its red.
 * Desktop and pixel7, a v2 build (E2E_EDITOR_V2=1).
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { job as storedJob, jobCard, JOBS, LANG_KEY, openWithStorage } from "./support/app";
import { API } from "./support/env";
import { holdRequests, openVorschau, TOUR_DONE, vorschau } from "./support/vorschau";

const TAG = { tag: "@editor-v2" };
const DE = { [LANG_KEY]: "de" };

/** The frame's shape as the page lays it out (data-shape) and as drawn. */
async function frameShape(page: Page): Promise<{ shape: string | null; wide: boolean }> {
  const box = (await page.getByTestId("preview-frame").boundingBox())!;
  return { shape: await vorschau(page).locator("[data-shape]").first().getAttribute("data-shape"), wide: box.width > box.height };
}

/** The tops of the lines the letters of `word` (in the element's text) are on. */
async function letterTops(el: Locator, word: string): Promise<number[]> {
  return el.evaluate((root, w) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(w);
      if (at < 0) continue;
      const tops = new Set<number>();
      for (let k = 0; k < w.length; k++) {
        const r = document.createRange();
        r.setStart(n, at + k);
        r.setEnd(n, at + k + 1);
        tops.add(Math.round(r.getBoundingClientRect().top));
      }
      return [...tops];
    }
    return [];
  }, word);
}

/** The tops of the lines the characters of `text` are on, in the
 *  element's text across its nodes (the title's name runs over several). */
async function textTops(el: Locator, text: string): Promise<number[]> {
  return el.evaluate((root, needle) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const at = nodes.map((n) => n.data).join("").indexOf(needle);
    if (at < 0) return [];
    const tops = new Set<number>();
    for (let k = at; k < at + needle.length; k++) {
      let rest = k;
      const node = nodes.find((n) => {
        if (rest < n.data.length) return true;
        rest -= n.data.length;
        return false;
      })!;
      const r = document.createRange();
      r.setStart(node, rest);
      r.setEnd(node, rest + 1);
      tops.add(Math.round(r.getBoundingClientRect().top));
    }
    return [...tops];
  }, text);
}

/** A box, rounded to whole pixels. */
const box = async (el: Locator) => {
  const b = (await el.boundingBox())!;
  return [b.x, b.y, b.width, b.height].map(Math.round);
};

/** A movie's settings exported as "Original" (a landscape upload keeps its frame). */
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

/** WCAG contrast of two computed colours ("rgb(r, g, b)"). */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Open ⋯ with the keyboard and press one of its items. */
async function menuByKeys(page: Page, item: "rename" | "delete") {
  await page.getByTestId("job-card-menu").focus();
  await page.keyboard.press("Enter");
  const target = page.getByTestId(`job-card-${item}`);
  for (let i = 0; i < 6 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");
}

/** Hold the mouse button down on `el`; its computed scale and transform
 *  while pressed (then released off it: no click). */
async function pressed(page: Page, el: Locator): Promise<{ scale: string; transform: string }> {
  const b = (await el.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  // the press transition (160 ms) has run
  await page.waitForTimeout(400);
  const style = await el.evaluate((n) => ({ scale: getComputedStyle(n).scale, transform: getComputedStyle(n).transform }));
  await page.mouse.move(2, 2);
  await page.mouse.up();
  return style;
}

test.describe("the Vorschau's screen", TAG, () => {
  test("a landscape video exported as Original: a wide frame before and after Export", async ({ page, stub }) => {
    // Format "Original" keeps the source's frame; the job says so only
    // through its filmstrip (the source scaled to 90 px high).
    const job = await stub.seed("review_land", { render_seconds: 1 });
    const j = await (await page.request.get(`${API}/jobs/${job.id}`)).json();
    expect(j.output_aspect).toBe("original");
    expect(j.filmstrip.tileW).toBeGreaterThan(j.filmstrip.tileH);
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    expect(await frameShape(page)).toEqual({ shape: "wide", wide: true });
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-video", "export");
    expect(await frameShape(page)).toEqual({ shape: "wide", wide: true });
  });

  test("a 16:9 frame on a laptop screen leaves the title and both buttons in view", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "desktop sizes");
    // a one-line title (the budget under the frame has one line)
    const ready = await stub.seed("review_land", { filename: "Interview.mp4" });
    const done = await stub.seed("done_land", { filename: "Interview.mp4" });
    for (const [job, state, actions] of [
      // the note under the frame (no caption opt-in): the longest ready state
      [ready, "ready", ["preview-captions-after", "preview-finish", "preview-refine"]],
      [done, "done", ["done-download", "preview-refine"]],
    ] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openVorschau(page, job.id);
      await expect(vorschau(page)).toHaveAttribute("data-state", state);
      // As tall as it gets on a tall screen (880 x 495), as before.
      const frame = (await page.getByTestId("preview-frame").boundingBox())!;
      expect([Math.round(frame.width), Math.round(frame.height)]).toEqual([880, 495]);
      for (const size of [
        { width: 1024, height: 768 },
        { width: 1366, height: 657 },
      ]) {
        await page.setViewportSize(size);
        for (const id of ["preview-title", ...actions]) {
          await expect(page.getByTestId(id).first(), `${state}: ${id} at ${size.width}x${size.height}`).toBeInViewport({ ratio: 1 });
        }
        expect((await frameShape(page)).wide).toBe(true);
      }
    }
  });

  test("a 16:9 frame over a two-line title or a notice: the title and both buttons stay in view on a laptop screen", async ({
    page,
    stub,
  }, info) => {
    test.skip(info.project.name !== "desktop", "desktop sizes");
    // The frame gives up the height they take (measured, not a one-line budget).
    const twoLines = await stub.seed("review_land", { filename: "Interview mit Anna über Morgenroutinen.mp4" });
    const failed = await stub.seed("render_failed", { orientation: "landscape", settings: ORIGINAL, filename: "Interview.mp4" });
    for (const [job, extra] of [
      [twoLines, "preview-captions-after"],
      [failed, "preview-failed"],
    ] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openVorschau(page, job.id, { storage: DE });
      await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
      await expect(page.getByTestId(extra)).toBeVisible();
      expect((await frameShape(page)).wide).toBe(true);
      // (more than one line)
      if (extra === "preview-captions-after") {
        expect((await letterTops(page.getByTestId("preview-title"), "Interview mit Anna über Morgenroutinen")).length).toBeGreaterThan(1);
      }
      for (const size of [
        { width: 1440, height: 900 },
        { width: 1024, height: 768 },
        { width: 1366, height: 657 },
      ]) {
        await page.setViewportSize(size);
        for (const id of ["preview-title", extra, "preview-finish", "preview-refine"]) {
          await expect(page.getByTestId(id).first(), `${extra}: ${id} at ${size.width}x${size.height}`).toBeInViewport({ ratio: 1 });
        }
        expect((await frameShape(page)).wide).toBe(true);
      }
    }
  });

  test("a 16:9 frame keeps its size from the tap on Export until it is done (the pressed button never moves)", async ({
    page,
    stub,
  }, info) => {
    test.skip(info.project.name !== "desktop", "desktop sizes");
    const job = await stub.seed("review_land", { filename: "Interview.mp4", render_seconds: 3 });
    await page.setViewportSize({ width: 1024, height: 768 });
    await openVorschau(page, job.id, { query: "?captions=v2" });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const frame = page.getByTestId("preview-frame");
    await expect(page.getByTestId("preview-video")).toHaveAttribute("src", /preview-video/);
    await page.getByTestId("preview-play").click();
    await page.waitForTimeout(500);
    const ready = await box(frame);
    const post = await holdRequests(page, `${API}/jobs/${job.id}/render`, "POST");
    await page.getByTestId("preview-finish").click();
    await post.held;
    // no Fine-tune from the tap on: the frame doesn't take its place
    await expect(page.getByTestId("preview-finish")).toHaveAttribute("data-state", "working");
    await expect(page.getByTestId("preview-refine")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await box(frame)).toEqual(ready);
    await post.release();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    await expect(page.getByTestId("preview-note")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await box(frame)).toEqual(ready);
  });

  test("phones: a preview that couldn't be made says so inside its frame, also on a small phone (no play button then)", async ({
    page,
    stub,
  }, info) => {
    test.skip(info.project.name !== "pixel7", "phone sizes");
    for (const [seed, size] of [
      ["review_speech", { width: 320, height: 568 }],
      // an iPhone SE's Safari: the frame at its smallest too
      ["review_speech", { width: 375, height: 553 }],
      ["review_speech", { width: 844, height: 390 }],
      // landscape "Original" on a narrow phone: the wide frame
      ["review_land", { width: 320, height: 568 }],
    ] as const) {
      const job = await stub.seed(seed);
      // Exporting, and the preview of the stored edit failed: nothing to play.
      await page.route(`${API}/jobs/${job.id}`, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const res = await route.fetch();
        const body = await res.json();
        Object.assign(body, { status: "processing", stage: "render.encode", preview_status: "failed", preview_error: "encode_failed" });
        return route.fulfill({ response: res, body: JSON.stringify(body) });
      });
      await page.setViewportSize(size);
      await openVorschau(page, job.id, { storage: DE });
      await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
      const chip = page.getByTestId("preview-unavailable");
      await expect(chip).toHaveText("Die Vorschau konnte nicht erstellt werden. Deine Änderungen sind gespeichert.");
      await expect(page.getByTestId("preview-play")).toBeHidden();
      const [, fy, , fh] = await box(page.getByTestId("preview-frame"));
      const [, cy, , ch] = await box(chip);
      const where = `${seed} at ${size.width}x${size.height}`;
      expect(cy, where).toBeGreaterThanOrEqual(fy);
      expect(cy + ch, where).toBeLessThanOrEqual(fy + fh);
    }
  });

  test("desktop: a date, a time or a number in the title stays whole; a camera name still breaks at its parts", async ({
    page,
    stub,
  }, info) => {
    test.skip(info.project.name !== "desktop", "the desktop title wraps (phones: one line)");
    const title = page.getByTestId("preview-title");
    for (const [name, whole, wraps] of [
      ["Interview vom 31.10.2026 mit Anna", ["31.10.2026"], true],
      ["Bildschirmaufnahme 2026-10-31 um 12.00.00", ["12.00.00"], true],
      ["Folge 2.10 Finale", ["2.10"], false],
      ["VID_20261031_123456", ["20261031", "123456"], true],
    ] as const) {
      const job = await stub.seed("review_speech", { filename: `${name}.mp4` });
      await openVorschau(page, job.id, { storage: DE });
      await expect(title).toHaveText(name);
      await page.evaluate(() => document.fonts.ready);
      // (more than one line)
      if (wraps) expect((await title.boundingBox())!.height, name).toBeGreaterThan(60);
      for (const part of whole) expect(await textTops(title, part), `${name}: ${part}`).toHaveLength(1);
    }
  });

  test("desktop: the title breaks between words and hyphenates a word too long for its line", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "the desktop title wraps (phones: one line)");
    const job = await stub.seed("review_speech", { filename: "Geburtstagsüberraschung_für_Oma.mp4" });
    await openVorschau(page, job.id, { storage: DE });
    const title = page.getByTestId("preview-title");
    await expect(title).toHaveText("Geburtstagsüberraschung_für_Oma");
    await expect(page.getByRole("heading", { level: 1, name: "Geburtstagsüberraschung_für_Oma", exact: true })).toBeVisible();
    // Hyphenated in the page's language, never broken anywhere.
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("de");
    expect(await title.evaluate((el) => [getComputedStyle(el).hyphens, getComputedStyle(el).overflowWrap])).toEqual([
      "auto",
      "break-word",
    ]);
    // The long word's separator is a box of its own (Chromium hyphenates
    // no word that runs into a "_"), on one line with the word's last two
    // letters (the short one's stays text).
    expect(
      await title.evaluate((el) =>
        [...el.querySelectorAll("span")].map((s) => [s.textContent, getComputedStyle(s).display, getComputedStyle(s).whiteSpace]),
      ),
    ).toEqual([
      ["ng_", "inline", "nowrap"],
      ["_", "inline-block", "nowrap"],
    ]);
  });

  test("desktop: a short word in the title never splits", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "the desktop title wraps (phones: one line)");
    const title = page.getByTestId("preview-title");
    // Hyphenated: only a word of 10 letters or more ("bessere" goes to the next line whole).
    const tips = await stub.seed("review_speech", { filename: "Tipps für bessere Präsentationen im Büro.mp4" });
    await openVorschau(page, tips.id, { storage: DE });
    await expect(title).toHaveText("Tipps für bessere Präsentationen im Büro");
    await page.evaluate(() => document.fonts.ready);
    expect((await letterTops(title, "Tipps für bessere Präsentationen im Büro")).length).toBeGreaterThan(1);
    expect(await letterTops(title, "bessere")).toHaveLength(1);
    expect(await title.evaluate((el) => getComputedStyle(el).hyphenateLimitChars)).toBe("10 4 4");
  });

  test("desktop: a long word's separator never starts a line of the title", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "the desktop title wraps (phones: one line)");
    const title = page.getByTestId("preview-title");
    // A compound's hyphen stays at the end of the line of the word before it (no line reads "-Vorbereitung").
    const compound = await stub.seed("review_speech", { filename: "Geburtstagsfeier-Vorbereitung.mp4" });
    await openVorschau(page, compound.id, { storage: DE });
    await expect(title).toHaveText("Geburtstagsfeier-Vorbereitung");
    await page.evaluate(() => document.fonts.ready);
    const [sep, before] = await title.evaluate((el) => {
      const box = [...el.querySelectorAll("span")].find((s) => s.textContent === "-")!;
      // the last letter before it, in the title's text
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let prev: Node | null = null;
      for (let n = walker.nextNode(); n && !box.contains(n); n = walker.nextNode()) prev = n;
      const r = document.createRange();
      r.setStart(prev!, prev!.textContent!.length - 1);
      r.setEnd(prev!, prev!.textContent!.length);
      return [Math.round(box.getBoundingClientRect().top), Math.round(r.getBoundingClientRect().top)];
    });
    // on the same line (44 px apart on the next one; the box's top is not the glyphs')
    expect(Math.abs(sep - before)).toBeLessThan(20);
    // (it breaks: the title takes more than one line)
    expect((await title.boundingBox())!.height).toBeGreaterThan(60);
  });

  test("an export finished during the visit is announced wherever the focus is; a finished one is not", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { render_seconds: 4 });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const announced = page.getByRole("status").filter({ hasText: "Your video is ready" });
    await expect(announced).toHaveCount(0);
    await page.getByTestId("preview-finish").click();
    await expect(vorschau(page)).toHaveAttribute("data-state", "finishing");
    const menu = page.getByTestId("job-card-menu");
    await menu.focus();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(announced).toHaveCount(1);
    await expect(menu).toBeFocused();
    // Opened when it was done already: nothing to announce.
    await page.reload();
    await expect(vorschau(page)).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(page.getByTestId("preview-frame")).toBeVisible();
    await expect(announced).toHaveCount(0);
  });

  test("⋯ Rename and Delete give the focus back to ⋯ when their dialog closes, also on a tile of Projects", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    const menu = page.getByTestId("job-card-menu");
    for (const item of ["rename", "delete"] as const) {
      await menuByKeys(page, item);
      await expect(page.getByTestId(`dialog-${item}`)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`dialog-${item}`)).toHaveCount(0);
      await expect(menu, `after ${item}, Escape`).toBeFocused();
    }
    await menu.click();
    await page.getByTestId("job-card-delete").click();
    await page.getByTestId("dialog-delete").getByRole("button", { name: "Cancel" }).click();
    await expect(menu, "after delete, Cancel").toBeFocused();
    // Renamed: the dialog closes after the server took the name.
    await menu.click();
    await page.getByTestId("job-card-rename").click();
    await page.getByTestId("rename-input").fill("Morgenroutine");
    await page.getByTestId("rename-save").click();
    await expect(page.getByTestId("dialog-rename")).toHaveCount(0);
    await expect(page.getByTestId("preview-title")).toHaveText("Morgenroutine");
    await expect(menu, "after a rename").toBeFocused();

    // Projects with this one project: its tile.
    await openWithStorage(page, "/app", { ...TOUR_DONE, [JOBS]: [storedJob(job.id, "tiktok_3_mistakes.mp4")] });
    const tileMenu = page.getByTestId("job-card").getByTestId("job-card-menu");
    await expect(tileMenu).toBeVisible({ timeout: 30_000 });
    await tileMenu.click();
    await page.getByTestId("job-card-rename").click();
    await expect(page.getByTestId("rename-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(tileMenu, "tile: after rename, Escape").toBeFocused();
    await tileMenu.click();
    await page.getByTestId("job-card-delete").click();
    await page.getByTestId("dialog-delete").getByRole("button", { name: "Cancel" }).click();
    await expect(tileMenu, "tile: after delete, Cancel").toBeFocused();
  });

  test("⋯, rename and delete name the video as its title does; an unchanged name renames nothing", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    const patches: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url() === `${API}/jobs/${job.id}`) patches.push(r.postData() ?? "");
    });
    await openVorschau(page, job.id);
    await expect(page.getByTestId("preview-title")).toHaveText("tiktok_3_mistakes");
    const menu = page.getByTestId("job-card-menu");
    await expect(menu).toHaveAttribute("aria-label", "More for tiktok_3_mistakes");
    await menu.click();
    await page.getByTestId("job-card-rename").click();
    await expect(page.getByTestId("rename-input")).toHaveValue("tiktok_3_mistakes");
    await page.getByTestId("rename-save").click();
    await expect(page.getByTestId("dialog-rename")).toHaveCount(0);
    expect(patches).toEqual([]);
    await menu.click();
    await page.getByTestId("job-card-delete").click();
    await expect(page.getByTestId("dialog-delete").getByRole("heading")).toHaveText("Delete “tiktok_3_mistakes”?");
  });

  test("an edited project: the Vorschau's ⋯ has no Edit again next to Fine-tune; its tile has", async ({ page, stub }) => {
    const job = await stub.seed("edited");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "edited");
    await expect(page.getByTestId("preview-refine")).toHaveText("Fine-tune");
    await page.getByTestId("job-card-menu").click();
    const list = page.getByTestId("job-card-menu-list");
    await expect(list.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(list.getByRole("menuitem", { name: "Edit again" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openWithStorage(page, "/app", { ...TOUR_DONE, [JOBS]: [storedJob(job.id, "tiktok_3_mistakes_v2.mp4")] });
    const tileMenu = jobCard(page, "tiktok_3_mistakes_v2").getByTestId("job-card-menu");
    await expect(tileMenu).toBeVisible({ timeout: 30_000 });
    await tileMenu.click();
    await expect(list.getByRole("menuitem", { name: "Edit again" })).toBeVisible();
  });

  test("phones: ⋯'s items are 44 px tall; a long press selects no control's label", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "a touch screen");
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    await page.getByTestId("job-card-menu").click();
    const items = page.getByTestId("job-card-menu-list").getByRole("menuitem");
    await expect(items.first()).toBeVisible();
    const heights = await items.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThanOrEqual(3);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Escape");
    await page.getByTestId("preview-more").click();
    for (const id of ["done-copy", "done-srt", "done-vtt", "preview-more", "preview-refine", "job-card-menu"]) {
      expect(await page.getByTestId(id).first().evaluate((el) => getComputedStyle(el).userSelect), id).toBe("none");
    }
  });

  test("a landscape phone: ⋯'s menu never opens over ⋯ itself", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "a touch screen");
    const job = await stub.seed("done");
    await page.setViewportSize({ width: 844, height: 390 });
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    const menu = page.getByTestId("job-card-menu");
    // ⋯ where its menu (four 44 px items) fits neither under nor over it
    await menu.evaluate((el) => window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 173, behavior: "instant" }));
    const [bx, by, bw, bh] = await box(menu);
    expect(by).toBe(173);
    await menu.click();
    const list = page.getByTestId("job-card-menu-list");
    await expect(list.getByRole("menuitem")).toHaveCount(4);
    const [lx, ly, lw, lh] = await box(list);
    const apart = lx + lw <= bx || bx + bw <= lx || ly + lh <= by || by + bh <= ly;
    expect(apart, `menu ${[lx, ly, lw, lh]} over ⋯ ${[bx, by, bw, bh]}`).toBe(true);
    expect(ly).toBeGreaterThanOrEqual(8);
    expect(ly + lh).toBeLessThanOrEqual(390 - 8);
    expect(lx).toBeGreaterThanOrEqual(8);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
  });

  test("phones: the rename and delete dialogs' buttons are 44 px tall", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "a touch screen");
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { storage: DE });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    for (const item of ["rename", "delete"] as const) {
      await page.getByTestId("job-card-menu").click();
      await page.getByTestId(`job-card-${item}`).click();
      const dialog = page.getByTestId(`dialog-${item}`);
      await expect(dialog).toBeVisible();
      const heights = await dialog.getByRole("button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      expect(heights, item).toHaveLength(2);
      for (const h of heights) expect(h, item).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  });

  test("pressed, the done state's small controls and the dialogs' buttons give a little too; not with reduced motion", async ({
    page,
    stub,
  }, info) => {
    test.skip(info.project.name !== "desktop", "a mouse");
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    await page.getByTestId("preview-more").click();
    const small = [
      page.getByTestId("done-copy"),
      page.getByTestId("done-srt"),
      page.getByTestId("done-vtt"),
      page.getByTestId("done-hooks").getByRole("link").first(),
    ];
    for (const el of small) await expect(el).toBeVisible();
    /** Held down on a dialog's button: its scale (then released on the dialog's title: no click). */
    const pressedInDialog = async (button: Locator, title: Locator) => {
      const b = (await button.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(400);
      const scale = await button.evaluate((n) => getComputedStyle(n).scale);
      const t = (await title.boundingBox())!;
      await page.mouse.move(t.x + 4, t.y + t.height / 2);
      await page.mouse.up();
      return scale;
    };
    // the scale while held: .97 (a frame of its transition may still be on its way), none with reduced motion
    const given = (scale: string) => (scale === "none" ? "none" : Math.abs(parseFloat(scale) - 0.97) < 0.002 ? "0.97" : scale);
    for (const motion of ["no-preference", "reduce"] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      const want = motion === "reduce" ? "none" : "0.97";
      for (const el of small) expect(given((await pressed(page, el)).scale), `${motion}: ${await el.textContent()}`).toBe(want);
      await page.getByTestId("job-card-menu").click();
      await page.getByTestId("job-card-rename").click();
      const dialog = page.getByTestId("dialog-rename");
      for (const name of ["Cancel", "Save"]) {
        expect(given(await pressedInDialog(dialog.getByRole("button", { name }), dialog.getByRole("heading"))), `${motion}: ${name}`).toBe(want);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  });

  test("pressed, ⋯ and the quiet buttons give a little; not with reduced motion", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "a mouse");
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    const menu = page.getByTestId("job-card-menu");
    const more = page.getByTestId("preview-more");
    expect((await pressed(page, menu)).scale).toMatch(/^0\.97( 0\.97)?$/);
    expect((await pressed(page, more)).transform).toBe("matrix(0.97, 0, 0, 0.97, 0, 0)");
    await expect(page.getByTestId("job-card-menu-list")).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await pressed(page, menu)).scale).toBe("none");
    expect((await pressed(page, more)).transform).toBe("none");
  });

  test("done: the bonus clips' heading sits under the title; SRT and VTT are spelled out", async ({ page, stub }) => {
    const job = await stub.seed("done");
    await openVorschau(page, job.id);
    await expect(vorschau(page)).toHaveAttribute("data-state", "done");
    await page.getByTestId("preview-more").click();
    await expect(page.getByRole("heading", { level: 2, name: /Bonus clips/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "SRT", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "VTT", exact: true })).toBeVisible();
  });

  test("German: deleting and Fertigstellen's refusals without Export, dashes or verarbeitet; the delete button AA", async ({
    page,
    stub,
  }) => {
    const job = await stub.seed("review_speech");
    await openVorschau(page, job.id, { storage: DE });
    await expect(vorschau(page)).toHaveAttribute("data-state", "ready");
    await page.getByTestId("job-card-menu").click();
    await page.getByTestId("job-card-delete").click();
    const dialog = page.getByTestId("dialog-delete");
    await expect(dialog).toContainText(
      "Das Video, seine Bearbeitungen und fertigen Versionen werden von unseren Servern entfernt. Das lässt sich nicht rückgängig machen.",
    );
    const confirm = page.getByTestId("delete-confirm");
    const [fg, bg] = await confirm.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    // The server can't delete it right now.
    await page.route(`${API}/jobs/${job.id}`, (r) =>
      r.request().method() === "DELETE" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.fallback(),
    );
    await confirm.click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Löschen hat gerade nicht geklappt. Wird das Video noch bearbeitet, versuch es gleich noch einmal.",
    );
    expect(await dialog.innerText()).not.toMatch(/Export|verarbeit|[–—]/);
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(dialog).toHaveCount(0);

    // Fertigstellen refused (429): too many at once, this video's limit for today.
    for (const [code, text] of [
      ["too_many_renders", "Gerade werden zu viele Videos fertiggestellt. Bitte warte, bis eins fertig ist."],
      ["render_limit", "Dieses Video hat sein Limit für heute erreicht. Versuch es morgen noch einmal."],
    ]) {
      await page.route(`${API}/jobs/${job.id}/render`, (r) =>
        r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ detail: code, code, params: {} }) }),
      );
      await page.getByTestId("preview-finish").click();
      await expect(page.getByTestId("preview-error")).toHaveText(text);
      await page.unroute(`${API}/jobs/${job.id}/render`);
    }
    expect((await stub.job(job.id))!.status).toBe("awaiting_review");
  });
});
