// The gate's exact spot in uploadJob (D1, plan §4 P1-B): on R2 the bytes
// go up, then POST /jobs waits for "Let's go" with the heartbeat on and
// the wake lock off, and reads the settings only after it; the legacy
// upload sends the bytes with POST /jobs, so both wait; Cancel while it
// waits leaves nothing (no POST, no record, the stored upload aborted),
// also right after the gate opened.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { createGate } from "./gate";

vi.mock("@/lib/account", () => ({
  fetchServerJobs: vi.fn(async () => null),
  refreshMe: vi.fn(),
  paywallFrom: vi.fn(() => null),
  toMs: () => null,
}));
vi.mock("@/lib/config", () => ({
  getConfig: async () => ({ limits: { max_upload_bytes: 10e9, max_seconds: 1800, min_seconds: 3 } }),
}));
const abortResumable = vi.fn<(o: { file: File }) => Promise<void>>(async () => {});
const readVideoDuration = vi.fn(async () => 20);
const uploadResumable = vi.fn();
vi.mock("@/lib/chunkedUpload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chunkedUpload")>()),
  abortResumable: (o: { file: File }) => abortResumable(o),
  readVideoDuration: () => readVideoDuration(),
  resumableProgress: async () => null,
  uploadResumable: (o: unknown) => uploadResumable(o),
}));
vi.mock("./records", () => ({
  knownJobIds: async () => new Set(),
  liveUploads: new Set(),
  recordJobCreated: vi.fn(),
  recordUploadFailed: vi.fn(),
  removeStoppedUploads: vi.fn(),
  removeUploadRecord: vi.fn(),
  uploadProgress: vi.fn(),
}));

/** POST /jobs as uploadJob sends it; `answer` gives the server's reply. */
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
  answer(status: number, responseText: string) {
    this.status = status;
    this.responseText = responseText;
    this.upload.onload?.();
    this.onload?.();
  }
}

const wake = { requests: 0, releases: 0 };
// The wake lock request number `hold.at` waits until `hold.release()`.
const hold = { at: 0, release: () => {} };
const onDocument = new Map<string, () => void>();

beforeEach(() => {
  FakeXhr.sent = [];
  wake.requests = wake.releases = 0;
  hold.at = 0;
  onDocument.clear();
  abortResumable.mockClear();
  readVideoDuration.mockClear();
  uploadResumable.mockReset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (ev: string, f: () => void) => onDocument.set(ev, f),
    removeEventListener: (ev: string) => onDocument.delete(ev),
  });
  vi.stubGlobal("navigator", {
    onLine: true,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    wakeLock: {
      request: async () => {
        wake.requests++;
        if (wake.requests === hold.at) await new Promise<void>((r) => (hold.release = r));
        const held = {
          released: false,
          release: async () => {
            held.released = true;
            wake.releases++;
          },
        };
        return held;
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SETTINGS = {
  style: "tight",
  voice_triggers: true,
  remove_fillers: true,
  smartcam_enabled: true,
  smartcam_format: "portrait" as const,
  resolution: "1080",
  output_formats: [],
};

/** The start screen's choice: the hint and the whole style (D7). */
const NEON = { caption_style_hint: "neon", caption_style: { presetId: "neon", overrides: {} } };

async function run(opts: { ready?: Promise<void>; duration?: number | null; size?: number } = {}) {
  const { uploadJob } = await import("./uploadJob");
  const records = await import("./records");
  const ctl = new AbortController();
  const settings = vi.fn(() => ({ ...SETTINGS, ...NEON }));
  const seen = { uploaded: 0, starting: 0, created: [] as string[], failed: 0 };
  const done = uploadJob(new File([new Uint8Array(opts.size ?? 8)], "clip.mp4", { type: "video/mp4" }), settings, null, {
    tempId: "upl-1",
    signal: ctl.signal,
    ready: opts.ready,
    duration: opts.duration,
    onPaywall: () => {},
    onCreated: (id) => seen.created.push(id),
    onFailed: () => seen.failed++,
    onStarting: () => seen.starting++,
    onUploaded: () => seen.uploaded++,
  });
  return { done, ctl, settings, seen, records };
}

/** The settings POST /jobs carried. */
const sentSettings = (x: FakeXhr) => JSON.parse(String(x.body?.get("settings")));

describe("the gate in uploadJob", () => {
  it("R2: the bytes go up, POST /jobs waits for the gate and reads the settings after it", async () => {
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k1", release: async () => {} });
    const gate = createGate();
    const { done, settings, seen } = await run({ ready: gate.promise, duration: 20 });
    await vi.waitFor(() => expect(seen.uploaded).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeXhr.sent).toHaveLength(0);
    expect(settings).not.toHaveBeenCalled();
    expect(seen.starting).toBe(0);
    // The length read at the pick went along; it isn't read again.
    expect(readVideoDuration).not.toHaveBeenCalled();
    expect(uploadResumable.mock.calls[0][0]).toMatchObject({ duration: 20 });
    // No wake lock while it waits, also when the page comes back.
    expect(wake).toEqual({ requests: 1, releases: 1 });
    onDocument.get("visibilitychange")?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(wake.requests).toBe(1);

    gate.open();
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    expect(wake.requests).toBe(2);
    expect(seen.starting).toBe(1);
    const xhr = FakeXhr.sent[0];
    expect(xhr.body?.get("storage_key")).toBe("uploads/k1");
    expect(sentSettings(xhr)).toMatchObject(NEON);
    xhr.answer(200, '{"id":"j1"}');
    await done;
    expect(seen.created).toEqual(["j1"]);
  });

  it("R2: Cancel while it waits for the gate: no POST, the record goes, the stored upload is aborted", async () => {
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k2", release: async () => {} });
    const { done, ctl, seen, records } = await run({ ready: createGate().promise });
    await vi.waitFor(() => expect(seen.uploaded).toBe(1));
    ctl.abort();
    await done;
    expect(FakeXhr.sent).toHaveLength(0);
    expect(records.removeUploadRecord).toHaveBeenCalledWith("upl-1");
    expect(abortResumable).toHaveBeenCalledExactlyOnceWith({ file: expect.any(File) });
    expect(records.recordUploadFailed).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ starting: 0, created: [], failed: 0 });
    expect(wake.releases).toBe(wake.requests);
  });

  it("legacy upload (no R2): the bytes wait for the gate with POST /jobs", async () => {
    uploadResumable.mockRejectedValue(new ApiError(503, "Direct upload not available", { detail: "x" }));
    const gate = createGate();
    const { done, settings, seen } = await run({ ready: gate.promise });
    await vi.waitFor(() => expect(uploadResumable).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeXhr.sent).toHaveLength(0);
    expect(settings).not.toHaveBeenCalled();
    expect(seen.uploaded).toBe(0);
    gate.open();
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    const xhr = FakeXhr.sent[0];
    expect(xhr.body?.get("file")).toBeInstanceOf(File);
    expect(sentSettings(xhr)).toMatchObject(NEON);
    xhr.answer(200, '{"id":"j2"}');
    await done;
    expect(seen.created).toEqual(["j2"]);
  });

  it("legacy upload: Cancel right after the gate opened (the wake lock being taken again): nothing goes out", async () => {
    uploadResumable.mockRejectedValue(new ApiError(503, "Direct upload not available", { detail: "x" }));
    const gate = createGate();
    const { done, ctl, settings, seen, records } = await run({ ready: gate.promise });
    vi.mocked(records.removeUploadRecord).mockClear();
    await vi.waitFor(() => expect(uploadResumable).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    // The lock taken again once the gate opens.
    hold.at = wake.requests + 1;
    gate.open();
    await vi.waitFor(() => expect(wake.requests).toBe(hold.at));
    ctl.abort();
    hold.release();
    await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
    expect(FakeXhr.sent).toHaveLength(0);
    expect(settings).not.toHaveBeenCalled();
    expect(records.removeUploadRecord).toHaveBeenCalledWith("upl-1");
    expect(seen).toMatchObject({ starting: 0, created: [], failed: 0 });
  });

  it("without a gate POST /jobs goes as soon as the bytes are up (and the length is read here)", async () => {
    uploadResumable.mockResolvedValue({ storage_key: "uploads/k3", release: async () => {} });
    const { done, seen } = await run();
    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
    expect(readVideoDuration).toHaveBeenCalledTimes(1);
    expect(wake).toEqual({ requests: 1, releases: 0 });
    FakeXhr.sent[0].answer(200, '{"id":"j3"}');
    await done;
    expect(seen.created).toEqual(["j3"]);
  });
});
