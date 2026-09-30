"use client";
/**
 * Test auth (NEXT_PUBLIC_AUTH_TEST=1, lib/auth AUTH_TEST): stands in for
 * ClerkShell in the e2e suites and on staging. Loaded lazily by
 * AuthProvider, and only in test-auth builds.
 *
 * The "session" is a test user in localStorage ({id, plan}); API calls
 * carry it as `X-Test-User: <id>[;plan=<plan>]` (the backend trusts it
 * with CLEO_AUTH_TEST=1 only, and never in production). Like ClerkShell
 * it mirrors the state into lib/auth + lib/account, so the app runs
 * exactly as with accounts on. The e2e fixture signedIn() writes the
 * same storage key.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAuthState,
  getAuthToken,
  publishAuthState,
  registerTokenGetter,
  signInHref,
} from "@/lib/auth";
import { AUTH_REQUIRED_EVENT } from "@/lib/api";
import { adoptLegacyLocalData, clearMe, refreshMe } from "@/lib/account";

export const TEST_USER_KEY = "cleocuts.testUser.v1";
const EVENT = "cleocuts.testUser.change";
export const TEST_PLANS = ["starter", "pro", "studio"] as const;

export type TestUser = { id: string; plan?: string | null; email?: string | null };

const ID = /^[A-Za-z0-9_.:@-]{1,128}$/;

export function readTestUser(): TestUser | null {
  try {
    const raw = localStorage.getItem(TEST_USER_KEY);
    const u = raw ? (JSON.parse(raw) as TestUser) : null;
    return u && typeof u.id === "string" && ID.test(u.id) ? u : null;
  } catch {
    return null;
  }
}

export function setTestUser(u: TestUser | null, { silent = false } = {}): void {
  try {
    if (u) localStorage.setItem(TEST_USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(TEST_USER_KEY);
  } catch {
    /* storage blocked */
  }
  if (!silent) window.dispatchEvent(new Event(EVENT));
}

/** The X-Test-User header value. */
const headerFor = (u: TestUser) => (u.plan ? `${u.id};plan=${u.plan}` : u.id);

/** Where to go after signing in: ?redirect_url= when it is ours, else /app. */
function returnTo(): string {
  try {
    const want = new URL(window.location.href).searchParams.get("redirect_url");
    if (want) {
      const u = new URL(want, window.location.origin);
      if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
    }
  } catch {
    /* fall through */
  }
  return "/app";
}

export default function MockAuthProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let lastUser: string | null = null;
    const sync = () => {
      const u = readTestUser();
      // Switched users without signing out: drop the previous user's /me.
      if (lastUser !== null && lastUser !== (u?.id ?? null)) clearMe();
      lastUser = u?.id ?? null;
      registerTokenGetter(u ? async () => headerFor(u) : null);
      publishAuthState({
        loaded: true,
        failed: false,
        signedIn: Boolean(u),
        userId: u?.id ?? null,
        email: u?.email ?? null,
      });
      if (u) {
        adoptLegacyLocalData(u.id);
        void getAuthToken();
        void refreshMe();
      } else {
        clearMe();
      }
    };
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === TEST_USER_KEY) sync();
    };
    // The backend said 401 while signed out: to the sign-in page.
    const onAuthRequired = () => {
      if (!getAuthState().signedIn) window.location.assign(signInHref());
    };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
      registerTokenGetter(null);
    };
  }, []);
  return <>{children}</>;
}

const box = {
  background: "var(--surface-1)",
  border: "1px solid var(--border)",
  color: "var(--text-strong)",
} as const;

/** The sign-in / sign-up page of test auth: pick a test user. */
export function MockSignIn({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [id, setId] = useState("test_user");
  const [plan, setPlan] = useState("");
  const signIn = (u: TestUser) => {
    setTestUser(u);
    router.replace(returnTo());
  };
  return (
    <div data-testid="mock-sign-in" className="flex w-full max-w-[400px] flex-col gap-3 rounded-2xl p-6" style={box}>
      <div className="text-lg font-bold">{mode === "sign-in" ? "Sign in" : "Sign up"} · test auth</div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        NEXT_PUBLIC_AUTH_TEST is on: pick a test user. Requests carry X-Test-User.
      </p>
      {[{ id: "test_user" }, ...TEST_PLANS.map((p) => ({ id: `test_${p}`, plan: p }))].map((u) => (
        <button
          key={u.id}
          data-testid={`mock-user-${u.id}`}
          onClick={() => signIn(u)}
          className="rounded-xl px-4 py-2 text-left text-sm"
          style={{ ...box, background: "var(--surface-2)" }}
        >
          {u.id}
          {"plan" in u ? ` · ${u.plan}` : " · no plan"}
        </button>
      ))}
      <form
        className="flex flex-col gap-2 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ID.test(id)) signIn({ id, plan: plan || null });
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          User id
          <input
            data-testid="mock-user-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            className="rounded-lg px-3 py-2 text-base sm:text-sm"
            style={box}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Plan
          <select
            data-testid="mock-user-plan"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="rounded-lg px-3 py-2 text-base sm:text-sm"
            style={box}
          >
            <option value="">(the user&apos;s own)</option>
            <option value="none">none</option>
            {TEST_PLANS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          data-testid="mock-sign-in-submit"
          className="rounded-xl px-4 py-2 text-sm font-semibold"
          style={{ background: "var(--brand)", color: "white" }}
        >
          Continue
        </button>
      </form>
    </div>
  );
}

/** The avatar menu of test auth: who is signed in, and sign out. */
export function MockUserButton() {
  const [user] = useState(() => (typeof window === "undefined" ? null : readTestUser()));
  return (
    <span className="inline-flex items-center gap-2 text-xs" data-testid="mock-user-button">
      <span data-testid="mock-user-name" className="hidden max-w-40 truncate sm:inline" style={{ color: "var(--text-muted)" }}>
        {user?.id}
      </span>
      <button
        data-testid="mock-sign-out"
        onClick={() => {
          // Like Clerk's afterSignOutUrl: a fresh landing page, signed out
          // (a state change first would send /app's gate to sign-in).
          setTestUser(null, { silent: true });
          window.location.assign("/");
        }}
        className="rounded-full px-2 py-1"
        style={{ ...box, background: "var(--surface-2)" }}
      >
        Sign out
      </button>
    </span>
  );
}
