// ESLint (flat config) — Next 16 removed `next lint`; run `npm run lint`.
// eslint-config-next brings the Next, React and React Hooks rule sets
// (core-web-vitals turns the performance rules into errors) and the
// TypeScript rules.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Findings that existed when linting was introduced (UX1, 2026-09-30).
// They are warnings in these files only — fixing them needs refactors
// (UX4 splits app/app/page.tsx; the billing views follow UX14). New
// files get the rules as errors. Remove an entry once its file is clean.
const LEGACY_FILES = [
  "src/app/app/page.tsx",
  "src/app/app/library/page.tsx",
  "src/components/billing/AccountView.tsx",
  "src/components/billing/PricingView.tsx",
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: LEGACY_FILES,
    rules: {
      // React Compiler rules of eslint-plugin-react-hooks 7
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Test output.
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
  ]),
]);
