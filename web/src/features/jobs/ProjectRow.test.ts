// Where a row of Projekte leads (ProjectRow openHref, plan D17): a project
// with something to show opens its Vorschau, whose Feinschliff opens the
// editor; one Cleo still works on, an upload and an expired project lead
// nowhere (the busy row is grey; an upload's row has its own buttons).
import { describe, expect, it } from "vitest";
import { openHref } from "./ProjectRow";
import type { Project, ProjectState } from "./projects";

const row = (state: ProjectState) => ({ id: "j1", state }) as Project;

describe("openHref", () => {
  it("opens the Vorschau of a project ready, edited, exporting, exported or failed", () => {
    for (const state of ["ready", "edited", "exporting", "exported", "failed"] as const) {
      expect(openHref(row(state)), state).toBe("/app/p/j1");
    }
  });

  it("opens nothing while Cleo works on it, for an upload (running or stopped), an unknown or an expired project", () => {
    for (const state of ["processing", "uploading", "upload_failed", "unknown", "expired"] as const) {
      expect(openHref(row(state)), state).toBeNull();
    }
  });
});
