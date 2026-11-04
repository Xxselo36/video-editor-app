// Where a tile of Projects opens (ProjectTile openHref, PR2 "tiles open
// the Vorschau"): every project with something to show opens on its
// Vorschau, whose Feinschliff opens the editor; an upload and an expired
// project open nothing (their tile has its own buttons, or none).
import { describe, expect, it } from "vitest";
import { openHref } from "./ProjectTile";
import type { Project, ProjectState } from "./projects";

const tile = (state: ProjectState) => ({ id: "j1", state }) as Project;

describe("openHref", () => {
  it("opens the Vorschau of a project being analysed, ready, edited, exporting, exported or failed", () => {
    for (const state of ["processing", "ready", "edited", "exporting", "exported", "failed"] as const) {
      expect(openHref(tile(state)), state).toBe("/app/p/j1");
    }
  });

  it("opens nothing for an upload (running or stopped), an unknown or an expired project", () => {
    for (const state of ["uploading", "upload_failed", "unknown", "expired"] as const) {
      expect(openHref(tile(state)), state).toBeNull();
    }
  });
});
