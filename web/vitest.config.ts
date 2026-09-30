/**
 * Unit tests (vitest): `npm test`. Pure logic only — flows are covered
 * by the Playwright suites in e2e/.
 *
 * vite is pinned to 7 in devDependencies: with vite 8, npm 10 fails to
 * resolve vitest 4's peer set ("Cannot read properties of null
 * (reading 'edgesOut')").
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    restoreMocks: true,
  },
});
