// The jobs store's poll with accounts on, against a fake backend with the
// row shapes of backend/main.py (GET /jobs?fields=summary, /jobs/status):
// a project deleted elsewhere while Cleo works on it leaves this page —
// also this device's own list (the device that uploaded it), never as an
// "expired" row — whether the account's list held it, it was made while
// the list was shown, or the tab comes back. Nothing is forgotten
// without the list's answer, nor after an account switch meanwhile.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The hook runs outside React here: its effect (the poll) at once, its
// cleanup kept (a remount releases it), the snapshot read directly.
vi.mock("react", async (importOriginal) => {
  const orig = await importOriginal<typeof import("react")>();
  const useEffect = (fn: () => unknown) => {
    if (effects) cleanups.push(fn() as (() => void) | undefined);
  };
  const useSyncExternalStore = <T,>(_sub: unknown, get: () => T) => get();
  return { ...orig, default: { ...orig, useEffect, useSyncExternalStore }, useEffect, useSyncExternalStore };
});
let effects = false;
const cleanups: ((() => void) | undefined)[] = [];

type Row = Record<string, unknown>;
const SUMMARY = ["id", "status", "message", "progress", "stage", "filename", "title", "created_at", "updated_at", "expires_at", "has_output"];
const STATUS = ["id", "status", "message", "progress", "stage", "title", "created_at", "updated_at", "expires_at", "has_output"];

const server = new Map<string, Row>();
/** The account the requests carry (the token). */
let asUser = "u1";
/** The list answers this status (0: as it should). */
let listFails = 0;
/** Ids one status answer leaves out although they exist. */
const statusHides = new Set<string>();

const pick = (j: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, j[k] ?? null]));
const mine = (j: Row) => (j.owner ?? "u1") === asUser;
const etagOf = (s: string) => `W/"${[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)}"`;

function answer(body: unknown, init: RequestInit): Response {
  const text = JSON.stringify(body);
  const etag = etagOf(text);
  if (new Headers(init.headers).get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(text, { status: 200, headers: { ETag: etag } });
}

async function fakeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  if (u.pathname === "/jobs" && u.searchParams.get("fields") === "summary") {
    if (listFails) return new Response("{}", { status: listFails });
    const rows = [...server.values()].filter(mine).sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return answer(rows.map((j) => pick(j, SUMMARY)), init);
  }
  if (u.pathname === "/jobs/status") {
    const ids = (u.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    const ok = (id: string) => server.has(id) && mine(server.get(id)!) && !statusHides.has(id);
    return answer({ jobs: ids.filter(ok).map((id) => pick(server.get(id)!, STATUS)), missing: ids.filter((id) => !ok(id)) }, init);
  }
  if (u.pathname === "/me/claim") {
    const ids = JSON.parse(String(init.body)).job_ids as string[];
    const claimed = ids.filter((i) => server.has(i) && mine(server.get(i)!));
    return new Response(JSON.stringify({ claimed, missing: ids.filter((i) => !server.has(i)), owned_elsewhere: [] }));
  }
  return new Response("{}", { status: 404 });
}

const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};
/** One poll (the store polls a running job every 2 s). */
async function tick() {
  await vi.advanceTimersByTimeAsync(2100);
  await flush();
}

const listeners = new Map<string, (() => void)[]>();
const doc = {
  hidden: false,
  addEventListener: (t: string, f: () => void) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
  removeEventListener: (t: string, f: () => void) => listeners.set(t, (listeners.get(t) ?? []).filter((g) => g !== f)),
};
async function setHidden(hidden: boolean) {
  doc.hidden = hidden;
  (listeners.get("visibilitychange") ?? []).forEach((f) => f());
  await flush();
}

let store: typeof import("./jobsStore");
let auth: typeof import("@/lib/auth");
let storage: import("./test-storage").MemoryStorage;

/** /app opens (accounts on, signed in as `user`) with this device's list
 *  (and other stored keys: `stored`). */
async function open(local: Row[] = [], { accounts = true, user = "u1", keys = {} as Record<string, string> } = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_AUTH_TEST", accounts ? "1" : "");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
  vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "http://api");
  const { MemoryStorage, fakeWindow } = await import("./test-storage");
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("window", fakeWindow(storage));
  doc.hidden = false;
  listeners.clear();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("fetch", fakeFetch);
  if (local.length) storage.setItem(`cleocuts.jobs.v2${accounts ? `:${user}` : ""}`, JSON.stringify(local));
  for (const [k, v] of Object.entries(keys)) storage.setItem(k, v);
  auth = await import("@/lib/auth");
  asUser = user;
  if (accounts) auth.publishAuthState({ loaded: true, signedIn: true, userId: user });
  store = await import("./jobsStore");
  effects = true;
  store.useProjects();
  effects = false;
  await flush();
}

/** The rows: id, state, name. */
const rows = () => store.useProjects().projects.map((p) => `${p.id}:${p.state}:${p.name}`);
/** This device's list (ids). */
const stored = (user = "u1", accounts = true) =>
  (JSON.parse(storage.getItem(`cleocuts.jobs.v2${accounts ? `:${user}` : ""}`) ?? "[]") as Row[]).map((j) => j.jobId);

const NOW = Date.now() / 1000;
const RUNNING = { id: "A", owner: "u1", status: "processing", progress: 40, stage: "analyze.transcribe", filename: "anderswo.mp4", created_at: NOW - 10, updated_at: NOW };
const READY = { id: "B", owner: "u1", status: "awaiting_review", progress: 100, filename: "bleibt.mp4", created_at: NOW - 100, updated_at: NOW - 50 };
const LOCAL_A = { jobId: "A", filename: "anderswo.mp4", timestamp: Date.now() - 10_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  server.clear();
  server.set("A", { ...RUNNING });
  server.set("B", { ...READY });
  listFails = 0;
  statusHides.clear();
});
afterEach(() => {
  cleanups.splice(0).forEach((f) => f?.());
  store._resetForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("the account's list only: the name stays over the polls; deleted elsewhere, the row goes", async () => {
  await open();
  await tick();
  await tick();
  // A status row has no file name: the list's stays.
  expect(rows()).toEqual(["A:processing:anderswo.mp4", "B:ready:bleibt.mp4"]);
  server.delete("A");
  await tick();
  expect(rows()).toEqual(["B:ready:bleibt.mp4"]);
});

it("also on this device's list (it uploaded it): gone from both, never an expired row", async () => {
  await open([LOCAL_A]);
  await tick();
  expect(rows()).toContain("A:processing:anderswo.mp4");
  server.delete("A");
  for (let i = 0; i < 3; i++) {
    await tick();
    expect(rows().some((r) => r.startsWith("A:expired"))).toBe(false);
  }
  expect(rows()).toEqual(["B:ready:bleibt.mp4"]);
  expect(stored()).toEqual([]);
});

it("deleted while the tab was hidden: gone when it comes back", async () => {
  await open([LOCAL_A]);
  await tick();
  await setHidden(true);
  server.delete("A");
  await vi.advanceTimersByTimeAsync(30_000);
  await setHidden(false);
  for (let i = 0; i < 3; i++) {
    await tick();
    expect(rows().some((r) => r.startsWith("A:expired"))).toBe(false);
  }
  expect(rows()).toEqual(["B:ready:bleibt.mp4"]);
  expect(stored()).toEqual([]);
});

it("made while the list was shown (not in it), deleted elsewhere: gone", async () => {
  server.delete("A");
  await open();
  store.addUpload("upl-1", { filename: "anderswo.mp4" }, {});
  server.set("A", { ...RUNNING });
  store.uploadCreated("upl-1", "A", { filename: "anderswo.mp4" });
  await flush();
  await tick();
  expect(rows()).toContain("A:processing:anderswo.mp4");
  server.delete("A");
  for (let i = 0; i < 3; i++) await tick();
  expect(rows()).toEqual(["B:ready:bleibt.mp4"]);
  expect(stored()).toEqual([]);
});

it("the list doesn't answer: nothing is decided until it does", async () => {
  await open([LOCAL_A]);
  await tick();
  server.delete("A");
  listFails = 503;
  for (let i = 0; i < 5; i++) await tick();
  expect(stored()).toEqual(["A"]);
  expect(rows()).toContain("A:processing:anderswo.mp4");
  listFails = 0;
  await tick();
  expect(stored()).toEqual([]);
  expect(rows()).toEqual(["B:ready:bleibt.mp4"]);
});

it("made while the list was shown, then the list doesn't answer: kept until it does", async () => {
  server.delete("A");
  await open();
  store.addUpload("upl-1", { filename: "anderswo.mp4" }, {});
  server.set("A", { ...RUNNING });
  store.uploadCreated("upl-1", "A", { filename: "anderswo.mp4" });
  await flush();
  await tick();
  server.delete("A");
  listFails = 503;
  await tick();
  await tick();
  expect(stored()).toEqual(["A"]);
  expect(rows()).toContain("A:processing:anderswo.mp4");
  listFails = 0;
  await tick();
  expect(stored()).toEqual([]);
});

it("left out once while the list fails, then back in the status answer: the list isn't asked for it any more", async () => {
  await open([LOCAL_A]);
  await tick();
  statusHides.add("A");
  listFails = 503;
  await tick();
  statusHides.clear();
  const real = globalThis.fetch;
  let lists = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (url.includes("/jobs?fields=summary")) lists++;
    return real(url, init);
  });
  for (let i = 0; i < 3; i++) await tick();
  expect(lists).toBe(0);
  expect(rows()).toContain("A:processing:anderswo.mp4");
  expect(stored()).toEqual(["A"]);
});

it("one status answer without it while the list still has it: kept", async () => {
  await open([LOCAL_A]);
  await tick();
  statusHides.add("A");
  await tick();
  statusHides.clear();
  await tick();
  expect(stored()).toEqual(["A"]);
  expect(rows()).toContain("A:processing:anderswo.mp4");
});

it("another account meanwhile (between the status answer and the list's): nothing of the first one is forgotten", async () => {
  await open([LOCAL_A]);
  await tick();
  storage.setItem("cleocuts.editor.title.A", "Mein Titel");
  asUser = "u2";
  const real = globalThis.fetch;
  let switched = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (!switched && url.includes("/jobs?fields=summary")) {
      switched = true;
      auth.publishAuthState({ userId: "u2" });
      await vi.advanceTimersByTimeAsync(1);
    }
    return real(url, init);
  });
  await tick();
  await tick();
  expect(switched).toBe(true);
  expect(stored("u1")).toEqual(["A"]);
  expect(storage.getItem("cleocuts.editor.title.A")).toBe("Mein Titel");
});

it("accounts off: a project the server no longer has stays as an expired row", async () => {
  await open([LOCAL_A], { accounts: false });
  await tick();
  expect(rows()).toEqual(["A:processing:anderswo.mp4"]);
  server.delete("A");
  await tick();
  expect(rows()).toEqual(["A:expired:anderswo.mp4"]);
  expect(stored("u1", false)).toEqual(["A"]);
});

it("seen running but past the expiry the server gave it, then gone: an expired row", async () => {
  server.set("A", { ...RUNNING, expires_at: NOW - 60 });
  // (Another running job keeps the poll going.)
  server.set("C", { ...RUNNING, id: "C", filename: "laeuft.mp4", created_at: NOW - 5 });
  await open([LOCAL_A]);
  await tick();
  await setHidden(true);
  server.delete("A");
  await setHidden(false);
  await tick();
  await tick();
  expect(rows()).toContain("A:expired:anderswo.mp4");
  expect(stored()).toEqual(["A"]);
});

it("not seen running (gone after its retention): an expired row, as before", async () => {
  server.delete("A");
  // Claimed by an earlier visit (else the claim drops an id the server
  // doesn't know).
  await open([LOCAL_A], { keys: { "cleocuts.jobs.claimed:u1": JSON.stringify(["A"]) } });
  await tick();
  expect(rows()).toContain("A:expired:anderswo.mp4");
  expect(stored()).toEqual(["A"]);
});

// ── another account signs in (Clerk's multi-session switch) ──────────

const RUN_C = { id: "C", owner: "u2", status: "processing", progress: 10, stage: "analyze.transcribe", filename: "zwei.mp4", created_at: NOW - 5, updated_at: NOW };
/** u1's editor copies of A on this device, and u2's own list. */
const KEYS = {
  "cleocuts.editor.title.A": "Mein Titel",
  "cleocuts.editor.unsaved.v1.A": JSON.stringify({ segments: [[0, 1]] }),
  "cleocuts.jobs.v2:u2": JSON.stringify([{ jobId: "C", filename: "zwei.mp4", timestamp: Date.now() - 5_000 }]),
  "cleocuts.jobs.claimed:u2": JSON.stringify(["C"]),
};
/** Nothing of u1's A was forgotten (it still exists). */
function aKept() {
  expect(server.has("A")).toBe(true);
  expect(stored("u1")).toContain("A");
  expect(storage.getItem("cleocuts.editor.title.A")).toBe("Mein Titel");
  expect(storage.getItem("cleocuts.editor.unsaved.v1.A")).not.toBeNull();
  expect(JSON.parse(storage.getItem("cleocuts.jobs.v2.deleted:u2") ?? "[]")).toEqual([]);
}
/** The next list request goes out as u1; u2 signs in before its answer
 *  (u1's list, or `fail`) comes. */
function switchDuringList(fail = 0): () => boolean {
  const real = globalThis.fetch;
  let switched = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (switched || !url.includes("/jobs?fields=summary")) return real(url, init);
    switched = true;
    const res = fail ? new Response("{}", { status: fail }) : await real(url, init);
    asUser = "u2";
    auth.publishAuthState({ userId: "u2" });
    await vi.advanceTimersByTimeAsync(1);
    return res;
  });
  return () => switched;
}

it("another account signs in while the list is asked: the first one's list lands nowhere, nothing of it is forgotten", async () => {
  server.set("C", { ...RUN_C });
  // D: made while the list was shown, then deleted elsewhere — its
  // status answer has the list asked again.
  await open([LOCAL_A], { keys: KEYS });
  store.addUpload("upl-9", { filename: "neu.mp4" }, {});
  server.set("D", { ...RUNNING, id: "D", filename: "neu.mp4", created_at: NOW - 1 });
  store.uploadCreated("upl-9", "D", { filename: "neu.mp4" });
  await flush();
  await tick();
  server.delete("D");
  const switched = switchDuringList();
  for (let i = 0; i < 4; i++) await tick();
  expect(switched()).toBe(true);
  expect(rows()).toEqual(["C:processing:zwei.mp4"]);
  aKept();
});

it("another account signs in while the list fails: nothing carries over to it", async () => {
  server.set("C", { ...RUN_C });
  await open([LOCAL_A], { keys: KEYS });
  await tick();
  statusHides.add("A");
  const switched = switchDuringList(503);
  await tick();
  statusHides.clear();
  for (let i = 0; i < 3; i++) await tick();
  expect(switched()).toBe(true);
  aKept();
});

it("left over from a failed list, then another account signs in: nothing of the first one is forgotten", async () => {
  server.set("C", { ...RUN_C });
  await open([LOCAL_A], { keys: KEYS });
  await tick();
  statusHides.add("A");
  listFails = 503;
  await tick();
  statusHides.clear();
  listFails = 0;
  asUser = "u2";
  auth.publishAuthState({ userId: "u2" });
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  for (let i = 0; i < 3; i++) await tick();
  aKept();
});

/** Clerk switches to `user`: lib/auth publishes, the app's keyed page
 *  unmounts (its poll released) and mounts again. */
function remountAs(user: string) {
  asUser = user;
  auth.publishAuthState({ userId: user });
  cleanups.splice(0).forEach((f) => f?.());
  effects = true;
  store.useProjects();
  effects = false;
}
/** The next request for `part` is answered for u1; then u2 signs in. */
function remountDuring(part: string): () => boolean {
  const real = globalThis.fetch;
  let switched = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (switched || !url.includes(part)) return real(url, init);
    switched = true;
    const res = await real(url, init);
    remountAs("u2");
    await vi.advanceTimersByTimeAsync(1);
    return res;
  });
  return () => switched;
}
const OWN_E = { id: "E", owner: "u2", status: "awaiting_review", progress: 100, filename: "eigen.mp4", created_at: NOW - 200, updated_at: NOW - 100 };
const page = () => {
  const p = store.useProjects();
  return { ready: p.ready, serverLoaded: p.serverLoaded, rows: rows() };
};

it("another account signs in while the list is asked as the tab comes back: its own list is asked and shown", async () => {
  server.set("E", { ...OWN_E });
  await open();
  await tick();
  await setHidden(true);
  const switched = remountDuring("/jobs?fields=summary");
  await setHidden(false);
  for (let i = 0; i < 3; i++) await tick();
  expect(switched()).toBe(true);
  expect(page()).toEqual({ ready: true, serverLoaded: true, rows: ["E:ready:eigen.mp4"] });
});

it("another account signs in while a poll asks the list: its own list is asked and shown", async () => {
  server.set("E", { ...OWN_E });
  await open([LOCAL_A]);
  await tick();
  server.delete("A");
  const switched = remountDuring("/jobs?fields=summary");
  for (let i = 0; i < 3; i++) await tick();
  expect(switched()).toBe(true);
  expect(page()).toEqual({ ready: true, serverLoaded: true, rows: ["E:ready:eigen.mp4"] });
});

it("another account signs in while a status answer is read: its own list is asked and shown", async () => {
  server.set("E", { ...OWN_E });
  await open();
  await tick();
  const switched = remountDuring("/jobs/status");
  for (let i = 0; i < 3; i++) await tick();
  expect(switched()).toBe(true);
  expect(page()).toEqual({ ready: true, serverLoaded: true, rows: ["E:ready:eigen.mp4"] });
});

it("another account signs in while the list's body is read: none of it lands, also when its own list fails first", async () => {
  server.set("E", { ...OWN_E });
  server.set("C", { ...RUN_C });
  await open([LOCAL_A], { keys: KEYS });
  await tick();
  await setHidden(true);
  const real = globalThis.fetch;
  let switched = false;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const res = await real(url, init);
    if (switched || !url.includes("/jobs?fields=summary") || res.status !== 200) return res;
    switched = true;
    const body = res.json.bind(res);
    res.json = async () => {
      remountAs("u2");
      listFails = 503;
      await vi.advanceTimersByTimeAsync(1);
      return body();
    };
    return res;
  });
  // (Changed meanwhile: a full answer, not a 304.)
  server.set("B", { ...READY, title: "Neu" });
  await setHidden(false);
  for (let i = 0; i < 3; i++) await tick();
  expect(switched).toBe(true);
  listFails = 0;
  store.refreshProjects(); // the page's Try again
  for (let i = 0; i < 3; i++) await tick();
  expect(page()).toEqual({ ready: true, serverLoaded: true, rows: ["C:processing:zwei.mp4", "E:ready:eigen.mp4"] });
  aKept();
});
