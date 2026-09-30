/**
 * Suites for known bugs that a later package fixes are `test.fixme`
 * (skipped) until then. E2E_RUN_FIXME=1 runs them anyway — they should
 * fail until the fix lands; the fixing package removes the marker.
 */
export const SKIP_KNOWN_BUGS = process.env.E2E_RUN_FIXME !== "1";
