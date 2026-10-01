import { describe, expect, it } from "vitest";
import { editWord, hideWords, setStyle, type EditDoc } from "./doc";
import { commit, initHistory, redo, undo } from "./history";
import { createDocStore } from "./store";

const doc: EditDoc = {
  v: 2,
  language: "en",
  words: [
    { id: "a", text: "one", start: 0, end: 1 },
    { id: "b", text: "two", start: 1, end: 2 },
  ],
  clips: null,
  style: { presetId: "power", overrides: {} },
  format: { aspect: "9:16" },
  rev: 0,
};

describe("history", () => {
  it("undo / redo round-trip; a new commit drops the redo stack", () => {
    let h = initHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = redo(h);
    expect(h.present).toBe(3);
    h = undo(undo(h));
    expect(h.present).toBe(1);
    expect(undo(h)).toBe(h);
    h = commit(h, 9);
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });

  it("coalesces rapid commits with the same key", () => {
    let h = initHistory(0);
    h = commit(h, 1, "drag", 1000);
    h = commit(h, 2, "drag", 1200);
    h = commit(h, 3, "drag", 1400);
    expect(h.past).toEqual([0]);
    h = commit(h, 4, "drag", 5000);
    expect(h.past).toEqual([0, 3]);
    expect(commit(h, h.present)).toBe(h);
  });
});

describe("doc store", () => {
  it("one undo step per op across words and style; onEdit after each", () => {
    const s = createDocStore(doc);
    const seen: EditDoc[] = [];
    s.onEdit = (d) => seen.push(d);
    expect(s.apply((d) => editWord(d, "a", "uno"))).toBe(true);
    expect(s.apply((d) => editWord(d, "a", "uno"))).toBe(false); // no change, no step
    s.apply((d) => hideWords(d, ["b"], true));
    s.apply((d) => setStyle(d, { presetId: "mega", overrides: {} }));
    expect(s.getState().past).toHaveLength(3);
    s.undo();
    expect(s.getState().present.style.presetId).toBe("power");
    s.undo();
    s.undo();
    expect(s.getState().present).toBe(doc);
    s.redo();
    expect(s.getState().present.words[0].text).toBe("uno");
    expect(seen).toHaveLength(7);
  });

  it("rename and reset are not undo steps and don't trigger the autosave", () => {
    const s = createDocStore(doc);
    let edits = 0;
    s.onEdit = () => edits++;
    const seen: string[] = [];
    const off = s.onRenamed((m) => seen.push(...m.values()));
    s.rename(new Map([["a", "a.1"]]));
    expect(s.getState().present.words[0].id).toBe("a.1");
    expect(seen).toEqual(["a.1"]);
    off();
    expect(s.getState().past).toHaveLength(0);
    s.reset(doc);
    expect(s.getState().present).toBe(doc);
    expect(edits).toBe(0);
  });
});
