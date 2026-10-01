// /app?job=<id> (the editor's URL before UX5) → /app/edit/<id>, keeping
// the v2 editor's per-browser switch (?editor=v1|v2, editor/v2/flag).
import { describe, expect, it } from "vitest";
import { legacyJobRedirect } from "./DashboardPage";

describe("legacyJobRedirect", () => {
  it("sends an old editor link to the editor route", () => {
    expect(legacyJobRedirect("?job=abc123")).toBe("/app/edit/abc123");
    expect(legacyJobRedirect("")).toBeNull();
    expect(legacyJobRedirect("?job=../x")).toBeNull();
  });

  it("keeps ?editor=v1|v2", () => {
    expect(legacyJobRedirect("?job=abc&editor=v2")).toBe("/app/edit/abc?editor=v2");
    expect(legacyJobRedirect("?editor=v1&job=abc")).toBe("/app/edit/abc?editor=v1");
    expect(legacyJobRedirect("?job=abc&editor=v9")).toBe("/app/edit/abc");
  });
});
