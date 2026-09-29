import type { NextConfig } from "next";

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

// Checkout / customer portal (Lemon Squeezy) are top-level navigations
// (window.location.assign in lib/account.ts): no script, frame or form
// of theirs runs on our pages, so no CSP entry is needed. An overlay
// checkout (lemon.js) would need script-src/frame-src + payment=.

const enforcedCsp = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"];

const reportOnlyCsp = [
  "default-src 'self'",
  `script-src ${uniq(["'self'", "'unsafe-inline'", isDev && "'unsafe-eval'", ...clerkScripts])}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${uniq(["'self'", "data:", "blob:", ...api, ...media, clerk && "https://img.clerk.com"])}`,
  `media-src ${uniq(["'self'", "blob:", ...api, ...media])}`,
  `connect-src ${uniq(["'self'", ...api, ...media, ...clerkConnect, sentryIngest])}`,
  "font-src 'self' data:",
  `frame-src ${clerkFrames.length ? uniq(clerkFrames) : "'none'"}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...enforcedCsp,
];

const permissionsPolicy = [
  // The voice/camera test (app/app/page.tsx) runs on our own origin.
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
