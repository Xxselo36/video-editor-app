/**
 * UX10: cuts made in the text, end to end through the pure parts the
 * editor wires together — the caption source leaves cut words out, and
 * one undo order covers text edits (doc store) and cuts / timeline edits
 * (the clip history), as the shell does with EditOrder.
 */
import { describe, expect, it } from "vitest";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { removedRanges } from "@/features/editor/v2/model";
import { EditOrder, type Area } from "@/features/editor/v2/editOrder";
import { aiCutsOf, cutWords, exportCaptionSource, labelRemoved, reorderBreaks, restoreKind, restoreWord } from "./cuts";
import { captionSource, captionUnits, editWord, hideWords, type DocWord, type EditDoc } from "./doc";
import { commit, initHistory, redo, undo, type History } from "./history";
import { createDocStore } from "./store";

const W = (id: string, text: string, start: number, end: number, x: Partial<DocWord> = {}): DocWord => ({
  id,
  text,
  start,
  end,
  ...x,
});

const words: DocWord[] = [
  W("w1", "Nobody", 0.0, 0.34),
  W("w2", "waits", 0.37, 0.66),
  W("w3", "ten", 0.95, 1.1),
  W("w4", "seconds.", 1.12, 1.5),
  W("w5", "I", 2.0, 2.1, { cut: "filler" }),
  W("w6", "I", 2.2, 2.3),
  W("w7", "mean", 2.35, 2.6),
  W("w8", "really", 3.4, 3.7, { nospeech: true }),
  W("w9", "it.", 4.2, 4.5),
];
const D = 5;
const midIn = (ranges: { start: number; end: number }[]) => (w: DocWord) =>
  ranges.some((r) => r.start <= (w.start + w.end) / 2 && (w.start + w.end) / 2 <= r.end);
const unitText = (ws: DocWord[], segs: EditorSeg[]) =>
  captionUnits(ws, midIn(removedRanges(segs, D))).map((u) => u.text);

describe("captions follow the clips", () => {
  // the analysis cut 1.9–2.15 (a repeat) and 3.0–4.1 (a pause with a word Whisper heard)
  const analysis: EditorSeg[] = [
    { id: "a", start: 0, end: 1.9 },
    { id: "b", start: 2.15, end: 3.0 },
    { id: "c", start: 4.1, end: 5 },
  ];

  it("a cut word is neither captioned nor glued across", () => {
    const cut = cutWords(analysis, words, 2, 2, D);
    expect(unitText(words, cut)).toEqual(["Nobody", "waits", "seconds.", "I mean", "it."]);
    // the glue (≤ 3 characters takes the next word) never spans the cut
    expect(unitText(words, analysis)).toEqual(["Nobody", "waits", "ten seconds.", "I mean", "it."]);
  });

  it("restoring a cut repeat or extending over a pause brings their captions back", () => {
    // the repeat: restore the word → "I I mean"
    const back = restoreWord(analysis, words[4], D);
    expect(unitText(words, back)).toEqual(["Nobody", "waits", "ten seconds.", "I I", "mean", "it."]);
    // the trim of clip b's end over the pause word (what the dock commits)
    const longer = analysis.map((s) => (s.id === "b" ? { ...s, end: 4.1 } : s));
    expect(unitText(words, longer)).toContain("really");
    expect(unitText(words, analysis)).not.toContain("really");
  });

  it("the caption source drops cut words from both the phrases and the units", () => {
    const cut = cutWords(analysis, words, 2, 2, D);
    const src = captionSource(words, midIn(removedRanges(cut, D)));
    expect(src.units.map((u) => u.text).join(" ")).not.toContain("ten");
    expect(src.phrases.map((p) => p.text).join(" ")).not.toContain("ten");
    // without cuts: as before (UX8)
    expect(captionSource(words)).toEqual(captionSource(words, () => false));
  });

  it("restore all AI cuts brings every analysis cut back", () => {
    const ai = aiCutsOf(
      [
        { id: 0, start: 1.9, end: 2.15, kind: "filler" },
        { id: 1, start: 3.0, end: 4.1, kind: "silence" },
      ],
      words,
    );
    const pieces = labelRemoved(removedRanges(analysis, D), ai);
    const all = restoreKind(analysis, pieces, "ai", D);
    expect(removedRanges(all, D)).toEqual([]);
    expect(unitText(words, all)).toContain("really");
  });
});

describe("no caption unit glued across a reorder boundary (review 15)", () => {
  // "is" (4.70–4.90) glues "big" (5.00–5.30): split at 5.0, B played first
  const ws: DocWord[] = [
    W("x1", "This", 4.2, 4.6),
    W("x2", "is", 4.7, 4.9),
    W("x3", "big", 5.0, 5.3),
    W("x4", "news.", 5.4, 5.9),
  ];
  const A: EditorSeg = { id: "A", start: 0, end: 5 };
  const B: EditorSeg = { id: "B", start: 5, end: 10 };
  const texts = (segs: EditorSeg[]) => exportCaptionSource(ws, removedRanges(segs, 10), segs).units.map((u) => u.text);

  it("source order: glued as before; reordered: split at the boundary", () => {
    expect(reorderBreaks([A, B])).toEqual([]);
    expect(texts([A, B])).toEqual(["This", "is big", "news."]);
    expect(exportCaptionSource(ws, [], [A, B])).toEqual(captionSource(ws));
    expect(reorderBreaks([B, A])).toEqual([5]);
    const out = texts([B, A]);
    expect(out).not.toContain("is big");
    expect(out).toEqual(["This", "is", "big news."]);
  });

  it("cuts only (a list in source order) never adds a break", () => {
    const cut = [
      { id: "a", start: 0, end: 4.65 },
      { id: "b", start: 4.95, end: 10 },
    ];
    expect(reorderBreaks(cut)).toEqual([]);
    // a split moved to the end of three pieces: breaks where the play order jumps
    const P = { id: "p", start: 0, end: 3 };
    const Q = { id: "q", start: 3, end: 6 };
    const R = { id: "r", start: 6, end: 9 };
    expect(reorderBreaks([P, R, Q])).toEqual([3, 6]);
  });
});

describe("one undo order for text and timeline (UX10)", () => {
  /** The shell's wiring: the doc store + a clip history + EditOrder. */
  function shell(doc: EditDoc, segs: EditorSeg[]) {
    const store = createDocStore(doc);
    let tl: History<EditorSeg[]> = initHistory(segs);
    const order = new EditOrder();
    const applyDoc = (op: (d: EditDoc) => EditDoc) => {
      if (store.apply(op)) order.record("doc");
    };
    const commitTl = (next: EditorSeg[]) => {
      if (next === tl.present) return;
      tl = commit(tl, next);
      order.record("tl");
    };
    const step = (kind: "undo" | "redo") => {
      const can = (a: Area) =>
        a === "doc"
          ? (kind === "undo" ? store.getState().past : store.getState().future).length > 0
          : (kind === "undo" ? tl.past : tl.future).length > 0;
      const area = order.take(kind, can);
      if (area === "doc") (kind === "undo" ? store.undo : store.redo)();
      else if (area === "tl") tl = kind === "undo" ? undo(tl) : redo(tl);
      return area;
    };
    return { store, segs: () => tl.present, applyDoc, commitTl, step };
  }

  it("undoes text, cut, hide and bulk restore in reverse order, and redoes them", () => {
    const doc: EditDoc = {
      v: 2,
      language: "en",
      words,
      clips: null,
      style: { presetId: "power", overrides: {} },
      format: { aspect: "9:16" },
      rev: 0,
    };
    const start: EditorSeg[] = [
      { id: "a", start: 0, end: 1.9 },
      { id: "b", start: 2.15, end: 5 },
    ];
    const s = shell(doc, start);
    s.applyDoc((d) => editWord(d, "w1", "Noone")); // 1 text
    s.commitTl(cutWords(s.segs(), words, 2, 3, D)); // 2 cut "ten seconds."
    s.applyDoc((d) => hideWords(d, ["w9"], true)); // 3 hide
    const pieces = labelRemoved(removedRanges(s.segs(), D), aiCutsOf([{ id: 0, start: 1.9, end: 2.15, kind: "filler" }], words));
    s.commitTl(restoreKind(s.segs(), pieces, "filler", D)); // 4 bulk restore: ONE step
    const afterAll = { segs: s.segs(), doc: s.store.getState().present };
    expect(removedRanges(afterAll.segs, D).map((r) => [r.start, r.end])).toEqual([[0.95, 1.5]]);

    expect(s.step("undo")).toBe("tl"); // 4
    expect(removedRanges(s.segs(), D).length).toBe(2);
    expect(s.step("undo")).toBe("doc"); // 3
    expect(s.store.getState().present.words[8].hidden).toBeUndefined();
    expect(s.step("undo")).toBe("tl"); // 2
    expect(s.segs()).toEqual(start);
    expect(s.step("undo")).toBe("doc"); // 1
    expect(s.store.getState().present.words[0].text).toBe("Nobody");
    expect(s.step("undo")).toBeNull();

    for (const want of ["doc", "tl", "doc", "tl"]) expect(s.step("redo")).toBe(want);
    expect(s.segs()).toEqual(afterAll.segs);
    expect(s.store.getState().present).toBe(afterAll.doc);
  });
});
