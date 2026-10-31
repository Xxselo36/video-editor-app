// A percentage the way the UI language writes it ({pct} in messages).
import { describe, expect, it } from "vitest";
import { formatPct } from "./percent";

describe("formatPct", () => {
  it("writes the sign and the space the language uses", () => {
    expect(formatPct(42, "en")).toBe("42%");
    // A no-break space: the sign never wraps onto a line of its own.
    expect(formatPct(42, "de")).toMatch(/^42[  ]%$/);
    expect(formatPct(42, "tr")).toBe("%42");
  });

  it("rounds to a whole percent", () => {
    expect(formatPct(41.6, "en")).toBe("42%");
    expect(formatPct(0.4, "en")).toBe("0%");
    expect(formatPct(100, "en")).toBe("100%");
  });

  it("falls back to the plain number when Intl refuses the language tag", () => {
    expect(formatPct(41.6, "not a language")).toBe("42%");
  });
});
