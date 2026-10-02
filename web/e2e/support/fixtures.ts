/**
 * Test fixtures for the e2e suites:
 *   stub        the stub backend's test API (seed jobs, read server state)
 *   pageErrors  collects uncaught page errors; a test fails if any occurred
 *               (every scratchpad suite ended with "no page errors")
 *
 * Seeds are per test (POST /_test/seed/{name}), so tests never share a job
 * and run in parallel. See backend/tests/stub_server.py for the seeds and
 * their options.
 */
import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "./env";

export type SeedName =
  | "review"
  | "review_speech"
  | "review_land"
  | "review_long"
  | "render_failed"
  | "analyzing"
  | "queued"
  | "rendering"
  | "error"
  | "err_no_speech"
  | "err_unreadable"
  | "done"
  | "done_land";

export type SeedOptions = {
  filename?: string;
  /** The job's owner (a test user id) — accounts on. */
  owner?: string;
  /** Created this many seconds ago. */
  age_s?: number;
  clip?: "grid" | "speech";
  orientation?: "portrait" | "landscape";
  settings?: Record<string, unknown>;
  caption_preset?: string;
  /** off: has_proxy false + proxy-video 404 (production default today);
   *  on: has_proxy true; probe: has_proxy not reported, proxy plays;
   *  probe-none: not reported, proxy-video 404; real: the backend's own. */
  proxy?: "off" | "on" | "probe" | "probe-none" | "real";
  render?: "ok" | "fail";
  render_seconds?: number;
  /** Seconds every /edit-segments waits before its preview rebuild. */
  slow_rebuild?: number;
  /** review_long: words in the doc (default 10 000). */
  words?: number;
  /** job.format_warning (UX6), e.g. "smartcam_failed". */
  format_warning?: string;
  /** false: a job from before the edit document (404 no_doc). */
  doc?: boolean;
  /** false: no first-frame poster (an analysis from before UT5). */
  poster?: boolean;
  /** review_speech (UX10): more analysis cuts [start, end, kind] —
   *  "voice_cmd" a Cleo-cut take, "filler" a repeat whose words get cut. */
  ai_cuts?: [number, number, "voice_cmd" | "filler" | "silence"][];
  /** review_speech (UX10): more transcribed words (nospeech: outside the speech regions). */
  extra_words?: { text: string; start: number; end: number; nospeech?: boolean }[];
  /** "redirect": /peaks answers a 307 to another origin (an R2 redirect
   *  the editor can't follow); default: the clip's peaks.bin. */
  peaks?: "redirect";
};

export type Seeded = { id: string; seed: SeedName; filename: string; status: string };

export type SegmentJson = {
  start: number;
  end: number;
  speed?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

/** GET /_test/job/{id}: the job as the web sees it, plus internals. */
export type StubJob = {
  id: string;
  status: string;
  message: string;
  error: string | null;
  has_proxy?: boolean;
  edit_segments: SegmentJson[];
  preview_segments: [number, number][];
  preview_version: number;
  outputs: string[];
  filename: string | null;
  preset_id: string | null;
  expires_at?: number;
  source_key: string | null;
  owner_id: string | null;
  size: number | null;
  media_store: string;
  /** The stored upload settings (internal "_" keys left out). */
  settings: Record<string, unknown>;
};

export type StubWord = {
  id: string;
  text: string;
  start: number;
  end: number;
  hidden?: boolean;
  filler?: boolean;
  breakBefore?: boolean;
  cut?: string;
  nospeech?: boolean;
};
export type StubDoc = {
  doc: { words: StubWord[]; style: { presetId: string }; rev: number };
  rev: number;
  read_only: boolean;
};

export class Stub {
  constructor(readonly api: APIRequestContext) {}

  async seed(name: SeedName, opts: SeedOptions = {}): Promise<Seeded> {
    const r = await this.api.post(`/_test/seed/${name}`, { data: opts, timeout: 240_000 });
    expect(r.ok(), `seed ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  }

  /** The job's server state, or null when it no longer exists. */
  async job(id: string): Promise<StubJob | null> {
    const r = await this.api.get(`/_test/job/${id}`);
    if (r.status() === 404) return null;
    expect(r.ok(), `job ${id}: ${r.status()}`).toBeTruthy();
    return r.json();
  }

  /** The saved timeline as [start, end] pairs (for readable assertions). */
  async timeline(id: string): Promise<number[][]> {
    const j = await this.job(id);
    return (j?.edit_segments ?? []).map((s) => [s.start, s.end]);
  }

  /** GET /jobs/{id}/doc (UT3): the stored edit document and its rev. */
  async doc(id: string): Promise<StubDoc> {
    const r = await this.api.get(`/jobs/${id}/doc`);
    expect(r.ok(), `doc ${id}: ${r.status()}`).toBeTruthy();
    return r.json();
  }

  async config(values: {
    analysis_seconds?: number;
    by_filename?: Record<string, Record<string, unknown>>;
  }): Promise<void> {
    const r = await this.api.post("/_test/config", { data: values });
    expect(r.ok()).toBeTruthy();
  }

  /** A stub clip to upload: grid.mp4, speech.mp4, speech_land.mp4, long.webm,
   *  portrait.webm / landscape.webm (VP8: the browser can read their frame),
   *  and ones POST /jobs refuses (audio.m4a, silent.mp4, short.mp4). */
  async media(
    name:
      | "grid.mp4"
      | "speech.mp4"
      | "speech_land.mp4"
      | "long.webm"
      | "portrait.webm"
      | "landscape.webm"
      | "audio.m4a"
      | "silent.mp4"
      | "short.mp4",
  ): Promise<Buffer> {
    const r = await this.api.get(`/_test/media/${name}`, { timeout: 240_000 });
    expect(r.ok(), `media ${name}`).toBeTruthy();
    return r.body();
  }

  async info(): Promise<{ auth_test: boolean; r2: boolean; r2_endpoint: string | null }> {
    return (await this.api.get("/_test/info")).json();
  }
}

// ── test auth (E2E_MODE=auth, @auth suites) ─────────────────────────

/** localStorage key of the test-auth "session" (MockAuthProvider). */
export const TEST_USER_KEY = "cleocuts.testUser.v1";

export type TestUser = { id: string; plan: string | null; header: string };

/**
 * Sign `page` in with test auth (NEXT_PUBLIC_AUTH_TEST / CLEO_AUTH_TEST):
 * a test user of its own per test and project unless `id` is given;
 * `plan` overrides the user's entitlement. Returns the user and the
 * X-Test-User value the app sends.
 */
export async function signedIn(
  page: Page,
  opts: { plan?: "starter" | "pro" | "studio" | "none"; id?: string } = {},
): Promise<TestUser> {
  const info = base.info();
  const id = opts.id ?? `e2e_${info.project.name}_${info.testId.replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}`;
  const plan = opts.plan ?? null;
  await page.goto("/imprint");
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [TEST_USER_KEY, JSON.stringify({ id, plan })]);
  return { id, plan, header: plan ? `${id};plan=${plan}` : id };
}

type Fixtures = { stub: Stub; pageErrors: string[] };

export const test = base.extend<Fixtures>({
  stub: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({ baseURL: API });
    await use(new Stub(api));
    await api.dispose();
  },
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await use(errors);
      expect(errors, "uncaught errors on the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
