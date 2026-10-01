import { describe, expect, it } from "vitest";
import { diffWords, editWord, hideWords, mergeWords, setBreak, type DocWord, type EditDoc } from "./doc";
import { DocSaver, PATCH_LIMIT, patchBodies, renameWords, serverIds, type DocSaveState, type PatchBody } from "./docSave";

function docOf(n: number, text = (i: number) => `word${i}`): EditDoc {
  return {
    v: 2,
    language: "en",
    words: Array.from({ length: n }, (_, i) => ({
      id: `w${String(i + 1).padStart(4, "0")}`,
      text: text(i),
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    })),
    clips: null,
    style: { presetId: "power", overrides: {} },
    format: { aspect: "9:16" },
    rev: 0,
  };
}

/** A fake PATCH /jobs/{id}/doc with the server's revision rule and merge. */
function fakeServer(doc: EditDoc) {
  const srv = {
    words: doc.words,
    rev: 0,
    bodies: [] as PatchBody[],
    fail: null as null | "net" | 500 | 409 | 400 | "lost",
    /** The next request never answers (and never reaches the server). */
    hold: false,
    inits: [] as RequestInit[],
  };
  const fetch = async (_path: string, init: RequestInit & { unloading?: boolean }) => {
    srv.inits.push(init);
    if (srv.hold) {
      srv.hold = false;
      return new Promise<Response>(() => undefined);
    }
    const body = JSON.parse(String(init.body)) as PatchBody;
    srv.bodies.push(body);
    if (srv.fail === "net") throw new TypeError("offline");
    if (srv.fail === 500) return new Response("{}", { status: 500 });
    if (srv.fail === 400) return new Response(JSON.stringify({ detail: "bad_word" }), { status: 400 });
    if (srv.fail === 409 || body.base_rev !== srv.rev || body.rev <= srv.rev)
      return new Response(JSON.stringify({ detail: "stale_rev", rev: srv.rev }), { status: 409 });
    if (body.words) srv.words = mergeWords(srv.words, body.words.upsert, body.words.delete);
    for (let i = 1; i < srv.words.length; i++) if (srv.words[i].start < srv.words[i - 1].start) throw new Error("words_not_monotonic");
    srv.rev = body.rev;
    if (srv.fail === "lost") {
      // committed, but the answer never arrives (a drop, a proxy 502)
      srv.fail = null;
      throw new TypeError("connection reset");
    }
    return new Response(JSON.stringify({ rev: body.rev }), { status: 200 });
  };
  return { srv, fetch };
}

function timers() {
  const q: { fn: () => void; ms: number; id: number }[] = [];
  let n = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      q.push({ fn, ms, id: ++n });
      return n;
    },
    clearTimer: (h: unknown) => {
      const i = q.findIndex((t) => t.id === h);
      if (i >= 0) q.splice(i, 1);
    },
    /** Run every pending timer (and what they schedule) once. */
    async tick() {
      const now = q.splice(0);
      for (const t of now) t.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
    get pending() {
      return q.map((t) => t.ms);
    },
  };
}

/** nextRev null: the saver's default (unique revs). */
function setup(doc = docOf(8), nextRev: ((b: number) => number) | null = (b) => b + 1) {
  const { srv, fetch } = fakeServer(doc);
  const tm = timers();
  const states: DocSaveState[] = [];
  let present = doc;
  const saver = new DocSaver(doc, 0, {
    jobId: "j1",
    fetch,
    onState: (s) => states.push(s),
    onRename: (map) => {
      present = { ...present, words: renameWords(present.words, map) };
    },
    setTimer: tm.setTimer,
    clearTimer: tm.clearTimer,
    nextRev: nextRev ?? undefined,
  });
  const edit = (op: (d: EditDoc) => EditDoc) => {
    present = op(present);
    saver.schedule(present);
  };
  return { srv, tm, states, saver, edit, get present() {
    return present;
  } };
}

describe("DocSaver", () => {
  it("debounces edits into one PATCH with the rev rule", async () => {
    const t = setup();
    t.edit((d) => editWord(d, "w0002", "two"));
    t.edit((d) => hideWords(d, ["w0003"], true));
    expect(t.tm.pending).toEqual([800]);
    expect(t.saver.status).toBe("saving");
    await t.tm.tick();
    expect(t.srv.bodies).toHaveLength(1);
    expect(t.srv.bodies[0]).toMatchObject({ base_rev: 0, rev: 1 });
    expect(t.srv.bodies[0].words!.upsert.map((w) => w.id)).toEqual(["w0002", "w0003"]);
    expect(t.srv.bodies[0].style).toBeUndefined();
    expect(t.saver.status).toBe("saved");
    expect(t.srv.words.map((w) => w.text)).toEqual(t.present.words.map((w) => w.text));
    // a second edit builds on rev 1
    t.edit((d) => setBreak(d, "w0005", true));
    await t.tm.tick();
    expect(t.srv.bodies[1]).toMatchObject({ base_rev: 1, rev: 2 });
    expect(t.srv.bodies[1].words!.upsert).toHaveLength(1);
  });

  it("409 stale_rev: conflict, autosave stops, nothing more is sent", async () => {
    const t = setup();
    t.srv.rev = 5; // another tab saved
    t.edit((d) => editWord(d, "w0002", "two"));
    await t.tm.tick();
    expect(t.saver.status).toBe("conflict");
    t.edit((d) => editWord(d, "w0003", "three"));
    await t.tm.tick();
    await t.saver.flush();
    expect(t.saver.flushUnload()).toBe(false);
    expect(t.srv.bodies).toHaveLength(1);
    // reload: a fresh doc, saving again
    t.saver.reset(docOf(8), 5);
    expect(t.saver.status).toBe("saved");
    t.saver.schedule(editWord(docOf(8), "w0001", "one"));
    await t.tm.tick();
    expect(t.srv.bodies[1]).toMatchObject({ base_rev: 5, rev: 6 });
  });

  it("a committed PATCH whose answer was lost: the retry's 409 is our own write, not a conflict", async () => {
    const t = setup(docOf(8), null); // unique revs (the default)
    t.srv.fail = "lost";
    t.edit((d) => editWord(d, "w0002", "two"));
    await t.tm.tick();
    expect(t.saver.status).toBe("retrying");
    const first = t.srv.bodies[0];
    t.edit((d) => editWord(d, "w0004", "four")); // typed meanwhile
    await t.tm.tick(); // the retry: same body (same rev) → 409 with that rev
    expect(t.srv.bodies[1]).toEqual(first);
    await t.tm.tick(); // then the rest
    expect(t.saver.status).toBe("saved");
    expect(t.srv.words.map((w) => w.text)).toEqual(t.present.words.map((w) => w.text));
    expect(t.srv.bodies.map((b) => b.rev > 1e15)).toEqual(t.srv.bodies.map(() => true));
  });

  it("unique revs: another tab's save on the same base is still a conflict", async () => {
    const t = setup(docOf(8), null);
    t.srv.rev = 1700000000000123; // another tab, also built on rev 0
    t.edit((d) => editWord(d, "w0002", "two"));
    await t.tm.tick();
    expect(t.saver.status).toBe("conflict");
  });

  it("network error: retrying with backoff, then saved", async () => {
    const t = setup();
    t.srv.fail = "net";
    t.edit((d) => editWord(d, "w0002", "two"));
    await t.tm.tick();
    expect(t.saver.status).toBe("retrying");
    expect(t.tm.pending).toEqual([1000]);
    await t.tm.tick();
    expect(t.tm.pending).toEqual([2000]);
    t.srv.fail = null;
    await t.tm.tick();
    expect(t.saver.status).toBe("saved");
    expect(t.srv.rev).toBe(1);
  });

  it("other refusals: failed; Retry (flush) sends again", async () => {
    const t = setup();
    t.srv.fail = 400;
    t.edit((d) => editWord(d, "w0002", "two"));
    await t.tm.tick();
    expect(t.saver.status).toBe("failed");
    t.srv.fail = null;
    await t.saver.flush();
    expect(t.saver.status).toBe("saved");
  });

  it("unload: one keepalive PATCH under 64 KB carrying everything the server is known not to have", async () => {
    const t = setup();
    t.srv.hold = true; // the debounced PATCH never leaves the page (aborted on unload)
    t.edit((d) => editWord(d, "w0002", "two"));
    void t.tm.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    t.edit((d) => editWord(d, "w0004", "four"));
    expect(t.saver.flushUnload()).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const last = t.srv.inits[t.srv.inits.length - 1];
    expect(last.keepalive).toBe(true);
    expect(new TextEncoder().encode(String(last.body)).length).toBeLessThan(64 * 1024);
    const body = t.srv.bodies[t.srv.bodies.length - 1];
    expect(body).toMatchObject({ base_rev: 0, rev: 1 });
    expect(body.words!.upsert.map((w) => w.id)).toEqual(["w0002", "w0004"]);
    // both edits reached the server although the in-flight one never did
    expect(t.srv.rev).toBe(1);
    expect(t.srv.words.map((w) => w.text)).toEqual(t.present.words.map((w) => w.text));
  });

  it("unload right after the debounce fired: no double send", async () => {
    const t = setup();
    t.edit((d) => editWord(d, "w0002", "two"));
    void t.tm.tick();
    expect(t.saver.flushUnload()).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.srv.bodies).toHaveLength(1);
    expect(t.saver.status).toBe("saved");
  });

  it("a big change goes as several PATCHes, each under the limit", async () => {
    const big = docOf(3000, (i) => `w${i}`);
    const t = setup(big);
    t.edit((d) => ({ ...d, words: d.words.map((w) => ({ ...w, text: `${w.text}-edited-text` })) }));
    await t.tm.tick();
    expect(t.srv.bodies.length).toBeGreaterThan(1);
    for (const b of t.srv.bodies) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(PATCH_LIMIT);
    expect(t.srv.bodies.map((b) => b.rev)).toEqual(t.srv.bodies.map((_, i) => i + 1));
    expect(t.srv.words.map((w) => w.text)).toEqual(t.present.words.map((w) => w.text));
    expect(t.saver.status).toBe("saved");
  });

  it("style and format changes are sent alone", () => {
    const d = docOf(3);
    const s = { words: d.words, style: d.style, format: d.format, rev: 0 };
    expect(patchBodies(s, { ...d, style: { presetId: "mega", overrides: {} } })).toEqual([{ style: { presetId: "mega", overrides: {} } }]);
    expect(patchBodies(s, d)).toEqual([]);
  });
});

describe("serverIds: the server's merge puts every word where the editor has it", () => {
  it("random edit sequences (orphaned splits, long chains) stay in order", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const vocab = ["a", "bb", "ccc", "the", "x.", "Why?", "ok"];
    for (let round = 0; round < 400; round++) {
      const d0 = docOf(10, (i) => vocab[i % vocab.length]);
      let d = d0;
      const pool = new Set<string>();
      for (let k = 0; k < 12; k++) {
        if (!d.words.length) break;
        const i = Math.floor(rnd() * d.words.length);
        const n = Math.floor(rnd() * 4);
        const text = Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" ");
        const kind = rnd();
        if (kind < 0.75) d = editWord(d, d.words[i].id, text, pool);
        else if (kind < 0.9) d = hideWords(d, [d.words[i].id], true);
        else d = setBreak(d, d.words[i].id, true);
      }
      const map = serverIds(d0.words, d.words, pool);
      const words = renameWords(d.words, map);
      for (const w of words) expect(w.id.length).toBeLessThanOrEqual(40);
      expect(new Set(words.map((w) => w.id)).size).toBe(words.length);
      const p = diffWords(d0.words, words);
      const merged = mergeWords(d0.words, p.upsert, p.delete);
      expect(merged.map((w: DocWord) => w.id), `round ${round}`).toEqual(words.map((w) => w.id));
    }
  });

  it("keeps ids that are already right", () => {
    const d0 = docOf(3);
    const d = editWord(d0, "w0002", "two more");
    expect(serverIds(d0.words, d.words).size).toBe(0);
  });
});
