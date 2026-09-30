/**
 * Page helpers shared by the suites. Selectors: data-testid (see the
 * UX1 commit) or roles with accessible names — never CSS classes or
 * glyphs (PLAN_TECH rule 0.9).
 */
import { expect, type Locator, type Page } from "@playwright/test";

// localStorage keys of the current app (anonymous beta).
export const ACTIVE_JOBS = "cleocuts.activeJobs.v1";
export const LIBRARY = "cleo-library-v1";
export const VOICE_SEEN = "cleocuts.voiceOnboardingSeen.v1";
export const LANG_KEY = "cleocuts.lang";

export const LANGS = ["en", "de", "es", "fr", "pt", "it", "tr", "pl", "nl", "ru", "ja", "ko", "id", "hi"] as const;

export type Phase = "uploading" | "analyzing" | "reviewing" | "rendering";

/** A dashboard card as lib/activeJobs stores it. */
export function card(jobId: string, phase: Phase, filename: string, extra: Record<string, unknown> = {}) {
  return {
    jobId,
    phase,
    timestamp: Date.now() - Number(extra.ageMs ?? 60_000),
    filename,
    presetId: null,
    presetLabel: null,
    presetIcon: null,
    captionPreset: "clipper",
    ...extra,
  };
}

/** A finished project as lib/library stores it. */
export function libEntry(jobId: string, filename: string, ageMs = 60_000, extra: Record<string, unknown> = {}) {
  return {
    jobId,
    timestamp: Date.now() - ageMs,
    presetId: null,
    presetIcon: null,
    presetLabel: null,
    filename,
    outputs: ["primary"],
    hookClips: [],
    socialCaption: "",
    socialHashtags: [],
    ...extra,
  };
}

/**
 * Replace localStorage (voice onboarding marked seen) from a light page
 * of the app's origin, then open `path`.
 */
export async function openWithStorage(page: Page, path: string, storage: Record<string, unknown> = {}) {
  await page.goto("/imprint");
  await page.evaluate(
    (kv) => {
      localStorage.clear();
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    },
    { [VOICE_SEEN]: "1", ...storage },
  );
  await page.goto(path);
}

export async function readStorage<T>(page: Page, key: string): Promise<T | null> {
  return page.evaluate((k) => {
    const v = localStorage.getItem(k);
    return v === null ? null : JSON.parse(v);
  }, key);
}

// ── dashboard ────────────────────────────────────────────────────────

export const jobCard = (page: Page, filename: string): Locator =>
  page.getByTestId("job-card").filter({ hasText: filename });

// ── editor ───────────────────────────────────────────────────────────

/**
 * How long to wait for the server to see an edit (expect.poll options).
 * A save queues behind the preview rebuild in flight (POST /edit-segments
 * answers after it), and a rebuild is real ffmpeg work (cut + VP8) — slow
 * on a busy machine. A poll ends as soon as its condition holds.
 */
export const SAVED = { timeout: 60_000 };

export const clips = (page: Page): Locator => page.getByTestId(/^clip-\d+$/);
export const clip = (page: Page, i: number): Locator => page.getByTestId(`clip-${i}`);
export const editorVideo = (page: Page): Locator => page.getByTestId("editor-video");

async function editorReady(page: Page) {
  await expect(page.getByTestId("apply-render")).toBeVisible({ timeout: 45_000 });
  await expect(clips(page).first()).toBeVisible();
}

/** Open the editor by URL (/app/edit/<id>, what a reload does). */
export async function openEditor(page: Page, jobId: string) {
  await page.goto(`/app/edit/${jobId}`);
  await editorReady(page);
}

/** Open the editor from its dashboard card (waits for saves in flight). */
export async function openFromDashboard(page: Page, filename: string) {
  await jobCard(page, filename).click();
  await editorReady(page);
}

export async function selectClip(page: Page, i: number) {
  const c = clip(page, i);
  await c.scrollIntoViewIfNeeded();
  await c.click();
  await expect(page.getByTestId("clip-delete")).toBeVisible();
}

export async function deleteClip(page: Page, i: number) {
  await selectClip(page, i);
  await page.getByTestId("clip-delete").click();
}

/** Set a range input like a drag does (React sees an input event). */
export async function setRange(locator: Locator, value: number) {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

export async function playbackMode(page: Page): Promise<string | null> {
  return editorVideo(page).getAttribute("data-playback");
}

export async function waitForMetadata(page: Page) {
  await expect
    .poll(() => editorVideo(page).evaluate((v) => (v as HTMLVideoElement).readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);
}

export const videoTime = (page: Page) =>
  editorVideo(page).evaluate((v) => (v as HTMLVideoElement).currentTime);
export const videoPaused = (page: Page) => editorVideo(page).evaluate((v) => (v as HTMLVideoElement).paused);

/** A user seek (the native controls): set currentTime, wait for `seeked`. */
export async function userSeek(page: Page, t: number) {
  await editorVideo(page).evaluate(async (el, t) => {
    const v = el as HTMLVideoElement;
    const seeked = new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    v.currentTime = t;
    await seeked;
  }, t);
}

export async function play(page: Page) {
  await editorVideo(page).evaluate((v) => (v as HTMLVideoElement).play());
}

export async function pause(page: Page) {
  await editorVideo(page).evaluate((v) => (v as HTMLVideoElement).pause());
}

/** No horizontal page overflow (px beyond the viewport). */
export const horizontalOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/**
 * Text of the caption shown over the editor video: the interim engine
 * overlay's test hook (UT1, NEXT_PUBLIC_CAPTIONS_INTERIM=1 builds) or the
 * plain text overlay. "" when none is shown.
 */
export async function captionText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __captionsInterim?: { page: string | null } }).__captionsInterim;
    if (hook) return hook.page ?? "";
    return document.querySelector('[data-testid="caption-overlay"]')?.textContent ?? "";
  });
}
