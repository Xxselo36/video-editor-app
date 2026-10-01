/**
 * The word-level Text tab of the v2 editor (UX8, PLAN_TECH "UX8 tests"):
 * fix a word (preview + stored doc + reload), find & replace across
 * three hits, hide from captions, a forced caption break, undo, the
 * sentence fallback for jobs without an edit document, the captions-off
 * note, a second tab's save (409 stale_rev → banner, nothing
 * overwritten) and the unload flush (keepalive body < 64 KB).
 * Desktop and pixel7; runs against a build with NEXT_PUBLIC_EDITOR_V2=1
 * (E2E_EDITOR_V2=1). The speech clip says "Nobody waits ten seconds"
 * and "mistake" three times.
 */
import type { Page, Request } from "@playwright/test";
import { expect, test, type Stub } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };

const isPhone = (page: Page) => page.getByTestId("editor-v2").evaluate((el) => el.getAttribute("data-layout") !== "desktop");

/** Open the job in the v2 editor with its Text tab (the sheet on the phone). */
async function openText(page: Page, jobId: string) {
  await openWithStorage(page, `/app/edit/${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  if (await isPhone(page)) await page.getByTestId("ed-tab-text").click();
  await expect(page.getByTestId("ed-word").first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

const word = (page: Page, text: string) => page.getByTestId("ed-word").filter({ hasText: new RegExp(`^${text}$`) });

/** Fix one word: double-click + type (desktop), tap + Edit + Done (phone). */
async function fixWord(page: Page, from: string, to: string) {
  if (await isPhone(page)) {
    await word(page, from).first().click();
    await page.getByTestId("ed-word-edit").click();
    await page.getByTestId("ed-word-input").fill(to);
    await page.getByTestId("ed-word-done").click();
  } else {
    await word(page, from).first().dblclick();
    await page.getByTestId("ed-word-input").fill(to);
    await page.getByTestId("ed-word-input").press("Enter");
  }
  await expect(page.getByTestId("ed-word-input")).toHaveCount(0);
}

const savedWords = async (stub: Stub, id: string) => (await stub.doc(id)).doc.words;
const savedText = async (stub: Stub, id: string) => (await savedWords(stub, id)).map((w) => w.text).join(" ");

type Hook = { page: string | null };
const captionPage = (page: Page) =>
  page.evaluate(() => (window as unknown as { __captionsInterim?: Hook }).__captionsInterim?.page ?? null);

test.describe("editor v2: word-level Text tab", TAG, () => {
  test("fix a word: the preview, the stored doc and a reload have it; ⌘Z undoes it", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    const before = await savedWords(stub, job.id);
    const ten = before.find((w) => w.text === "ten")!;
    await fixWord(page, "ten", "10");
    await expect(word(page, "10")).toHaveCount(1);
    // stored: the word keeps its id and its timing
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("waits 10 seconds");
    const fixed = (await savedWords(stub, job.id)).find((w) => w.id === ten.id)!;
    expect([fixed.text, fixed.start, fixed.end]).toEqual(["10", ten.start, ten.end]);
    await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "saved");
    // the preview: the caption at that word shows the fix
    await word(page, "10").click();
    await expect.poll(() => captionPage(page), { timeout: 15_000 }).toMatch(/\b10\b/);
    // undo (top bar) brings "ten" back, also on the server
    await page.getByTestId("ed-undo").click();
    await expect(word(page, "ten")).toHaveCount(1);
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("waits ten seconds");
    // redo, then reload: still there
    await page.getByTestId("ed-redo").click();
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("waits 10 seconds");
    await page.reload();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    if (await isPhone(page)) await page.getByTestId("ed-tab-text").click();
    await expect(word(page, "10")).toHaveCount(1, { timeout: 30_000 });
  });

  test("find & replace: 3 hits replaced in one step; then no results", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    await page.getByTestId("ed-search").click();
    await page.getByTestId("ed-find-input").fill("mistake number");
    await expect(page.getByTestId("ed-find-count")).toHaveText("1/3");
    await page.getByTestId("ed-find-input").press("Enter");
    await expect(page.getByTestId("ed-find-count")).toHaveText("2/3");
    await page.getByTestId("ed-replace-input").fill("error no.");
    await page.getByTestId("ed-replace-all").click();
    await expect(page.getByTestId("ed-toast")).toContainText("3");
    await expect(page.getByTestId("ed-find-none")).toHaveText("No results for “mistake number”");
    await expect.poll(async () => (await savedText(stub, job.id)).match(/\berror no\. /gi)?.length ?? 0, { timeout: 10_000 }).toBe(3);
    expect(await savedText(stub, job.id)).not.toMatch(/mistake number/i);
    expect(await savedText(stub, job.id)).toContain("three mistakes");
    // one undo step brings all three back
    await page.getByTestId("ed-find-input").press("Escape");
    await page.getByTestId("ed-undo").click();
    await expect(page.getByTestId("ed-word").filter({ hasText: /^mistake$/i })).toHaveCount(3);
    await expect(page.getByTestId("ed-word").filter({ hasText: /^error$/i })).toHaveCount(0);
  });

  test("hide from captions, show again; a forced caption break", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    const target = (await savedWords(stub, job.id)).find((w) => w.text === "seconds")!;
    await word(page, "seconds").click();
    await expect(page.getByTestId("ed-wordbar")).toBeVisible();
    await page.getByTestId("ed-word-hide").click();
    await expect(word(page, "seconds")).toHaveAttribute("data-hidden", "true");
    await expect.poll(async () => (await savedWords(stub, job.id)).find((w) => w.id === target.id)?.hidden, { timeout: 10_000 }).toBe(true);
    await page.getByTestId("ed-word-hide").click();
    await expect(word(page, "seconds")).not.toHaveAttribute("data-hidden", "true");
    // a new caption line before "seconds": its row starts there
    await page.getByTestId("ed-word-break").click();
    const row = page.getByTestId("transcript-line").filter({ has: word(page, "seconds") });
    await expect(row.getByTestId("ed-word").first()).toHaveText("seconds");
    await expect
      .poll(async () => (await savedWords(stub, job.id)).find((w) => w.id === target.id), { timeout: 10_000 })
      .toMatchObject({ breakBefore: true });
    expect((await savedWords(stub, job.id)).find((w) => w.id === target.id)?.hidden).toBeFalsy();
  });

  test("keyboard (desktop): Enter edits, Tab moves on, Enter at the word start breaks the line", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard");
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    await word(page, "Nobody").click();
    await word(page, "Nobody").press("ArrowRight");
    await expect(word(page, "waits")).toBeFocused();
    await page.keyboard.press("Enter");
    const input = page.getByTestId("ed-word-input");
    await expect(input).toHaveValue("waits");
    await input.fill("waited");
    await input.press("Tab"); // → editing "ten"
    await expect(page.getByTestId("ed-word-input")).toHaveValue("ten");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter"); // caret at the start: new caption line here
    await expect(page.getByTestId("ed-word-input")).toHaveCount(0);
    await expect(word(page, "ten")).toBeFocused();
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("Nobody waited ten");
    expect((await savedWords(stub, job.id)).find((w) => w.text === "ten")?.breakBefore).toBe(true);
    // H hides the focused word
    await page.keyboard.press("h");
    await expect(word(page, "ten")).toHaveAttribute("data-hidden", "true");
  });

  test("a closed Text tab doesn't act on its old selection (H, Escape)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "keyboard");
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    const target = (await savedWords(stub, job.id)).find((w) => w.text === "seconds")!;
    await word(page, "seconds").click();
    await page.getByTestId("ed-tab-style").click();
    await expect(page.getByTestId("ed-word")).toHaveCount(0);
    // focus on the page, not a control
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("h");
    // Escape still reaches the timeline: select a clip, Escape deselects it
    const clip = page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first();
    await clip.click();
    await expect(page.getByTestId("ed-split")).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ed-split")).toHaveCount(0);
    await page.waitForTimeout(1200);
    expect((await savedWords(stub, job.id)).find((w) => w.id === target.id)?.hidden).toBeFalsy();
    await page.getByTestId("ed-tab-text").click();
    await expect(word(page, "seconds")).not.toHaveAttribute("data-hidden", "true");
  });

  test("IME: Enter / Tab that confirm a composition don't commit, move or replace", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    const ime = (testId: string, key: string) =>
      page.getByTestId(testId).evaluate((el, k) => {
        for (const type of ["keydown", "keyup"])
          el.dispatchEvent(new KeyboardEvent(type, { key: k, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      }, key);
    if (await isPhone(page)) {
      await word(page, "ten").click();
      await page.getByTestId("ed-word-edit").click();
    } else await word(page, "ten").dblclick();
    await page.getByTestId("ed-word-input").fill("じゅう");
    await ime("ed-word-input", "Enter");
    await ime("ed-word-input", "Tab");
    await expect(page.getByTestId("ed-word-input")).toHaveValue("じゅう");
    await page.getByTestId("ed-word-input").fill("十");
    await page.getByTestId("ed-word-input").press("Enter");
    if (await isPhone(page)) await expect(page.getByTestId("ed-word-input")).toHaveCount(0);
    await expect(word(page, "十")).toHaveCount(1);
    // the replace field: composing Enter doesn't replace
    await page.getByTestId("ed-search").click();
    await page.getByTestId("ed-find-input").fill("seconds");
    await page.getByTestId("ed-replace-input").fill("びょう");
    await ime("ed-replace-input", "Enter");
    await ime("ed-find-input", "Enter");
    await expect(page.getByTestId("ed-find-count")).toHaveText("1/1");
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("waits 十 seconds");
  });

  test("a job from before the edit document: the sentence transcript", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { doc: false });
    await openWithStorage(page, `/app/edit/${job.id}`, TOUR_DONE);
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    if (await isPhone(page)) await page.getByTestId("ed-tab-text").click();
    await expect(page.getByTestId("transcript-line").first().locator("textarea")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ed-word")).toHaveCount(0);
  });

  test("captions off: the note links to the Style tab", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    const r = await stub.api.patch(`/jobs/${job.id}/doc`, {
      data: { base_rev: 0, rev: 1, style: { presetId: "none", overrides: {} } },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    await openText(page, job.id);
    const note = page.getByTestId("ed-captions-off");
    await expect(note).toContainText("Captions are off");
    await note.getByRole("button", { name: "Choose a style" }).click();
    await expect(page.getByTestId(/^ed-(style|sheet-style)$/).first()).toBeVisible();
  });

  test("another tab saved meanwhile: banner, nothing overwritten, reload shows theirs", async ({ page, stub, browser }) => {
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    const other = await browser.newContext(test.info().project.use);
    const tab2 = await other.newPage();
    await openText(tab2, job.id);
    await fixWord(tab2, "ten", "10");
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("waits 10 seconds");
    // this tab still has rev 0: its save is refused
    await fixWord(page, "Nobody", "Noone");
    await expect(page.getByTestId("ed-conflict")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("ed-conflict")).toContainText("Changed in another tab");
    expect(await savedText(stub, job.id)).not.toContain("Noone");
    // no further autosave
    await fixWord(page, "waits", "waited");
    await page.waitForTimeout(1500);
    expect(await savedText(stub, job.id)).not.toContain("waited");
    await page.getByTestId("ed-conflict-reload").click();
    await expect(page.getByTestId("ed-conflict")).toHaveCount(0);
    await expect(word(page, "10")).toHaveCount(1);
    await expect(word(page, "Noone")).toHaveCount(0);
    // saving works again after the reload
    await fixWord(page, "seconds", "secs");
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("10 secs");
    await other.close();
  });

  test("leaving right after an edit: the unload flush saves it (keepalive body < 64 KB)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await openText(page, job.id);
    const patches: Request[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url().endsWith(`/jobs/${job.id}/doc`)) patches.push(r);
    });
    await fixWord(page, "ten", "10");
    // before the 800 ms debounce: leave the page
    await page.goto("/imprint");
    await expect.poll(() => savedText(stub, job.id), { timeout: 10_000 }).toContain("waits 10 seconds");
    expect(patches.length).toBeGreaterThan(0);
    for (const r of patches) expect(r.postDataBuffer()?.length ?? 0).toBeLessThan(64 * 1024);
  });

  test("an inline edit survives scrolling its row far out of view", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "inline edit is desktop");
    const job = await stub.seed("review_long", { words: 3000 });
    await openText(page, job.id);
    const first = page.getByTestId("ed-word").first();
    const id = (await savedWords(stub, job.id))[0].id;
    await first.dblclick();
    await page.getByTestId("ed-word-input").fill("Scrolled");
    const list = page.getByTestId("ed-transcript");
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(300);
    await expect(page.getByTestId("ed-word-input")).toHaveValue("Scrolled");
    await list.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300);
    await expect(page.getByTestId("ed-word-input")).toHaveValue("Scrolled");
    await expect(page.getByTestId("ed-word-input")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await savedWords(stub, job.id)).find((w) => w.id === id)?.text, { timeout: 10_000 }).toBe("Scrolled");
  });

  test("replacing in thousands of words saves in several bodies under 64 KB", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "one size check is enough");
    const job = await stub.seed("review_long");
    await openText(page, job.id);
    const patches: Request[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url().endsWith(`/jobs/${job.id}/doc`)) patches.push(r);
    });
    await page.getByTestId("ed-search").click();
    await page.getByTestId("ed-find-input").fill("e");
    await page.getByTestId("ed-replace-input").fill("E");
    await page.getByTestId("ed-replace-all").click();
    await expect(page.getByTestId("ed-toast")).toBeVisible();
    await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const n = (await savedWords(stub, job.id)).filter((w) => w.text.includes("E")).length;
    expect(n).toBeGreaterThan(3000);
    expect(patches.length).toBeGreaterThan(1);
    for (const r of patches) expect(r.postDataBuffer()?.length ?? 0).toBeLessThan(64 * 1024);
  });
});
