// The export's files, when the Vorschau fetches one ahead (plan D21), and
// the share session behind "Video sichern" / "Save / Share…".
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFn } from "@/i18n";
import { RETRY_WAITS_MS, type OnProgress } from "../share";
import { downloadHref, exportFiles, prefetchAhead, preparingLabel, ShareSession, type Prepared } from "./useShareFile";

describe("exportFiles", () => {
  it("lists one file per format, the primary first in line", () => {
    const { all, primary } = exportFiles({
      downloads: [
        { format: "16:9", bytes: 9_000_000 },
        { format: "primary", bytes: 12_000_000 },
      ],
      outputs: ["primary", "16:9", "hook_1"],
    });
    expect(all.map((d) => d.format)).toEqual(["16:9", "primary"]);
    expect(primary).toEqual({ format: "primary", bytes: 12_000_000 });
  });

  it("reads the outputs of a server before UX11, bonus clips left out", () => {
    const { all, primary } = exportFiles({ outputs: ["primary", "hook_1", "1:1"] });
    expect(all).toEqual([
      { format: "primary", bytes: null },
      { format: "1:1", bytes: null },
    ]);
    expect(primary?.format).toBe("primary");
  });

  it("falls back to the primary, and to the first file without one", () => {
    expect(exportFiles({}).primary).toEqual({ format: "primary", bytes: null });
    expect(exportFiles({ downloads: [{ format: "9:16", bytes: 1 }] }).primary?.format).toBe("9:16");
  });
});

describe("prefetchAhead", () => {
  it("fetches only an export that finished while the page was open", () => {
    expect(prefetchAhead(true, undefined)).toBe(true);
    expect(prefetchAhead(false, undefined)).toBe(false);
    expect(prefetchAhead(false, { type: "wifi" })).toBe(false);
  });

  it("never on Data Saver or mobile data", () => {
    expect(prefetchAhead(true, { saveData: true })).toBe(false);
    expect(prefetchAhead(true, { type: "cellular" })).toBe(false);
    expect(prefetchAhead(true, { saveData: false, type: "wifi" })).toBe(true);
  });
});

// PR2 live test (D1): after Fine-tune and a second export, Download
// saved the first one: every export had the same link, and the browser
// answered it with the first export's redirect from its cache.
describe("downloadHref", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is a link of its own per export: the export's generation in it", () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND_URL", "https://api.test");
    const first = downloadHref({ id: "j1", renders_ok: 1 }, "primary");
    const second = downloadHref({ id: "j1", renders_ok: 2 }, "primary");
    expect(second).not.toBe(first);
    const q = new URL(second).searchParams;
    expect(new URL(second).pathname).toBe("/jobs/j1/download");
    expect([q.get("format"), q.get("name"), q.get("v")]).toEqual(["primary", "v2", "2"]);
    // an export the server doesn't count (an instant one, or one from before the counter)
    expect(new URL(downloadHref({ id: "j1" }, "1:1")).searchParams.get("v")).toBe("0");
  });
});

// The owner's iPhone (2026-11): "Video sichern" ended as a plain download
// (into Files, not Photos). The file is now tried three times, each try
// going on where the last stopped, it shows how much of it is here, it
// waits while the video plays, and nothing downloads by itself.
describe("ShareSession", () => {
  const video = () => new File([new Uint8Array(4)], "talk_cleocuts_9x16.mp4", { type: "video/mp4" });
  const named = (name: string, message = "x") => new DOMException(message, name);

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A page whose visibility the test sets. */
  function fakePage(hidden = false) {
    const page = Object.assign(new EventTarget(), { hidden });
    const show = () => {
      page.hidden = false;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    return { page, show };
  }

  /**
   * A session whose tries fail `fails` times, then give `video()`. Each
   * try reports `pieces` of a 1000-byte file, going on from where the
   * last one stopped (FileFetch); `held`: tries that wait until their
   * signal aborts. navigator.share answers with `answer`. `states`:
   * every onChange, in turn; `signals`: each try's.
   */
  function session(
    o: { fails?: number; pieces?: number[]; hidden?: boolean; answer?: () => Promise<void>; active?: boolean | null; hang?: boolean } = {},
  ) {
    const { page, show } = fakePage(o.hidden);
    const ctrl = new AbortController();
    const states: Prepared[] = [];
    const signals: AbortSignal[] = [];
    let tries = 0;
    let loaded = 0;
    const load = vi.fn(async (signal: AbortSignal, onProgress: OnProgress) => {
      signals.push(signal);
      tries++;
      for (const n of o.pieces ?? []) onProgress((loaded += n), 1000);
      if (o.hang)
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError"))));
      if (tries <= (o.fails ?? 0)) throw new TypeError(`Load failed ${tries}`);
      return video();
    });
    const share = vi.fn(o.answer ?? (async () => {}));
    const activation = o.active === null ? undefined : ({ isActive: o.active ?? false, hasBeenActive: true } as UserActivation);
    const s = new ShareSession({
      load,
      signal: ctrl.signal,
      onChange: (p) => states.push(p),
      nav: { share, userActivation: activation },
      page,
      waits: RETRY_WAITS_MS,
    });
    return { s, load, share, states, signals, ctrl, show, last: () => states.at(-1)?.state ?? "preparing" };
  }

  /** document.createElement watched: a download link would be made with it. */
  function watchLinks() {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement, body: { appendChild: vi.fn() } });
    return createElement;
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("fails twice, then is ready: tried 2 s and 6 s after a failure, nothing shared without a tap", async () => {
    vi.useFakeTimers();
    const links = watchLinks();
    const x = session({ fails: 2 });
    const done = x.s.start(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(x.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(x.load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(x.load).toHaveBeenCalledTimes(2);
    expect(x.last()).toBe("preparing");
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(x.load).toHaveBeenCalledTimes(3);
    expect(x.states).toEqual([{ state: "ready", progress: null }]);
    expect(x.share).not.toHaveBeenCalled();
    expect(links).not.toHaveBeenCalled();
    x.s.tap();
    expect(x.share).toHaveBeenCalledTimes(1);
  });

  it("three failures: failed, and nothing downloaded", async () => {
    vi.useFakeTimers();
    const links = watchLinks();
    const x = session({ fails: 3 });
    const done = x.s.start(true);
    await vi.advanceTimersByTimeAsync(8_000);
    await done;
    expect(x.load).toHaveBeenCalledTimes(3);
    expect(x.states).toEqual([{ state: "failed", progress: null }]);
    expect(x.s.settled).toBe(true);
    // a tap on a failed one does nothing (the page offers Download)
    x.s.tap();
    expect(x.share).not.toHaveBeenCalled();
    expect(links).not.toHaveBeenCalled();
  });

  it("a hidden page: the next try waits for visibilitychange", async () => {
    vi.useFakeTimers();
    const x = session({ fails: 1, hidden: true });
    const done = x.s.start(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(x.load).toHaveBeenCalledTimes(1);
    expect(x.last()).toBe("preparing");
    x.show();
    await done;
    expect(x.load).toHaveBeenCalledTimes(2);
    expect(x.last()).toBe("ready");
  });

  // Review F2 and F5: a refusal the next tap would repeat failed silently
  // (Chromium refuses files over 50 MiB from a real tap; WebKit's "error
  // while reading files"): it fails now, and the page offers Download.
  it("no outcome downloads: a refusal of the file fails it, the user's own cancel or the gesture leaves it ready", async () => {
    const links = watchLinks();
    for (const [answer, active, after] of [
      [() => Promise.reject(named("AbortError", "Abort due to cancellation of share.")), true, "ready"],
      [() => Promise.reject(named("InvalidStateError")), true, "ready"],
      // the browser didn't count the tap: the next one shares
      [() => Promise.reject(named("NotAllowedError")), false, "ready"],
      // it counted the tap and still refused: this file (Chromium over 50 MiB)
      [() => Promise.reject(named("NotAllowedError", "Permission denied")), true, "failed"],
      // a browser without userActivation (Safari before 16.4): the tap itself
      [() => Promise.reject(named("NotAllowedError", "Permission denied")), null, "failed"],
      [() => Promise.reject(named("AbortError", "Abort due to error while reading files.")), true, "failed"],
      [() => Promise.reject(new TypeError("can't share this")), true, "failed"],
    ] as const) {
      const x = session({ answer, active });
      await x.s.start(false);
      x.s.tap();
      await vi.waitFor(() => expect(x.share).toHaveBeenCalledTimes(1));
      await settle();
      expect(x.last(), `${String(answer)} ${active}`).toBe(after);
      // ready: the next tap shares again; failed: nothing
      x.s.tap();
      expect(x.share).toHaveBeenCalledTimes(after === "ready" ? 2 : 1);
    }
    expect(links).not.toHaveBeenCalled();
  });

  it("a double tap shares once; once the sheet closed, a tap shares again", async () => {
    let close: () => void = () => {};
    const x = session({ answer: () => new Promise<void>((r) => (close = r)) });
    await x.s.start(false);
    x.s.tap();
    x.s.tap();
    expect(x.share).toHaveBeenCalledTimes(1);
    close();
    await settle();
    x.s.tap();
    expect(x.share).toHaveBeenCalledTimes(2);
  });

  it("a tap's fetch shares from the tap if the browser still counts it; else the next tap does", async () => {
    const quick = session({ active: true });
    await quick.s.start(true);
    expect(quick.share).toHaveBeenCalledTimes(1);
    const slow = session({ active: false });
    await slow.s.start(true);
    expect(slow.share).not.toHaveBeenCalled();
    // fetched ahead (no tap): never shared by itself
    const ahead = session({ active: true });
    await ahead.s.start(false);
    expect(ahead.share).not.toHaveBeenCalled();
  });

  // Review F4: each try started from 0 again ("90 %", "Preparing…", "5 %").
  it("progress: told once per whole percent, and the next try goes on from there", async () => {
    vi.useFakeTimers();
    // 3 bytes at a time: 167 pieces (501 bytes) a try, then the rest
    const pieces = [...Array(167).fill(3)];
    const x = session({ fails: 1, pieces });
    const done = x.s.start(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    const pcts = x.states.map((p) => (p.progress === null ? p.state : Math.round(p.progress * 100)));
    const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    // the first try to 50 % (501 bytes), the second on to 100 %, then ready
    expect(pcts).toEqual([...run(0, 50), ...run(51, 100), "ready"]);
  });

  // Review F3: the fetch ahead ran through the video's playback (7.4 s
  // stalled in 25 s on production): it holds while the video plays.
  it("hold: the try stops at once, no failure counted, and the fetch goes on when the hold ends", async () => {
    vi.useFakeTimers();
    const x = session({ hang: true });
    void x.s.start(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(x.load).toHaveBeenCalledTimes(1);
    // four holds: more than the three tries a failure gets
    for (let i = 1; i <= 4; i++) {
      x.s.hold(true);
      expect(x.signals[i - 1].aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(x.load).toHaveBeenCalledTimes(i);
      x.s.hold(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(x.load).toHaveBeenCalledTimes(i + 1);
    }
    expect(x.states.map((p) => p.state)).not.toContain("failed");
    expect(x.s.settled).toBe(false);
  });

  it("a hold while waiting to try again: the next try waits for the hold's end too", async () => {
    vi.useFakeTimers();
    const x = session({ fails: 1 });
    const done = x.s.start(false);
    await vi.advanceTimersByTimeAsync(0);
    x.s.hold(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(x.load).toHaveBeenCalledTimes(1);
    x.s.hold(false);
    await done;
    expect(x.load).toHaveBeenCalledTimes(2);
    expect(x.last()).toBe("ready");
  });

  it("a tap while held (ask): the fetch goes on and shares from the tap if the browser still counts it", async () => {
    vi.useFakeTimers();
    let hang = true;
    const share = vi.fn(async () => {});
    const ctrl = new AbortController();
    const load = vi.fn(async (signal: AbortSignal) => {
      if (hang) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("held", "AbortError"))));
      return video();
    });
    const s = new ShareSession({
      load,
      signal: ctrl.signal,
      onChange: () => {},
      nav: { share, userActivation: { isActive: true, hasBeenActive: true } as UserActivation },
      page: fakePage().page,
    });
    const done = s.start(false);
    await vi.advanceTimersByTimeAsync(0);
    s.hold(true);
    hang = false;
    s.ask();
    s.hold(false);
    await done;
    expect(load).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("aborted (a new export, the page left): no state after it, not even failed, also while held", async () => {
    vi.useFakeTimers();
    const x = session({ fails: 3 });
    const done = x.s.start(false);
    await vi.advanceTimersByTimeAsync(1_000);
    x.ctrl.abort();
    await done;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(x.load).toHaveBeenCalledTimes(1);
    expect(x.states).toEqual([]);
    expect(x.s.settled).toBe(false);
    const y = session({ hang: true });
    const held = y.s.start(false);
    await vi.advanceTimersByTimeAsync(0);
    y.s.hold(true);
    y.ctrl.abort();
    await held;
    y.s.hold(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(y.load).toHaveBeenCalledTimes(1);
    expect(y.states).toEqual([]);
  });
});

describe("preparingLabel", () => {
  const t: TFn = (key, vars) => (key === "app.done.preparing" ? "Wird vorbereitet…" : `Wird vorbereitet… ${vars?.pct}`);

  it("the percent as the language writes it, none while the size is unknown", () => {
    expect(preparingLabel(t, "de", null)).toBe("Wird vorbereitet…");
    expect(preparingLabel(t, "de", 0.42)).toBe("Wird vorbereitet… 42 %");
    expect(preparingLabel(t, "en", 0.29)).toBe("Wird vorbereitet… 29%");
    expect(preparingLabel(t, "de", 0)).toBe("Wird vorbereitet… 0 %");
    expect(preparingLabel(t, "tr", 1)).toBe("Wird vorbereitet… %100");
  });
});
