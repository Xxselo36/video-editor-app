// Resume records (lib/uploadResume) and the resume of lib/chunkedUpload:
// a re-picked file is found by its content (a new name and a new
// lastModified still match), the record is written before part 1 and
// after every part, lives as long as the server's ticket, and a resume
// sends only the parts the server does NOT list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { path: string; body: Record<string, unknown> };
const calls: Call[] = [];
let answer: (path: string, body: Record<string, unknown>) => Response = () => new Response("{}", { status: 500 });

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
  EXPIRY_MARGIN_MS,
  findRecord,
  fingerprint,
  legacyFingerprint,
  LEGACY_TTL_MS,
  listResumable,
  markUploadActive,
  recordPct,
  type UploadRecord,
} from "@/lib/uploadResume";
import { resumableProgress, uploadResumable } from "@/lib/chunkedUpload";

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
    expires_at: Date.now() + 7 * 86400_000,
    ...over,
  };
}

// ── a fake XMLHttpRequest: every PUT "uploads" at once ────────────────
const puts: string[] = [];
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
  send(body: Blob) {
    puts.push(this.url);
    setTimeout(() => {
      this.upload.onprogress?.({ loaded: body.size });
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

  it("a 5xx from /parts keeps the record for the next try", async () => {
    const bytes = content(size, 13);
    const fp = (await fingerprint(fileOf(bytes, "a", 1)))!;
    store.set(fp, record(fp, { size, part_size: part, parts_total: total }));
    answer = () => json({ detail: "storage_error" }, 502);
    await expect(uploadResumable({ file: fileOf(bytes, "a", 1) })).rejects.toBeTruthy();
    expect(store.has(fp)).toBe(true);
    expect(puts).toHaveLength(0);
  });
});
