import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captionSource,
  diffWords,
  editRange,
  editWord,
  findMatches,
  hideWords,
  mergeWords,
  replaceMatches,
  rowsOf,
  setBreak,
  setFormat,
  setStyle,
  wordAt,
  type DocWord,
  type EditDoc,
} from "./doc";
import { applyTextEdit } from "./textEdit";

const W = (id: string, text: string, start: number, end: number, extra: Partial<DocWord> = {}): DocWord => ({
  id,
  text,
  start,
  end,
  ...extra,
});

function docOf(words: DocWord[]): EditDoc {
  return {
    v: 2,
    language: "en",
    words,
    clips: null,
    style: { presetId: "power", overrides: {} },
    format: { aspect: "9:16" },
    rev: 0,
  };
}

const base = () =>
  docOf([
    W("w0001", "Nobody", 0, 0.4),
    W("w0002", "waits", 0.4, 0.8, { conf: 0.9 }),
    W("w0003", "ten", 0.8, 1.1),
    W("w0004", "seconds.", 1.1, 1.6),
    W("w0005", "Mistake", 2.0, 2.4),
    W("w0006", "number", 2.4, 2.7),
    W("w0007", "two.", 2.7, 3.0),
  ]);

type Vector = { name: string; words: DocWord[]; text: string; taken?: string[]; expected: DocWord[] };
const vectors: { vectors: Vector[] } = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../../testdata/text_edit_vectors.json"), "utf8"),
);

describe("editWord", () => {
  it("changes only the edited word: the timing of every other token stays", () => {
    const d = base();
    const n = editWord(d, "w0003", "10");
    expect(n.words.map((w) => w.text).join(" ")).toBe("Nobody waits 10 seconds. Mistake number two.");
    n.words.forEach((w, i) => {
      expect(w.start).toBe(d.words[i].start);
      expect(w.end).toBe(d.words[i].end);
      expect(w.id).toBe(d.words[i].id);
    });
    // untouched words are the same objects (structural sharing)
    expect(n.words[0]).toBe(d.words[0]);
    expect(n.words[6]).toBe(d.words[6]);
    expect(d.words[2].text).toBe("ten");
  });

  it("returns the same doc when nothing changed", () => {
    const d = base();
    expect(editWord(d, "w0003", "ten")).toBe(d);
    expect(editWord(d, "w0003", "  ten ")).toBe(d);
    expect(editWord(d, "nope", "x")).toBe(d);
  });

  it("typed extra words split the word's time; ids <parent>.<k>", () => {
    const n = editWord(base(), "w0003", "ten whole");
    const i = n.words.findIndex((w) => w.id === "w0003");
    expect(n.words[i].text).toBe("ten");
    expect(n.words[i + 1]).toMatchObject({ id: "w0003.1", text: "whole" });
    expect(n.words[i].start).toBe(0.8);
    expect(n.words[i + 1].end).toBe(1.1);
    expect(n.words[i].end).toBe(n.words[i + 1].start);
  });

  it("an emptied word goes and its time joins the word before it", () => {
    const n = editWord(base(), "w0003", "");
    expect(n.words.map((w) => w.id)).not.toContain("w0003");
    const prev = n.words.find((w) => w.id === "w0002")!;
    expect(prev.end).toBe(1.1);
    // the first word: its time joins the word after it
    const m = editWord(base(), "w0001", "");
    expect(m.words[0]).toMatchObject({ id: "w0002", start: 0 });
  });

  it("keeps the flags of the edited word", () => {
    const d = docOf([W("a", "uh", 0, 0.3, { filler: true, hidden: true }), W("b", "so", 0.3, 0.6, { breakBefore: true })]);
    const n = editWord(d, "b", "So");
    expect(n.words[1]).toMatchObject({ id: "b", text: "So", breakBefore: true });
    const m = editWord(d, "a", "um");
    expect(m.words[0]).toMatchObject({ id: "a", text: "um", filler: true, hidden: true });
  });

  it("never reuses an id from the pool (words the server may still have)", () => {
    const pool = new Set(["w0003.1"]);
    const n = editWord(base(), "w0003", "ten whole", pool);
    expect(n.words.map((w) => w.id)).toContain("w0003.2");
    expect(pool.has("w0003.2")).toBe(true);
  });

  it("editRange on a lone span equals applyTextEdit (shared text edit vectors)", () => {
    for (const v of vectors.vectors) {
      if (!v.words.length) continue;
      const d = docOf(v.words);
      const n = editRange(d, 0, v.words.length - 1, v.text, new Set(v.taken ?? []));
      // without neighbours, editRange is exactly applyTextEdit
      const direct = applyTextEdit(v.words, v.text, v.taken ?? []);
      if (n === d) expect(direct.map((w) => w.text)).toEqual(v.words.map((w) => w.text));
      else expect(n.words, v.name).toEqual(direct);
      expect(direct.map((w) => w.id), v.name).toEqual(v.expected.map((w) => w.id));
    }
  });
});

describe("hideWords / setBreak / style / format", () => {
  it("hides and shows words", () => {
    const d = base();
    const n = hideWords(d, ["w0002", "w0003"], true);
    expect(n.words.filter((w) => w.hidden).map((w) => w.id)).toEqual(["w0002", "w0003"]);
    expect(n.words[0]).toBe(d.words[0]);
    expect(hideWords(n, ["w0002", "w0003"], true)).toBe(n);
    const s = hideWords(n, ["w0002"], false);
    expect(s.words[1].hidden).toBeUndefined();
    expect("hidden" in s.words[1]).toBe(false);
  });

  it("sets and clears a forced break", () => {
    const n = setBreak(base(), "w0003", true);
    expect(n.words[2].breakBefore).toBe(true);
    expect(setBreak(n, "w0003", true)).toBe(n);
    expect("breakBefore" in setBreak(n, "w0003", false).words[2]).toBe(false);
  });

  it("style and format: same doc when equal", () => {
    const d = base();
    expect(setStyle(d, { presetId: "power", overrides: {} })).toBe(d);
    expect(setStyle(d, { presetId: "mega", overrides: {} }).style.presetId).toBe("mega");
    expect(setFormat(d, { aspect: "9:16" })).toBe(d);
    expect(setFormat(d, { aspect: "16:9" }).format.aspect).toBe("16:9");
  });
});

describe("rows and caption source", () => {
  it("rows follow sentences, long pauses and forced breaks", () => {
    expect(rowsOf(base().words)).toEqual([
      { first: 0, last: 3 },
      { first: 4, last: 6 },
    ]);
    const b = setBreak(base(), "w0003", true);
    expect(rowsOf(b.words)).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 3 },
      { first: 4, last: 6 },
    ]);
    const gap = docOf([W("a", "a", 0, 1), W("b", "b", 3, 4)]);
    expect(rowsOf(gap.words)).toHaveLength(2);
    expect(rowsOf([])).toEqual([]);
    const many = docOf(Array.from({ length: 50 }, (_, i) => W(`w${i}`, "x", i * 0.1, i * 0.1 + 0.1)));
    expect(rowsOf(many.words, 24).map((r) => r.last - r.first + 1)).toEqual([24, 24, 2]);
  });

  it("captions skip hidden words and break at forced breaks", () => {
    let d = hideWords(base(), ["w0002"], true);
    d = setBreak(d, "w0003", true);
    const { phrases, units } = captionSource(d.words);
    expect(units.map((u) => u.text)).toEqual(["Nobody", "ten", "seconds.", "Mistake", "number", "two."]);
    expect(phrases.map((p) => p.text)).toEqual(["Nobody", "ten seconds.", "Mistake number two."]);
    expect(units[1]).toMatchObject({ original_start: 0.8, original_end: 1.1 });
    expect(phrases[0].original_start).toBe(0);
  });

  it("wordAt finds the word under the playhead", () => {
    const ws = base().words;
    const starts = ws.map((w) => w.start);
    const ends = ws.map((w) => w.end);
    expect(wordAt(starts, ends, 0.85)).toBe(2);
    expect(wordAt(starts, ends, 1.7)).toBe(3); // 0.25 s grace
    expect(wordAt(starts, ends, 1.95)).toBe(-1); // in the pause
    expect(wordAt(starts, ends, -1)).toBe(-1);
  });
});

describe("find & replace", () => {
  const d = docOf([
    W("a", "Mistake", 0, 1),
    W("b", "number", 1, 2),
    W("c", "one:", 2, 3),
    W("d", "mistake", 3, 4),
    W("e", "MISTAKE.", 4, 5),
    W("f", "Number", 5, 6),
  ]);

  it("finds case-insensitively, inside words and across words", () => {
    expect(findMatches(d.words, "mistake").map((m) => [m.first, m.last])).toEqual([
      [0, 0],
      [3, 3],
      [4, 4],
    ]);
    expect(findMatches(d.words, "mistake  number").map((m) => [m.first, m.last])).toEqual([[0, 1]]);
    expect(findMatches(d.words, "take. num")[0]).toMatchObject({ first: 4, last: 5, from: 3, to: 12 });
    expect(findMatches(d.words, "zzz")).toEqual([]);
    expect(findMatches(d.words, "   ")).toEqual([]);
    expect(findMatches(d.words, "(.*)")).toEqual([]); // regex chars are literal
  });

  it("replaces all hits; timings of the rest stay", () => {
    const hits = findMatches(d.words, "mistake");
    const n = replaceMatches(d, hits, "error");
    expect(n.words.map((w) => w.text)).toEqual(["error", "number", "one:", "error", "error.", "Number"]);
    n.words.forEach((w, i) => expect([w.id, w.start, w.end]).toEqual([d.words[i].id, d.words[i].start, d.words[i].end]));
    expect(findMatches(n.words, "mistake")).toEqual([]);
  });

  it("replaces a phrase across words and with nothing", () => {
    const two = replaceMatches(d, findMatches(d.words, "mistake number"), "Fehler");
    expect(two.words.map((w) => w.text)).toEqual(["Fehler", "one:", "mistake", "MISTAKE.", "Number"]);
    const gone = replaceMatches(d, findMatches(d.words, "number"), "");
    expect(gone.words.map((w) => w.text)).toEqual(["Mistake", "one:", "mistake", "MISTAKE."]);
    // a deleted word's time joined its neighbour: nothing is lost
    expect(gone.words[0].end).toBe(2);
    expect(gone.words[3].end).toBe(6);
  });
});

describe("PATCH diff and the server merge", () => {
  it("diff of an edit is the changed words only", () => {
    const d = base();
    const n = hideWords(editWord(d, "w0003", "10 whole"), ["w0005"], true);
    const p = diffWords(d.words, n.words);
    expect(p.upsert.map((w) => w.id)).toEqual(["w0003", "w0003.1", "w0005"]);
    expect(p.delete).toEqual([]);
    expect(diffWords(d.words, d.words)).toEqual({ upsert: [], delete: [] });
  });

  it("merging the diff on the server gives the client's words (random edits)", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const vocab = ["a", "bb", "ccc", "the", "x.", "Why?", "ok"];
    for (let round = 0; round < 200; round++) {
      const words = Array.from({ length: 12 }, (_, i) => W(`w${String(i + 1).padStart(4, "0")}`, vocab[i % vocab.length], i * 0.5, i * 0.5 + 0.4));
      const d0 = docOf(words);
      const pool = new Set<string>();
      let d = d0;
      for (let k = 0; k < 6; k++) {
        if (!d.words.length) break;
        const i = Math.floor(rnd() * d.words.length);
        const kind = rnd();
        const n = Math.floor(rnd() * 3);
        const text = Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" ");
        if (kind < 0.6) d = editWord(d, d.words[i].id, text, pool);
        else if (kind < 0.8) d = hideWords(d, [d.words[i].id], rnd() < 0.5);
        else d = setBreak(d, d.words[i].id, rnd() < 0.5);
      }
      const p = diffWords(d0.words, d.words);
      const merged = mergeWords(d0.words, p.upsert, p.delete);
      expect(merged.map((w) => w.id), `round ${round}`).toEqual(d.words.map((w) => w.id));
      for (let i = 1; i < merged.length; i++) expect(merged[i].start).toBeGreaterThanOrEqual(merged[i - 1].start);
    }
  });
});
