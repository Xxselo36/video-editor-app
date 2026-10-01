/**
 * Per-caption keys follow the words (UT5 review 2/3/10): renames by the
 * autosave, hides, deletes and merges never strand a caption's own
 * position / size on a word that isn't drawn.
 */
import { describe, expect, it } from "vitest";
import { editWord, hideWords, type EditDoc } from "@/features/editor/state/doc";
import { DocSaver } from "@/features/editor/state/docSave";
import { createDocStore } from "@/features/editor/state/store";
import { adjustedWordIds, followCaptionKeys, renameCaptionKeys } from "./adjusted";

const word = (id: string, text: string, start: number, extra = {}) => ({ id, text, start, end: start + 0.3, ...extra });

function doc(captions: Record<string, unknown> = {}): EditDoc {
  return {
    v: 2,
    language: "en",
    words: [
      word("w0001", "Hello", 0),
      word("w0002", "there.", 0.4),
      word("w0003", "So", 1.0),
      word("w0004", "today", 1.4),
      word("w0005", "we", 1.8),
      word("w0006", "start.", 2.2),
    ],
    clips: null,
    style: { presetId: "power", overrides: { y: 0.6, captions } },
    format: { aspect: "9:16" },
    rev: 0,
  };
}
const keys = (d: EditDoc) => [...adjustedWordIds(d.style.overrides)];
/** An op as the editor applies it: the op, then the keys follow. */
const run = (d: EditDoc, op: (d: EditDoc) => EditDoc) => {
  const n = op(d);
  return n === d ? d : followCaptionKeys(d, n);
};

describe("keys follow renames (review 2)", () => {
  it("renameCaptionKeys moves a key to the new id, else is a no-op", () => {
    const s = doc({ w0003: { y: 0.3 } }).style;
    expect(renameCaptionKeys(s, new Map([["w0003", "w0002.1"]])).overrides.captions).toEqual({ "w0002.1": { y: 0.3 } });
    expect(renameCaptionKeys(s, new Map([["w0009", "x"]]))).toBe(s);
  });

  it("the store's rename moves the key", () => {
    const store = createDocStore(doc({ w0003: { y: 0.3 } }));
    store.rename(new Map([["w0003", "w0002.1"]]));
    expect(keys(store.getState().present)).toEqual(["w0002.1"]);
  });

  it("the autosave renames an unsaved first word: the PATCH and the editor carry the key with it", async () => {
    const d = doc({ w0003: { y: 0.3 } });
    const store = createDocStore(d);
    // the server doesn't have w0003 (deleted and saved, then restored by undo)
    const server = { ...d, words: d.words.filter((w) => w.id !== "w0003"), style: { presetId: "power", overrides: { y: 0.6 } } };
    const sent: { style?: { overrides: { captions?: Record<string, unknown> } }; words?: { upsert: { id: string }[] } }[] = [];
    const saver = new DocSaver(server, 0, {
      jobId: "j",
      fetch: async (_p, init) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ rev: 1 }), { status: 200 });
      },
      setTimer: () => 0,
      clearTimer: () => {},
      onRename: (map) => store.rename(map),
    });
    saver.schedule(store.getState().present);
    await saver.flush();
    expect(sent.length).toBe(1);
    const renamed = sent[0].words!.upsert.map((w) => w.id);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).not.toBe("w0003");
    expect(Object.keys(sent[0].style!.overrides.captions!)).toEqual(renamed);
    expect(keys(store.getState().present)).toEqual(renamed);
  });
});

describe("keys follow hides, deletes and merges (review 3/10)", () => {
  it("hiding the first word moves the key to the caption's next shown word", () => {
    const d = run(doc({ w0003: { y: 0.3 } }), (x) => hideWords(x, ["w0003"], true));
    expect(d.style.overrides.captions).toEqual({ w0004: { y: 0.3 } });
    expect(d.style.overrides.y).toBe(0.6); // the rest of the style is untouched
  });

  it("deleting it (its text cleared) does the same", () => {
    const d = run(doc({ w0003: { sizeScale: 1.2 } }), (x) => editWord(x, "w0003", ""));
    expect(keys(d)).toEqual(["w0004"]);
  });

  it("merging it into the next word keeps the caption's values", () => {
    const d = run(doc({ w0003: { y: 0.3 } }), (x) => editWord(x, "w0003", ""));
    const merged = run(d, (x) => editWord(x, "w0004", "Sotoday"));
    expect(keys(merged)).toHaveLength(1);
    expect(merged.words.find((w) => w.id === keys(merged)[0])?.text).toBe("Sotoday");
  });

  it("a caption gone with its word (sentence end) drops its key; an adjusted neighbour wins", () => {
    // "there." ends the sentence: its caption doesn't continue into "So"
    const gone = run(doc({ w0002: { y: 0.3 } }), (x) => hideWords(x, ["w0002"], true));
    expect(keys(gone)).toEqual([]);
    // the next word already starts another adjusted caption: it keeps its own
    const both = run(doc({ w0003: { y: 0.3 }, w0004: { y: 0.8 } }), (x) => hideWords(x, ["w0003"], true));
    expect(both.style.overrides.captions).toEqual({ w0004: { y: 0.8 } });
  });

  it("no stale key is left to win later: un-hiding doesn't bring the old value back", () => {
    const hidden = run(doc({ w0003: { y: 0.3 } }), (x) => hideWords(x, ["w0003"], true));
    // the user re-adjusts the caption (now starting at "today")
    const readjusted = { ...hidden, style: { ...hidden.style, overrides: { ...hidden.style.overrides, captions: { w0004: { y: 0.5 } } } } };
    const shown = run(readjusted, (x) => hideWords(x, ["w0003"], false));
    expect(shown.style.overrides.captions).toEqual({ w0004: { y: 0.5 } });
  });

  it("a change that doesn't touch keyed words keeps the doc's style object", () => {
    const d = doc({ w0003: { y: 0.3 } });
    const n = run(d, (x) => editWord(x, "w0005", "they"));
    expect(n.style).toBe(d.style);
  });
});
