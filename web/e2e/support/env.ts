/**
 * Where the e2e run's servers live, shared by playwright.config.ts and
 * the specs. The web build must talk to the stub: it is built with
 * NEXT_PUBLIC_BACKEND_URL=API (the webServer does that for `dev`/`build`;
 * CI builds once up front).
 *
 * E2E_MODE picks the backend flavour for the whole run (one stub per run):
 *   anon  the anonymous beta (accounts off) — every suite without a tag
 *   auth  accounts on with test auth (CLEO_AUTH_TEST / NEXT_PUBLIC_AUTH_TEST):
 *         the suites tagged @auth
 *   r2    media + uploads in R2 (moto): the suites tagged @r2
 */
export type Mode = "anon" | "auth" | "r2";

export const MODE = (process.env.E2E_MODE ?? "anon") as Mode;
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3501);
export const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 8501);
export const WEB = `http://localhost:${WEB_PORT}`;
export const API = `http://localhost:${STUB_PORT}`;
/**
 * E2E_EDITOR_V2=1: the web build has NEXT_PUBLIC_EDITOR_V2=1 (UX7) and the
 * run executes the @editor-v2 suites only; without it they are skipped.
 */
export const EDITOR_V2 = process.env.E2E_EDITOR_V2 === "1";
/** Suites tagged @nightly run only with E2E_NIGHTLY=1. */
export const NIGHTLY = process.env.E2E_NIGHTLY === "1";
