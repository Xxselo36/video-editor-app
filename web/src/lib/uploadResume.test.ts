// Resume records (lib/uploadResume) and the resume of lib/chunkedUpload:
// a re-picked file is found by its content (a new name and a new
// lastModified still match), the record is written before part 1 and
// after every part, lives as long as the server's ticket, and a resume
// sends only the parts the server does NOT list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { path: string; body: Record<string, unknown> };
const calls: Call[] = [];
let answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response> = () =>
  new Response("{}", { status: 500 });

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    return answer(path, body);
  }),
}));

import {
  _useMemoryStoreForTests,
  ABORT_TIMEOUT_MS,
  ACTIVE_MS,
  contentFingerprint,
  discardResumable,
  EXPIRY_MARGIN_MS,
  findRecord,
  findRecordMatch,
  fingerprint,
  heldElsewhere,
  legacyFingerprint,
  LEGACY_TTL_MS,
  listResumable,
  markUploadActive,
  partHash,
  partProbe,
  PROBE_BYTES,
  recordPct,
  type UploadRecord,
} from "@/lib/uploadResume";
import { abortResumable, keepParts, resumableProgress, uploadResumable } from "@/lib/chunkedUpload";
import { stoppedTileShowsError } from "@/features/upload/useResumable";
import { movie, noise } from "./__tests__/mp4Fixtures";

const MIB = 1024 * 1024;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

/** Deterministic bytes (seed → content). */
function content(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}
const fileOf = (bytes: Uint8Array, name: string, lastModified: number) =>
  new File([bytes as BlobPart], name, { type: "video/quicktime", lastModified });

function record(fp: string, over: Partial<UploadRecord> = {}): UploadRecord {
  return {
    v: 2,
    fp,
    name: "IMG_0042.MOV",
    size: 60 * MIB + 12345,
    ticket: "t1",
    storage_key: "uploads/x.mov",
    part_size: 16 * MIB,
    parts_total: 4,
    done: [1, 2],
    created_at: Date.now(),
    // Last written 5 min ago: not running anywhere (no heartbeat).
    updated_at: Date.now() - 5 * 60_000,
    expires_at: Date.now() + 7 * 86400_000,
    ...over,
  };
}

// ── a fake XMLHttpRequest: every PUT "uploads" at once ────────────────
const puts: string[] = [];
/** The bytes of each PUT that went as a buffer (read once, hashed, sent). */
const sent: Uint8Array[] = [];
class FakeXhr {
  status = 0;
  upload: { onprogress?: (e: { loaded: number }) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  private url = "";
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  abort() {
    this.onabort?.();
  }
  send(body: Blob | ArrayBuffer) {
    puts.push(this.url);
    sent.push(new Uint8Array(body instanceof ArrayBuffer ? body.slice(0) : new ArrayBuffer(0)));
    setTimeout(() => {
      this.upload.onprogress?.({ loaded: body instanceof ArrayBuffer ? body.byteLength : body.size });
      this.upload.onload?.();
      this.status = 200;
      this.onload?.();
    }, 0);
  }
}

let store: Map<string, UploadRecord>;
beforeEach(() => {
  store = _useMemoryStoreForTests();
  calls.length = 0;
  puts.length = 0;
  sent.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fingerprint", () => {
  it("matches the same bytes under a new name and a new lastModified", async () => {
    const bytes = content(5 * MIB + 3, 1);
    const a = await fingerprint(fileOf(bytes, "IMG_0042.MOV", 1_700_000_000_000));
    const b = await fingerprint(fileOf(bytes, "trim.0A1B2C3D-4E5F.MOV", 1_800_000_000_000));
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it("doesn't match different content of the same size", async () => {
    const a = await fingerprint(fileOf(content(5 * MIB, 1), "a.mov", 1));
    const head = content(5 * MIB, 1);
    head[10] ^= 1;
    const tail = content(5 * MIB, 1);
    tail[5 * MIB - 10] ^= 1;
    expect(await fingerprint(fileOf(content(5 * MIB, 2), "a.mov", 1))).not.toBe(a);
    expect(await fingerprint(fileOf(head, "a.mov", 1))).not.toBe(a);
    expect(await fingerprint(fileOf(tail, "a.mov", 1))).not.toBe(a);
  });
});

describe("record lifecycle", () => {
  it("finds a record by content; a different file finds none and leaves it", async () => {
    const bytes = content(3 * MIB, 3);
    const fp = (await fingerprint(fileOf(bytes, "x", 0)))!;
    store.set(fp, record(fp, { size: bytes.length, part_size: MIB, parts_total: 3, done: [1] }));
    const again = await findRecord(fileOf(bytes, "renamed.MOV", 99));
    expect(again?.fp).toBe(fp);
    expect(await resumableProgress(fileOf(bytes, "renamed.MOV", 99))).toBe(33);
    expect(await findRecord(fileOf(content(3 * MIB, 4), "x", 0))).toBeNull();
    expect(store.has(fp)).toBe(true);
  });

  it("moves a record of the old key (with the name) to the content key", async () => {
    const bytes = content(2 * MIB + 7, 5);
    const f = fileOf(bytes, "IMG_0042.MOV", 1);
    const old = (await legacyFingerprint(f))!;
    store.set(old, record(old, { v: 1, size: bytes.length, expires_at: undefined }));
    const rec = await findRecord(fileOf(bytes, "IMG_0042.MOV", 2));
    const fp = (await fingerprint(f))!;
    expect(rec?.fp).toBe(fp);
    expect([...store.keys()]).toEqual([fp]);
    // The old key needed the name: a renamed file can't find an old record.
    store.clear();
    store.set(old, record(old, { v: 1, size: bytes.length }));
    expect(await findRecord(fileOf(bytes, "trim.ABC.MOV", 2))).toBeNull();
  });

  it("lives until the ticket's expiry (old records: 23 h), then goes", async () => {
    const now = Date.now();
    store.set("a", record("a", { expires_at: now + 6 * 86400_000 }));
    store.set("b", record("b", { expires_at: now + EXPIRY_MARGIN_MS - 1 }));
    store.set("c", record("c", { expires_at: undefined, created_at: now - LEGACY_TTL_MS + 3600_000 }));
    store.set("d", record("d", { expires_at: undefined, created_at: now - LEGACY_TTL_MS }));
    const list = await listResumable(now);
    expect(list.map((r) => r.fp).sort()).toEqual(["a", "c"]);
    expect([...store.keys()].sort()).toEqual(["a", "c"]);
    expect(list.find((r) => r.fp === "a")?.pct).toBe(53);
  });

  it("doesn't list an upload running in this page", async () => {
    store.set("a", record("a"));
    markUploadActive("a", true);
    expect(await listResumable()).toEqual([]);
    markUploadActive("a", false);
    expect((await listResumable()).map((r) => r.fp)).toEqual(["a"]);
  });

  it("recordPct: completed is 100", () => {
    expect(recordPct(record("a", { completed: true }))).toBe(100);
    expect(recordPct(record("a", { done: [] }))).toBe(0);
  });
});

/** A fake Web Locks manager: `held` are the lock names of every tab. */
function fakeLocks() {
  const held = new Set<string>();
  const locks = {
    async request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<void>) {
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        throw new Error("would wait");
      }
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    },
  };
  vi.stubGlobal("navigator", { userAgent: "test", locks });
  return held;
}

describe("uploads running in another tab", () => {
  it("(Web Locks) aren't listed, and Discard never aborts them", async () => {
    const held = fakeLocks();
    store.set("a", record("a"));
    store.set("b", record("b"));
    held.add("cleocuts-upload:a"); // another tab uploads "a"
    expect((await listResumable()).map((r) => r.fp)).toEqual(["b"]);
    expect(await discardResumable("a")).toBe(false);
    expect(store.has("a")).toBe(true);
    expect(calls.filter((c) => c.path === "/uploads/multipart/abort")).toEqual([]);
    // That tab is gone (closed, reloaded, phone off): the browser drops its lock.
    held.delete("cleocuts-upload:a");
    expect((await listResumable()).map((r) => r.fp).sort()).toEqual(["a", "b"]);
    answer = () => new Response(null, { status: 204 });
    expect(await discardResumable("a")).toBe(true);
    expect(calls.filter((c) => c.path === "/uploads/multipart/abort")).toHaveLength(1);
    expect(store.has("a")).toBe(false);
  });

  it("(Web Locks) this page's upload holds the lock while it runs, and frees it", async () => {
    const held = fakeLocks();
    store.set("a", record("a"));
    markUploadActive("a", true);
    await new Promise((r) => setTimeout(r, 0));
    expect(held.has("cleocuts-upload:a")).toBe(true);
    expect(await discardResumable("a")).toBe(false);
    markUploadActive("a", false);
    // Cancelled here: its own (just released) lock doesn't block the abort.
    answer = () => new Response(null, { status: 204 });
    expect(await discardResumable("a")).toBe(true);
    expect(held.size).toBe(0);
  });

  it("(no Web Locks) a record with a fresh heartbeat counts as running elsewhere", async () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    const now = Date.now();
    store.set("fresh", record("fresh", { updated_at: now - 10_000 }));
    store.set("old", record("old", { updated_at: now - ACTIVE_MS - 1 }));
    expect((await listResumable(now)).map((r) => r.fp)).toEqual(["old"]);
    expect(await discardResumable("fresh")).toBe(false);
    expect(store.has("fresh")).toBe(true);
  });
});

describe("giving an upload up (X, Cancel, Remove, Discard)", () => {
  const size = 3 * MIB + 5;
  const part = MIB;
  const init = (ticket: string, key: string) =>
    json({
      ticket,
      storage_key: key,
      part_size: part,
      parts_total: 4,
      expires_at: Math.floor(Date.now() / 1000) + 86400,
      parts: [1, 2, 3, 4].map((n) => ({ part_number: n, url: `https://r2/${key}?partNumber=${n}` })),
    });
  /** The abort's answer, held until `release()`. */
  function holdAbort(): () => void {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const before = answer;
    answer = async (path, body) => {
      if (path !== "/uploads/multipart/abort") return before(path, body);
      await held;
      return new Response(null, { status: 204 });
    };
    return release;
  }

  it("a stored upload: the same bytes picked while its abort is out start a new upload, never the object being deleted", async () => {
    const bytes = content(size, 41);
    answer = (path) => {
      if (path === "/uploads/multipart/init") return init("tk-a", "uploads/a.mov");
      if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/a.mov", size });
      return json({}, 500);
    };
    expect((await uploadResumable({ file: fileOf(bytes, "IMG_1.MOV", 1) })).storage_key).toBe("uploads/a.mov");
    calls.length = 0;
    const release = holdAbort();
    const giving = abortResumable({ file: fileOf(bytes, "IMG_1.MOV", 1) });
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain("/uploads/multipart/abort"));
    // (An iPhone hands over a new File: a new lastModified.)
    answer = ((before) => async (path: string, body: Record<string, unknown>) => {
      if (path === "/uploads/multipart/init") return init("tk-b", "uploads/b.mov");
      if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/b.mov", size });
      return before(path, body);
    })(answer);
    const again = await uploadResumable({ file: fileOf(bytes, "IMG_1.MOV", 2) });
    expect(again.storage_key).toBe("uploads/b.mov");
    expect(calls.map((c) => c.path)).toContain("/uploads/multipart/init");
    release();
    await giving;
  });

  it("an open upload: the same bytes picked while its abort is out don't resume the ticket being aborted", async () => {
    const bytes = content(size, 42);
    answer = (path) => (path === "/uploads/multipart/init" ? init("tk-c", "uploads/c.mov") : json({}, 500));
    // Parts 1 and 2 go up, then X.
    const ctl = new AbortController();
    const origSend = FakeXhr.prototype.send;
    FakeXhr.prototype.send = function (this: FakeXhr, b: Blob) {
      // Parts 3 and 4 never get an answer.
      if (Number(new URL((this as unknown as { url: string }).url).searchParams.get("partNumber")) >= 3) return;
      return origSend.call(this, b);
    };
    const up = uploadResumable({ file: fileOf(bytes, "IMG_2.MOV", 1), signal: ctl.signal });
    up.catch(() => {});
    try {
      await vi.waitFor(() => expect([...store.values()][0]?.done.sort()).toEqual([1, 2]), { timeout: 4000 });
    } finally {
      ctl.abort();
      await up.catch(() => {});
      FakeXhr.prototype.send = origSend;
    }
    calls.length = 0;
    const release = holdAbort();
    const giving = abortResumable({ file: fileOf(bytes, "IMG_2.MOV", 1) });
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain("/uploads/multipart/abort"));
    answer = ((before) => async (path: string, body: Record<string, unknown>) => {
      if (path === "/uploads/multipart/init") return init("tk-d", "uploads/d.mov");
      if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/d.mov", size });
      return before(path, body);
    })(answer);
    const again = await uploadResumable({ file: fileOf(bytes, "IMG_2.MOV", 2) });
    expect(again.storage_key).toBe("uploads/d.mov");
    expect(calls.filter((c) => c.body.ticket === "tk-c").map((c) => c.path)).toEqual(["/uploads/multipart/abort"]);
    release();
    await giving;
  });

  it("an abort that never answers: the record goes at once, and giving up is over after ABORT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      store.set("hangs", record("hangs"));
      answer = () => new Promise<Response>(() => {});
      let over = false;
      const giving = discardResumable("hangs").then((v) => ((over = true), v));
      for (let i = 0; i < 50 && !calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(calls.map((c) => c.path)).toEqual(["/uploads/multipart/abort"]);
      expect(store.has("hangs")).toBe(false);
      await vi.advanceTimersByTimeAsync(ABORT_TIMEOUT_MS - 100);
      expect(over).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(over).toBe(true);
      await expect(giving).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("completed uploads (all bytes stored, POST /jobs not answered)", () => {
  it("without Web Locks aren't offered (nothing tells one a page still holds), but a re-pick still finds them", async () => {
    const bytes = content(MIB + 1, 21);
    const fp = (await fingerprint(fileOf(bytes, "a", 1)))!;
    store.set(fp, record(fp, { size: bytes.length, completed: true, updated_at: Date.now() - 5 * 60_000 }));
    expect(await listResumable()).toEqual([]);
    expect((await findRecord(fileOf(bytes, "renamed", 2)))?.completed).toBe(true);
  });

  it("(Web Locks) are offered at 100 % once no page holds them; one a start holds (waiting for Let's go) is not, nor given up", async () => {
    const held = fakeLocks();
    store.set("stopped", record("stopped", { completed: true }));
    store.set("waits", record("waits", { completed: true }));
    held.add("cleocuts-upload:waits"); // another tab's start, waiting for "Let's go"
    expect(await listResumable()).toEqual([expect.objectContaining({ fp: "stopped", pct: 100, completed: true })]);
    expect(await discardResumable("waits")).toBe(false);
    expect(store.has("waits")).toBe(true);
    expect(calls).toEqual([]);
    // Held in this page: not offered here either.
    markUploadActive("stopped", true);
    expect(await listResumable()).toEqual([]);
    markUploadActive("stopped", false);
    // A stopped tile's Remove gives it up: the server deletes the object.
    answer = () => new Response(null, { status: 204 });
    expect(await discardResumable("stopped")).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/uploads/multipart/abort"]);
  });
});

describe("the same video picked in a second tab", () => {
  it("(Web Locks) is held there while that tab uploads it or waits for Let's go; not while this page does", async () => {
    const held = fakeLocks();
    const f = fileOf(content(MIB + 3, 23), "zwei.mov", 1);
    const fp = (await fingerprint(f))!;
    expect(await heldElsewhere(f)).toBe(false);
    held.add(`cleocuts-upload:${fp}`);
    expect(await heldElsewhere(fileOf(content(MIB + 3, 23), "IMG_9.MOV", 2))).toBe(true);
    // Other bytes: not held.
    expect(await heldElsewhere(fileOf(content(MIB + 3, 24), "zwei.mov", 1))).toBe(false);
    held.delete(`cleocuts-upload:${fp}`);
    markUploadActive(fp, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(held.has(`cleocuts-upload:${fp}`)).toBe(true);
    expect(await heldElsewhere(f)).toBe(false);
    markUploadActive(fp, false);
  });

  it("(no Web Locks) is held there while its heartbeat is fresh", async () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    const f = fileOf(content(MIB + 5, 25), "puls.mov", 1);
    const fp = (await fingerprint(f))!;
    store.set(fp, record(fp, { size: f.size, updated_at: Date.now() - 10_000 }));
    expect(await heldElsewhere(f)).toBe(true);
    store.set(fp, record(fp, { size: f.size, updated_at: Date.now() - ACTIVE_MS - 1 }));
    expect(await heldElsewhere(f)).toBe(false);
  });
});

describe("stopped tile text", () => {
  it("keeps the real reason after a reload; only the bare interruption gives way to the resume line", () => {
    expect(stoppedTileShowsError("auth_required", true)).toBe(true);
    expect(stoppedTileShowsError("too_many_jobs", true)).toBe(true);
    expect(stoppedTileShowsError("upload_interrupted", true)).toBe(false);
    expect(stoppedTileShowsError("upload_interrupted", false)).toBe(true);
    expect(stoppedTileShowsError(null, false)).toBe(true);
  });
});

describe("uploadResumable", () => {
  const size = 3 * MIB + 5;
  const part = MIB;
  const total = 4;

  it("writes the record before part 1 (with the ticket's expiry) and after every part", async () => {
    const bytes = content(size, 7);
    const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
    const snapshots: number[][] = [];
    answer = (path) => {
      if (path === "/uploads/multipart/init") {
        return json({
          ticket: "tk",
          storage_key: "uploads/k.mov",
          part_size: part,
          parts_total: total,
          expires_at: exp,
          parts: [1, 2, 3, 4].map((n) => ({ part_number: n, url: `https://r2/k?partNumber=${n}` })),
        });
      }
      if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/k.mov", size });
      return json({}, 500);
    };
    const origSend = FakeXhr.prototype.send;
    FakeXhr.prototype.send = function (this: FakeXhr, body: Blob) {
      // What the store holds as each part goes out.
      snapshots.push([...(store.values().next().value?.done ?? [-1])].sort());
      return origSend.call(this, body);
    };
    try {
      const res = await uploadResumable({ file: fileOf(bytes, "IMG_1.MOV", 1) });
      expect(res.storage_key).toBe("uploads/k.mov");
    } finally {
      FakeXhr.prototype.send = origSend;
    }
    // Before the first PUT the record was there (no parts done yet).
    expect(snapshots[0]).toEqual([]);
    const rec = [...store.values()][0];
    expect(rec.v).toBe(2);
    expect(rec.expires_at).toBe(exp * 1000);
    expect(rec.done.sort()).toEqual([1, 2, 3, 4]);
    expect(rec.completed).toBe(true);
    expect(puts).toHaveLength(4);
    // Every part's probe and whole-part hash went in with it (what a
    // re-pick is checked against) …
    const f = fileOf(bytes, "x", 1);
    for (const n of [1, 2, 3, 4]) {
      expect(rec.probes?.[n]).toBe(await partProbe(f, n, part, size, total));
      expect(rec.hashes?.[n]).toBe((await partHash(f, n, part, size, total))?.hash);
      expect(rec.hashes?.[n]).toMatch(/^[0-9a-f]{64}$/);
    }
    // … read once: the bytes hashed are the bytes sent.
    const byPart = new Map(puts.map((u, i) => [Number(new URL(u).searchParams.get("partNumber")), sent[i]]));
    for (const n of [1, 2, 3, 4]) {
      const want = Buffer.from(bytes.subarray((n - 1) * part, Math.min(size, n * part)));
      expect(Buffer.from(byPart.get(n)!).equals(want)).toBe(true);
    }
  });

  it("keeps the picker the file came from (Pick anyway) on the record and in the list", async () => {
    const bytes = content(size, 8);
    answer = (path) => {
      if (path === "/uploads/multipart/init") {
        return json({ ticket: "tk", storage_key: "uploads/k.mov", part_size: part, parts_total: total, parts: [] });
      }
      return json({}, 500);
    };
    const ctl = new AbortController();
    const origSend = FakeXhr.prototype.send;
    FakeXhr.prototype.send = () => {}; // the parts never answer: the upload stops there
    try {
      const up = uploadResumable({ file: fileOf(bytes, "IMG_1.MOV", 1), signal: ctl.signal, source: "any" });
      up.catch(() => {});
      await vi.waitFor(() => expect(store.size).toBe(1));
      ctl.abort();
      await up.catch(() => {});
    } finally {
      FakeXhr.prototype.send = origSend;
    }
    // After a reload: the start screen's card and the tile open the
    // unfiltered picker for it (features/start/videoPicker resumeWithAny).
    expect([...store.values()][0].source).toBe("any");
    expect((await listResumable()).map((r) => r.source)).toEqual(["any"]);
  });

  it("a renamed re-pick resumes from the server's list of parts, never sending a listed part again", async () => {
    const bytes = content(size, 9);
    const first = fileOf(bytes, "IMG_0042.MOV", 1);
    const fp = (await fingerprint(first))!;
    // The local record thinks parts 1 + 2 are done; R2 has 1 and 3
    // (part 2 never arrived, 3 did before the tab died).
    store.set(
      fp,
      record(fp, { size, part_size: part, parts_total: total, done: [1, 2], ticket: "tk", storage_key: "uploads/k.mov" }),
    );
    answer = (path, body) => {
      if (path === "/uploads/multipart/parts") {
        expect(body.ticket).toBe("tk");
        return json({ parts: [{ part_number: 1, size: part }, { part_number: 3, size: part }] });
      }
      if (path === "/uploads/multipart/sign") {
        return json({ parts: (body.part_numbers as number[]).map((n) => ({ part_number: n, url: `https://r2/k?partNumber=${n}` })) });
      }
      if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/k.mov", size });
      return json({}, 500);
    };
    const progress: number[] = [];
    const res = await uploadResumable({
      file: fileOf(bytes, "trim.7D3E.MOV", 2_000_000_000_000),
      onProgress: (p) => progress.push(p),
    });
    expect(res.storage_key).toBe("uploads/k.mov");
    expect(calls.map((c) => c.path)).not.toContain("/uploads/multipart/init");
    expect(calls[0].path).toBe("/uploads/multipart/parts");
    expect(puts.map((u) => Number(new URL(u).searchParams.get("partNumber"))).sort()).toEqual([2, 4]);
    // It started where the SERVER says (2 of 4 parts ≈ 66 % of the bytes), not at 0.
    expect(progress[0]).toBe(Math.floor((2 * part / size) * 100));
    expect(store.get(fp)?.completed).toBe(true);
    // A record from before probes: its parts were trusted as before, and
    // now carry the probes of the file that continued them.
    expect(Object.keys(store.get(fp)?.probes ?? {}).sort()).toEqual(["1", "2", "3", "4"]);
    await res.release?.();
    expect(store.size).toBe(0);
  });

  it("an expired upload (410 from /parts) starts over with a new upload", async () => {
    const bytes = content(size, 11);
    const fp = (await fingerprint(fileOf(bytes, "a", 1)))!;
    store.set(fp, record(fp, { size, part_size: part, parts_total: total, ticket: "old" }));
    answer = (path) => {
      if (path === "/uploads/multipart/parts") return json({ detail: "upload_expired" }, 410);
      if (path === "/uploads/multipart/init") {
        return json({
          ticket: "new",
          storage_key: "uploads/n.mov",
          part_size: part,
          parts_total: total,
          expires_at: Math.floor(Date.now() / 1000) + 3600 * 23,
          parts: [1, 2, 3, 4].map((n) => ({ part_number: n, url: `https://r2/n?partNumber=${n}` })),
        });
      }
      if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/n.mov", size });
      return json({}, 500);
    };
    const res = await uploadResumable({ file: fileOf(bytes, "b", 2) });
    expect(res.storage_key).toBe("uploads/n.mov");
    expect(puts).toHaveLength(4);
    expect(store.get(fp)?.ticket).toBe("new");
  });

  it("a 5xx from /parts (a deploy restarting the backend) is waited out: the record stays, nothing is sent meanwhile", async () => {
    const bytes = content(size, 13);
    const fp = (await fingerprint(fileOf(bytes, "a", 1)))!;
    store.set(fp, record(fp, { size, part_size: part, parts_total: total }));
    answer = () => json({ detail: "storage_error" }, 502);
    const ctl = new AbortController();
    const paused: boolean[] = [];
    const up = uploadResumable({ file: fileOf(bytes, "a", 1), signal: ctl.signal, onPaused: (p) => paused.push(p) });
    up.catch(() => {});
    // Two 502 in a row: "waiting" (the retry after 1 s, then 3 s).
    await vi.waitFor(() => expect(paused).toEqual([true]), { timeout: 4000 });
    expect(store.has(fp)).toBe(true);
    expect(puts).toHaveLength(0);
    expect(calls.filter((c) => c.path === "/uploads/multipart/init")).toHaveLength(0);
    ctl.abort();
    await expect(up).rejects.toMatchObject({ name: "AbortError" });
    expect(store.has(fp)).toBe(true);
  });
});

// ── a re-pick that iOS exported again (2026-10, the owner's picker tests)
//
// Every pick of a video from Photos is a fresh export: the same bytes but
// new creation / modification times in moov (mvhd, tkhd, mdhd), which sits
// in part 1. The upload must continue after a reload all the same, and
// only from parts whose bytes the new copy has too.
describe("a re-pick exported again by iOS", () => {
  const part = 1024 * 1024;
  const total = 4;
  /** 4 parts of 1 MiB: ftyp, moov (with these times), wide, mdat. */
  const video = (created: number, media = noise(3 * part + 1000, 31)) =>
    movie({ media, created, modified: created + 5, sampleSizes: [part, part, part, 1000] });
  const signAll = (path: string, body: Record<string, unknown>) => {
    if (path === "/uploads/multipart/sign") {
      return json({ parts: (body.part_numbers as number[]).map((n) => ({ part_number: n, url: `https://r2/k?partNumber=${n}` })) });
    }
    if (path === "/uploads/multipart/complete") return json({ storage_key: "uploads/k.mov" });
    return null;
  };
  const partsSent = () => puts.map((u) => Number(new URL(u).searchParams.get("partNumber"))).sort();

  /** The first pick's upload, stopped once parts 1 and 2 are in (the
   *  tab reloaded): its record, as the next page finds it. */
  async function stoppedUpload(first: Uint8Array): Promise<UploadRecord> {
    answer = (path, body) => {
      if (path === "/uploads/multipart/init") {
        return json({
          ticket: "tk",
          storage_key: "uploads/k.mov",
          part_size: part,
          parts_total: total,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          parts: [],
        });
      }
      return signAll(path, body) ?? json({}, 500);
    };
    const origSend = FakeXhr.prototype.send;
    FakeXhr.prototype.send = function (this: FakeXhr, b: Blob) {
      // Parts 3 and 4 never get an answer.
      if (Number(new URL((this as unknown as { url: string }).url).searchParams.get("partNumber")) >= 3) return;
      return origSend.call(this, b);
    };
    const ctl = new AbortController();
    const up = uploadResumable({ file: fileOf(first, "IMG_0042.MOV", 1), signal: ctl.signal });
    up.catch(() => {});
    try {
      await vi.waitFor(() => expect([...store.values()][0]?.done.sort()).toEqual([1, 2]), { timeout: 4000 });
    } finally {
      ctl.abort();
      await up.catch(() => {});
      FakeXhr.prototype.send = origSend;
    }
    calls.length = 0;
    puts.length = 0;
    return [...store.values()][0];
  }

  it("finds the record although the moov times differ, and sends only the parts R2 lacks", async () => {
    const first = video(3_900_000_000);
    const again = video(3_911_111_111);
    expect(await contentFingerprint(fileOf(again, "b", 2))).not.toBe(await contentFingerprint(fileOf(first, "a", 1)));
    const rec = await stoppedUpload(first);
    expect(rec.fp).toMatch(/^m1:/);
    expect(Object.keys(rec.probes ?? {}).sort()).toEqual(["1", "2"]);

    const repick = fileOf(again, "trim.5C1D.MOV", 2_000_000_000_000);
    expect((await findRecord(repick))?.fp).toBe(rec.fp);
    answer = (path, body) => {
      if (path === "/uploads/multipart/parts") return json({ parts: [{ part_number: 1, size: part }, { part_number: 2, size: part }] });
      return signAll(path, body) ?? json({}, 500);
    };
    const res = await uploadResumable({ file: repick });
    expect(res.storage_key).toBe("uploads/k.mov");
    expect(calls.map((c) => c.path)).not.toContain("/uploads/multipart/init");
    // Part 1 (with the first pick's moov) stays: same sample tables.
    expect(partsSent()).toEqual([3, 4]);
    expect(calls.find((c) => c.path === "/uploads/telemetry" && c.body.event === "resume")?.body.redo).toBe(0);
  });

  it("sends a part again when the new copy's bytes differ there (same layout, other media)", async () => {
    const rec = await stoppedUpload(video(3_900_000_000));
    // Same size, same sample tables, other media: the same m1 key …
    const other = video(3_900_000_000, noise(3 * part + 1000, 99));
    const repick = fileOf(other, "IMG_0042.MOV", 3);
    expect((await findRecord(repick))?.fp).toBe(rec.fp);
    answer = (path, body) => {
      if (path === "/uploads/multipart/parts") return json({ parts: [{ part_number: 1, size: part }, { part_number: 2, size: part }] });
      return signAll(path, body) ?? json({}, 500);
    };
    await uploadResumable({ file: repick });
    // … but the probes of parts 1 and 2 don't match: everything goes up.
    expect(partsSent()).toEqual([1, 2, 3, 4]);
    expect(calls.find((c) => c.path === "/uploads/telemetry" && c.body.event === "resume")?.body.redo).toBe(2);
  });

  it("keepParts: a part stays only when its whole-part hash matches; without a hash it goes again", async () => {
    const f = fileOf(video(1), "a.mov", 1);
    const d1 = (await partHash(f, 1, part, f.size, total))!;
    const d2 = (await partHash(f, 2, part, f.size, total))!;
    expect(d1.probe).toMatch(/^[0-9a-f]{16}$/);
    expect(d1.probe).toBe(await partProbe(f, 1, part, f.size, total));
    const rec = { part_size: part, parts_total: total };
    // Part 2 has no hash (the tab died before the record's write).
    expect(await keepParts(f, { ...rec, probes: { 1: d1.probe }, hashes: { 1: d1.hash } }, [1, 2])).toEqual({
      done: [1],
      probes: { 1: d1.probe },
      hashes: { 1: d1.hash },
      redo: 1,
    });
    // A hash that doesn't match (whatever the probe says).
    expect(
      await keepParts(f, { ...rec, probes: { 1: d1.probe, 2: d2.probe }, hashes: { 1: d1.hash, 2: "0".repeat(64) } }, [2, 1]),
    ).toMatchObject({ done: [1], redo: 1 });
    // A probe that doesn't match: no need to read the whole part.
    expect(
      await keepParts(f, { ...rec, probes: { 1: d1.probe, 2: "0".repeat(16) }, hashes: { 1: d1.hash, 2: d2.hash } }, [2, 1]),
    ).toMatchObject({ done: [1], redo: 1 });
  });

  it("keepParts: a record from before the hashes keeps its parts when found by raw bytes, none when found by the moov key", async () => {
    const f = fileOf(video(1), "a.mov", 1);
    const d1 = (await partHash(f, 1, part, f.size, total))!;
    const d2 = (await partHash(f, 2, part, f.size, total))!;
    const rec = { part_size: part, parts_total: total };
    // c2 / legacy: the raw first and last 2 MiB matched, as before;
    // the digests come from the file now.
    expect(await keepParts(f, rec, [2, 1], { rawMatch: true })).toEqual({
      done: [1, 2],
      probes: { 1: d1.probe, 2: d2.probe },
      hashes: { 1: d1.hash, 2: d2.hash },
      redo: 0,
    });
    // (with probes: those are checked)
    expect(await keepParts(f, { ...rec, probes: { 1: d1.probe } }, [2, 1], { rawMatch: true })).toMatchObject({ done: [1], redo: 1 });
    // m1: nothing to check the media against.
    expect(await keepParts(f, rec, [2, 1])).toMatchObject({ done: [], redo: 2 });
    expect(await keepParts(f, { ...rec, probes: { 1: d1.probe, 2: d2.probe } }, [2, 1])).toMatchObject({ done: [], redo: 2 });
  });

  it("keepParts: a difference outside the probe window is caught (a same-length re-export, 16 MiB parts)", async () => {
    // The review's case: 48 MiB of media; the second export differs in
    // 64 KiB runs at 1 MiB, 16 + 2 MiB and 32 + 3 MiB, its moov only in
    // the times. Same m1 key, same probes: only the whole-part hashes
    // tell the parts apart.
    const big = 16 * MIB;
    const media = noise(48 * MIB, 5);
    const a = movie({ media, created: 3_900_000_000, sampleSizes: [big, big, big] });
    const changed = media.slice();
    const head = a.length - media.length;
    for (const at of [1 * MIB, 16 * MIB + 2 * MIB, 32 * MIB + 3 * MIB]) {
      const run = noise(64 * 1024, at);
      changed.set(run, at - head);
    }
    const b = movie({ media: changed, created: 3_911_111_111, sampleSizes: [big, big, big] });
    const fa = fileOf(a, "a.mov", 1);
    const fb = fileOf(b, "b.mov", 2);
    expect(await fingerprint(fb)).toBe(await fingerprint(fa));
    const parts = Math.ceil(a.length / big);
    const probes: Record<number, string> = {};
    const hashes: Record<number, string> = {};
    for (const n of [1, 2, 3]) {
      const d = (await partHash(fa, n, big, fa.size, parts))!;
      probes[n] = d.probe;
      hashes[n] = d.hash;
      // The 16 KiB in the middle are the same: a probe alone keeps it.
      expect(await partProbe(fb, n, big, fb.size, parts)).toBe(d.probe);
    }
    expect(PROBE_BYTES).toBe(16 * 1024);
    expect(await keepParts(fb, { part_size: big, parts_total: parts, probes, hashes }, [1, 2, 3])).toMatchObject({
      done: [],
      redo: 3,
    });
    // The same file, picked again (other times, the same media): all stay.
    const again = fileOf(movie({ media, created: 3_922_222_222, sampleSizes: [big, big, big] }), "c.mov", 3);
    expect(await keepParts(again, { part_size: big, parts_total: parts, probes, hashes }, [1, 2, 3])).toMatchObject({
      done: [1, 2, 3],
      redo: 0,
    });
  });

  it("a resume sends again a part whose bytes differ only outside the probe window", async () => {
    const media = noise(3 * part + 1000, 31);
    const rec = await stoppedUpload(video(3_900_000_000, media));
    // Part 2's bytes differ 100 KiB into it (its probe window is in the
    // middle); everything else is the first pick's but for the times.
    const changed = media.slice();
    const first = video(3_900_000_000, media);
    const head = first.length - media.length;
    changed.set(noise(4096, 77), part + 100 * 1024 - head);
    const repick = fileOf(video(3_955_555_555, changed), "trim.AB12.MOV", 4);
    expect((await findRecord(repick))?.fp).toBe(rec.fp);
    expect(await partProbe(repick, 2, part, repick.size, total)).toBe(rec.probes?.[2]);
    answer = (path, body) => {
      if (path === "/uploads/multipart/parts") return json({ parts: [{ part_number: 1, size: part }, { part_number: 2, size: part }] });
      return signAll(path, body) ?? json({}, 500);
    };
    await uploadResumable({ file: repick });
    expect(partsSent()).toEqual([2, 3, 4]);
    expect(calls.find((c) => c.path === "/uploads/telemetry" && c.body.event === "resume")?.body.redo).toBe(1);
    // The record now names what R2 has: part 2 of the re-pick.
    const now = [...store.values()][0];
    expect(now.hashes?.[2]).toBe((await partHash(repick, 2, part, repick.size, total))?.hash);
    expect(now.hashes?.[1]).toBe(rec.hashes?.[1]);
  });

  /** The first pick uploaded whole and completed; POST /jobs never
   *  answered (the record stays, completed). */
  async function completedUpload(first: Uint8Array): Promise<UploadRecord> {
    answer = (path, body) => {
      if (path === "/uploads/multipart/init") {
        return json({
          ticket: "tk",
          storage_key: "uploads/A.mov",
          part_size: part,
          parts_total: total,
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          parts: [],
        });
      }
      return signAll(path, body) ?? json({}, 500);
    };
    const res = await uploadResumable({ file: fileOf(first, "IMG_0042.MOV", 1) });
    expect(res.storage_key).toBe("uploads/A.mov");
    calls.length = 0;
    puts.length = 0;
    const rec = [...store.values()][0];
    expect(rec.completed).toBe(true);
    return rec;
  }
  const newUpload = (path: string, body: Record<string, unknown>) => {
    if (path === "/uploads/multipart/init") {
      return json({
        ticket: "tk2",
        storage_key: "uploads/B.mov",
        part_size: part,
        parts_total: total,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        parts: [],
      });
    }
    return signAll(path, body) ?? json({}, 500);
  };

  it("a completed upload goes straight to POST /jobs for the same video exported again (other times only)", async () => {
    await completedUpload(video(3_900_000_000));
    const repick = fileOf(video(3_977_777_777), "trim.99.MOV", 5);
    answer = newUpload;
    const res = await uploadResumable({ file: repick });
    expect(res.storage_key).toBe("uploads/A.mov");
    expect(calls).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("a completed upload is NOT used for another clip with the same moov: a new upload", async () => {
    // The review's case: an export whose upload completed but whose POST
    // /jobs failed; re-exported at the same length with other media.
    const a = await completedUpload(video(3_900_000_000, noise(3 * part + 1000, 1)));
    const b = fileOf(video(3_900_000_999, noise(3 * part + 1000, 2)), "IMG_0042.MOV", 6);
    expect((await findRecordMatch(b))?.by).toBe("m1");
    expect((await findRecord(b))?.fp).toBe(a.fp);
    answer = newUpload;
    const progress: number[] = [];
    const res = await uploadResumable({ file: b, onProgress: (p) => progress.push(p) });
    expect(res.storage_key).toBe("uploads/B.mov");
    expect(calls.map((c) => c.path)).toContain("/uploads/multipart/init");
    expect(partsSent()).toEqual([1, 2, 3, 4]);
    expect(calls.find((c) => c.body.event === "resume_stale")?.body).toMatchObject({ redo: 4, kind: "completed" });
    expect(progress[0]).toBe(0);
    expect([...store.values()].map((r) => r.ticket)).toEqual(["tk2"]);
  });

  it("an upload the server reports completed is not used for another clip either", async () => {
    const a = await completedUpload(video(3_900_000_000, noise(3 * part + 1000, 1)));
    // (As if the tab died between "complete" and the record's write.)
    store.set(a.fp, { ...a, completed: undefined });
    const b = fileOf(video(3_900_000_000, noise(3 * part + 1000, 3)), "IMG_0042.MOV", 7);
    answer = (path, body) => {
      if (path === "/uploads/multipart/parts") {
        return json({ completed: true, parts: [1, 2, 3, 4].map((n) => ({ part_number: n, size: n < 4 ? part : b.size - 3 * part })) });
      }
      return newUpload(path, body);
    };
    const res = await uploadResumable({ file: b });
    expect(res.storage_key).toBe("uploads/B.mov");
    const paths = [...new Set(calls.map((c) => c.path).filter((p) => p !== "/uploads/telemetry"))];
    expect(paths).toEqual(["/uploads/multipart/parts", "/uploads/multipart/init", "/uploads/multipart/sign", "/uploads/multipart/complete"]);
    expect(partsSent()).toEqual([1, 2, 3, 4]);
  });

  it("an MP4's record from before the hashes keeps its parts as before, also after the start screen read it", async () => {
    const bytes = video(11);
    const f = fileOf(bytes, "IMG_0042.MOV", 1);
    const c2 = (await contentFingerprint(f))!;
    store.set(c2, record(c2, { size: bytes.length, part_size: part, parts_total: total, done: [1, 2], ticket: "tk" }));
    // uploadJob asks for the percent first (that moves the record).
    expect(await resumableProgress(f)).not.toBeNull();
    answer = (path, body) => {
      if (path === "/uploads/multipart/parts") return json({ parts: [{ part_number: 1, size: part }, { part_number: 2, size: part }] });
      return signAll(path, body) ?? json({}, 500);
    };
    await uploadResumable({ file: f });
    expect(partsSent()).toEqual([3, 4]);
    // From now on its parts carry hashes.
    expect(Object.keys([...store.values()][0].hashes ?? {}).sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("an MP4's record under the raw-bytes key (from before the m1 key) is found and moved", async () => {
    const bytes = video(7);
    const f = fileOf(bytes, "a.mov", 1);
    const c2 = (await contentFingerprint(f))!;
    const m1 = (await fingerprint(f))!;
    expect(c2).toMatch(/^c2:/);
    expect(m1).toMatch(/^m1:/);
    store.set(c2, record(c2, { size: bytes.length, part_size: part, parts_total: total }));
    const f2 = fileOf(bytes, "b.mov", 2);
    const rec = await findRecord(f2);
    expect(rec?.fp).toBe(m1);
    expect([...store.keys()]).toEqual([m1]);
    // The same File asked again (the upload after the start screen's
    // percent): still a raw-bytes match. Another File: the moov key's.
    expect((await findRecordMatch(f2))?.by).toBe("c2");
    expect((await findRecordMatch(fileOf(bytes, "c.mov", 3)))?.by).toBe("m1");
    // Only these very bytes find it there: a re-export (other times) doesn't.
    store.clear();
    store.set(c2, record(c2, { size: bytes.length }));
    expect(await findRecord(fileOf(video(8), "a.mov", 1))).toBeNull();
  });
});
