// The beforeunload guard of a running upload (PR #66 review): on desktops
// (a touch laptop included) leaving asks first; phones and tablets get
// none (they ignore it); a click on a download link doesn't ask (the
// browser navigates until the answer turns out to be an attachment).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "@/features/jobs/test-storage";

const pending: (() => void)[] = [];
vi.mock("./uploadJob", () => ({
  uploadJob: vi.fn(async (_f: File, _s: unknown, _p: unknown, cb: { tempId: string; onEnd?: (id: string) => void }) => {
    await new Promise<void>((resolve) => pending.push(resolve));
    cb.onEnd?.(cb.tempId);
  }),
}));

type Listener = (e: unknown) => void;
const on = { window: new Map<string, Set<Listener>>(), document: new Map<string, Set<Listener>>() };
const target = (m: Map<string, Set<Listener>>) => ({
  addEventListener: (ev: string, f: Listener) => {
    if (!m.has(ev)) m.set(ev, new Set());
    m.get(ev)!.add(f);
  },
  removeEventListener: (ev: string, f: Listener) => void m.get(ev)?.delete(f),
});
const fire = (m: Map<string, Set<Listener>>, ev: string, e: unknown) => m.get(ev)?.forEach((f) => f(e));

const WIN_TOUCH = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 10 };
const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 };

function page(nav: typeof WIN_TOUCH) {
  on.window.clear();
  on.document.clear();
  const storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("location", { href: "https://app.test/app", origin: "https://app.test", search: "" });
  vi.stubGlobal("window", { ...target(on.window), localStorage: storage, location: { search: "" } });
  vi.stubGlobal("document", {
    ...target(on.document),
    visibilityState: "visible",
    createElement: () => ({}),
  });
  vi.stubGlobal("navigator", nav);
}

const settings = {
  style: "smooth",
  voice_triggers: true,
  remove_fillers: true,
  smartcam_enabled: false,
  smartcam_format: "portrait" as const,
  resolution: "1080",
  output_formats: [],
};
const unload = () => {
  const e = { preventDefault: vi.fn(), returnValue: undefined as unknown };
  fire(on.window, "beforeunload", e);
  return e.preventDefault.mock.calls.length > 0;
};

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  pending.splice(0).forEach((f) => f());
  vi.unstubAllGlobals();
});

describe("leaving the page while an upload runs", () => {
  it("asks on a desktop — a Windows touch laptop too — and stops asking once it is over", async () => {
    page(WIN_TOUCH);
    const { startUpload } = await import("./uploadManager");
    const done = startUpload(new File([new Uint8Array(4)], "a.mp4", { lastModified: 1 }), settings, null);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(unload()).toBe(true);
    pending.splice(0).forEach((f) => f());
    await done;
    expect(unload()).toBe(false);
  });

  it("a click on a download link doesn't ask (for a second); the page is left alone", async () => {
    page(WIN_TOUCH);
    const { startUpload } = await import("./uploadManager");
    void startUpload(new File([new Uint8Array(4)], "b.mp4", { lastModified: 1 }), settings, null);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // Another link: still asks.
    fire(on.document, "click", { target: { closest: () => null }, preventDefault: vi.fn() });
    expect(unload()).toBe(true);
    const click = { target: { closest: () => ({ href: "https://api.test/jobs/j1/download" }) }, preventDefault: vi.fn() };
    fire(on.document, "click", click);
    // The browser handles the download itself (no frame, nothing prevented).
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(unload()).toBe(false);
  });

  it("phones and tablets get no guard (they ignore beforeunload)", async () => {
    page(IPHONE);
    const { startUpload } = await import("./uploadManager");
    void startUpload(new File([new Uint8Array(4)], "c.mp4", { lastModified: 1 }), settings, null);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(on.window.get("beforeunload")?.size ?? 0).toBe(0);
  });
});
