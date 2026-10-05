// Backlog #20: which footage brought back has no words (useSpanFill),
// and how a server-made change of words joins the doc (DocSaver
// exclusive / adopt, DocStore.addWords).
import { describe, expect, it } from "vitest";
import { mergeWords, type DocWord, type EditDoc } from "@/features/editor/state/doc";
import { DocSaver, type PatchBody } from "@/features/editor/state/docSave";
import { createDocStore } from "@/features/editor/state/store";
import { addedRanges, keptRanges, wordlessSpans } from "./useSpanFill";

const w = (id: string, start: number, end: number, extra: Partial<DocWord> = {}): DocWord => ({ id, text: id, start, end, ...extra });

describe("keptRanges / addedRanges", () => {
  it("merges the clips and gives what a change brought back", () => {
    const before = keptRanges([
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 5, end: 8 },
      { id: "x", start: 2, end: 3, disabled: true },
    ]);
    expect(before).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 8 },
    ]);
    // restore the gap 2–5, extend the end to 9
    const after = keptRanges([
      { id: "a", start: 0, end: 2 },
      { id: "c", start: 2, end: 5 },
      { id: "b", start: 5, end: 9 },
    ]);
    expect(addedRanges(before, after)).toEqual([
      { start: 2, end: 5 },
      { start: 8, end: 9 },
    ]);
    // a trim inward brings nothing back
    expect(addedRanges(after, before)).toEqual([]);
  });
});

describe("wordlessSpans", () => {
  const words = [w("a", 0, 0.5), w("b", 2.2, 2.6), w("h", 3.0, 3.4, { hidden: true, nospeech: true }), w("c", 4.6, 5)];
  it("finds the parts of ≥ 0.5 s without words; a hidden hallucination is no text", () => {
    expect(wordlessSpans([{ start: 0, end: 5 }], words)).toEqual([
      { start: 0.5, end: 2.2 },
      { start: 2.6, end: 4.6 },
    ]);
  });
  it("skips short gaps and splits long ones into ≤ maxSpan pieces", () => {
    expect(wordlessSpans([{ start: 2.6, end: 3.0 }], words)).toEqual([]);
    const long = wordlessSpans([{ start: 10, end: 130 }], [], 0.5, 55);
    expect(long).toHaveLength(3);
    expect(long[0].start).toBe(10);
    expect(long[2].end).toBe(130);
    expect(Math.max(...long.map((r) => r.end - r.start))).toBeLessThanOrEqual(55);
  });
});

function docOf(words: DocWord[]): EditDoc {
  return { v: 2, language: "en", words, clips: null, style: { presetId: "power", overrides: {} }, format: { aspect: "9:16" }, rev: 0 };
}

describe("a transcribed span joins the doc", () => {
  it("DocStore.addWords: in every history state, no undo step", () => {
    const store = createDocStore(docOf([w("w1", 0, 1), w("w2", 5, 6)]));
    store.apply((d) => ({ ...d, words: d.words.map((x) => (x.id === "w1" ? { ...x, text: "Hi" } : x)) }));
    store.addWords([w("t2000", 2, 2.5)]);
    const st = store.getState();
    expect(st.present.words.map((x) => x.id)).toEqual(["w1", "t2000", "w2"]);
    expect(st.past[0].words.map((x) => x.id)).toEqual(["w1", "t2000", "w2"]);
    store.undo();
    expect(store.getState().present.words.map((x) => x.id)).toEqual(["w1", "t2000", "w2"]);
    expect(store.getState().present.words[0].text).toBe("w1");
  });

  it("DocSaver: serialised with the PATCHes; the adopted rev is the next base, the words are never deleted", async () => {
    const doc = docOf([w("w1", 0, 1), w("w2", 5, 6)]);
    const bodies: PatchBody[] = [];
    let srvRev = 0;
    let srvWords = doc.words;
    const timers: (() => void)[] = [];
    const saver = new DocSaver(doc, 0, {
      jobId: "j",
      fetch: async (_p, init) => {
        const body = JSON.parse(String(init.body)) as PatchBody;
        bodies.push(body);
        if (body.base_rev !== srvRev) return new Response(JSON.stringify({ detail: "stale_rev", rev: srvRev }), { status: 409 });
        if (body.words) srvWords = mergeWords(srvWords, body.words.upsert, body.words.delete);
        srvRev = body.rev;
        return new Response("{}", { status: 200 });
      },
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
      nextRev: (b) => b + 1,
    });
    const store = createDocStore(doc);
    store.onEdit = (d) => saver.schedule(d);
    let seenBase = -1;
    const added = [w("t2000", 2, 2.5)];
    const run = saver.exclusive(async (base) => {
      seenBase = base;
      // the server merges the words and takes rev 100
      srvWords = mergeWords(srvWords, added, []);
      srvRev = 100;
      saver.adopt(added, 100);
      store.addWords(added);
      return "words";
    });
    // an edit while the span is out
    store.apply((d) => ({ ...d, words: d.words.map((x) => (x.id === "w2" ? { ...x, text: "two" } : x)) }));
    expect(await run).toBe("words");
    expect(seenBase).toBe(0);
    timers.shift()?.();
    await saver.settle();
    expect(saver.status).toBe("saved");
    expect(bodies.at(-1)?.base_rev).toBe(100);
    expect(bodies.flatMap((b) => b.words?.delete ?? [])).toEqual([]);
    expect(srvWords.map((x) => `${x.id}:${x.text}`)).toEqual(["w1:w1", "t2000:t2000", "w2:two"]);
  });
});
