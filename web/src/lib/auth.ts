/**
 * Accounts switch + the auth state the rest of the app needs, without
 * importing Clerk (and without React, so server components can read
 * AUTH_ENABLED too).
 *
 * AUTH_ENABLED is inlined at build time (NEXT_PUBLIC_*). When it is
 * false nothing here touches Clerk and the app behaves exactly like the
 * anonymous beta. When it is true, components/auth/ClerkShell (loaded
 * lazily, only then) publishes Clerk's state and token getter here.
 *
 * Deploy: set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY
 * together on Vercel and redeploy — NEXT_PUBLIC_* is frozen at build.
 */

// Literal reference: only `process.env.NEXT_PUBLIC_X` gets inlined.
export const AUTH_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/** Paid plans are advertised (landing copy, legal texts). Copy only —
 *  whether billing is on is decided by the backend (GET /billing/config).
 *  Lives here (no React) so server components can read it too. */
export const BILLING_COPY =
  AUTH_ENABLED &&
  ["1", "true"].includes((process.env.NEXT_PUBLIC_BILLING_ENABLED ?? "").toLowerCase());

export type AuthState = {
  /** Clerk finished loading (always true when auth is off). */
  loaded: boolean;
  /** clerk-js could not be loaded (offline, content blocker, bad key). */
  failed: boolean;
  signedIn: boolean;
  userId: string | null;
  email: string | null;
};

const OFF: AuthState = { loaded: true, failed: false, signedIn: false, userId: null, email: null };
const LOADING: AuthState = { loaded: false, failed: false, signedIn: false, userId: null, email: null };
/** Snapshot for the server render and the first client paint. */
export const INITIAL_AUTH_STATE: AuthState = AUTH_ENABLED ? LOADING : OFF;

let state: AuthState = INITIAL_AUTH_STATE;
const listeners = new Set<() => void>();
let loadedWaiters: (() => void)[] = [];

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Called by the Clerk shell only. */
export function publishAuthState(patch: Partial<AuthState>): void {
  const next = { ...state, ...patch };
  const same = (Object.keys(next) as (keyof AuthState)[]).every((k) => next[k] === state[k]);
  if (same) return;
  if (next.userId !== state.userId) lastToken = null;
  state = next;
  if (state.loaded || state.failed) {
    const w = loadedWaiters;
    loadedWaiters = [];
    w.forEach((f) => f());
  }
  listeners.forEach((f) => f());
}

function whenAuthLoaded(timeoutMs = 10_000): Promise<void> {
  if (state.loaded || state.failed) return Promise.resolve();
  return new Promise((resolve) => {
    loadedWaiters.push(resolve);
    setTimeout(resolve, timeoutMs);
  });
}

type TokenGetter = (opts?: { skipCache?: boolean }) => Promise<string | null>;
let tokenGetter: TokenGetter | null = null;
let lastToken: string | null = null;

/** Called by the Clerk shell only. */
export function registerTokenGetter(g: TokenGetter | null): void {
  tokenGetter = g;
}

/**
 * Current Clerk session JWT (cached by clerk-js, ~60 s lifetime), or
 * null when auth is off / signed out. Waits for Clerk to load.
 */
export async function getAuthToken(opts?: { skipCache?: boolean }): Promise<string | null> {
  if (!AUTH_ENABLED || typeof window === "undefined") return null;
  await whenAuthLoaded();
  if (!state.signedIn || !tokenGetter) {
    lastToken = null;
    return null;
  }
  try {
    lastToken = await tokenGetter(opts);
  } catch {
    /* offline — keep the last one, the backend decides */
  }
  return lastToken;
}

/** Last token seen: for saves sent while the page unloads, where
 *  nothing may be awaited before fetch(). The shell keeps it fresh. */
export function cachedAuthToken(): string | null {
  return AUTH_ENABLED ? lastToken : null;
}

/**
 * Suffix for per-user localStorage keys, so a shared device doesn't
 * show one user's projects to the next. "" with auth off (the keys stay
 * exactly what they were).
 */
export function storageScope(): string {
  if (!AUTH_ENABLED) return "";
  return `:${state.userId ?? "anon"}`;
}

/** Clerk's sign-in page, coming back to `returnTo` (default: here). */
export function signInHref(returnTo?: string): string {
  const back = returnTo ?? (typeof window !== "undefined" ? window.location.href : "/app");
  return `/sign-in?redirect_url=${encodeURIComponent(back)}`;
}

export function signUpHref(returnTo?: string): string {
  const back = returnTo ?? (typeof window !== "undefined" ? window.location.href : "/app");
  return `/sign-up?redirect_url=${encodeURIComponent(back)}`;
}
