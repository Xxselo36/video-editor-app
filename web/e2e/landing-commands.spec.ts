/**
 * The command rows play with the scroll (sections/CommandRows.tsx; the
 * owner, on an iPhone: each row only once it is in the middle of the
 * screen, one after another, backwards when scrolling up). Each row's
 * progress, as its animations have it, against the lanes the page lays
 * out (commandScroll.ts): at most one row in flight, rows above edited,
 * rows below waiting, the same scrolled down and back up; a row starts
 * on the middle line, not 80 px early (the scroll padding); reduced
 * motion attaches nothing; without view timelines, or with ones that
 * disagree with the lanes, the script fallback plays the same rows, and
 * ones that agree keep them through a viewport that changes height or
 * turns; a language change leaves every row where it is; nothing in the
 * list widens a small phone; the strips are no buttons.
 * Only the list is measured: the landing's videos play no part (headless
 * Chromium has no H.264).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import {
  CHROME_BOTTOM,
  CHROME_TOP,
  fallbackProgress,
  inFlight,
  middleLine,
} from "../src/features/landing/sections/commandScroll";

type Lane = { off: number; len: number; mid: number };
type Snap = { y: number; top: number; motion: string | null; p: (number | null)[]; lanes: Lane[] };

/** The list now: the scroll position, the list's top on screen, each
 *  row's progress (its ink's animation: every track spans the whole lane
 *  with linear timing) and its lane (`mid`: the strip's centre below the
 *  probe's top, the middle line). */
const snap = (page: Page): Promise<Snap> =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="command-rows"]')!;
    const top = list.getBoundingClientRect().top;
    const rows = Array.from(list.querySelectorAll("[data-row]"));
    return {
      y: window.scrollY,
      top,
      motion: list.getAttribute("data-motion"),
      p: rows.map((r) => {
        const v = r.querySelector("[data-ink]")?.getAnimations()[0]?.effect?.getComputedTiming().progress;
        return typeof v === "number" ? v : null;
      }),
      lanes: rows.map((r) => {
        const probe = r.querySelector("[data-probe]")!.getBoundingClientRect();
        const strip = r.querySelector("[data-strip]")!.getBoundingClientRect();
        return { off: probe.top - top, len: probe.height, mid: (strip.top + strip.bottom) / 2 - probe.top };
      }),
    };
  });

/** Scrolls to `y` and waits two frames: the timelines (or the fallback's
 *  seek) have caught up. */
async function scrollTo(page: Page, y: number): Promise<Snap> {
  await page.evaluate(async (top) => {
    window.scrollTo({ top, behavior: "instant" });
    for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(done));
  }, y);
  return snap(page);
}

async function open(page: Page): Promise<Snap> {
  await page.goto("/");
  await expect(page.getByTestId("command-rows")).toHaveAttribute("data-motion", /^(native|js)$/);
  return snap(page);
}

/** A lane's start as a scroll position. */
const start = (s: Snap, i: number) => s.top + s.y + s.lanes[i].off;
/** 0 and 1 as the fallback seeks them (it stops 0.1 ms short of the end). */
const settled = (p: number) => (p >= 0.999 ? 1 : p <= 0.001 ? 0 : p);

/** What is wrong with the rows at this step: a missing animation, a row
 *  off its lane, more than one in flight, or one out of order. */
function problems(s: Snap): string[] {
  const out: string[] = [];
  const at = `y ${s.y}`;
  if (s.p.some((p) => p === null)) return [`${at}: a row has no animation`];
  const got = (s.p as number[]).map(settled);
  got.forEach((p, i) => {
    const want = fallbackProgress(s.top, s.lanes[i].off, s.lanes[i].len);
    if (Math.abs(p - want) > 0.02) out.push(`${at}: row ${i} at ${p.toFixed(3)}, its lane says ${want.toFixed(3)}`);
  });
  const flying = inFlight(got);
  if (flying.length > 1) out.push(`${at}: rows ${flying.join(", ")} in flight at once`);
  const k = flying.length ? flying[0] : got.indexOf(0);
  const edge = k < 0 ? got.length : k;
  got.forEach((p, i) => {
    if (i < edge && p !== 1) out.push(`${at}: row ${i} above the one playing is not edited (${p})`);
    if (i > edge && p !== 0) out.push(`${at}: row ${i} below the one playing has started (${p})`);
  });
  return out;
}

/** Through the list and back in 8 px steps: no problem at any step, and
 *  every row as far along scrolled up as it was scrolled down. */
async function sweep(page: Page) {
  const s = await snap(page);
  const n = s.lanes.length;
  const from = Math.max(0, Math.floor(start(s, 0) - 120));
  const to = Math.ceil(start(s, n - 1) + s.lanes[n - 1].len + 120);
  const ys: number[] = [];
  for (let y = from; y <= to; y += 8) ys.push(y);
  const down = new Map<number, (number | null)[]>();
  const found: string[] = [];
  for (const y of ys) {
    const at = await scrollTo(page, y);
    found.push(...problems(at));
    down.set(y, at.p);
  }
  for (const y of ys.reverse()) {
    const at = await scrollTo(page, y);
    found.push(...problems(at));
    at.p.forEach((p, i) => {
      const was = down.get(y)![i];
      if (p !== null && was !== null && Math.abs(settled(p) - settled(was)) > 0.01)
        found.push(`y ${y}: row ${i} at ${p.toFixed(3)} scrolling up, ${was.toFixed(3)} scrolling down`);
    });
  }
  expect(found).toEqual([]);
}

test.describe("landing: the command rows play with the scroll", () => {
  test("one row at a time, in order, and backwards when scrolling up", async ({ page, browserName }) => {
    const s = await open(page);
    // Chromium has view timelines and gets them right: the native path
    // stays on through the check.
    if (browserName === "chromium") expect(s.motion).toBe("native");
    await sweep(page);
    if (browserName === "chromium") expect((await snap(page)).motion).toBe("native");
  });

  test("a row starts on the middle line, not before, and is half way half a lane later", async ({ page }) => {
    const s = await open(page);
    const [vh, phone] = await page.evaluate(() => [window.innerHeight, window.innerWidth < 768] as const);
    const mid = middleLine(vh, CHROME_TOP, phone ? CHROME_BOTTOM : 0);
    for (const lane of s.lanes) expect(Math.abs(lane.mid - mid)).toBeLessThan(1);
    for (let i = 0; i < s.lanes.length; i++) {
      const before = await scrollTo(page, start(s, i) - 4);
      expect(before.p[i], `row ${i} before its lane`).toBe(0);
      if (i > 0) expect(settled(before.p[i - 1]!), `row ${i - 1} before row ${i} starts`).toBe(1);
      const half = await scrollTo(page, start(s, i) + s.lanes[i].len / 2);
      expect(Math.abs(half.p[i]! - 0.5), `row ${i} half way through its lane`).toBeLessThanOrEqual(0.05);
    }
  });

  test("a jump lands every row: all edited at the end of the page, all waiting at the top", async ({ page }) => {
    await open(page);
    const end = await scrollTo(page, await page.evaluate(() => document.documentElement.scrollHeight));
    expect(end.p.map((p) => settled(p ?? -1))).toEqual([1, 1, 1, 1, 1]);
    const top = await scrollTo(page, 0);
    expect(top.p).toEqual([0, 0, 0, 0, 0]);
  });

  test("reduced motion: nothing attached, every strip marked at rest; turning it on detaches the rows", async ({
    page,
  }) => {
    const rest = () =>
      page.evaluate(() => {
        const list = document.querySelector('[data-testid="command-rows"]')!;
        const styles = (sel: string) => Array.from(list.querySelectorAll(sel), (e) => getComputedStyle(e));
        return {
          motion: list.hasAttribute("data-motion"),
          animations: list.getAnimations({ subtree: true }).length,
          // the hatch over the removed piece (and between the stop/go posts)
          hatch: styles("[data-hatch-clip], [data-hatch]").map((cs) => cs.translate),
          // the next scene in place, every post up
          next: styles("[data-new-clip]").map((cs) => cs.translate),
          posts: styles("[data-post]").map((cs) => cs.scale),
          // no ink copy, caret or rail
          copies: styles("[data-ink], [data-voice], [data-rail]").map((cs) => cs.display),
        };
      });
    const atRest = (r: Awaited<ReturnType<typeof rest>>) => {
      expect(r.motion).toBe(false);
      expect(r.animations).toBe(0);
      expect(r.hatch).toHaveLength(8);
      for (const v of [...r.hatch, ...r.next, ...r.posts]) expect(v).toBe("none");
      for (const v of r.copies) expect(v).toBe("none");
    };

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    atRest(await rest());
    // Hydrated all along: the rows attach as soon as reduced motion is off...
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.getByTestId("command-rows")).toHaveAttribute("data-motion", /^(native|js)$/);
    // ...and are gone again, every inline width and height with them.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.getByTestId("command-rows")).not.toHaveAttribute("data-motion");
    atRest(await rest());
    const inline = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="command-rows"] :is([data-rail], [data-probe])'),
        (e) => e.style.width + e.style.height,
      ).join(""),
    );
    expect(inline).toBe("");
  });

  test("without view timelines the script fallback plays the same rows", async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as { ViewTimeline?: unknown }).ViewTimeline;
    });
    const s = await open(page);
    expect(s.motion).toBe("js");
    await sweep(page);
  });

  test("view timelines that disagree with the lanes hand the rows to the fallback", async ({ page }) => {
    // An engine that gets the inset wrong: here every timeline is built
    // with 200 px instead of the 0 px asked for.
    await page.addInitScript(() => {
      const Native = window.ViewTimeline;
      if (typeof Native !== "function") return;
      window.ViewTimeline = class extends Native {
        constructor(options?: ViewTimelineOptions) {
          super({ ...options, inset: "200px" });
        }
      };
    });
    const s = await open(page);
    test.skip(s.motion !== "native", "no view timelines in this browser");
    // At the top no row is in its lane yet: nothing to compare.
    await page.waitForTimeout(300);
    expect((await snap(page)).motion).toBe("native");
    await scrollTo(page, start(s, 1) + s.lanes[1].len / 2);
    await expect(page.getByTestId("command-rows")).toHaveAttribute("data-motion", "js");
    expect(problems(await scrollTo(page, start(s, 1) + s.lanes[1].len / 2 + 8))).toEqual([]);
  });

  test("view timelines that agree stay on through a viewport that changes height or turns", async ({
    page,
    browserName,
  }) => {
    // The middle line is in svh: a window made shorter (DevTools docked,
    // fullscreen) moves every lane while no strip changes size, and the
    // check has to compare against the lanes as they are now.
    await open(page);
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: size.height - 40 });
    await sweep(page);
    if (browserName === "chromium") expect((await snap(page)).motion).toBe("native");

    // Turned while the check waits for the timelines to sample a row
    // half way (two frames): the lanes it would compare have moved.
    await page.setViewportSize(size);
    const s = await open(page);
    await page.evaluate(async (y) => {
      window.scrollTo({ top: y, behavior: "instant" });
      for (let i = 0; i < 2; i++) await new Promise((done) => requestAnimationFrame(done));
    }, start(s, 1) + s.lanes[1].len / 2);
    await page.setViewportSize({ width: size.height, height: size.width });
    await sweep(page);
    if (browserName === "chromium") expect((await snap(page)).motion).toBe("native");
  });

  test("a language change leaves every row where the scroll has it", async ({ page }) => {
    const s = await open(page);
    // Rows 0 and 1 edited, row 2 half way: a re-attach would show the
    // rest state for a moment, then fade.
    const y = start(s, 2) + s.lanes[2].len / 2;
    await scrollTo(page, y);
    await page.evaluate(() => {
      const list = document.querySelector('[data-testid="command-rows"]')!;
      for (const a of list.getAnimations({ subtree: true })) a.id = "kept";
      const w = window as { detached?: number };
      w.detached = 0;
      new MutationObserver(() => {
        if (!list.hasAttribute("data-motion")) w.detached!++;
      }).observe(list, { attributeFilter: ["data-motion"] });
    });
    await page.getByTestId("language-switcher").first().selectOption("de");
    await expect(page.locator('html[data-i18n~="de"]')).toHaveCount(1);
    expect(problems(await scrollTo(page, y))).toEqual([]);
    const after = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="command-rows"]')!;
      const all = list.getAnimations({ subtree: true });
      return {
        detached: (window as { detached?: number }).detached,
        count: all.length,
        renewed: all.filter((a) => a.id !== "kept").length,
      };
    });
    expect(after).toEqual({ detached: 0, count: 61, renewed: 0 });
  });

  test("nothing in the list widens a small phone, at any point of any row", async ({ page }) => {
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const found: string[] = [];
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 740 });
      const s = await open(page);
      // Only the list may answer for it: everything beside its ancestors
      // clips its own horizontal overflow.
      await page.evaluate(() => {
        const list = document.querySelector('[data-testid="command-rows"]')!;
        for (let el: Element = list; el.parentElement; el = el.parentElement)
          for (const sib of Array.from(el.parentElement.children))
            if (sib !== el && sib instanceof HTMLElement) sib.style.overflowX = "clip";
      });
      for (let i = 0; i < s.lanes.length; i++)
        for (const [name, at] of [
          ["0", -4],
          ["0.5", s.lanes[i].len / 2],
          ["1", s.lanes[i].len + 4],
        ] as const) {
          await scrollTo(page, start(s, i) + at);
          const px = await overflow();
          if (px > 0) found.push(`${width}px, row ${i} at p ${name}: ${px}px wider`);
        }
    }
    expect(found).toEqual([]);
  });

  test("the strips are no buttons: no tab stops in the list", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("command-rows").locator("button, a, [tabindex]")).toHaveCount(0);
  });
});
