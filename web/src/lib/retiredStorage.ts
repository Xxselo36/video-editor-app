/**
 * localStorage keys that older builds wrote and nothing needs any more.
 * AppFlags removes them on every /app page, so they leave the devices
 * that still have them:
 * - cleocuts.exports.v1: the post-export survey's log (export ids, the
 *   time of the last answer). The survey counts in page memory now
 *   (features/project/exportsInfo).
 * - cleocuts.voiceOnboardingSeen.v1: "the voice test was closed". Nothing
 *   has read it since the start screens stopped offering the test on
 *   their own.
 */
export const RETIRED_KEYS = ["cleocuts.exports.v1", "cleocuts.voiceOnboardingSeen.v1"] as const;

export function dropRetiredKeys(): void {
  for (const key of RETIRED_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage blocked: there is nothing to remove */
    }
  }
}
