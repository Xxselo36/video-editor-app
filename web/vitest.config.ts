/**
 * Unit tests (vitest): `npm test`. Pure logic only — flows are covered
 * by the Playwright suites in e2e/.
 *
 * `virtual:page-internals` exposes helpers that still live inside
 * app/app/page.tsx (buildPhrases, friendlyError). A Next page may only
 * export its route fields, and page.tsx is frozen for UX4's split, so
 * the helpers are re-exported for the tests only; their types are in
 * src/test/page-internals.d.ts. When UX4 moves them into modules, the
 * tests import those modules and this plugin goes.
 *
 * vite is pinned to 7 in devDependencies: with vite 8, npm 10 fails to
 * resolve vitest 4's peer set ("Cannot read properties of null
 * (reading 'edgesOut')").
 */
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const PAGE = fileURLToPath(new URL("./src/app/app/page.tsx", import.meta.url));
const PAGE_INTERNALS = ["buildPhrases", "friendlyError", "jobErrorText", "localizeKnown", "matchTemplate"];

function pageInternals(): Plugin {
  const id = "virtual:page-internals";
  return {
    name: "cleocuts:page-internals",
    enforce: "pre",
    resolveId(source) {
      return source === id ? `${PAGE}?internals` : null;
    },
    transform(code, moduleId) {
      if (moduleId !== `${PAGE}?internals`) return null;
      return { code: `${code}\nexport { ${PAGE_INTERNALS.join(", ")} };\n`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [pageInternals()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    restoreMocks: true,
  },
});
