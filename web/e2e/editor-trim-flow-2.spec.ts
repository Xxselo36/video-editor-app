/**
 * The trim flow, round 2 (owner report S1–S6, after round 1):
 *   - preview mode plays the server's preview with its baked volume and
 *     fades and applies only the speed; proxy mode applies all of it;
 *   - timeline saves carry the revision rule: another tab's or device's
 *     save is never overwritten — the editor reloads it and says so;
 *   - one timeline save on the wire at a time, the newest state next;
 *   - dragging a trim edge all the way removes the clip (one undo step);
 *   - the video follows a dragged edge, and a released edge goes between
 *     words, while one put between words stays exact;
 *   - at Fit a released edge stays where it was let go, then the strip
 *     settles to fill the dock again;
 *   - phone: zoom buttons, and a tap on a seam next to a tiny clip
 *     selects the clip;
 *   - an edit that never reached the server comes back on the next open;
 *   - preview mode: every frame after a skip has its playhead.
 * Desktop and pixel7 (touch via CDP touch events); a v2 build
 * (E2E_EDITOR_V2=1).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openWithStorage } from "./support/app";

const TAG = { tag: "@editor-v2" };
const TOUR_DONE = { "cleocuts.editor.tourDone.v1": "1", "cleocuts.voiceOnboardingSeen.v1": "1" };
const SAVED = { timeout: 15_000 };

const isPhone = (page: Page) => page.getByTestId("editor-v2").evaluate((el) => el.getAttribute("data-layout") !== "desktop");
const clipsOf = (page: Page) => page.getByTestId("ed-timeline").getByTestId(/^clip-\d+$/);
const video = (page: Page) => page.getByTestId("editor-video");
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(page: Page, jobId: string, storage: Record<string, string> = {}) {
  await openWithStorage(page, `/app/edit/${jobId}`, { ...TOUR_DONE, ...storage });
  await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
  await expect(clipsOf(page).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => video(page).evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
}

/** Pointer down at (x, y); `to(x)` moves it; `up()` releases. Mouse on desktop, CDP touch on the phone. */
async function press(page: Page, x: number, y: number) {
  if (await isPhone(page)) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    return {
      to: async (nx: number, steps = 8) => {
        for (let i = 1; i <= steps; i++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + ((nx - x) * i) / steps, y }] });
          await page.waitForTimeout(16);
        }
        x = nx;
      },
      up: async () => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach();
      },
    };
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  return {
    to: async (nx: number, steps = 8) => {
      await page.mouse.move(nx, y, { steps });
      x = nx;
    },
    up: async () => {
      await page.mouse.up();
    },
  };
}

/** A finger's tap (CDP touch: the phone moves the click onto a small
 *  target nearby, touch adjustment, as on a real phone). */
async function tap(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(40);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** The settle after a released trim (TimelineDock SETTLE_ID) has ended:
 *  the clips are drawn where they are laid out. */
const settled = (page: Page) =>
  page
    .getByTestId("timeline-scroll")
    .evaluate((el) => !el.getAnimations({ subtree: true }).some((a) => a.id === "ed-settle" && a.playState === "running"));

async function select(page: Page, i: number) {
  const clip = clipsOf(page).nth(i);
  // where the clip is drawn at rest: a box read while the strip settles is
  // stale by the click (the click goes to what is drawn there by then)
  await expect.poll(() => settled(page), { timeout: 3_000 }).toBe(true);
  await clip.scrollIntoViewIfNeeded();
  const b = (await clip.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(clip).toHaveAttribute("data-selected", "true");
  return clip;
}

/** px per second of the strip as laid out now. */
async function ppsOf(page: Page, total: number) {
  return (await page.getByTestId("timeline-scroll").evaluate((el) => el.scrollWidth)) / total;
}

async function trimEnd(page: Page, i: number, dx: number) {
  const clip = await select(page, i);
  const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
  const p = await press(page, h.x, h.y);
  await p.to(h.x + dx);
  await p.up();
}

test.describe("editor v2: the trim flow, round 2", TAG, () => {
  for (const proxy of ["off", "on"] as const) {
    test(`${proxy === "off" ? "preview" : "proxy"} mode: a clip's speed plays; volume ${proxy === "off" ? "comes baked in the preview (not applied again)" : "is applied by the player"} (preview-5)`, async ({ page, stub }) => {
      test.setTimeout(240_000);
      const job = await stub.seed("review_speech", { proxy });
      await open(page, job.id);
      await expect(video(page)).toHaveAttribute("data-playback", proxy === "off" ? "preview" : "proxy");
      const clip = await select(page, 0);
      await page.getByTestId("ed-clip-menu").click();
      const pop = page.getByTestId("ed-clip-popover");
      await pop.getByRole("button", { name: "1.5×" }).click();
      await pop.getByRole("slider", { name: "Volume" }).fill("0.5");
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await stub.job(job.id))!.edit_segments[0].volume, SAVED).toBe(0.5);
      // preview mode: the rebuilt file (with the volume in it) on screen
      if (proxy === "off") await expect(page.getByTestId("preview-updating")).toBeHidden({ timeout: 200_000 });
      const b = (await clip.boundingBox())!;
      await page.mouse.click(b.x + b.width * 0.3, b.y + b.height / 2);
      const seen = await video(page).evaluate(async (el) => {
        const v = el as HTMLVideoElement;
        await v.play();
        await new Promise((r) => setTimeout(r, 600));
        const out = { rate: v.playbackRate, volume: v.volume, muted: v.muted };
        v.pause();
        return out;
      });
      expect(seen.rate).toBeCloseTo(1.5, 2);
      if (proxy === "off") expect(seen.volume).toBe(1);
      else expect(seen.volume).toBeCloseTo(0.5, 2);
      expect(seen.muted).toBe(false);
    });
  }

  test("another device saved the timeline: the editor never overwrites it, reloads it and says so (F3)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const j0 = (await stub.job(job.id))!;
    const n0 = j0.edit_segments.length;
    // another device: drops the last clip
    const theirs = j0.edit_segments.slice(0, -1);
    const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
      data: { segments: theirs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) },
      timeout: 120_000,
    });
    expect(r.ok(), await r.text()).toBe(true);
    // this tab, still on the old timeline, trims
    await trimEnd(page, 1, -30);
    await expect(page.getByTestId("ed-toast")).toContainText("another tab or on another device", { timeout: 15_000 });
    // the other device's timeline is on screen, and still on the server
    await expect(clipsOf(page)).toHaveCount(n0 - 1);
    const now = await stub.timeline(job.id);
    expect(now).toEqual(theirs.map((s) => [s.start, s.end]));
    // and editing goes on from it
    await trimEnd(page, 1, -30);
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < theirs[1].end - 0.05, SAVED).toBe(true);
    expect((await stub.timeline(job.id)).length).toBe(n0 - 1);
  });

  for (const theirsDoc of [false, true]) {
    test(`a timeline conflict keeps the text edits made here${theirsDoc ? " (the other device changed the text too: both stay)" : ""}, and the last change is one tap away (round 3)`, async ({ page, stub }) => {
      const job = await stub.seed("review_speech");
      await open(page, job.id);
      const phone = await isPhone(page);
      const j0 = (await stub.job(job.id))!;
      const n0 = j0.edit_segments.length;
      // another device: drops the last clip (and fixes a word)
      const theirs = j0.edit_segments.slice(0, -1);
      const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
        data: { segments: theirs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) },
        timeout: 120_000,
      });
      expect(r.ok(), await r.text()).toBe(true);
      if (theirsDoc) {
        const d0 = await stub.doc(job.id);
        const ten = d0.doc.words.find((w) => w.text === "ten")!;
        const p = await stub.api.patch(`/jobs/${job.id}/doc`, {
          data: { base_rev: d0.rev, rev: Math.floor(Date.now() * 1000), words: { upsert: [{ ...ten, text: "10" }], delete: [] } },
        });
        expect(p.ok(), await p.text()).toBe(true);
      }
      // this tab's timeline save waits until the word below is fixed: the
      // 409 comes while that text edit is still unsaved (its debounce)
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      await page.route(/\/edit-segments$/, async (route) => {
        await held;
        await route.continue();
      });
      await trimEnd(page, 1, -30);
      if (phone) await page.getByTestId("ed-tab-text").click();
      const w = page.getByTestId("ed-word").filter({ hasText: /^Nobody$/ }).first();
      if (phone) {
        await w.click();
        await page.getByTestId("ed-word-edit").click();
        await page.getByTestId("ed-word-input").fill("Noone");
        await page.getByTestId("ed-word-done").click();
      } else {
        await w.dblclick();
        await page.getByTestId("ed-word-input").fill("Noone");
        await page.getByTestId("ed-word-input").press("Enter");
      }
      release();
      const toast = page.getByTestId("ed-toast");
      await expect(toast).toContainText("another tab or on another device", { timeout: 15_000 });
      await expect(toast.getByTestId("ed-toast-action")).toHaveText("Restore your last change");
      // the text edit: on screen and on the server (with theirs, when they made one)
      const text = async () => (await stub.doc(job.id)).doc.words.map((x) => x.text).join(" ");
      await expect.poll(text, SAVED).toContain("Noone");
      if (theirsDoc) expect(await text()).toContain("waits 10 seconds");
      await expect(page.getByTestId("ed-word").filter({ hasText: /^Noone$/ })).toHaveCount(1);
      if (theirsDoc) await expect(page.getByTestId("ed-word").filter({ hasText: /^10$/ })).toHaveCount(1);
      // the other device's timeline is what is stored
      expect(await stub.timeline(job.id)).toEqual(theirs.map((x) => [x.start, x.end]));
      // one tap: this device's last change (the trim, on the old clip list) is back and saved
      await toast.getByTestId("ed-toast-action").click();
      await expect.poll(async () => (await stub.timeline(job.id)).length, SAVED).toBe(n0);
      const back = await stub.timeline(job.id);
      expect(back[1][1]).toBeLessThan(j0.edit_segments[1].end - 0.05);
      await expect(clipsOf(page)).toHaveCount(n0);
      // the text edit is still there
      expect(await text()).toContain("Noone");
    });
  }

  test("a timeline conflict brings the other device's text edits in when none of this tab's is pending; the next text edit saves (round 3)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const phone = await isPhone(page);
    const j0 = (await stub.job(job.id))!;
    // another device: fixes a word, then drops the last clip
    const d0 = await stub.doc(job.id);
    const ten = d0.doc.words.find((w) => w.text === "ten")!;
    const p = await stub.api.patch(`/jobs/${job.id}/doc`, {
      data: { base_rev: d0.rev, rev: Math.floor(Date.now() * 1000), words: { upsert: [{ ...ten, text: "10" }], delete: [] } },
    });
    expect(p.ok(), await p.text()).toBe(true);
    const theirs = j0.edit_segments.slice(0, -1);
    const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
      data: { segments: theirs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) + 7 },
      timeout: 120_000,
    });
    expect(r.ok(), await r.text()).toBe(true);
    // this tab: a trim only, no text edit pending
    await trimEnd(page, 1, -30);
    await expect(page.getByTestId("ed-toast")).toContainText("another tab or on another device", { timeout: 15_000 });
    // "the newest version": the other device's word fix is on screen too
    if (phone) await page.getByTestId("ed-tab-text").click();
    await expect(page.getByTestId("ed-word").filter({ hasText: /^10$/ })).toHaveCount(1);
    // a text edit now saves (no conflict of the doc's own)
    const w = page.getByTestId("ed-word").filter({ hasText: /^Nobody$/ }).first();
    if (phone) {
      await w.click();
      await page.getByTestId("ed-word-edit").click();
      await page.getByTestId("ed-word-input").fill("Noone");
      await page.getByTestId("ed-word-done").click();
    } else {
      await w.dblclick();
      await page.getByTestId("ed-word-input").fill("Noone");
      await page.getByTestId("ed-word-input").press("Enter");
    }
    const text = async () => (await stub.doc(job.id)).doc.words.map((x) => x.text).join(" ");
    await expect.poll(text, SAVED).toContain("Noone");
    expect(await text()).toContain("waits 10 seconds");
    await expect(page.getByTestId("ed-conflict")).toHaveCount(0);
  });

  test("one timeline save on the wire at a time: edits meanwhile go as one save of the newest state (F4)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const phone = await isPhone(page);
    const bodies: { base_rev: number; rev: number; segments: { start: number; end: number }[] }[] = [];
    let hold = true;
    await page.route(/\/edit-segments$/, async (route) => {
      bodies.push(JSON.parse(route.request().postData() ?? "{}"));
      // the first save takes 10 s to reach the server
      if (hold) {
        hold = false;
        await sleep(10_000);
      }
      await route.continue();
    });
    await trimEnd(page, 1, -20);
    await expect.poll(() => bodies.length, { timeout: 5_000 }).toBe(1);
    await trimEnd(page, 3, -20);
    await page.waitForTimeout(900);
    await trimEnd(page, 4, -20);
    await page.waitForTimeout(900);
    // still one on the wire, nothing "Saved"
    expect(bodies).toHaveLength(1);
    if (!phone) await expect(page.getByTestId("ed-save-status")).not.toHaveAttribute("data-state", "saved");
    // the first stored: one more save, of the newest state, on its rev
    await expect.poll(() => bodies.length, { timeout: 20_000 }).toBe(2);
    expect(bodies[1].base_rev).toBe(bodies[0].rev);
    await expect
      .poll(async () => {
        const t = await stub.timeline(job.id);
        return t[1][1] < before[1][1] - 0.05 && t[3][1] < before[3][1] - 0.05 && t[4][1] < before[4][1] - 0.05;
      }, SAVED)
      .toBe(true);
    expect(bodies[1].segments.map((s) => [s.start, s.end])).toEqual(await stub.timeline(job.id));
    if (!phone) await expect(page.getByTestId("ed-save-status")).toHaveAttribute("data-state", "saved", { timeout: 10_000 });
    await page.waitForTimeout(1500);
    expect(bodies).toHaveLength(2);
  });

  test("dragging a trim edge all the way removes the clip, as one undo step (state-3)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    const n0 = await clipsOf(page).count();
    const clip = await select(page, 1);
    const box = (await clip.boundingBox())!;
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    // past its start (a phone handle reaches into the clip: well past)
    await p.to(box.x - 60, 12);
    // shown as going
    await expect(page.getByTestId("ed-trim-readout")).toHaveAttribute("data-removing", "true");
    await p.up();
    await expect(clipsOf(page)).toHaveCount(n0 - 1);
    await expect.poll(async () => (await stub.timeline(job.id)).length, SAVED).toBe(before.length - 1);
    const after = await stub.timeline(job.id);
    // gone, no blip left behind
    expect(after.every(([s, e]) => e - s >= 0.15)).toBe(true);
    expect(after).toEqual(before.filter((_, i) => i !== 1));
    // one undo step brings it back as it was
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await expect(clipsOf(page)).toHaveCount(n0);
    await expect.poll(async () => JSON.stringify(await stub.timeline(job.id)), SAVED).toBe(JSON.stringify(before));
  });

  test("the video follows a dragged trim edge; released inside a word it goes between words, put between words it stays (drag-9)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const tl = await stub.timeline(job.id);
    const total = tl.reduce((a, [s, e]) => a + e - s, 0);
    const words = (await stub.doc(job.id)).doc.words.filter((w) => !w.nospeech);
    const [c4s, c4e] = tl[4];
    // a word well inside clip 4 (not the last one), and a gap between two of its words
    // (half of it under the snap radius: ≤ 0.23 s at Fit on the desktop)
    const inner = words.filter((w) => w.start > c4s + 0.5 && w.end < c4e - 0.8 && w.end - w.start >= 0.25 && w.end - w.start <= 0.4);
    expect(inner.length).toBeGreaterThan(1);
    const word = inner[0];
    const inSound = (t: number) => words.some((w) => w.end - w.start <= 1.2 && t > w.start + 0.03 && t < w.end - 0.03);

    // (released at once: an edge held still MAGNIFY_MS magnifies the dock, and
    // the snap radius is then the magnified zoom's — a slow check would race it)
    const dragEndTo = async (t: number, check?: () => Promise<void>) => {
      const clip = await select(page, 4);
      const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
      const pps = await ppsOf(page, total);
      const end0 = (await stub.timeline(job.id))[4][1];
      const p = await press(page, h.x, h.y);
      await p.to(h.x + (t - end0) * pps, 10);
      if (check) {
        await page.waitForTimeout(250);
        await check();
      }
      await p.up();
      return pps;
    };
    const saved4 = async (end: number) => expect.poll(async () => (await stub.timeline(job.id))[4][1], SAVED).toBeCloseTo(end, 3);

    // 1. while dragging, the video shows the frame at the edge (paused)
    const mid = (word.start + word.end) / 2;
    await dragEndTo(mid, async () => {
      const v = await video(page).evaluate((el) => ({ t: (el as HTMLVideoElement).currentTime, paused: (el as HTMLVideoElement).paused }));
      expect(v.paused).toBe(true);
      // (the edge on the 0.01 s grid, a px or two from the pointer)
      expect(Math.abs(v.t - mid)).toBeLessThan(0.08);
    });
    await expect.poll(async () => (await stub.timeline(job.id))[4][1] < c4e - 0.3, SAVED).toBe(true);
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await saved4(c4e);

    // 2. released mid-word: between words
    const pps = await dragEndTo(mid);
    await expect.poll(async () => (await stub.timeline(job.id))[4][1] < c4e - 0.3, SAVED).toBe(true);
    const e1 = (await stub.timeline(job.id))[4][1];
    expect(inSound(e1), `edge ${e1} inside a word (${word.text} ${word.start}–${word.end})`).toBe(false);
    expect(Math.abs(e1 - mid)).toBeLessThan(Math.min(0.25, 12 / pps) + 0.15);

    // 3. undo, then into a gap between two words: exact (a frame)
    await page.locator('[data-testid="ed-undo"]:visible').first().click();
    await saved4(c4e);
    const gapAfter = words.find((w, i) => w.start > c4s + 0.5 && w.end < c4e - 0.6 && i + 1 < words.length && words[i + 1].start - w.end >= 0.15);
    if (gapAfter) {
      const next = words[words.indexOf(gapAfter) + 1];
      const g = (gapAfter.end + next.start) / 2;
      await dragEndTo(g);
      await expect.poll(async () => (await stub.timeline(job.id))[4][1] < c4e - 0.3, SAVED).toBe(true);
      const e2 = (await stub.timeline(job.id))[4][1];
      // the pointer's spot (a px of rounding, the 0.01 s grid, half a frame)
      expect(Math.abs(e2 - g)).toBeLessThan(2 / pps + 0.01 + 0.02);
    }
  });

  test("at Fit a released edge stays where it was let go, then the strip fills the dock again (F7, drag-11)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const strip = page.getByTestId("timeline-scroll");
    // the strip's content (its first child) is the view's width at Fit
    const slack = () => strip.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().width - el.clientWidth);
    expect(Math.abs(await slack())).toBeLessThanOrEqual(1);
    // the trimmed edge of the selected clip as the finger goes up (before the
    // editor handles it) and two frames later (read in the page: a release
    // right away, before the dock magnifies an edge held still MAGNIFY_MS).
    // Only the trim handle's own release: the click that selects the clip
    // has a pointerup too, and its reads two frames later (the edge before
    // the trim) landed after the reset and passed for the trim's when the
    // poll came first (the CI flake: 195.69 → 255.89 is the untrimmed edge)
    await page.evaluate(() => {
      const w = window as unknown as { __atUp: number | null; __afterUp: number | null; __which: string };
      w.__atUp = w.__afterUp = null;
      const edge = () => {
        const r = document.querySelector("[data-selected=true]")?.getBoundingClientRect();
        return r ? (w.__which === "end" ? r.right : r.left) : null;
      };
      window.addEventListener(
        "pointerup",
        (ev) => {
          if (!(ev.target as Element | null)?.closest?.("[data-testid^='clip-trim-']")) return;
          w.__atUp = edge();
          requestAnimationFrame(() => requestAnimationFrame(() => (w.__afterUp = edge())));
        },
        true,
      );
    });
    const fills = async () => {
      const r = await strip.evaluate((el) => {
        const inner = (el.firstElementChild as HTMLElement).getBoundingClientRect();
        const last = [...el.querySelectorAll("[data-seg]")].pop()!.getBoundingClientRect();
        return { slack: inner.width - el.clientWidth, right: inner.right - last.right };
      });
      return Math.abs(r.slack) <= 1 && Math.abs(r.right) <= 6;
    };
    for (const [mode, i, dx] of [
      ["end", 0, -60],
      ["start", 3, 40],
    ] as const) {
      await page.evaluate((m) => {
        const w = window as unknown as { __atUp: number | null; __afterUp: number | null; __which: string };
        w.__which = m;
        w.__atUp = w.__afterUp = null;
      }, mode);
      const clip = await select(page, i);
      const handle = clip.getByTestId(`clip-trim-${mode}`);
      const h = center((await handle.boundingBox())!);
      const p = await press(page, h.x, h.y);
      await p.to(h.x + dx);
      await page.waitForTimeout(150);
      await p.up();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __afterUp: number | null }).__afterUp), { timeout: 3_000 }).not.toBeNull();
      const { at, after } = await page.evaluate(() => {
        const w = window as unknown as { __atUp: number; __afterUp: number };
        return { at: w.__atUp, after: w.__afterUp };
      });
      // no jump under the finger at the release (the edge where it was let go)
      expect(Math.abs(after - at), `${mode}: ${at} → ${after}`).toBeLessThanOrEqual(2);
      // then it settles to Fit again: the strip fills the dock, no zooming
      await expect.poll(fills, { timeout: 3_000 }).toBe(true);
    }
  });

  test("a click on a clip while the strip settles after a trim selects that clip (F7, pixel7 CI)", async ({ page, stub }) => {
    // CI's pixel7 run: the settle ran when the next clip was clicked — the
    // mouse click select() presses (page.mouse: pointerType "mouse" on the
    // phone too), 90 ms after the release — and nothing was selected. Here
    // on both projects: the settle forced at the release and held where it
    // starts, the press the same mouse press. A release settles unless the
    // trim was magnified (held MAGNIFY_MS: the zoom goes back instead):
    // round 5 trimmed clip 0's end to 25 px on the phone, into the strip's
    // edge zone (EDGE_SCROLL_PX: the strip at Fit can't scroll, the moves
    // there don't re-arm the magnifier), and the slow touch moves of a busy
    // run (60–120 ms each) let it fire before the release now and then —
    // no settle (1 in 10–20). Clip 1 is trimmed instead, its end handle
    // well inside the view at the release: every move re-arms the
    // magnifier, the release comes 150 ms after the last.
    const T = 1;
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const clip = await select(page, T);
    // the settle caught where it starts (its beat: everything where it was
    // let go) and held there, so the click below is pressed on a clip as
    // drawn — the press ends the settle at once (settleNow), and the clip
    // moves out from under the pointer before it is released
    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
        const a = animate.apply(this, args);
        const o = args[1];
        if (typeof o === "object" && o?.id === "ed-settle") a.pause();
        return a;
      };
    });
    // most of clip 1 trimmed away: the clips after it move far
    const w0 = (await clip.boundingBox())!.width;
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const view = (await page.getByTestId("timeline-scroll").boundingBox())!;
    const toX = h.x - (w0 - 20);
    expect(toX, "the release well inside the view (not the edge zone)").toBeGreaterThan(view.x + 48);
    const p = await press(page, h.x, h.y);
    await p.to(toX);
    await page.waitForTimeout(150);
    await p.up();
    const settling = () => page.getByTestId("timeline-scroll").evaluate((el) => el.getAnimations({ subtree: true }).some((a) => a.id === "ed-settle"));
    await expect.poll(settling, { timeout: 3_000 }).toBe(true);
    // a clip whose middle as drawn now is off its own box as laid out
    // (where it goes when the settle ends)
    const i = await clipsOf(page).evaluateAll((els, trimmed) => {
      let best = -1;
      let most = 0;
      els.forEach((el, n) => {
        const c = el as HTMLElement;
        if (n === trimmed || !c.offsetParent) return;
        const drawn = c.getBoundingClientRect();
        const left = (c.offsetParent as HTMLElement).getBoundingClientRect().left + c.offsetLeft;
        const mid = drawn.left + drawn.width / 2;
        const off = mid < left ? left - mid : mid - (left + c.offsetWidth);
        if (off > most) [best, most] = [n, off];
      });
      return best;
    }, T);
    expect(i, "no clip moves off its own box in the settle").toBeGreaterThanOrEqual(0);
    const clipI = clipsOf(page).nth(i);
    const drawn = (await clipI.boundingBox())!;
    await page.mouse.move(drawn.x + drawn.width / 2, drawn.y + drawn.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(clipI).toHaveAttribute("data-selected", "true");
  });

  test("phone at Fit: a tap on the seam glyph next to a short clip (1.4 s, ~23 px) is Restore, not a selection (phone-tiny-seam)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "the phone dock");
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    // the "uh," cut right after the 1.4 s clip (16.56–17.06 s)
    const filler = page.locator('[data-testid="ed-seam"][data-seam="filler"]').first();
    const fb = (await filler.boundingBox())!;
    const line = fb.x + (await filler.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--sl"))));
    const short = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid=ed-timeline] [data-seg]")].map((e) => e.getBoundingClientRect().width).sort((a, b) => a - b)[0],
    );
    // a short clip, but one with a body of its own to tap
    expect(short).toBeGreaterThanOrEqual(12);
    expect(short).toBeLessThan(24);
    await page.mouse.click(line, fb.y + fb.height / 2);
    await expect(page.getByTestId("ed-seam-popover")).toBeVisible();
    await expect(page.getByTestId("ed-seam-popover")).toContainText("Filler word");
    await expect(page.locator("[data-testid=ed-timeline] [data-selected=true]")).toHaveCount(0);
  });

  test("phone: a seam tap is Restore as on the desktop — its core a finger's width — only its edge at a tiny clip selects that clip; zoom buttons with a selected clip (drag-6, phone-tiny-seam)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "the phone dock");
    const job = await stub.seed("review_speech");
    // a tiny clip at Fit (0.8 s: a few px drawn, its seams apart — closer
    // ones overlap, the next test), after a cut
    const j0 = (await stub.job(job.id))!;
    const segs = j0.edit_segments.map((x) => ({ start: x.start, end: x.end }));
    segs.splice(2, 0, { start: segs[1].end + 0.6, end: segs[1].end + 1.4 });
    segs[3].start = Math.max(segs[3].start, segs[2].end + 0.3);
    const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
      data: { segments: segs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) },
    });
    expect(r.ok(), await r.text()).toBe(true);
    await open(page, job.id);
    const strip = page.getByTestId("timeline-scroll");
    const zin = page.getByTestId("timeline-zoom-in");
    const zout = page.getByTestId("timeline-zoom-out");
    // the default state keeps its control budget: no zoom buttons yet
    await expect(zin).toHaveCount(0);
    // a tiny clip at Fit, and the seam before it
    const widths = await clipsOf(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const i = widths.findIndex((w, k) => k > 0 && w < 12);
    expect(i, widths.join(" ")).toBeGreaterThan(0);
    const id = await clipsOf(page).nth(i).getAttribute("data-seg");
    const seam = page.locator(`[data-testid=ed-seam][data-seam-key$=">${id}"]`);
    await expect(seam).toHaveCount(1);
    const sb = (await seam.boundingBox())!;
    // the seam line: its hit area reaches --sl px to the left of it
    const line = sb.x + (await seam.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--sl"))));
    const prevW = widths[i - 1];
    // the part on the other side of the line, next to a clip big enough to
    // tap: what the cut removed, and Restore — as on the desktop
    if (prevW >= 12) {
      await page.mouse.click(line - 4, sb.y + sb.height / 2);
      await expect(page.getByTestId("ed-seam-popover")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ed-seam-popover")).toHaveCount(0);
    }
    // the seam's core — the glyph a finger aims at, a few px either side of
    // its line: the seam, even next to the tiny clip; with a finger too (its
    // click is moved onto the small clip beside it, touch adjustment: the
    // editor goes by where the finger was)
    for (const dx of [0, 2, -2]) {
      for (const how of ["mouse", "finger"] as const) {
        if (how === "mouse") await page.mouse.click(line + dx, sb.y + sb.height / 2);
        else await tap(page, line + dx, sb.y + sb.height / 2);
        await expect(page.getByTestId("ed-seam-popover"), `${how}, ${dx} px off the line`).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("ed-seam-popover")).toHaveCount(0);
      }
    }
    await expect(page.locator("[data-testid=ed-timeline] [data-selected=true]")).toHaveCount(0);
    // the gap's edge at the tiny clip, past the core: that clip
    await page.mouse.click(line + 2.8, sb.y + sb.height / 2);
    await expect(clipsOf(page).nth(i)).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("ed-seam-popover")).toHaveCount(0);
    // now + / − (44 px), zooming around the selected clip
    const bi = (await zin.boundingBox())!;
    expect(bi.width).toBeGreaterThanOrEqual(44);
    expect(bi.height).toBeGreaterThanOrEqual(44);
    await expect(zout).toBeDisabled();
    const w0 = await strip.evaluate((el) => el.scrollWidth);
    for (let k = 0; k < 4; k++) await zin.click();
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth)).toBeGreaterThan(w0 * 3);
    // the selected clip stayed in view, and is no longer tiny (once the
    // zoom has settled)
    await expect.poll(async () => (await clipsOf(page).nth(i).boundingBox())!.width).toBeGreaterThan(12);
    const cb = (await clipsOf(page).nth(i).boundingBox())!;
    const vb = (await strip.boundingBox())!;
    expect(cb.x + cb.width / 2).toBeGreaterThan(vb.x);
    expect(cb.x + cb.width / 2).toBeLessThan(vb.x + vb.width);
    expect(cb.width).toBeGreaterThan(12);
    for (let k = 0; k < 6; k++) if (await zout.isEnabled()) await zout.click();
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(zout).toBeDisabled();
  });

  test("phone at Fit: two seams around a clip too short to draw overlap — a tap opens the one whose line is nearest (phone-tiny-seam)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "the phone dock");
    const job = await stub.seed("review_speech");
    // a 0.08 s clip (about a px at Fit) between a 0.6 s and a 0.3 s cut
    const j0 = (await stub.job(job.id))!;
    const segs = j0.edit_segments.map((x) => ({ start: x.start, end: x.end }));
    const a = segs[1].end + 0.6;
    segs.splice(2, 0, { start: a, end: a + 0.08 });
    segs[3].start = a + 0.08 + 0.3;
    segs[3].end = Math.max(segs[3].end, segs[3].start + 0.5);
    const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
      data: { segments: segs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) },
    });
    expect(r.ok(), await r.text()).toBe(true);
    await open(page, job.id);
    const id = await clipsOf(page).nth(2).getAttribute("data-seg");
    const before = page.locator(`[data-testid=ed-seam][data-seam-key$=">${id}"]`);
    const after = page.locator(`[data-testid=ed-seam][data-seam-key^="${id}>"]`);
    const lineOf = async (l: typeof before) => {
      const b = (await l.boundingBox())!;
      return { x: b.x + (await l.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--sl")))), y: b.y + b.height / 2 };
    };
    const l1 = await lineOf(before);
    const l2 = await lineOf(after);
    // (their hit areas overlap: the later one covers the earlier one's line)
    expect(l2.x - l1.x).toBeLessThan(6);
    for (const [l, len] of [[l1, "0.6"], [l2, "0.3"]] as const) {
      await page.mouse.click(l.x, l.y);
      await expect(page.getByTestId("ed-seam-popover")).toBeVisible();
      await expect(page.getByTestId("ed-seam-popover")).toContainText(`${len} s removed`);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("ed-seam-popover")).toHaveCount(0);
    }
  });

  test("an edit that never reached the server comes back on the next open (save-11)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const before = await stub.timeline(job.id);
    let offline = true;
    await page.route(/\/edit-segments$/, (route) => (offline ? route.abort("internetdisconnected") : route.continue()));
    await trimEnd(page, 1, -40);
    const key = `cleocuts.editor.unsaved.v1.${job.id}`;
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key), { timeout: 5_000 }).not.toBeNull();
    const kept = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), key))!) as { segs: { end: number }[]; base: number };
    expect(kept.segs[1].end).toBeLessThan(before[1][1] - 0.05);
    // the page goes (its flush on the way out is lost too), comes back
    await page.reload();
    await expect(page.getByTestId("editor-v2")).toBeVisible({ timeout: 45_000 });
    await expect(clipsOf(page).first()).toBeVisible({ timeout: 30_000 });
    expect(await stub.timeline(job.id)).toEqual(before);
    await expect(page.getByTestId("ed-toast")).toContainText("hadn't reached the server", { timeout: 10_000 });
    offline = false;
    // back, as an undo step, and saved now
    await expect.poll(async () => (await stub.timeline(job.id))[1][1], { timeout: 30_000 }).toBeCloseTo(kept.segs[1].end, 3);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), key), { timeout: 10_000 }).toBeNull();
    await expect(page.locator('[data-testid="ed-undo"]:visible').first()).toBeEnabled();
  });

  test("a long edit (66 clips), zoomed in: only the clips near the view are drawn, the view is never empty wherever it scrolls, and a trim there lands (drag-12-rest)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "desktop", "the desktop zoom slider");
    const job = await stub.seed("review_speech");
    const j0 = (await stub.job(job.id))!;
    const segs = Array.from({ length: 66 }, (_, i) => ({ start: 0.5 + i * 0.5, end: 0.5 + i * 0.5 + 0.3 }));
    const r = await stub.api.post(`/jobs/${job.id}/edit-segments`, {
      data: { segments: segs, base_rev: j0.edit_rev ?? 0, rev: Math.floor(Date.now() * 1000) },
      timeout: 120_000,
    });
    expect(r.ok(), await r.text()).toBe(true);
    await open(page, job.id);
    // at Fit every clip is in view: all drawn
    await expect(clipsOf(page)).toHaveCount(66, { timeout: 30_000 });
    await page.getByTestId("ed-zoom").fill("80");
    const strip = page.getByTestId("timeline-scroll");
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth / el.clientWidth), { timeout: 10_000 }).toBeGreaterThan(3);
    // zoomed in: the far ones are not drawn
    await expect.poll(() => clipsOf(page).count(), { timeout: 10_000 }).toBeLessThan(66);
    for (const at of [0.2, 0.5, 0.8, 1]) {
      await strip.evaluate((el, f) => {
        el.scrollLeft = (el.scrollWidth - el.clientWidth) * f;
      }, at);
      await page.waitForTimeout(250);
      // clips (or the seams between them) all across the view
      const hits = await strip.evaluate((el) => {
        const b = el.getBoundingClientRect();
        const row = el.querySelector("[data-seg]")!.getBoundingClientRect();
        const y = row.top + row.height / 2;
        return [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => {
          const e = document.elementFromPoint(b.left + b.width * f, y);
          return !!e?.closest("[data-seg], [data-testid=ed-seam]");
        });
      });
      expect(hits, `scrolled to ${at}`).toEqual([true, true, true, true, true]);
    }
    // a trim on a clip drawn there: saved as made
    const id = await strip.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const row = el.querySelector("[data-seg]")!.getBoundingClientRect();
      for (const f of [0.5, 0.45, 0.55, 0.4, 0.6]) {
        const c = document.elementFromPoint(b.left + b.width * f, row.top + row.height / 2)?.closest<HTMLElement>("[data-seg]");
        if (c) return c.dataset.testid!;
      }
      return null;
    });
    expect(id).toBeTruthy();
    const i = Number(id!.replace("clip-", ""));
    const clip = page.getByTestId("ed-timeline").getByTestId(id!);
    const cb = (await clip.boundingBox())!;
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await expect(clip).toHaveAttribute("data-selected", "true");
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - Math.round(cb.width * 0.3));
    await p.up();
    await expect.poll(async () => (await stub.timeline(job.id))[i][1], SAVED).toBeLessThan(segs[i].end - 0.03);
    expect((await stub.timeline(job.id)).length).toBe(66);
  });

  test("preview mode: every frame after a skip over trimmed footage has its playhead (F11)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: 15 });
    await open(page, job.id);
    await expect(video(page)).toHaveAttribute("data-playback", "preview");
    const old = (await stub.job(job.id))!.preview_segments;
    const total = old.reduce((a, [s0, e0]) => a + e0 - s0, 0);
    const clip = await select(page, 1);
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const pps = await ppsOf(page, total);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - Math.round(pps * 0.8));
    await page.waitForTimeout(250);
    // preview mode follows the dragged edge too: the playing file's frame at it
    const shown = await video(page).evaluate((el, segs) => {
      const v = el as HTMLVideoElement;
      let acc = 0;
      for (const [s0, e0] of segs) {
        if (v.currentTime < acc + (e0 - s0)) return { src: s0 + (v.currentTime - acc), paused: v.paused };
        acc += e0 - s0;
      }
      return { src: -1, paused: v.paused };
    }, old);
    expect(shown.paused).toBe(true);
    expect(Math.abs(shown.src - (old[1][1] - 0.8))).toBeLessThan(0.12);
    await p.up();
    await expect.poll(async () => (await stub.timeline(job.id))[1][1] < old[1][1] - 0.4, SAVED).toBe(true);
    await expect(page.getByTestId("preview-updating")).toBeVisible();
    // play across the skip (the old file still has the trimmed footage), sampling every frame
    const hidden = await video(page).evaluate(
      async (el, from) => {
        const v = el as HTMLVideoElement;
        const ph = document.querySelector<HTMLElement>("[data-testid=ed-playhead]")!;
        v.muted = true;
        v.currentTime = from;
        await new Promise((r) => setTimeout(r, 300));
        const bad: number[] = [];
        let on = true;
        const tick = () => {
          if (!on) return;
          if (!v.paused && !v.seeking && ph.style.visibility === "hidden") bad.push(v.currentTime);
          requestAnimationFrame(tick);
        };
        await v.play();
        requestAnimationFrame(tick);
        await new Promise((r) => setTimeout(r, 2000));
        on = false;
        v.pause();
        return bad;
      },
      old[0][1] - old[0][0] + (old[1][1] - old[1][0]) - 1.6,
    );
    expect(hidden).toEqual([]);
  });

  test("preview mode: a trim started while playing with a newer preview waiting shows the edge's own frame, and the new file comes in after it (scrub-pending-swap)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: 3 });
    await open(page, job.id);
    await expect(video(page)).toHaveAttribute("data-playback", "preview");
    const j0 = (await stub.job(job.id))!;
    const versions = new Map<number, [number, number][]>([[j0.preview_version, j0.preview_segments]]);
    const total = j0.preview_segments.reduce((a, [s0, e0]) => a + e0 - s0, 0);
    // the source time the element shows, by the file it has loaded
    const shown = async () => {
      const v = await video(page).evaluate((el) => {
        const e = el as HTMLVideoElement;
        return { t: e.currentTime, paused: e.paused, v: Number(new URL(e.currentSrc || e.src).searchParams.get("v") ?? -1) };
      });
      const segs = versions.get(v.v);
      let src = -1;
      let acc = 0;
      for (const [s0, e0] of segs ?? []) {
        if (v.t < acc + (e0 - s0) + 1e-3) {
          src = s0 + (v.t - acc);
          break;
        }
        acc += e0 - s0;
      }
      return { ...v, src, known: !!segs };
    };
    // an edit (its rebuild takes a while), then play: the new preview
    // arrives while playing (the editor follows the server's rebuild) and
    // waits for a pause
    await trimEnd(page, 1, -Math.max(30, Math.round((await ppsOf(page, total)) * 0.6)));
    await expect.poll(async () => (await stub.timeline(job.id))[1][1], SAVED).toBeLessThan(j0.edit_segments[1].end - 0.1);
    await video(page).evaluate(async (el) => {
      const v = el as HTMLVideoElement;
      v.muted = true;
      // (still playing however long the rebuild takes: a run in parallel
      // can take longer than the old preview plays)
      v.loop = true;
      v.currentTime = 0.5;
      await v.play();
    });
    await expect.poll(async () => (await stub.job(job.id))!.preview_version, { timeout: 60_000 }).toBeGreaterThan(j0.preview_version);
    const j1 = (await stub.job(job.id))!;
    const ans = { preview_version: j1.preview_version, preview_segments: j1.preview_segments };
    versions.set(ans.preview_version, ans.preview_segments);
    // the new file loads slowly (a phone network): a swap in the middle of
    // the trim would hold the screen on an old edge meanwhile
    await page.route(new RegExp(`preview-video.*[?&]v=${ans.preview_version}\\b`), async (route) => {
      await sleep(1500);
      await route.continue();
    });
    // (the editor's poll picks it up within a second or two)
    await page.waitForTimeout(2500);
    const playing = await shown();
    expect(playing.paused).toBe(false);
    expect(playing.v).toBe(j0.preview_version);
    // a trim started now: the edge's frame in the file on screen, every time
    const tl = await stub.timeline(job.id);
    const clip = clipsOf(page).nth(3);
    await clip.scrollIntoViewIfNeeded();
    const cb = (await clip.boundingBox())!;
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await expect(clip).toHaveAttribute("data-selected", "true");
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    // every frame the video presents once the trim shows its edge (its
    // first seek, paused, after its readout is up, landed): the file it
    // came from (?v=) and its time
    await video(page).evaluate((el) => {
      const v = el as HTMLVideoElement;
      const w = window as unknown as { __scrubFrames: [number, number][]; __trimOn: boolean; __scrubbing: boolean };
      w.__scrubFrames = [];
      w.__trimOn = w.__scrubbing = false;
      new MutationObserver(() => {
        if (document.querySelector("[data-testid=ed-trim-readout]")) w.__trimOn = true;
      }).observe(document.body, { childList: true, subtree: true });
      // (from the trim's own first seek, the video paused — not a skip
      // while it plays — once it landed: no frame from before it)
      let armed = false;
      v.addEventListener("seeking", () => {
        if (w.__trimOn && v.paused) armed = true;
      });
      v.addEventListener("seeked", () => {
        if (armed) w.__scrubbing = true;
      });
      const cb: VideoFrameRequestCallback = (_n, md) => {
        if (w.__scrubbing) w.__scrubFrames.push([md.mediaTime, Number(new URL(v.currentSrc || v.src).searchParams.get("v") ?? -1)]);
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    });
    const srcOf = (t: number, segs: [number, number][]) => {
      let acc = 0;
      for (const [s0, e0] of segs) {
        if (t < acc + (e0 - s0) + 1e-3) return s0 + (t - acc);
        acc += e0 - s0;
      }
      return -1;
    };
    const p = await press(page, h.x, h.y);
    // (past the touch slop, and within the clip: up to half of it)
    const steps = [0.15, 0.3, 0.45].map((f) => Math.max(12, Math.round(cb.width * f)));
    let edge = tl[3][1];
    const edges: number[] = [];
    for (const px of steps) {
      await p.to(h.x - px, 4);
      // (moving on before an edge held still MAGNIFY_MS magnifies the dock)
      await page.waitForTimeout(220);
      // where the dock has the edge now (its readout: "17.83 s"), and the
      // frame on screen: the last one presented, by the file it came from
      const now = await page.evaluate(() => ({
        readout: document.querySelector("[data-testid=ed-trim-readout]")?.textContent ?? "",
        paused: (document.querySelector("[data-testid=editor-video]") as HTMLVideoElement).paused,
        last: (window as unknown as { __scrubFrames: [number, number][] }).__scrubFrames.at(-1) ?? [-1, -1],
      }));
      edge = parseFloat(now.readout.replace(",", "."));
      edges.push(edge);
      expect(edge).toBeLessThan(tl[3][1] - 0.05);
      expect(now.paused).toBe(true);
      const [mt, ver] = now.last;
      expect(versions.has(ver), `frame of v=${ver}`).toBe(true);
      const onScreen = srcOf(mt, versions.get(ver)!);
      expect(Math.abs(onScreen - edge), `on screen ${onScreen} (v${ver}), edge ${edge}`).toBeLessThan(0.1);
    }
    // no frame of anything else meanwhile (a scrub mapped through the
    // other file's clips, a reload's first frame)
    const frames = await page.evaluate(() => (window as unknown as { __scrubFrames: [number, number][] }).__scrubFrames);
    const wrong = frames
      .map(([t, ver]) => ({ ver, src: versions.has(ver) ? srcOf(t, versions.get(ver)!) : -1 }))
      .filter((f) => !(f.src >= edge - 0.15 && f.src <= tl[3][1] + 0.05));
    expect(frames.length).toBeGreaterThan(0);
    expect(wrong, `frames that were not the dragged edge (${edges.join(", ")}): ${JSON.stringify(frames)}`).toEqual([]);
    await p.up();
    // let go: the waiting preview comes in, on the same moment (the edge
    // shown last, or where the release put it: between words)
    await expect.poll(async () => (await shown()).v, { timeout: 10_000 }).toBe(ans.preview_version);
    await expect
      .poll(async () => {
        const s2 = await shown();
        const end = (await stub.timeline(job.id))[3][1];
        return Math.abs(s2.src - edge) < 0.1 || Math.abs(s2.src - end) < 0.1;
      }, SAVED)
      .toBe(true);
  });
  test("preview mode: a trim started while a newer preview is still loading (paused) shows the edge once it is in, not the moment the swap left from (scrub-pending-swap)", async ({ page, stub }) => {
    const job = await stub.seed("review_speech", { proxy: "off", slow_rebuild: 2 });
    await open(page, job.id);
    await expect(video(page)).toHaveAttribute("data-playback", "preview");
    const j0 = (await stub.job(job.id))!;
    // every newer preview file loads slowly (a phone network)
    await page.route(/preview-video.*[?&]v=(\d+)/, async (route) => {
      const v = Number(/[?&]v=(\d+)/.exec(route.request().url())![1]);
      if (v > j0.preview_version) await sleep(2500);
      await route.continue();
    });
    // an edit; paused, so its preview is swapped in as soon as it is there
    await trimEnd(page, 1, -40);
    await expect.poll(async () => (await stub.job(job.id))!.preview_version, { timeout: 60_000 }).toBeGreaterThan(j0.preview_version);
    const j1 = (await stub.job(job.id))!;
    // the editor picked it up: the element is loading the new file
    await expect
      .poll(() => video(page).evaluate((el) => Number(new URL((el as HTMLVideoElement).src).searchParams.get("v") ?? -1)), { timeout: 10_000 })
      .toBe(j1.preview_version);
    // a trim now, while the file loads: the edge's own frame once it is in
    const tl = await stub.timeline(job.id);
    const clip = clipsOf(page).nth(3);
    await clip.scrollIntoViewIfNeeded();
    const cb = (await clip.boundingBox())!;
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await expect(clip).toHaveAttribute("data-selected", "true");
    const h = center((await clip.getByTestId("clip-trim-end").boundingBox())!);
    const p = await press(page, h.x, h.y);
    await p.to(h.x - Math.max(14, Math.round(cb.width * 0.3)), 4);
    const edge = parseFloat(((await page.getByTestId("ed-trim-readout").textContent()) ?? "").replace(",", "."));
    expect(edge).toBeLessThan(tl[3][1] - 0.05);
    // the new file is in (its metadata loaded), held at the edge
    const srcOf = (t: number, segs: [number, number][]) => {
      let acc = 0;
      for (const [s0, e0] of segs) {
        if (t < acc + (e0 - s0) + 1e-3) return s0 + (t - acc);
        acc += e0 - s0;
      }
      return -1;
    };
    await expect
      .poll(
        async () => {
          const v = await video(page).evaluate((el) => {
            const e = el as HTMLVideoElement;
            return { t: e.currentTime, ready: e.readyState, seeking: e.seeking, paused: e.paused };
          });
          return v.ready >= 1 && !v.seeking && v.paused ? Math.round(srcOf(v.t, j1.preview_segments) * 100) / 100 : null;
        },
        { timeout: 15_000 },
      )
      .toBeCloseTo(edge, 1);
    await p.up();
  });
});
