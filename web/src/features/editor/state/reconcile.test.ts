import { describe, expect, it } from "vitest";
import { captionSource, type DocWord, type EditDoc } from "./doc";
import { reconcileV1, v1IsNewer } from "./reconcile";

const W = (id: string, text: string, start: number, end: number, extra: Partial<DocWord> = {}): DocWord => ({
  id,
  text,
  start,
  end,
  ...extra,
});
const docOf = (words: DocWord[]): EditDoc => ({
  v: 2,
  language: "en",
  words,
  clips: null,
  style: { presetId: "power", overrides: {} },
  format: { aspect: "9:16" },
  rev: 0,
});
const doc = () =>
  docOf([
    W("w1", "Nobody", 0, 0.4),
    W("w2", "waits", 0.4, 0.8),
    W("w3", "ten", 0.8, 1.1),
    W("w4", "seconds.", 1.1, 1.6),
    W("w5", "uh,", 1.7, 1.9, { filler: true, hidden: true }),
    W("w6", "Mistake", 2.0, 2.4),
    W("w7", "number", 2.4, 2.7),
    W("w8", "two.", 2.7, 3.0),
    W("w9", "Follow", 4.0, 4.4),
    W("w10", "me.", 4.4, 4.8),
  ]);
const P = (s: number, e: number, text: string) => ({ start: s, end: e, original_start: s, original_end: e, text });
const MS = 1_759_300_000_000;

describe("v1 sentence edits into the doc", () => {
  it("applies a newer v1 edit: changed words take the text, timings of the rest stay", () => {
    const v1 = { phrases: [P(0, 1.6, "Nobody waits 10 seconds."), P(2.0, 3.0, "Mistake number two."), P(4.0, 4.8, "Follow me.")], rev: MS };
    const n = reconcileV1(doc(), 0, v1);
    expect(n.words.map((w) => w.text)).toEqual(["Nobody", "waits", "10", "seconds.", "uh,", "Mistake", "number", "two.", "Follow", "me."]);
    expect(n.words[2]).toMatchObject({ id: "w3", start: 0.8, end: 1.1 });
    expect(n.words[0]).toMatchObject({ id: "w1", text: "Nobody", start: 0, end: 0.4 });
  });

  it("a sentence deleted in v1 is hidden from the captions; fillers stay as they were", () => {
    const v1 = { phrases: [P(0, 1.6, "Nobody waits ten seconds."), P(4.0, 4.8, "Follow me.")], rev: MS };
    const n = reconcileV1(doc(), 0, v1);
    expect(n.words.filter((w) => w.hidden).map((w) => w.id)).toEqual(["w5", "w6", "w7", "w8"]);
    expect(captionSource(n.words).phrases.map((p) => p.text)).toEqual(["Nobody waits ten seconds.", "Follow me."]);
  });

  it("a sentence across a hidden filler: the filler keeps its place", () => {
    const v1 = { phrases: [P(0, 3.0, "Nobody waits. Mistake two."), P(4.0, 4.8, "Follow me.")], rev: MS };
    const n = reconcileV1(doc(), 0, v1);
    expect(n.words.map((w) => w.text).join(" ")).toBe("Nobody waits. uh, Mistake two. Follow me.");
    for (let i = 1; i < n.words.length; i++) expect(n.words[i].start).toBeGreaterThanOrEqual(n.words[i - 1].start);
  });

  it("only when the v1 save is newer than the doc; v2's own /phrases change nothing", () => {
    const v1 = { phrases: [P(0, 1.6, "Nobody waits 10 seconds.")], rev: MS };
    const d = doc();
    expect(v1IsNewer(v1, MS * 1000 + 5)).toBe(false);
    expect(reconcileV1(d, MS * 1000 + 5, v1)).toBe(d);
    expect(reconcileV1(d, 0, null)).toBe(d);
    expect(reconcileV1(d, 0, { phrases: null, rev: 0 })).toBe(d);
    // sentences equal to the doc's captions (what v2 writes after an edit)
    const own = { phrases: captionSource(d.words).phrases, rev: MS };
    expect(reconcileV1(d, 0, own)).toBe(d);
  });

  it("v2's own copy of touching sentences is a no-op on every reopen (owner: words re-timed, re-id'd, then lost)", () => {
    // a sentence ends where a short first word of the next one starts:
    // its middle is within EPS of the sentence end
    const d = docOf([
      W("w1", "Das", 12.9, 13.2),
      W("w2", "ist", 13.2, 13.6),
      W("w3", "fertig.", 13.6, 14.2),
      W("w4", "so", 14.2, 14.28),
      W("w5", "weiter", 14.28, 14.9),
      W("w6", "geht's.", 14.9, 15.4),
    ]);
    let cur = d;
    for (let round = 0; round < 3; round++) {
      const copy = { phrases: captionSource(cur.words).phrases, rev: MS + round };
      const n = reconcileV1(cur, 0, copy);
      expect(n).toBe(cur);
      cur = n;
    }
  });

  it("a real v1 edit next to touching sentences: the short first word stays in its own sentence", () => {
    const d = docOf([
      W("w1", "Das", 12.9, 13.2),
      W("w2", "ist", 13.2, 13.6),
      W("w3", "fertig.", 13.6, 14.2),
      W("w4", "so", 14.2, 14.28),
      W("w5", "weiter", 14.28, 14.9),
      W("w6", "geht's.", 14.9, 15.4),
    ]);
    const v1 = { phrases: [P(12.9, 14.2, "Das ist fertig."), P(14.2, 15.4, "so weiter geht es.")], rev: MS };
    const n = reconcileV1(d, 0, v1);
    expect(n.words.map((w) => w.text)).toEqual(["Das", "ist", "fertig.", "so", "weiter", "geht", "es."]);
    // the untouched words keep their ids and times
    expect(n.words.slice(0, 5)).toEqual(d.words.slice(0, 5));
    expect(n.words.some((w) => w.hidden)).toBe(false);
  });

  it("overlapping Whisper words: a sentence ends at its latest word, so the copy covers every word", () => {
    // "lang" (stretched by Whisper) ends after the sentence's last word
    const d = docOf([
      W("w1", "Ein", 1.0, 1.2),
      W("w2", "lang", 1.2, 4.0),
      W("w3", "Wort.", 1.5, 1.9),
      W("w4", "Und", 5.0, 5.3),
      W("w5", "weiter.", 5.3, 5.8),
    ]);
    const src = captionSource(d.words).phrases;
    expect(src[0].original_end).toBe(4.0);
    expect(reconcileV1(d, 0, { phrases: src, rev: MS })).toBe(d);
    // an older copy that ended the sentence at its last word: no word is lost either
    const old = src.map((p, i) => (i === 0 ? { ...p, original_end: 1.9 } : p));
    const n = reconcileV1(d, 0, { phrases: old, rev: MS });
    expect(n.words.filter((w) => w.hidden)).toEqual([]);
    expect(n.words.map((w) => w.id)).toEqual(d.words.map((w) => w.id));
  });
});

