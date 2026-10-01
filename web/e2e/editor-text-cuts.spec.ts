/**
 * Cuts in the text, visible AI cuts, one undo (UX10, PLAN_TECH "UX10
 * tests") and the owner's timeline items from the iPhone test:
 *   - cut a word range from the text: struck in the text, a gap in the
 *     clips (stored), the preview skips it, the export body leaves it out;
 *   - a Cleo-cut take is a chip in the text ("Show" jumps to it); the chip
 *     brings it back;
 *   - pause chips; bulk restore ("Restore pauses") is one undo step;
 *   - ⌘Z / redo order across text, cuts and hide;
 *   - extending a clip over a repeat cut and over a pause with a word
 *     brings their captions back (text tab, preview, export body);
 *   - a tapped seam names the cut and restores it;
 *   - press and hold a clip, drag it: reordered (stored, the export
 *     reads that order); a quick swipe doesn't move it;
 *   - holding a trim handle still zooms in; the readout shows 2 decimals;
 *   - 0.1 s ruler marks once they are 6 px apart.
 * Desktop and pixel7 (touch via CDP touch events); a build with
 * NEXT_PUBLIC_EDITOR_V2=1 (E2E_EDITOR_V2=1). The speech clip:
 *   0:00 "Hey, so today …" · pause · "Um," · "Mistake number one: …" ·
 *   "Nobody waits ten seconds for you to get to the point." · pause · …
 */
import type { Page, Request } from "@playwright/test";
import { expect, test, type Stub } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1" };
const SAVED = { timeout: 15_000 };

const isPhone = (page: Page) => page.getByTestId("editor-v2").evaluate((el) => el.getAttribute("data-layout") !== "desktop");

async function open(page: Page, jobId: string, text = true) {
  await openWithStorage(page, `/app/edit/${jobId}`, TOUR_DONE);
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.getByTestId("editor-video").evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  if (text) await openText(page);
}

async function openText(page: Page) {
  if ((await isPhone(page)) && !(await page.getByTestId("ed-sheet-text").isVisible())) await page.getByTestId("ed-tab-text").click();
  await expect(page.getByTestId("ed-word").first()).toBeVisible({ timeout: 30_000 });
}

async function closeText(page: Page) {
  if (!(await isPhone(page))) return;
  // Escape first clears a word selection, then closes the sheet
  for (let i = 0; i < 3 && (await page.getByTestId("ed-sheet-text").isVisible()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId("ed-sheet-text")).toBeHidden();
}

const word = (page: Page, text: string) => page.getByTestId("ed-word").filter({ hasText: new RegExp(`^${text}$`) });
const clipsOf = (page: Page) => page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
const seams = (page: Page) => page.getByTestId("ed-seam");
const timeline = (stub: Stub, id: string) => stub.timeline(id);
const covered = (tl: number[][], t: number) => tl.some(([s, e]) => s <= t && t <= e);

type Hook = { page: string | null };
const captionPage = (page: Page) =>
  page.evaluate(() => (window as unknown as { __captionsInterim?: Hook }).__captionsInterim?.page ?? null);

/** Select words first..last in the text (click, ⇧-click). */
async function selectWords(page: Page, first: string, last: string) {
  await word(page, first).first().click();
  await word(page, last).first().click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("ed-wordbar")).toBeVisible();
}

/** The render body the Export button sends. */
async function exportBody(page: Page): Promise<{ subtitles: { text: string; original_start: number }[] }> {
  const req = page.waitForRequest((r: Request) => r.method() === "POST" && /\/jobs\/[^/]+\/render$/.test(r.url()), { timeout: 30_000 });
  await page.getByTestId("ed-export").click();
  return (await req).postDataJSON();
}

/** Press, hold, then drag (mouse on desktop, CDP touch on the phone). */
async function holdAndDrag(page: Page, x0: number, y0: number, x1: number, y1: number, holdMs = 650) {
  if (await isPhone(page)) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
    await page.waitForTimeout(holdMs);
    for (let i = 1; i <= 12; i++) {
      const x = x0 + ((x1 - x0) * i) / 12;
      const y = y0 + ((y1 - y0) * i) / 12;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(20);
    }
    return async () => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    };
  }
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.move(x1, y1, { steps: 12 });
  return async () => {
    await page.mouse.up();
  };
}

test.describe("editor v2: cuts in the text, AI cuts, one undo", TAG, () => {
  test("cut a word range: struck, a gap in the clips, the preview skips it, the export leaves it out", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const nClips = await clipsOf(page).count();
    await selectWords(page, "ten", "seconds");
    await page.getByTestId("ed-word-cut").click();
    await expect(word(page, "ten")).toHaveAttribute("data-rm", "true");
    await expect(word(page, "seconds")).toHaveAttribute("data-rm", "true");
    // stored: a gap over "ten seconds" (11.195–11.812), the rest still there
    await expect.poll(async () => covered(await timeline(stub, job.id), 11.5), SAVED).toBe(false);
    const tl = await timeline(stub, job.id);
    expect(covered(tl, 10.9) && covered(tl, 12.0)).toBe(true);
    await closeText(page);
    await expect(clipsOf(page)).toHaveCount(nClips + 1);
    // the preview: playing across the cut never shows its footage
    const seen = await page.getByTestId("editor-video").evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      v.muted = true;
      v.currentTime = 10.6;
      await new Promise((r) => setTimeout(r, 300));
      const out: number[] = [];
      const id = setInterval(() => out.push(v.currentTime), 25);
      await v.play();
      await new Promise((r) => setTimeout(r, 1600));
      v.pause();
      clearInterval(id);
      return out;
    });
    expect(seen.some((t) => t > 12.0)).toBe(true);
    expect(seen.filter((t) => t > 11.3 && t < 11.7)).toEqual([]);
    // the export body: no "ten", no "seconds."; "waits" and "for" stay
    const body = await exportBody(page);
    const said = body.subtitles.map((u) => u.text).join(" ");
    expect(said).not.toMatch(/\bten\b/);
    expect(said).not.toMatch(/\bseconds\b/);
    expect(said).toContain("waits");
    expect(said).toMatch(/\bfor\b/);
  });

  test("peaks come from the API itself and snap a text cut; a redirecting /peaks leaves the edges raw, no CORS error", async ({
    page,
    stub,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    // the gap the cut of "ten seconds" (11.195–11.812) leaves: its start
    const gapStart = async (id: string) => {
      await expect.poll(async () => covered(await timeline(stub, id), 11.5), SAVED).toBe(false);
      return (await timeline(stub, id)).map((x) => x[1]).find((e) => e > 10.9 && e < 11.5)!;
    };
    const job = await stub.seed("review_speech");
    const peaks = page.waitForResponse((r) => /\/jobs\/[^/]+\/peaks/.test(r.url()));
    await open(page, job.id);
    const res = await peaks;
    expect(res.status()).toBe(200);
    expect((await res.body()).length).toBeGreaterThan(1000);
    await page.waitForTimeout(300);
    await selectWords(page, "ten", "seconds");
    await page.getByTestId("ed-word-cut").click();
    const snapped = await gapStart(job.id);
    expect(Math.abs(snapped - 11.195)).toBeLessThanOrEqual(0.121);
    // only in the gap after the word before "ten" (review 14)
    const ws = (await stub.doc(job.id)).doc.words;
    const iTen = ws.findIndex((w) => w.text === "ten");
    expect(snapped).toBeGreaterThanOrEqual(ws[iTen - 1].end - 0.0011);
    expect(snapped).toBeLessThanOrEqual(11.195 + 0.0011);
    // (i + 0.5) / 100: the centre of a peaks frame
    expect(Math.abs(snapped * 100 - 0.5 - Math.round(snapped * 100 - 0.5))).toBeLessThan(0.01);

    // the R2 redirect the editor's fetch used to follow: not followed now
    const job2 = await stub.seed("review_speech", { peaks: "redirect" });
    const red = page.waitForResponse((r) => /\/jobs\/[^/]+\/peaks/.test(r.url()) && r.url().includes(job2.id));
    await open(page, job2.id);
    await red;
    await page.waitForTimeout(300);
    await selectWords(page, "ten", "seconds");
    await page.getByTestId("ed-word-cut").click();
    expect(await gapStart(job2.id)).toBeCloseTo(11.195, 3);
    expect(errors.filter((e) => /CORS|peaks|Access-Control/i.test(e))).toEqual([]);
  });

  test("Cleo cut: a take chip with its line; the chip restores it; ⌘Z cuts it again", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { ai_cuts: [[10.45, 13.7, "voice_cmd"]] });
    await open(page, job.id);
    await expect(page.getByTestId("ed-cleo-cut")).toContainText("1");
    const chip = page.getByTestId("ed-take-chip");
    await expect(chip).toHaveCount(1);
    // "Show" (review E3): the playhead jumps to the take's cut (10.45 → 13.7 s), its chip in view
    const video = page.getByTestId("editor-video");
    const at = () => video.evaluate((v) => (v as HTMLVideoElement).currentTime);
    await page.getByTestId("ed-cleo-show").click();
    await expect.poll(async () => Math.min(Math.abs((await at()) - 10.45), Math.abs((await at()) - 13.7))).toBeLessThan(0.25);
    await expect(chip).toBeInViewport();
    // the take's words collapse into the chip
    await expect(word(page, "Nobody")).toHaveCount(0);
    await chip.click();
    await expect(word(page, "Nobody")).toHaveCount(1);
    await expect(word(page, "Nobody")).not.toHaveAttribute("data-rm", "true");
    await expect(page.getByTestId("ed-cleo-cut")).toHaveCount(0);
    await expect.poll(async () => covered(await timeline(stub, job.id), 12.0), SAVED).toBe(true);
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await expect(page.getByTestId("ed-take-chip")).toHaveCount(1);
    await expect.poll(async () => covered(await timeline(stub, job.id), 12.0), SAVED).toBe(false);
  });

  test("pause chips restore their pause; Restore pauses is one undo step", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const chips = page.getByTestId("ed-pause-chip");
    const n = await chips.count();
    expect(n).toBeGreaterThanOrEqual(3);
    // the pause after "point." (13.656–15.156) comes back with its chip
    const before = await timeline(stub, job.id);
    expect(covered(before, 14.4)).toBe(false);
    await page.getByTestId("ed-pause-chip").filter({ hasText: /1[.,]5/ }).first().click();
    await expect.poll(async () => covered(await timeline(stub, job.id), 14.4), SAVED).toBe(true);
    await expect(chips).toHaveCount(n - 1);
    // bulk: every pause in one op, one ⌘Z brings them all back
    await page.getByTestId("ed-cuts").click();
    await expect(page.getByTestId("ed-cuts-menu")).toBeVisible();
    await page.getByTestId("ed-restore-silence").click();
    await expect.poll(async () => covered(await timeline(stub, job.id), 0.2), SAVED).toBe(true);
    // the "uh," filler cut is not a pause: it stays cut
    expect(covered(await timeline(stub, job.id), 16.8)).toBe(false);
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await expect.poll(async () => covered(await timeline(stub, job.id), 0.2), SAVED).toBe(false);
    expect(covered(await timeline(stub, job.id), 14.4)).toBe(true); // the single restore stays
    await expect(chips).toHaveCount(n - 1);
  });

  test("⌘Z and redo go through text, cut and hide in order", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const undo = page.locator('[data-testid="ed-undo"]:visible').first();
    const redo = page.locator('[data-testid="ed-redo"]:visible').first();
    // 1 text: "ten" → "10"
    if (await isPhone(page)) {
      await word(page, "ten").click();
      await page.getByTestId("ed-word-edit").click();
      await page.getByTestId("ed-word-input").fill("10");
      await page.getByTestId("ed-word-done").click();
    } else {
      await word(page, "ten").dblclick();
      await page.getByTestId("ed-word-input").fill("10");
      await page.getByTestId("ed-word-input").press("Enter");
    }
    await expect(word(page, "10")).toHaveCount(1);
    // 2 cut: "point."
    await word(page, "point.").click();
    await page.getByTestId("ed-word-cut").click();
    await expect(word(page, "point.")).toHaveAttribute("data-rm", "true");
    // 3 hide: "waits" (Escape first: the word menu of "point." sits over it)
    await page.keyboard.press("Escape");
    await word(page, "waits").click();
    await page.getByTestId("ed-word-hide").click();
    await expect(word(page, "waits")).toHaveAttribute("data-hidden", "true");

    await undo.click(); // 3
    await expect(word(page, "waits")).not.toHaveAttribute("data-hidden", "true");
    await expect(word(page, "point.")).toHaveAttribute("data-rm", "true");
    await undo.click(); // 2
    await expect(word(page, "point.")).not.toHaveAttribute("data-rm", "true");
    await expect(word(page, "10")).toHaveCount(1);
    await undo.click(); // 1
    await expect(word(page, "ten")).toHaveCount(1);
    await redo.click();
    await expect(word(page, "10")).toHaveCount(1);
    await expect(word(page, "point.")).not.toHaveAttribute("data-rm", "true");
    await redo.click();
    await expect(word(page, "point.")).toHaveAttribute("data-rm", "true");
    await redo.click();
    await expect(word(page, "waits")).toHaveAttribute("data-hidden", "true");
    await expect.poll(async () => covered(await timeline(stub, job.id), 13.3), SAVED).toBe(false);
  });

  test("extending a clip over a repeat cut and a pause with a word brings their captions back", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", {
      ai_cuts: [[24.6, 25.6, "filler"]],
      extra_words: [{ text: "really", start: 14.2, end: 14.5, nospeech: true }],
    });
    await open(page, job.id);
    await expect(word(page, "Most")).toHaveAttribute("data-rm", "true");
    await expect(word(page, "really")).toHaveAttribute("data-rm", "true");
    await closeText(page);
    // the clips ending at 13.656 (before "really") and 24.6 (before "Most"): drag their end handles right
    const tl = await timeline(stub, job.id);
    for (const end of [13.656, 24.6]) {
      const idx = tl.findIndex(([, e]) => Math.abs(e - end) < 0.01);
      expect(idx, `clip ending at ${end}`).toBeGreaterThanOrEqual(0);
      const clip = clipsOf(page).nth(idx);
      await clip.click();
      const h = (await clip.getByTestId("clip-trim-end").boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + 160, h.y + h.height / 2, { steps: 8 });
      await page.mouse.up();
    }
    await expect.poll(async () => covered(await timeline(stub, job.id), 14.35) && covered(await timeline(stub, job.id), 24.8), SAVED).toBe(true);
    await openText(page);
    await expect(word(page, "Most")).not.toHaveAttribute("data-rm", "true");
    await expect(word(page, "really")).not.toHaveAttribute("data-rm", "true");
    // the preview's caption at "really"
    await word(page, "really").click();
    await expect.poll(() => captionPage(page), { timeout: 15_000 }).toMatch(/really/i);
    const body = await exportBody(page);
    const said = body.subtitles.map((u) => u.text).join(" ");
    expect(said).toMatch(/\breally\b/);
    expect(said).toMatch(/\bMost\b/);
  });

  test("a tapped seam names the cut and restores it (one undo step, in the text too)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id, false);
    const n = await seams(page).count();
    expect(n).toBeGreaterThanOrEqual(4);
    // one seam per cut between two clips (the stored timeline's gaps: the
    // job's cut ranges without the head and tail)
    const tl0 = await timeline(stub, job.id);
    expect(n).toBe(tl0.filter((x, i) => i > 0 && x[0] - tl0[i - 1][1] > 0.02).length);
    // the "uh," cut between "two," and "is" (16.56–17.063): a filler word
    const filler = page.locator('[data-testid="ed-seam"][data-seam="filler"]').first();
    const box = (await filler.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(32);
    await filler.click();
    const pop = page.getByTestId("ed-seam-popover");
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("Filler word");
    await expect(pop).toContainText(/0[.,]5\ss/);
    await pop.getByTestId("ed-seam-restore").click();
    await expect(seams(page)).toHaveCount(n - 1);
    await expect.poll(async () => covered(await timeline(stub, job.id), 16.8), SAVED).toBe(true);
    await openText(page);
    await expect(word(page, "uh,")).not.toHaveAttribute("data-rm", "true");
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await expect(word(page, "uh,")).toHaveAttribute("data-rm", "true");
  });
});

test.describe("editor v2: the timeline (owner's iPhone items)", TAG, () => {
  test("press and hold a clip, drag it: reordered and stored; a quick swipe moves nothing", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id, false);
    const before = await timeline(stub, job.id);
    // a quick swipe over clip 0 (no hold): nothing moves
    const c0 = (await clipsOf(page).nth(0).boundingBox())!;
    const y = c0.y + c0.height / 2;
    const quick = await holdAndDrag(page, c0.x + 6, y, c0.x + 120, y, 0);
    await quick();
    await page.waitForTimeout(400);
    await expect(clipsOf(page).nth(0)).not.toHaveAttribute("data-lifted", "true");
    expect(await timeline(stub, job.id)).toEqual(before);
    // hold clip 0 (at its middle), drag it so its middle passes clip 1's
    // middle as the others lay out without it (they make room): [1, 0, 2, …]
    const c1 = (await clipsOf(page).nth(1).boundingBox())!;
    const release = await holdAndDrag(page, c0.x + c0.width / 2, y, c0.x + c1.width * 0.75, y);
    await expect(page.locator('[data-lifted="true"]')).toHaveCount(1);
    await release();
    await expect.poll(async () => (await timeline(stub, job.id))[0], SAVED).toEqual(before[1]);
    const after = await timeline(stub, job.id);
    expect(after[1]).toEqual(before[0]);
    expect(after.slice(2)).toEqual(before.slice(2));
    // seams: only real cuts (a gap no clip plays); the jumps across the
    // moved clip are moves — no "Manual cut", no inflated length (review 2/8)
    const realCuts = after.filter(
      (x, i) => i > 0 && x[0] - after[i - 1][1] > 0.02 && !after.some(([s, e]) => s < x[0] - 0.001 && e > after[i - 1][1] + 0.001),
    ).length;
    await expect(seams(page)).toHaveCount(realCuts);
    await expect(page.locator('[data-testid="ed-seam"][data-seam="user"]')).toHaveCount(0);
    // one undo step
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await expect.poll(() => timeline(stub, job.id), SAVED).toEqual(before);
    await page.locator('[data-testid="ed-redo"]:visible').first().click();
    await expect.poll(async () => (await timeline(stub, job.id))[0], SAVED).toEqual(before[1]);
    // the export renders that order (the render reads the stored segments)
    await openText(page);
    const body = await exportBody(page);
    expect(body.subtitles.length).toBeGreaterThan(0);
    await expect.poll(async () => (await stub.job(job.id))!.status, { timeout: 30_000 }).not.toBe("awaiting_review");
    expect((await timeline(stub, job.id))[0]).toEqual(before[1]);
  });

  test("holding a trim handle still zooms in; the edge reads 2 decimals; release zooms back", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id, false);
    const strip = page.getByTestId("timeline-scroll");
    const width0 = await strip.evaluate((el) => el.scrollWidth);
    const clip = clipsOf(page).nth(1);
    await clip.click();
    const h = (await clip.getByTestId("clip-trim-end").boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    const release = await holdAndDrag(page, x, y, x - 6, y, 0);
    const readout = page.getByTestId("ed-trim-readout");
    await expect(readout).toHaveText(/^\d+\.\d{2} s$/);
    // hold still: the magnifier
    await expect(strip).toHaveAttribute("data-magnified", "true", { timeout: 3_000 });
    const shown = parseFloat((await readout.textContent()) ?? "");
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth), { timeout: 3_000 }).toBeGreaterThan(width0 * 3);
    // 0.1 s marks and the frame grid at this zoom
    await expect(page.locator('[data-testid="timeline-ruler"] [data-kind="tenth"]').first()).toBeAttached();
    await expect(page.locator('[class*="frameLine"]').first()).toBeAttached();
    await release();
    await expect(strip).not.toHaveAttribute("data-magnified", "true", { timeout: 3_000 });
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth), { timeout: 3_000 }).toBeLessThan(width0 * 1.5);
    // stored on a frame boundary (30 fps, a hair before it: both exports
    // cut there), and that is the value the readout showed
    await expect.poll(async () => Math.abs((await timeline(stub, job.id))[1][1] - 13.656) > 0.001, SAVED).toBe(true);
    const e = (await timeline(stub, job.id))[1][1]; // the server keeps ms
    const f = e * 30;
    expect(Math.abs(f - Math.round(f))).toBeLessThan(0.05);
    expect(Math.ceil(f - 1e-9)).toBe(Math.round(f)); // v1 and v2 pick the same frame
    expect(e.toFixed(2)).toBe(shown.toFixed(2));
  });

  test("0.1 s ruler marks once they are 6 px apart", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "the zoom slider is desktop only (the phone zooms by pinch)");
    const job = await stub.seed("review_speech");
    await open(page, job.id, false);
    const tenth = page.locator('[data-testid="timeline-ruler"] [data-kind="tenth"]');
    await expect(tenth).toHaveCount(0); // fitted: 35 s in ~1400 px
    await page.getByTestId("ed-zoom").fill("100");
    await expect(tenth.first()).toBeAttached();
    const xs = await tenth.evaluateAll((els) => els.slice(0, 3).map((e) => e.getBoundingClientRect().left));
    expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(6);
  });
});
