/**
 * Account + billing state for the UI: GET /me (plan, minutes, media
 * token), GET /billing/config (public plans/prices), the server-side
 * project list, and the checkout / portal hand-offs to Lemon Squeezy.
 *
 * All of it is inert with auth off: nothing is fetched, the hooks return
 * their "off" values and the app behaves like the anonymous beta.
 * Billing is never switched on from env alone — the backend decides
 * (GET /billing/config), the frontend only follows.
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  AUTH_ENABLED,
  INITIAL_AUTH_STATE,
  getAuthState,
  subscribeAuth,
  type AuthState,
} from "@/lib/auth";
import { apiError, apiFetch, backendUrl, detailCode, setMediaAccess } from "@/lib/api";
import { LIBRARY_KEY, type LibraryEntry, type LibraryHookClip } from "@/lib/library";
import { ACTIVE_JOBS_KEY } from "@/lib/activeJobs";
import { ACTIVE_JOB_KEY } from "@/lib/activeJob";
import { mergeStored, storedValue } from "@/lib/scopedStorage";

/** Landing-page copy only ("Open beta · free" → pricing CTA). */
export const BILLING_COPY =
  AUTH_ENABLED &&
  ["1", "true"].includes((process.env.NEXT_PUBLIC_BILLING_ENABLED ?? "").toLowerCase());

export function useAuthState(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, () => INITIAL_AUTH_STATE);
}

// ── Tiny external store helper ───────────────────────────────────────
function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((f) => f());
    },
    subscribe: (cb: () => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

// ── GET /me ───────────────────────────────────────────────────────────
export type PlanId = "starter" | "pro" | "studio";
/** ISO string or unix seconds — whatever the backend sends. */
export type ApiTime = string | number | null | undefined;

export type Me = {
  auth_enabled: boolean;
  user?: { id: string; email: string | null };
  billing?: { enabled: boolean; enforce: boolean };
  plan?: PlanId | null;
  /** Plan granted by CLEO_COMP_USERS, not by a Lemon Squeezy subscription. */
  comp?: boolean;
  subscription?: {
    status: string;
    renews_at?: ApiTime;
    ends_at?: ApiTime;
    test_mode?: boolean;
  } | null;
  minutes?: {
    limit: number;
    used: number;
    remaining: number;
    period_start?: ApiTime;
    period_end?: ApiTime;
  } | null;
  media_token?: string;
};

export type MeState = { status: "idle" | "loading" | "ready" | "error"; me: Me | null };

const meStore = createStore<MeState>({ status: "idle", me: null });
const ME_OFF: MeState = { status: "idle", me: null };
let meInflight: { gen: number; promise: Promise<Me | null> } | null = null;
let meRetry: ReturnType<typeof setTimeout> | null = null;
let meFailures = 0;
let meGeneration = 0;

export function useMe(): MeState {
  return useSyncExternalStore(meStore.subscribe, meStore.get, () => ME_OFF);
}

/** (Re)load /me. Retries with backoff while it fails. */
export function refreshMe(): Promise<Me | null> {
  if (!AUTH_ENABLED || typeof window === "undefined") return Promise.resolve(null);
  // A request started before a sign-out / account switch belongs to the
  // previous user: its answer is dropped, so start a fresh one.
  if (meInflight && meInflight.gen === meGeneration) return meInflight.promise;
  const gen = meGeneration;
  const cur = meStore.get();
  if (!cur.me) meStore.set({ status: "loading", me: null });
  const promise = loadMe(gen);
  meInflight = { gen, promise };
  void promise.finally(() => {
    if (meInflight?.promise === promise) meInflight = null;
  });
  return promise;
}

async function loadMe(gen: number): Promise<Me | null> {
  try {
    const r = await apiFetch("/me");
    let me: Me;
    if (r.status === 404) {
      // Backend without accounts yet (frontend deployed first): media
      // works without a token there.
      me = { auth_enabled: false };
    } else if (!r.ok) {
      throw await apiError(r);
    } else {
      me = (await r.json()) as Me;
    }
    if (gen !== meGeneration) return null; // signed out / switched meanwhile
    meFailures = 0;
    meStore.set({ status: "ready", me });
    setMediaAccess(me.media_token ?? null, true);
    return me;
  } catch {
    if (gen !== meGeneration) return null;
    meFailures++;
    meStore.set({ status: "error", me: meStore.get().me });
    if (meRetry) clearTimeout(meRetry);
    meRetry = setTimeout(() => {
      meRetry = null;
      void refreshMe();
    }, Math.min(60_000, 5_000 * 2 ** Math.min(meFailures - 1, 4)));
    return null;
  }
}

/** Signed out / user changed: forget everything user-specific. */
export function clearMe(): void {
  meGeneration++;
  meFailures = 0;
  if (meRetry) clearTimeout(meRetry);
  meRetry = null;
  meStore.set({ status: "idle", me: null });
  setMediaAccess(null, false);
}

// ── GET /billing/config (public) ──────────────────────────────────────
export type BillingPlan = {
  id: PlanId;
  name: string;
  minutes: number;
  retention_days: number;
  price_formatted: string | null;
  interval: string | null;
  available: boolean;
};

export type BillingConfig = {
  enabled: boolean;
  enforce: boolean;
  test_mode: boolean;
  plans: BillingPlan[];
};

const BILLING_OFF: BillingConfig = { enabled: false, enforce: false, test_mode: false, plans: [] };
const billingStore = createStore<BillingConfig | null>(null);
const billingFailedStore = createStore(false);
let billingLoading = false;

/** Loads once per page life; `retry` after a failure. */
export async function loadBillingConfig(): Promise<void> {
  if (!AUTH_ENABLED || billingLoading || billingStore.get()) return;
  billingLoading = true;
  billingFailedStore.set(false);
  try {
    // Plain fetch: public endpoint, no token → no CORS preflight.
    const r = await fetch(`${backendUrl()}/billing/config`);
    if (r.status === 404) billingStore.set(BILLING_OFF); // older backend
    else if (!r.ok) billingFailedStore.set(true);
    else {
      const c = (await r.json()) as Partial<BillingConfig>;
      billingStore.set({
        enabled: Boolean(c.enabled),
        enforce: Boolean(c.enforce),
        test_mode: Boolean(c.test_mode),
        plans: Array.isArray(c.plans) ? c.plans : [],
      });
    }
  } catch {
    // Offline: stays null (= "not known"); the next mount retries.
    billingFailedStore.set(true);
  } finally {
    billingLoading = false;
  }
}

/** null while unknown (and always with auth off — no billing without accounts). */
export function useBillingConfig(): BillingConfig | null {
  const c = useSyncExternalStore(billingStore.subscribe, billingStore.get, () => null);
  useEffect(() => {
    if (AUTH_ENABLED) void loadBillingConfig();
  }, []);
  return AUTH_ENABLED ? c : null;
}

export function useBillingLoadFailed(): boolean {
  return useSyncExternalStore(billingFailedStore.subscribe, billingFailedStore.get, () => false);
}

export function useBillingEnabled(): boolean {
  return useBillingConfig()?.enabled === true;
}

// ── Checkout / portal ─────────────────────────────────────────────────
/** Lemon Squeezy checkout. Already subscribed (409) → the customer
 *  portal, where plans are switched. Navigates away on success. */
export async function startCheckout(plan: PlanId, email?: string | null): Promise<void> {
  const r = await apiFetch("/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(email ? { plan, email } : { plan }),
  });
  if (r.ok) {
    const { url } = (await r.json()) as { url?: string };
    if (!url) throw new Error("checkout: no url");
    window.location.assign(url);
    return;
  }
  const err = await apiError(r);
  if (r.status === 409 && err.code === "already_subscribed") {
    const d = err.detail as { portal_url?: unknown } | null;
    if (d && typeof d.portal_url === "string" && d.portal_url) {
      window.location.assign(d.portal_url);
      return;
    }
    await openPortal();
    return;
  }
  throw err;
}

/** The portal URL is signed and expires — always fetch a fresh one. */
export async function openPortal(): Promise<void> {
  const r = await apiFetch("/billing/portal");
  if (!r.ok) throw await apiError(r);
  const { url } = (await r.json()) as { url?: string };
  if (!url) throw new Error("portal: no url");
  window.location.assign(url);
}

// ── Upload blocked by billing (402) ───────────────────────────────────
export type Paywall =
  | { code: "subscription_required" }
  | { code: "quota_exceeded"; remainingSeconds: number | null; neededSeconds: number | null };

/** A 402 detail → what to tell the user, or null if it isn't one. */
export function paywallFrom(status: number, detail: unknown): Paywall | null {
  if (status !== 402) return null;
  const code = detailCode(detail);
  if (code === "quota_exceeded") {
    const d = (detail ?? {}) as { remaining_seconds?: unknown; needed_seconds?: unknown };
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
    return {
      code,
      remainingSeconds: num(d.remaining_seconds),
      neededSeconds: num(d.needed_seconds),
    };
  }
  return { code: "subscription_required" };
}

// ── Server-side project list (GET /jobs) ──────────────────────────────
export type ServerJob = {
  id: string;
  status: string;
  message?: string;
  progress?: number;
  filename?: string | null;
  preset_id?: string | null;
  preset_label?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  expires_at?: number | null;
  has_output?: boolean;
  outputs?: string[] | Record<string, string> | null;
  hook_clips?: LibraryHookClip[] | null;
  social_caption?: string | null;
  social_hashtags?: string[] | null;
  duration?: number | null;
};

/** The caller's jobs, newest first — or null (auth off, backend without
 *  the list, offline): callers then fall back to localStorage. */
export async function fetchServerJobs(): Promise<ServerJob[] | null> {
  if (!AUTH_ENABLED) return null;
  try {
    const r = await apiFetch("/jobs");
    if (!r.ok) return null;
    const j = (await r.json()) as unknown;
    if (Array.isArray(j)) return j as ServerJob[];
    const jobs = (j as { jobs?: unknown } | null)?.jobs;
    return Array.isArray(jobs) ? (jobs as ServerJob[]) : null;
  } catch {
    return null;
  }
}

export function outputKeys(outputs: ServerJob["outputs"]): string[] {
  if (Array.isArray(outputs)) return outputs;
  if (outputs && typeof outputs === "object") return Object.keys(outputs);
  return ["primary"];
}

export function serverJobToLibraryEntry(j: ServerJob): LibraryEntry {
  return {
    jobId: j.id,
    timestamp: toMs(j.updated_at ?? j.created_at) ?? Date.now(),
    presetId: j.preset_id ?? null,
    presetIcon: null,
    presetLabel: j.preset_label ?? null,
    // Old beta jobs have no stored name; rendered as "Untitled".
    filename: j.filename ?? "",
    outputs: outputKeys(j.outputs),
    hookClips: j.hook_clips ?? [],
    socialCaption: j.social_caption ?? "",
    socialHashtags: j.social_hashtags ?? [],
  };
}

// ── Beta data → the first account that signs in on this device ───────
let adoptedFor: string | null = null;

/**
 * The anonymous beta kept projects in un-namespaced localStorage keys.
 * Merge them into the signed-in user's keys (once) — merged, not only
 * when the user has none yet: after accounts were switched off and on
 * again the plain keys hold the projects made in between — and open
 * each job once so the backend assigns the ownerless beta job to this
 * account, otherwise it wouldn't show up in GET /jobs. The plain keys
 * are removed, so the next account on a shared device doesn't get them.
 */
export function adoptLegacyLocalData(userId: string): void {
  if (!AUTH_ENABLED || adoptedFor === userId || typeof window === "undefined") return;
  adoptedFor = userId;
  const ids = new Set<string>();
  try {
    for (const base of [LIBRARY_KEY, ACTIVE_JOBS_KEY, ACTIVE_JOB_KEY]) {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      const mine = `${base}:${userId}`;
      const merged = mergeStored(localStorage.getItem(mine), legacy);
      const value = storedValue(merged, base === ACTIVE_JOB_KEY);
      if (value !== null) localStorage.setItem(mine, value);
      localStorage.removeItem(base);
      try {
        const parsed = JSON.parse(legacy) as unknown;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const e of list) {
          const id = (e as { jobId?: unknown } | null)?.jobId;
          if (typeof id === "string" && !id.startsWith("upl-")) ids.add(id);
        }
      } catch {
        /* unreadable entry — nothing to claim */
      }
    }
  } catch {
    return; // storage blocked
  }
  void (async () => {
    for (const id of ids) {
      try {
        await apiFetch(`/jobs/${encodeURIComponent(id)}`);
      } catch {
        /* offline: the card's own poll claims it later */
      }
    }
  })();
}

// ── Formatting ────────────────────────────────────────────────────────
/** ApiTime → epoch ms (unix seconds and ISO strings both accepted). */
export function toMs(v: ApiTime): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : d;
}

export function fmtDate(v: ApiTime, lang: string): string {
  const ms = toMs(v);
  if (ms === null) return "";
  try {
    return new Date(ms).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

/** Minutes with at most one decimal, in the UI language. */
export function fmtMinutes(min: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(min);
  } catch {
    return String(Math.round(min * 10) / 10);
  }
}

export const PLAN_ORDER: PlanId[] = ["starter", "pro", "studio"];

/** Display name of a plan: backend name when known, else capitalized id. */
export function planName(id: string | null | undefined, config?: BillingConfig | null): string {
  if (!id) return "";
  const p = config?.plans.find((x) => x.id === id);
  return p?.name || id.charAt(0).toUpperCase() + id.slice(1);
}
