// The Vorschau tab (plan D15): the Vorschau last opened in this tab
// unless a newer project came since, else the newest with something to
// show; nothing to show: none.
import { describe, expect, it } from "vitest";
import type { ProjectState } from "@/features/jobs/projects";
import { parseLastPreview, pickPreview } from "./pickPreview";

const p = (id: string, state: ProjectState, createdAt: number, startedAt: number | null = null) => ({ id, state, createdAt, startedAt });

describe("pickPreview", () => {
  it("opens the newest project with something to show", () => {
    const list = [p("a", "exported", 100), p("b", "ready", 300), p("c", "edited", 200)];
    expect(pickPreview(list, null)).toBe("b");
  });

  it("counts a project being edited or exported, never an upload, a failed or an expired one", () => {
    expect(pickPreview([p("a", "exported", 100), p("b", "processing", 200)], null)).toBe("b");
    expect(pickPreview([p("a", "exported", 100), p("b", "exporting", 200)], null)).toBe("b");
    for (const state of ["uploading", "upload_failed", "failed", "expired", "unknown"] as const) {
      expect(pickPreview([p("a", "exported", 100), p("b", state, 200)], null), state).toBe("a");
    }
    expect(pickPreview([p("b", "failed", 200)], null)).toBeNull();
    expect(pickPreview([], null)).toBeNull();
  });

  it("opens the one last opened in this tab, unless a newer project came since", () => {
    const list = [p("a", "exported", 100), p("b", "ready", 300)];
    expect(pickPreview(list, { id: "a", at: 400 })).toBe("a");
    // b came after a was opened.
    expect(pickPreview(list, { id: "a", at: 200 })).toBe("b");
    // The last one is gone (deleted, expired) or has nothing to show.
    expect(pickPreview(list, { id: "x", at: 400 })).toBe("b");
    expect(pickPreview([p("a", "failed", 100), p("b", "ready", 50)], { id: "a", at: 400 })).toBe("b");
  });

  it("a video picked before that Vorschau was opened came when its job was made", () => {
    // b picked at 150, a's Vorschau opened at 300, "Los geht's" at 500.
    const list = [p("a", "exported", 100), p("b", "processing", 150, 500)];
    expect(pickPreview(list, { id: "a", at: 300 })).toBe("b");
    // Made before it was opened: a stays.
    expect(pickPreview([p("a", "exported", 100), p("b", "ready", 150, 250)], { id: "a", at: 300 })).toBe("a");
    // Several came since: the one that came last, not the one picked last.
    const two = [p("a", "exported", 100), p("b", "ready", 150, 700), p("c", "processing", 400, 600)];
    expect(pickPreview(two, { id: "a", at: 300 })).toBe("b");
  });

  it("reads only a stored entry of its own shape", () => {
    expect(parseLastPreview(JSON.stringify({ id: "a", at: 5 }))).toEqual({ id: "a", at: 5 });
    expect(parseLastPreview(null)).toBeNull();
    expect(parseLastPreview("{")).toBeNull();
    expect(parseLastPreview(JSON.stringify({ id: "", at: 5 }))).toBeNull();
    expect(parseLastPreview(JSON.stringify({ id: "a" }))).toBeNull();
    expect(parseLastPreview("null")).toBeNull();
  });
});
