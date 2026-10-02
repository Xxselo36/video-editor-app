/**
 * Everything that talks to the FastAPI backend goes through here.
 *
 * Auth off: plain fetch() against backendUrl() — requests are exactly
 * what they were before accounts existed.
 * Auth on: API calls carry `Authorization: Bearer <Clerk JWT>`; URLs the
 * browser loads by itself (<video>, <img>, download links) can't send
 * headers, so they carry the per-user media token from GET /me (?t=).
 */
import { useState, useSyncExternalStore } from "react";
import { AUTH_ENABLED, authHeader, cachedAuthToken, getAuthToken } from "@/lib/auth";

// Backend host: explicit env wins, else the page's hostname on port
// 8000 — so a phone on the LAN (192.168.x.y:3000) hits 192.168.x.y:8000,
// not its own localhost. Called lazily so it runs in the browser.
export function backendUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

/** Fired (debounced) when the backend answers 401 — the Clerk shell
 *  opens sign-in. Never treat a 401 as "job gone". */
export const AUTH_REQUIRED_EVENT = "cleocuts:auth-required";
let lastAuthEvent = 0;

export function notifyAuthRequired(): void {
  if (!AUTH_ENABLED || typeof window === "undefined") return;
  // The dashboard polls every 2 s per job: without the debounce an
  // expired session would re-open sign-in over and over.
  const now = Date.now();
  if (now - lastAuthEvent < 10_000) return;
  lastAuthEvent = now;
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

export type ApiInit = RequestInit & {
  /** The page is going away: don't await anything before fetch(). */
  unloading?: boolean;
};

export async function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const { unloading, ...rest } = init;
  const url = `${backendUrl()}${path}`;
  if (!AUTH_ENABLED) return fetch(url, rest);
  // Unload saves use the cached token: an await here would let the page
  // die before the request is even sent.
  const token = unloading || rest.keepalive ? cachedAuthToken() : await getAuthToken();
  const headers = new Headers(rest.headers);
  if (token) headers.set(...authHeader(token));
  const r = await fetch(url, { ...rest, headers });
  if (r.status === 401) notifyAuthRequired();
  return r;
}

/** Headers for the XHR uploads (they need progress events, so no fetch). */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  if (!token) return {};
  const [name, value] = authHeader(token);
  return { [name]: value };
}

/** A non-2xx backend answer, with FastAPI's `detail` parsed. */
export class ApiError extends Error {
  status: number;
  detail: unknown;
  /** The whole JSON body: refusals put extra fields next to `detail`
   *  ({"detail":"file_too_large","max_gb":4}). */
  body: Record<string, unknown> | null;
  constructor(status: number, detail: unknown, body: Record<string, unknown> | null = null) {
    super(`${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
  /** detail.code ({"detail":{"code":…}}) or a plain string detail. */
  get code(): string | null {
    return detailCode(this.detail);
  }
  /** A numeric field of the answer, from the body or from detail. */
  num(field: string): number | null {
    const d = this.detail && typeof this.detail === "object" ? (this.detail as Record<string, unknown>) : {};
    const v = this.body?.[field] ?? d[field];
    return typeof v === "number" && isFinite(v) ? v : null;
  }
}

export function parseDetail(body: string): unknown {
  try {
    const j = JSON.parse(body);
    return j && typeof j === "object" && "detail" in j ? j.detail : j;
  } catch {
    return body;
  }
}

export function detailCode(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "code" in detail) {
    const c = (detail as { code?: unknown }).code;
    return typeof c === "string" ? c : null;
  }
  return null;
}

/** ApiError from a status + raw body (fetch or XHR answers). */
export function apiErrorFromText(status: number, text: string): ApiError {
  let body: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j)) body = j;
  } catch {
    /* not JSON */
  }
  return new ApiError(status, parseDetail(text), body);
}

export async function apiError(r: Response): Promise<ApiError> {
  let text = "";
  try {
    text = await r.text();
  } catch {
    /* body unreadable */
  }
  return apiErrorFromText(r.status, text);
}

// ── Media URLs ────────────────────────────────────────────────────────
// The token is stable for a whole UTC day (backend accepts today's and
// yesterday's), so a <video> keeps working through a long edit session.
let mediaToken: string | null = null;
let mediaReady = !AUTH_ENABLED;
let mediaWaiters: (() => void)[] = [];
const mediaSubs = new Set<() => void>();

/** Called by lib/account after GET /me. */
export function setMediaAccess(token: string | null, ready: boolean): void {
  if (token === mediaToken && ready === mediaReady) return;
  mediaToken = token;
  mediaReady = !AUTH_ENABLED || ready;
  if (mediaReady) {
    const w = mediaWaiters;
    mediaWaiters = [];
    w.forEach((f) => f());
  }
  mediaSubs.forEach((f) => f());
}

function subscribeMedia(cb: () => void): () => void {
  mediaSubs.add(cb);
  return () => {
    mediaSubs.delete(cb);
  };
}

/** True once media URLs can be built (always with auth off). Render no
 *  <img>/<video> before that: a tokenless first try fails for good. */
export function useMediaReady(): boolean {
  return useSyncExternalStore(subscribeMedia, () => mediaReady, () => !AUTH_ENABLED);
}

export function isMediaReady(): boolean {
  return mediaReady;
}

/** Resolves true once media URLs can be built, false if that didn't
 *  happen within `timeoutMs` — callers must not build URLs then. */
export function whenMediaReady(timeoutMs = 10_000): Promise<boolean> {
  if (mediaReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    mediaWaiters.push(() => resolve(true));
    setTimeout(() => resolve(mediaReady), timeoutMs);
  });
}

// proxy-video: the full normalized source at ≤720p (seconds = source
// seconds), which the editor plays and cuts client-side (lib/editPlayback).
// peaks: the audio envelope the v2 editor snaps text cuts to (UX10).
export type MediaRoute = "preview-video" | "proxy-video" | "watch" | "download" | "thumbnail" | "poster" | "peaks";

export function mediaUrl(
  jobId: string,
  route: MediaRoute,
  query: Record<string, string | number> = {},
): string {
  const parts = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  if (AUTH_ENABLED && mediaToken) parts.push(`t=${encodeURIComponent(mediaToken)}`);
  return `${backendUrl()}/jobs/${jobId}/${route}${parts.length ? `?${parts.join("&")}` : ""}`;
}

/**
 * A media URL frozen for the lifetime of the element using it (a new
 * src would restart playback), or null until the token is known.
 */
export function useMediaUrl(
  jobId: string,
  route: MediaRoute,
  query: Record<string, string | number> = {},
): string | null {
  const ready = useMediaReady();
  const key = `${jobId}/${route}?${JSON.stringify(query)}`;
  const [frozen, setFrozen] = useState<{ key: string; url: string } | null>(() =>
    ready ? { key, url: mediaUrl(jobId, route, query) } : null,
  );
  if (ready && frozen?.key !== key) {
    const next = { key, url: mediaUrl(jobId, route, query) };
    setFrozen(next);
    return next.url;
  }
  return frozen?.key === key ? frozen.url : null;
}

/** Public backend assets (caption previews) — never need auth. */
export function publicUrl(path: string): string {
  return `${backendUrl()}${path}`;
}
