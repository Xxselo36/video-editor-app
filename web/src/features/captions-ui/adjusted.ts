/**
 * Ids of the words whose caption has its own position or size (UT5: the
 * keys of the doc style's overrides.captions). No engine import: the Text
 * tab marks their rows with it.
 */
export function adjustedWordIds(overrides: Record<string, unknown> | null | undefined): ReadonlySet<string> {
  const c = overrides?.captions;
  return new Set(c && typeof c === "object" && !Array.isArray(c) ? Object.keys(c) : []);
}
