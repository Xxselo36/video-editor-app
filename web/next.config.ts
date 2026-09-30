import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// ── Release (git SHA) ────────────────────────────────────────────────
// Tags Sentry events (lib/sentryInit) with the deployed commit — the
// backend uses the same SHA (backend/observability.py release()). Vercel
// builds know it (VERCEL_GIT_COMMIT_SHA); elsewhere the local checkout.
function gitSha(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_RELEASE ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.SOURCE_COMMIT;
  if (fromEnv) return fromEnv.trim();
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const release = gitSha();

// ── Security headers ─────────────────────────────────────────────────
// Evaluated at BUILD time (Vercel bakes headers into the deployment),
// so the env-driven origins below must be set before the build — same
// rule as every NEXT_PUBLIC_* variable.
//
// Two CSPs:
//  - Content-Security-Policy (enforced): only directives that cannot
//    break a flow — no framing, no plugins, no <base>, forms only to us.
//  - Content-Security-Policy-Report-Only: the full allow-list of every
//    origin the app really talks to. Violations only show up in the
//    browser console (no report endpoint: reports would carry media URLs
//    with ?t= tokens). Enforce it once production is clean.
//    Scripts: 'unsafe-inline' because Next inlines its RSC/bootstrap
//    scripts and nonces would force every page to render dynamically;
//    switch to nonces (proxy.ts) or experimental.sri before enforcing.

const isDev = process.env.NODE_ENV === "development";

// Test auth (NEXT_PUBLIC_AUTH_TEST=1, lib/auth AUTH_TEST) lets anyone sign
// in as anyone: e2e runs and staging only, never a production deployment.
if (
  process.env.NEXT_PUBLIC_AUTH_TEST === "1" &&
  (process.env.VERCEL_ENV === "production" ||
    /^pk_live_/.test(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ""))
) {
  throw new Error(
    "NEXT_PUBLIC_AUTH_TEST=1 is refused in a production deployment (VERCEL_ENV=production or a live Clerk key)",
  );
}

/** Origin of an absolute URL from env, or null. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Clerk Frontend API host: pk_(test|live)_<base64("host$")>. */
function clerkFrontendApi(pk: string | undefined): { host: string; dev: boolean } | null {
  const m = pk?.match(/^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/);
  if (!m) return null;
  const host = Buffer.from(m[2], "base64").toString("utf8").replace(/\$$/, "");
  return /^[a-z0-9.-]+$/i.test(host) ? { host, dev: m[1] === "test" } : null;
}

function uniq(values: (string | null | false | undefined)[]): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].join(" ");
}

// Backend (lib/api.ts backendUrl()): NEXT_PUBLIC_BACKEND_URL, else the
// page's own host on port 8000 (LAN/dev), which only a wildcard covers.
const backendOrigin = originOf(process.env.NEXT_PUBLIC_BACKEND_URL);
const api = backendOrigin ? [backendOrigin] : ["http://*:8000", "https://*:8000"];

// Media: the backend serves /jobs/:id/* itself today, but uploads PUT
// straight to R2 (presigned, lib/chunkedUpload.ts) and media routes may
// redirect to presigned R2 GETs. CSP_MEDIA_ORIGINS: extra origins, e.g.
// a public R2 / CDN domain (comma- or space-separated).
const media = [
  "https://*.r2.cloudflarestorage.com",
  ...(process.env.CSP_MEDIA_ORIGINS ?? "")
    .split(/[\s,]+/)
    // A bare host ("media.example.com") means https.
    .map((s) => originOf(s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? `https://${s}` : s))
    .filter((s): s is string => Boolean(s)),
];

// Accounts (only when Clerk is configured — same switch as lib/auth).
const clerk = clerkFrontendApi(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
const clerkFapi = clerk ? [`https://${clerk.host}`, clerk.dev && "https://*.clerk.accounts.dev"] : [];
const clerkScripts = clerk ? [...clerkFapi, "https://challenges.cloudflare.com", "https://*.protect.clerk.com"] : [];
const clerkConnect = clerk
  ? [
      ...clerkFapi,
      "https://img.clerk.com",
      "https://clerk-telemetry.com",
      "https://*.clerk-telemetry.com",
      "https://*.protect.clerk.com",
    ]
  : [];
const clerkFrames = clerk ? ["https://challenges.cloudflare.com", "https://*.protect.clerk.com"] : [];

// Browser error reports (components/ErrorReporting), only with a DSN.
const sentryIngest = originOf(process.env.NEXT_PUBLIC_SENTRY_DSN);

// Cookieless analytics (lib/analytics), only with a provider. Vercel Web
// Analytics serves its script and takes its events on our own origin
// (/_vercel/insights/*, 'self'); outside Vercel deployments it loads the
// debug script from va.vercel-scripts.com.
const analyticsProvider = (process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER ?? "").trim().toLowerCase();
const analyticsScripts = analyticsProvider === "vercel" ? ["https://va.vercel-scripts.com"] : [];

// Checkout / customer portal (Lemon Squeezy) are top-level navigations
// (window.location.assign in lib/account.ts): no script, frame or form
// of theirs runs on our pages, so no CSP entry is needed. An overlay
// checkout (lemon.js) would need script-src/frame-src + payment=.

const enforcedCsp = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"];

const reportOnlyCsp = [
  "default-src 'self'",
  // 'wasm-unsafe-eval': HarfBuzz (WASM) shapes Hindi captions (lib/captions/shape-hb.ts).
  `script-src ${uniq(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", isDev && "'unsafe-eval'", ...clerkScripts, ...analyticsScripts])}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${uniq(["'self'", "data:", "blob:", ...api, ...media, clerk && "https://img.clerk.com"])}`,
  `media-src ${uniq(["'self'", "blob:", ...api, ...media])}`,
  `connect-src ${uniq(["'self'", ...api, ...media, ...clerkConnect, sentryIngest, ...analyticsScripts])}`,
  "font-src 'self' data:",
  `frame-src ${clerkFrames.length ? uniq(clerkFrames) : "'none'"}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...enforcedCsp,
];

const permissionsPolicy = [
  // The voice test (features/voice-test) runs on our own origin.
  "camera=(self)",
  "microphone=(self)",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "midi=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "display-capture=()",
  "idle-detection=()",
  "browsing-topics=()",
  "xr-spatial-tracking=()",
];

const securityHeaders = [
  // No preload: includeSubDomains + preload is hard to undo.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: permissionsPolicy.join(", ") },
  // Clerk's OAuth popups need to keep window.opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Content-Security-Policy", value: enforcedCsp.join("; ") },
  { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp.join("; ") },
];

const nextConfig: NextConfig = {
  // Allow LAN IPs so we can open the dev server on phone/tablet
  // (Next 16 blocks cross-origin dev resources by default).
  allowedDevOrigins: [
    "192.168.178.155",
    "localhost",
  ],
  poweredByHeader: false,
  // The build's git SHA for the browser (Sentry release).
  env: { NEXT_PUBLIC_RELEASE: release },
  // Caption engine (lib/captions/shape-hb.ts) loads harfbuzzjs lazily. Its
  // Emscripten loader imports Node's "module" only under Node; in the
  // browser bundle that import resolves to a stub, and on the server the
  // package is left to Node.
  turbopack: {
    resolveAlias: { module: { browser: "./src/lib/captions/empty-module.ts" } },
  },
  serverExternalPackages: ["harfbuzzjs"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
