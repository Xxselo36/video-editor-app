// Backlog #20: which footage brought back has no words (useSpanFill),
// and how a server-made change of words joins the doc (DocSaver
// exclusive / adopt, DocStore.addWords).
import { describe, expect, it } from "vitest";
import { mergeWords, type DocWord, type EditDoc } from "@/features/editor/state/doc";
import { DocSaver, type PatchBody } from "@/features/editor/state/docSave";
import { createDocStore } from "@/features/editor/state/store";
import type { Piece } from "@/features/editor/state/cuts";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import type { SpanResult } from "./useDocSession";
import {
  addedRanges,
  coalesceSpans,
  INTENT_MS,
  keptRanges,
  planSpans,
  SpanFiller,
  wordlessSpans,
  type SpanMark,
} from "./useSpanFill";

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

// ── when the editor asks (no flood on a bulk restore) ────────────────

describe("planSpans: which revealed spans are worth a request", () => {
  const words = [w("a", 0, 1), w("b", 10, 11), w("g", 6.1, 6.6, { hidden: true, nospeech: true })];
  it("skips a short silence, keeps a long one, a filler and one with a hidden hallucination", () => {
    const pieces: Piece[] = [
      { start: 1, end: 2, kind: "silence" }, // 1 s: skipped
      { start: 3, end: 5, kind: "silence" }, // 2 s: asked
      { start: 6, end: 6.8, kind: "silence" }, // short, but Whisper heard something
      { start: 8, end: 8.7, kind: "filler" },
    ];
    // the likely speech first: the hallucination's and the filler's, then the long pause
    expect(planSpans(pieces, words, pieces)).toEqual([
      { start: 6, end: 6.8 },
      { start: 8, end: 8.7 },
      { start: 3, end: 5 },
    ]);
  });
  it("coalesces spans < 1 s apart with no word between, up to the cap", () => {
    expect(coalesceSpans([{ start: 2, end: 3 }, { start: 3.5, end: 4.5 }], [])).toEqual([{ start: 2, end: 4.5 }]);
    // a word between: two requests (the server answers a span with words from the doc)
    expect(coalesceSpans([{ start: 2, end: 3 }, { start: 3.5, end: 4.5 }], [w("x", 3.1, 3.4)])).toHaveLength(2);
    expect(coalesceSpans([{ start: 0, end: 59 }, { start: 59.5, end: 61 }], [])).toHaveLength(2);
  });
});

/** Clips 0–2, 5–8, 12–20; removed 2–5 and 8–12 (pauses). */
const SEGS: EditorSeg[] = [
  { id: "a", start: 0, end: 2 },
  { id: "b", start: 5, end: 8 },
  { id: "c", start: 12, end: 20 },
];
const PIECES: Piece[] = [
  { start: 2, end: 5, kind: "silence" },
  { start: 8, end: 12, kind: "silence" },
];
const WORDS = [w("w1", 0.2, 1.8), w("w2", 5.2, 7.8), w("w3", 12.2, 19.8)];
/** The seam whose gap is a..b restored (the clips around it become one). */
const restoreGap = (segs: EditorSeg[], a: number, b: number): EditorSeg[] => {
  const before = segs.find((s) => Math.abs(s.end - a) < 1e-6)!;
  const after = segs.find((s) => Math.abs(s.start - b) < 1e-6)!;
  return segs.filter((s) => s !== after).map((s) => (s === before ? { ...s, end: after.end } : s));
};

function filler(results: SpanResult[]) {
  const calls: [number, number][] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let marks: SpanMark[] = [];
  let t = 1000;
  const f = new SpanFiller({
    onMarks: (m) => (marks = m),
    setTimer: (fn, ms) => {
      const h = { fn, ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => void timers.splice(timers.indexOf(h as (typeof timers)[number]), 1),
    now: () => t,
  });
  f.setTranscribe(async (s, e) => {
    calls.push([s, e]);
    return results.shift() ?? "words";
  });
  f.update(SEGS, PIECES, WORDS);
  return { f, calls, timers, marks: () => marks, tick: (ms: number) => (t += ms) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("SpanFiller: one deliberate action asks, a bulk restore doesn't", () => {
  it("bulk restore (Restore all pauses): no request at all", async () => {
    const x = filler([]);
    x.f.update(restoreGap(restoreGap(SEGS, 8, 12), 2, 5), [], WORDS);
    await settle();
    expect(x.calls).toEqual([]);
    expect(x.marks()).toEqual([]);
  });

  it("one seam restored: one request for its gap, then the chip goes", async () => {
    const x = filler(["words"]);
    const next = restoreGap(SEGS, 8, 12);
    x.f.note();
    x.f.update(next, [PIECES[0]], WORDS);
    expect(x.marks().map((m) => m.state)).toEqual(["busy"]);
    await settle();
    expect(x.calls).toEqual([[8, 12]]);
    expect(x.marks()).toEqual([]);
    // the same clips seen again (a re-render, the new words): nothing more
    x.f.update(next, [PIECES[0]], [...WORDS, w("t8000", 8.1, 8.5)]);
    await settle();
    expect(x.calls).toHaveLength(1);
  });

  it("an undo (no note) and a stale note ask nothing", async () => {
    const x = filler([]);
    x.f.note();
    x.tick(INTENT_MS + 1);
    x.f.update(restoreGap(SEGS, 8, 12), [PIECES[0]], WORDS);
    await settle();
    expect(x.calls).toEqual([]);
  });

  it("429: the queue waits for Retry-After, the span is no error, then it is asked again", async () => {
    const x = filler([{ later: 30_000 }, "words"]);
    x.f.note();
    x.f.update(restoreGap(SEGS, 8, 12), [PIECES[0]], WORDS);
    await settle();
    expect(x.calls).toHaveLength(1);
    expect(x.marks().map((m) => m.state)).toEqual(["busy"]); // no retry chip
    expect(x.timers.map((h) => h.ms)).toEqual([30_000]);
    // nothing goes out meanwhile, not even a newly revealed span
    x.f.note();
    x.f.update(restoreGap(restoreGap(SEGS, 8, 12), 2, 5), [], WORDS);
    await settle();
    expect(x.calls).toHaveLength(1);
    x.timers.shift()!.fn();
    await settle();
    await settle();
    expect(x.calls).toEqual([
      [8, 12],
      [8, 12],
      [2, 5],
    ]);
    expect(x.marks()).toEqual([]);
  });

  it("a failure: one quiet retry chip; its retry brings the words", async () => {
    const x = filler(["error", "error", "words"]);
    x.f.note();
    x.f.update(restoreGap(SEGS, 8, 12), [PIECES[0]], WORDS);
    await settle();
    expect(x.marks()).toEqual([{ start: 8, end: 12, key: "8.000-12.000", state: "failed" }]);
    x.f.retry("8.000-12.000");
    await settle();
    expect(x.marks().map((m) => m.state)).toEqual(["failed"]); // still one chip
    x.f.retry("8.000-12.000");
    await settle();
    expect(x.marks()).toEqual([]);
    expect(x.calls).toHaveLength(3);
  });
});

describe("DocSaver.exclusive while a PATCH waits for its retry", () => {
  function saverWith(down: () => boolean) {
    const doc = docOf([w("w1", 0, 1), w("w2", 5, 6)]);
    let srvRev = 0;
    const timers: (() => void)[] = [];
    const saver = new DocSaver(doc, 0, {
      jobId: "j",
      fetch: async (_p, init) => {
        const body = JSON.parse(String(init.body)) as PatchBody;
        if (down()) throw new TypeError("offline");
        if (body.base_rev !== srvRev) return new Response(JSON.stringify({ detail: "stale_rev", rev: srvRev }), { status: 409 });
        srvRev = body.rev;
        return new Response("{}", { status: 200 });
      },
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
      nextRev: (b) => b + 1,
    });
    const edit = { ...doc, words: doc.words.map((x) => (x.id === "w1" ? { ...x, text: "one" } : x)) };
    return { saver, edit, timers, rev: () => srvRev };
  }

  it("sends the retry first, then runs on the rev the server has (no false conflict)", async () => {
    let down = true;
    const x = saverWith(() => down);
    x.saver.schedule(x.edit);
    x.timers.shift()!(); // the debounce
    await x.saver.settle(1);
    expect(x.saver.status).toBe("retrying");
    down = false;
    let base = -1;
    const out = await x.saver.exclusive(async (b) => {
      base = b;
      return "ran";
    });
    expect(out).toBe("ran");
    expect(base).toBe(1);
    expect(x.rev()).toBe(1);
    expect(x.saver.status).toBe("saved");
  });

  it("still offline: busy, and nothing is sent for the span", async () => {
    const x = saverWith(() => true);
    x.saver.schedule(x.edit);
    x.timers.shift()!();
    await x.saver.settle(1);
    let ran = false;
    const out = await x.saver.exclusive(async () => {
      ran = true;
      return "ran";
    });
    expect(out).toBe("busy");
    expect(ran).toBe(false);
    expect(x.saver.status).toBe("retrying");
  });
});
