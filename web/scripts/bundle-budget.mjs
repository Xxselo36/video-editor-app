#!/usr/bin/env node
/**
 * Bundle budget (UX5, PLAN_TECH §0.12) — `npm run bundle:budget` after
 * `next build` (CI: .github/workflows/web.yml).
 *
 * First-load JS per app route, gzipped: what the browser must fetch
 * before the route runs — the root chunks (build-manifest rootMainFiles,
 * without the nomodule polyfills) plus every entry chunk of the route's
 * client reference manifest (layouts, page, error / not-found
 * boundaries: the scripts Next puts into the route's HTML). Chunks loaded
 * later with import() (other languages, the upload code, the caption
 * engine) don't count.
 *
 * Budgets (KB gz) in BUDGETS below; a route over its budget fails the
 * run (exit 1). Routes without a budget are only reported.
 *
 * Usage: node scripts/bundle-budget.mjs [--json] [--dir .next]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** KB gz of first-load JS per route (PLAN_TECH §0.12 targets). */
export const BUDGETS = {
  "/app": 200,
  "/app/new": 200,
  "/app/p/[jobId]": 200,
  "/app/edit/[jobId]": 250,
};

/** The entry chunks listed in a page_client-reference-manifest.js. */
export function manifestEntryFiles(source) {
  const sandbox = { globalThis: {} };
  new Function("globalThis", source)(sandbox.globalThis);
  const all = sandbox.globalThis.__RSC_MANIFEST ?? {};
  const files = new Set();
  for (const m of Object.values(all)) {
    for (const list of Object.values(m.entryJSFiles ?? {})) for (const f of list) files.add(f);
  }
  return files;
}

const gzCache = new Map();
function gzSize(file) {
  if (!gzCache.has(file)) gzCache.set(file, zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length);
  return gzCache.get(file);
}

/** [{ route, kb, files, budget }] for every app page of the build. */
export function measure(dir = path.join(WEB, ".next")) {
  const build = JSON.parse(fs.readFileSync(path.join(dir, "build-manifest.json"), "utf8"));
  const polyfills = new Set(build.polyfillFiles ?? []);
  const root = (build.rootMainFiles ?? []).filter((f) => !polyfills.has(f));
  const routes = JSON.parse(fs.readFileSync(path.join(dir, "app-path-routes-manifest.json"), "utf8"));
  const out = [];
  for (const [entry, route] of Object.entries(routes)) {
    if (!entry.endsWith("/page") || route.startsWith("/_")) continue;
    const mf = path.join(dir, "server", "app", `${entry}_client-reference-manifest.js`);
    if (!fs.existsSync(mf)) continue;
    const files = new Set(root);
    for (const f of manifestEntryFiles(fs.readFileSync(mf, "utf8"))) {
      if (!polyfills.has(f)) files.add(f.replace(/^\/_next\//, ""));
    }
    const bytes = [...files].reduce((n, f) => n + gzSize(path.join(dir, f)), 0);
    out.push({ route, kb: Math.round(bytes / 102.4) / 10, files: files.size, budget: BUDGETS[route] ?? null });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

function main(argv) {
  const dirArg = argv.indexOf("--dir");
  const dir = dirArg >= 0 ? path.resolve(argv[dirArg + 1]) : path.join(WEB, ".next");
  if (!fs.existsSync(path.join(dir, "build-manifest.json"))) {
    console.error(`bundle budget: no build in ${dir} (run next build first)`);
    return 2;
  }
  const rows = measure(dir);
  const over = rows.filter((r) => r.budget !== null && r.kb > r.budget);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ rows, over: over.map((r) => r.route) }, null, 2));
    return over.length ? 1 : 0;
  }
  console.log("First-load JS (gzip):");
  for (const r of rows) {
    const mark = r.budget === null ? " " : r.kb > r.budget ? "✗" : "✓";
    const budget = r.budget === null ? "" : ` / ${r.budget} KB`;
    console.log(`${mark} ${r.route.padEnd(28)} ${String(r.kb).padStart(7)} KB${budget}  (${r.files} files)`);
    if (process.env.GITHUB_ACTIONS && r.budget !== null && r.kb > r.budget) {
      console.log(`::error title=Bundle budget::${r.route} loads ${r.kb} KB gz, budget ${r.budget} KB`);
    }
  }
  console.log(over.length ? `bundle budget FAILED: ${over.map((r) => r.route).join(", ")}` : "bundle budget passed");
  return over.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
