/**
 * End-to-end suites (web/e2e) against the stub backend
 * (backend/tests/stub_server.py): `npm run test:e2e`.
 *
 * Projects: desktop (Chromium 1440×900) and pixel7 (mobile emulation) on
 * every PR; webkit nightly (required for release from UX18).
 * E2E_MODE (e2e/support/env.ts) picks the backend flavour of the run:
 *   anon (default) · auth (@auth suites, test auth) · r2 (@r2 suites, moto).
 * @nightly suites (R2 uploads, the visual screens) need E2E_NIGHTLY=1.
 *
 * Servers (reused when already running, except on CI):
 *   stub  python ../backend/tests/stub_server.py (STUB_PYTHON, default python3)
 *   web   E2E_WEB=start (default: `next start`, build it first with
 *         NEXT_PUBLIC_BACKEND_URL=http://localhost:8501), build (build, then
 *         start) or dev (`next dev`; the default in auth mode)
 */
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { API, MODE, NIGHTLY, STUB_PORT, WEB, WEB_PORT } from "./e2e/support/env";

const CI = Boolean(process.env.CI);
const web = process.env.E2E_WEB ?? (MODE === "auth" ? "dev" : "start");
const webEnv: Record<string, string> = {
  NEXT_PUBLIC_BACKEND_URL: API,
  NEXT_TELEMETRY_DISABLED: "1",
  // UT1 interim captions on, with their test hook (captions-interim.spec).
  // E2E_WEB=start serves a build made with the same two (CI: web.yml).
  NEXT_PUBLIC_CAPTIONS_INTERIM: "1",
  NEXT_PUBLIC_TEST_PAGES: "1",
  ...(MODE === "auth" ? { NEXT_PUBLIC_AUTH_TEST: "1" } : {}),
};
const webCommand = {
  start: `npx next start -p ${WEB_PORT}`,
  build: `npx next build && npx next start -p ${WEB_PORT}`,
  dev: `npx next dev -p ${WEB_PORT}`,
}[web];
if (!webCommand) throw new Error(`E2E_WEB=${web}: use start, build or dev`);

const stubFlags = [
  `--port ${STUB_PORT}`,
  `--web-origin ${WEB}`,
  MODE === "auth" ? "--auth" : "",
  MODE === "r2" ? "--r2" : "",
].join(" ");

// Mode tags: a run executes its own mode's suites only.
const grep = MODE === "anon" ? undefined : new RegExp(`@${MODE}\\b`);
const grepInvert = [
  ...(MODE === "anon" ? [/@(auth|r2)\b/] : []),
  ...(NIGHTLY ? [] : [/@nightly\b/]),
];

// The editor plays video without a user gesture (video.play() in tests).
const chromiumArgs = ["--autoplay-policy=no-user-gesture-required"];

const config: PlaywrightTestConfig = {
  testDir: "./e2e",
  globalSetup: "./e2e/support/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : 3,
  reporter: CI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"]],
  grep,
  grepInvert: grepInvert.length ? grepInvert : undefined,
  use: {
    baseURL: WEB,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: chromiumArgs },
      },
    },
    {
      name: "pixel7",
      use: { ...devices["Pixel 7"], launchOptions: { args: chromiumArgs } },
    },
    {
      // Nightly only (`--project=webkit`); required for release from UX18.
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `${process.env.STUB_PYTHON ?? "python3"} ../backend/tests/stub_server.py ${stubFlags}`,
      url: `${API}/health`,
      reuseExistingServer: !CI,
      timeout: 240_000,
      stdout: "pipe",
      // SIGTERM, not the default SIGKILL: the stub then stops moto and
      // deletes its throwaway database and media.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: webCommand,
      url: `${WEB}/imprint`,
      reuseExistingServer: !CI,
      timeout: 240_000,
      env: webEnv,
    },
  ],
};

export default defineConfig(config);
