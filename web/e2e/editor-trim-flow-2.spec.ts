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

async function select(page: Page, i: number) {
  const clip = clipsOf(page).nth(i);
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
    // right away, before the dock magnifies an edge held still MAGNIFY_MS)
    await page.evaluate(() => {
      const w = window as unknown as { __atUp: number | null; __afterUp: number | null; __which: string };
      w.__atUp = w.__afterUp = null;
      const edge = () => {
        const r = document.querySelector("[data-selected=true]")?.getBoundingClientRect();
        return r ? (w.__which === "end" ? r.right : r.left) : null;
      };
      window.addEventListener(
        "pointerup",
        () => {
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

  test("phone: a tap on the seam next to a tiny clip selects that clip; zoom buttons with a selected clip (drag-6)", async ({ page, stub }, info) => {
    test.skip(info.project.name !== "pixel7", "the phone dock");
    const job = await stub.seed("review_speech");
    await open(page, job.id);
    const strip = page.getByTestId("timeline-scroll");
    const zin = page.getByTestId("timeline-zoom-in");
    const zout = page.getByTestId("timeline-zoom-out");
    // the default state keeps its control budget: no zoom buttons yet
    await expect(zin).toHaveCount(0);
    // a tiny clip at Fit, and the seam before it
    const widths = await clipsOf(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    const i = widths.findIndex((w, k) => k > 0 && w < 24);
    expect(i, widths.join(" ")).toBeGreaterThan(0);
    const id = await clipsOf(page).nth(i).getAttribute("data-seg");
    const seam = page.locator(`[data-testid=ed-seam][data-seam-key$=">${id}"]`);
    await expect(seam).toHaveCount(1);
    const sb = (await seam.boundingBox())!;
    await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await expect(clipsOf(page).nth(i)).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("ed-seam-popover")).toHaveCount(0);
    // now + / − (44 px), zooming around the selected clip
    const bi = (await zin.boundingBox())!;
    expect(bi.width).toBeGreaterThanOrEqual(44);
    expect(bi.height).toBeGreaterThanOrEqual(44);
    await expect(zout).toBeDisabled();
    const w0 = await strip.evaluate((el) => el.scrollWidth);
    for (let k = 0; k < 3; k++) await zin.click();
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth)).toBeGreaterThan(w0 * 3);
    // the selected clip stayed in view, and is no longer tiny
    const cb = (await clipsOf(page).nth(i).boundingBox())!;
    const vb = (await strip.boundingBox())!;
    expect(cb.x + cb.width / 2).toBeGreaterThan(vb.x);
    expect(cb.x + cb.width / 2).toBeLessThan(vb.x + vb.width);
    expect(cb.width).toBeGreaterThan(24);
    for (let k = 0; k < 4; k++) if (await zout.isEnabled()) await zout.click();
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(zout).toBeDisabled();
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
});
