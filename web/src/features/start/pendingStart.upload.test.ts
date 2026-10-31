// The pending start with the real upload code (pendingStart, uploadManager,
// uploadControls and uploadJob wired together; the network, the stored
// records and the prefs faked): what POST /jobs sends, what is
// remembered as the last used, and what a "Try again" on the Projects
// tile goes on with (D2 to D4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StyleChoice } from "./choices";
import { initialChoices, settingsOf } from "./choices";
import { uploadSettings } from "./defaults";

vi.mock("@/lib/account", () => ({
  fetchServerJobs: vi.fn(async () => null),
  refreshMe: vi.fn(),
  paywallFrom: vi.fn(() => null),
  toMs: () => null,
}));
vi.mock("@/lib/config", () => ({
  getConfig: async () => ({ limits: { max_upload_bytes: 10e9, max_seconds: 1800, min_seconds: 3 } }),
}));
let abortGate: Promise<void> = Promise.resolve();
const abortResumable = vi.fn<(o: { file: File }) => Promise<void>>(async () => {
  await abortGate;
});
const uploadResumable = vi.fn();
vi.mock("@/lib/chunkedUpload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chunkedUpload")>()),
  abortResumable: (o: { file: File }) => abortResumable(o),
  readVideoDuration: async () => 20,
  resumableProgress: async () => null,
  uploadResumable: (o: unknown) => uploadResumable(o),
}));
const rec = { removed: [] as string[], created: [] as [string, string][] };
vi.mock("@/features/upload/records", () => ({
  knownJobIds: async () => new Set(),
  liveUploads: new Set<string>(),
  projectsV2: () => false,
  addUploadRecord: vi.fn(),
  recordUploadSettings: vi.fn(),
  recordUploadStarting: vi.fn(),
  recordUploadStored: vi.fn(),
  recordUploadWaiting: vi.fn(),
  recordJobCreated: (t: string, j: string) => rec.created.push([t, j]),
  recordUploadFailed: vi.fn(),
  removeStoppedUploads: vi.fn(),
  removeUploadRecord: (id: string) => rec.removed.push(id),
  stoppedUpload: async () => null,
  uploadProgress: vi.fn(),
}));
const saveLastUsed = vi.fn<(p: unknown) => Promise<void>>(async () => {});
vi.mock("./lastUsed", () => ({ saveLastUsed: (p: unknown) => saveLastUsed(p) }));

/** POST /jobs as uploadJob sends it. */
class FakeXhr {
  static sent: FakeXhr[] = [];
  status = 0;
  responseText = "";
  timeout = 0;
  body: FormData | null = null;
  upload: { onprogress: unknown; onload: (() => void) | null } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  abort() {
    this.onabort?.();
  }
  send(body: FormData) {
    this.body = body;
    FakeXhr.sent.push(this);
  }
  /** The legacy upload's body is sent (the server creates the job now). */
  bodySent() {
    this.upload.onload?.();
  }
  answer(status: number, responseText: string) {
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
}

beforeEach(() => {
  vi.resetModules();
  FakeXhr.sent = [];
  rec.removed.length = rec.created.length = 0;
  abortGate = Promise.resolve();
  abortResumable.mockClear();
  uploadResumable.mockReset();
  saveLastUsed.mockClear();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("navigator", {
    onLine: true,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    wakeLock: { request: async () => ({ released: false, release: async () => {} }) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sentSettings = (x: FakeXhr) => JSON.parse(String(x.body?.get("settings")));
const probe = { width: 1080, height: 1920, duration: 20 };
const first = () => initialChoices({ saved: null, standard: null, lastStyle: null, live: undefined });
const POWER: StyleChoice = { presetId: "power", overrides: {} };
const NEON: StyleChoice = { presetId: "neon", overrides: {} };
/** What the start screen sends for the first visit's choices with `style`. */
const sentSettingsOf = (style: StyleChoice) => uploadSettings(settingsOf({ ...first(), style }, probe), { captionStyle: style });
let n = 0;
const video = () => new File([new Uint8Array(8)], `clip-${++n}.mp4`, { type: "video/mp4", lastModified: n });

/** "Neues Video" took `file`: its upload runs, "Untertitel wählen" shows it. */
async function pick(file = video(), frame: Promise<string | null> = Promise.resolve(null)) {
  const ps = await import("./pendingStart");
  expect(ps.beginStart(file, { probe, frame, choices: first() })).toBe(true);
  return { ps, file, tempId: ps.getPendingStart()!.tempId };
}

describe("the pending start with the upload code", () => {
  it("legacy upload: once POST /jobs has read the choices (Let's go, the bytes still going with it) they are locked: the job and Last used carry what the screen shows", async () => {
    // (This case's module graph: the ApiError uploadJob knows.)
    const { ApiError } = await import("@/lib/api");
    uploadResumable.mockRejectedValue(new ApiError(503, "Direct upload not available", { detail: "x" }));
    const { ps } = await pick();
    await vi.waitFor(() => expect(uploadResumable).toHaveBeenCalled());
    await sleep(20);
    ps.goStart();
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    const xhr = FakeXhr.sent[0];
    // "Startet nach dem Hochladen": the bytes go up with the request.
    expect(ps.getPendingStart()).toMatchObject({ starting: false, sent: true });
    ps.changeChoices((c) => ({ ...c, style: NEON }));
    expect(ps.getPendingStart()!.choices.style).toEqual(POWER);
    xhr.bodySent();
    expect(saveLastUsed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ caption_style_last: "power" }));
    expect(sentSettings(xhr).caption_style).toEqual(ps.getPendingStart()!.choices.style);
    xhr.answer(200, '{"id":"j1"}');
    await vi.waitFor(() => expect(rec.created).toEqual([[expect.any(String), "j1"]]));
  });

  it("Let's go, then the upload fails before POST /jobs: Try again on its Projects tile goes on with the start (Last used written, the frame kept)", async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => void revoked.push(u));
    let failFirst!: (e: unknown) => void;
    uploadResumable.mockImplementationOnce(() => new Promise((_res, rej) => (failFirst = rej)));
    const { ps, tempId } = await pick(video(), Promise.resolve("blob:frame"));
    ps.changeChoices((c) => ({ ...c, style: NEON }));
    ps.goStart();
    await vi.waitFor(() => expect(uploadResumable).toHaveBeenCalledTimes(1));
    failFirst(new Error("Network error"));
    await vi.waitFor(() => expect(ps.getPendingStart()!.failed).toBe(true));
    // Projects: the gate is open, so the tile offers its own "Try again"
    // (ProjectTile → retryUpload(id), no options).
    const state = await import("@/features/upload/uploadState");
    expect(state.isAwaitingGo(tempId)).toBe(false);
    uploadResumable.mockResolvedValueOnce({ storage_key: "uploads/k", release: async () => {} });
    const { retryUpload } = await import("@/features/upload/uploadControls");
    expect(retryUpload(tempId)).toBe(true);
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    expect(sentSettings(FakeXhr.sent[0]).caption_style).toEqual(NEON);
    // D4: written as POST /jobs goes out.
    expect(saveLastUsed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ caption_style_last: "neon" }));
    FakeXhr.sent[0].answer(200, '{"id":"j2"}');
    await vi.waitFor(() => expect(rec.created).toEqual([[expect.any(String), "j2"]]));
    // The frame went along to the job's tile.
    await expect(state.takeThumb("j2")).resolves.toBe("blob:frame");
    expect(revoked).toEqual([]);
  });

  it("X, then the same file again at once: it waits for the given up upload to wind down, then starts anew", async () => {
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k", release: async () => {} });
    let finishAbort!: () => void;
    abortGate = new Promise<void>((r) => (finishAbort = r));
    const file = video();
    const { ps, tempId } = await pick(file);
    const manager = await import("@/features/upload/uploadManager");
    await vi.waitFor(() => expect(manager.getLiveUpload(tempId)?.uploaded).toBe(true));
    expect(manager.isCancelling(file)).toBe(false);
    ps.cancelStart();
    expect(ps.getPendingStart()).toBeNull();
    await vi.waitFor(() => expect(abortResumable).toHaveBeenCalledOnce());
    // The stored parts are still being discarded: not a running upload to
    // go to (Projects no longer lists it), not free for a new one either.
    expect(manager.isUploading(file)).toBe(true);
    expect(manager.isCancelling(file)).toBe(true);
    const free = manager.whenFree(file, 5000);
    await expect(manager.whenFree(file, 10)).resolves.toBe(false);
    finishAbort();
    await expect(free).resolves.toBe(true);
    expect(manager.isUploading(file)).toBe(false);
    expect(manager.isCancelling(file)).toBe(false);
    // Picked again now: a new upload.
    const again = await pick(file);
    expect(again.tempId).not.toBe(tempId);
  });

  it("the waiting tile's Cancel, then New video while the abort is still out: the given-up video isn't shown again", async () => {
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k", release: async () => {} });
    let finishAbort!: () => void;
    abortGate = new Promise<void>((r) => (finishAbort = r));
    const { ps, tempId } = await pick();
    const manager = await import("@/features/upload/uploadManager");
    await vi.waitFor(() => expect(manager.getLiveUpload(tempId)?.uploaded).toBe(true));
    const { cancelUpload } = await import("@/features/upload/uploadControls");
    await cancelUpload(tempId);
    await vi.waitFor(() => expect(abortResumable).toHaveBeenCalledOnce());
    // Neues Video opens (the Projects pill, Back) before the abort is answered.
    ps.restoreStart();
    expect(ps.getPendingStart()).toBeNull();
    finishAbort();
    await vi.waitFor(() => expect(manager.getLiveUpload(tempId)).toBeNull());
    expect(ps.getPendingStart()).toBeNull();
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it("a failed start, waiting for Let's go still, is shown again, and so is its Try again", async () => {
    uploadResumable.mockRejectedValueOnce(new Error("Network error"));
    const { ps, tempId } = await pick();
    await vi.waitFor(() => expect(ps.getPendingStart()!.failed).toBe(true));
    ps.restoreStart();
    expect(ps.getPendingStart()?.tempId).toBe(tempId);
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k", release: async () => {} });
    expect(ps.retryStart()).toBe(true);
    const again = ps.getPendingStart()!.tempId;
    expect(again).not.toBe(tempId);
    ps.restoreStart();
    expect(ps.getPendingStart()?.tempId).toBe(again);
    // (A running one too.)
    const manager = await import("@/features/upload/uploadManager");
    await vi.waitFor(() => expect(manager.getLiveUpload(again)?.uploaded).toBe(true));
    ps.restoreStart();
    expect(ps.getPendingStart()?.tempId).toBe(again);
    ps.cancelStart();
  });

  it("after a reload, its tile's Try again: POST /jobs goes out with the record's choices and remembers them as the last used", async () => {
    // The record a start screen left (a reload took the page and its start).
    const settings = { ...sentSettingsOf(NEON), target_aspect: "original" as const };
    const lastUsed = { target_aspect: "16:9" as const, remove_fillers: false, spoken_language: "de", caption_style_last: "neon" };
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k", release: async () => {} });
    const { retryUploadWith } = await import("@/features/upload/uploadControls");
    expect(await retryUploadWith("upl-stopped", video(), settings, null, undefined, lastUsed)).toBe(true);
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    expect(sentSettings(FakeXhr.sent[0])).toEqual(settings);
    // D4: as POST /jobs goes out, exactly the record's wishes.
    await vi.waitFor(() => expect(saveLastUsed).toHaveBeenCalledExactlyOnceWith(lastUsed));
    FakeXhr.sent[0].answer(200, '{"id":"j3"}');
    await vi.waitFor(() => expect(rec.created).toEqual([[expect.any(String), "j3"]]));
    expect(saveLastUsed).toHaveBeenCalledOnce();
  });

  it("after a reload, Try again of an upload that didn't start on the start screen remembers nothing", async () => {
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k", release: async () => {} });
    const { retryUploadWith } = await import("@/features/upload/uploadControls");
    expect(await retryUploadWith("upl-v1", video(), sentSettingsOf(POWER), null)).toBe(true);
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    FakeXhr.sent[0].answer(200, '{"id":"j4"}');
    await vi.waitFor(() => expect(rec.created).toEqual([[expect.any(String), "j4"]]));
    expect(saveLastUsed).not.toHaveBeenCalled();
  });
});
