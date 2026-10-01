import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUDGETS, manifestEntryFiles, measure } from "./bundle-budget.mjs";

const manifest = (route, entries) =>
  `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
  `globalThis.__RSC_MANIFEST[${JSON.stringify(route)}] = ${JSON.stringify({ clientModules: {}, entryJSFiles: entries })};`;

describe("bundle budget", () => {
  it("reads a route's entry chunks from its client reference manifest", () => {
    const src = manifest("/app/page", { "[project]/src/app/layout": ["static/chunks/a.js"], "[project]/src/app/app/page": ["static/chunks/a.js", "static/chunks/b.js"] });
    expect([...manifestEntryFiles(src)]).toEqual(["static/chunks/a.js", "static/chunks/b.js"]);
  });

  it("sums root + entry chunks gzipped, without polyfills", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
    const chunk = (name, kb) => {
      fs.mkdirSync(path.join(dir, "static", "chunks"), { recursive: true });
      // Incompressible bytes: gzip keeps the size.
      fs.writeFileSync(path.join(dir, "static", "chunks", name), Buffer.from(Array.from({ length: kb * 1024 }, (_, i) => (i * 2654435761) % 251)));
    };
    chunk("root.js", 10);
    chunk("poly.js", 50);
    chunk("page.js", 5);
    fs.writeFileSync(path.join(dir, "build-manifest.json"), JSON.stringify({ polyfillFiles: ["static/chunks/poly.js"], rootMainFiles: ["static/chunks/root.js"] }));
    fs.writeFileSync(path.join(dir, "app-path-routes-manifest.json"), JSON.stringify({ "/app/page": "/app", "/_not-found/page": "/_not-found" }));
    fs.mkdirSync(path.join(dir, "server", "app", "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server", "app", "app", "page_client-reference-manifest.js"), manifest("/app/page", { x: ["/_next/static/chunks/page.js", "static/chunks/poly.js"] }));
    const [row] = measure(dir);
    const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(dir, "static", "chunks", f)), { level: 9 }).length;
    expect(row).toEqual({ route: "/app", kb: Math.round((gz("root.js") + gz("page.js")) / 102.4) / 10, files: 2, budget: BUDGETS["/app"] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("budgets /app at 200 KB (PLAN_TECH §0.12)", () => {
    expect(BUDGETS["/app"]).toBe(200);
  });
});
