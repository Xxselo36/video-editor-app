// The Vorschau player's logic (player.ts): the frame's shape, when it
// waits for the file (spinner, aria-busy) and when it has none of it yet
// (after 10 s "the preview is still being prepared"), the scrub line,
// the clips the preview's captions map through, what it shows of the
// captions, and the done frame's still.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetched } from "@/features/editor/state/docFetch";
import {
  BUSY,
  DECODE_WAIT_MS,
  EMPTY,
  PLAYING,
  decodeStill,
  editSegsOf,
  isWide,
  pickStill,
  playbackOf,
  previewCaptions,
  progressOf,
  stillCandidates,
  type StillImage,
} from "./player";

// HTMLMediaElement: networkState IDLE 1, LOADING 2, NO_SOURCE 3;
// readyState HAVE_NOTHING 0 … HAVE_ENOUGH_DATA 4.
const media = (paused: boolean, networkState: number, readyState: number) => ({ paused, networkState, readyState });

describe("playbackOf", () => {
  it("no element yet: paused, nothing loading", () => {
    expect(playbackOf(null)).toBe(0);
  });

  it("paused: busy only while the file's start is on its way, empty until any of it came", () => {
    // the request waits (a preview the server still builds)
    expect(playbackOf(media(true, 2, 0))).toBe(BUSY | EMPTY);
    // its metadata came: the poster and the play button are all it needs
    expect(playbackOf(media(true, 2, 1))).toBe(0);
    // preload="metadata" done, or a browser that loads nothing before play
    expect(playbackOf(media(true, 1, 1))).toBe(0);
    expect(playbackOf(media(true, 1, 0))).toBe(0);
  });

  it("playing: busy while the next frames are on their way", () => {
    expect(playbackOf(media(false, 2, 4))).toBe(PLAYING);
    expect(playbackOf(media(false, 2, 3))).toBe(PLAYING);
    // waiting (buffering)
    expect(playbackOf(media(false, 2, 2))).toBe(PLAYING | BUSY);
    expect(playbackOf(media(false, 2, 1))).toBe(PLAYING | BUSY);
    expect(playbackOf(media(false, 2, 0))).toBe(PLAYING | BUSY | EMPTY);
  });

  it("a load that failed waits for nothing", () => {
    expect(playbackOf(media(true, 3, 0))).toBe(0);
    expect(playbackOf(media(false, 3, 0))).toBe(PLAYING);
  });
});

describe("progressOf", () => {
  it("the part played, 0..1", () => {
    expect(progressOf(0, 60)).toBe(0);
    expect(progressOf(15, 60)).toBe(0.25);
    expect(progressOf(61, 60)).toBe(1);
  });

  it("0 while the length is unknown", () => {
    expect(progressOf(3, NaN)).toBe(0);
    expect(progressOf(3, 0)).toBe(0);
    expect(progressOf(3, Infinity)).toBe(0);
  });
});

describe("editSegsOf", () => {
  it("the stored timeline with the editor's clip ids and effects", () => {
    expect(
      editSegsOf([
        { start: 0.5, end: 4, speed: 1, fadeIn: 0, fadeOut: 0, volume: 1 },
        { start: 6.25, end: 9.125, speed: 1.5 },
      ]),
    ).toEqual([
      { id: "seg-0-0.500", start: 0.5, end: 4, speed: 1, fadeIn: 0, fadeOut: 0, volume: 1 },
      { id: "seg-1-6.250", start: 6.25, end: 9.125, speed: 1.5, fadeIn: undefined, fadeOut: undefined, volume: undefined },
    ]);
    expect(editSegsOf([])).toEqual([]);
  });
});

describe("previewCaptions", () => {
  const fetched = (
    engine: "v1" | "v2" | "optin",
    presetId = "power",
    renderStyle: { presetId: string; overrides: Record<string, unknown> } | null = null,
  ): Fetched => ({
    doc: {
      v: 2,
      language: "de",
      words: [],
      clips: null,
      style: { presetId, overrides: {} },
      format: { aspect: "9:16" },
      rev: 1,
    },
    rev: 1,
    read_only: false,
    captions: { engine, presetsLive: null, recommended: [] },
    renderStyle,
  });

  it("nothing while the doc loads", () => {
    expect(previewCaptions(null, true, false)).toBeNull();
  });

  it("drawn live when the export draws v2 captions", () => {
    expect(previewCaptions(fetched("v2"), false, false)).toBe("live");
    expect(previewCaptions(fetched("optin"), true, false)).toBe("live");
  });

  it("a note when the export draws them another way (v1, optin without ?captions=v2)", () => {
    expect(previewCaptions(fetched("v1"), true, false)).toBe("after");
    expect(previewCaptions(fetched("optin"), false, false)).toBe("after");
  });

  it("none when the style an export draws is none", () => {
    expect(previewCaptions(fetched("v2", "none"), false, false)).toBeNull();
    expect(previewCaptions(fetched("v1", "none"), false, false)).toBeNull();
    // the render style decides over the doc's own
    expect(previewCaptions(fetched("v2", "power", { presetId: "none", overrides: {} }), false, false)).toBeNull();
    expect(previewCaptions(fetched("v2", "none", { presetId: "mega", overrides: {} }), false, false)).toBe("live");
  });

  it("no doc (analysed before it existed, or it didn't load): the note, unless the project has no captions", () => {
    expect(previewCaptions("none", true, false)).toBe("after");
    expect(previewCaptions("none", true, true)).toBeNull();
  });
});

describe("isWide", () => {
  // The filmstrip's tiles: the source scaled to 90 px high.
  const strip = (tileW: number, tileH = 90) => ({ n: 30, interval: 1, tileW, tileH });

  it("a 16:9 output is wide, a 9:16 one tall, whatever the source", () => {
    expect(isWide({ output_aspect: "16:9", filmstrip: strip(50) })).toBe(true);
    expect(isWide({ output_aspect: "9:16", filmstrip: strip(160) })).toBe(false);
  });

  it("an original keeps the source's frame: landscape wide, portrait and square tall", () => {
    expect(isWide({ output_aspect: "original", filmstrip: strip(160) })).toBe(true);
    // 4:3, and a very wide source (its tiles cropped to 320 px)
    expect(isWide({ output_aspect: "original", filmstrip: strip(120) })).toBe(true);
    expect(isWide({ output_aspect: "original", filmstrip: strip(320) })).toBe(true);
    expect(isWide({ output_aspect: "original", filmstrip: strip(50) })).toBe(false);
    expect(isWide({ output_aspect: "original", filmstrip: strip(72) })).toBe(false);
    expect(isWide({ output_aspect: "original", filmstrip: strip(90) })).toBe(false);
  });

  it("tall while the source's shape is unknown: no filmstrip, no aspect (a server before it)", () => {
    expect(isWide({ output_aspect: "original", filmstrip: null })).toBe(false);
    expect(isWide({ output_aspect: "original" })).toBe(false);
    expect(isWide({ output_aspect: "original", filmstrip: strip(160, 0) })).toBe(false);
    expect(isWide({ filmstrip: strip(160) })).toBe(false);
    expect(isWide({ output_aspect: null, filmstrip: strip(160) })).toBe(false);
  });
});

// The owner's iPhone (2026-11): the done frame was empty before a tap.
// iOS paints only the poster there, and the thumbnail it got didn't show.
describe("the done frame's still", () => {
  const THUMB = "https://api.test/jobs/j1/thumbnail?v=2";
  const POSTER = "https://api.test/jobs/j1/poster";

  /** decode() of a detached image: `broken` URLs reject (a 404, a file the browser can't decode). */
  const decoder = (...broken: string[]) =>
    vi.fn(async (url: string) => {
      if (broken.includes(url)) throw new DOMException("The source image cannot be decoded.", "EncodingError");
    });

  it("tries the export's thumbnail, then the analysis' poster when the job has one", () => {
    expect(stillCandidates(THUMB, POSTER)).toEqual([
      { kind: "thumbnail", url: THUMB },
      { kind: "poster", url: POSTER },
    ]);
    expect(stillCandidates(THUMB, null)).toEqual([{ kind: "thumbnail", url: THUMB }]);
    // media URLs not ready yet
    expect(stillCandidates(null, null)).toEqual([]);
  });

  it("a thumbnail that decodes: that one, the poster never asked for", async () => {
    const decode = decoder();
    const got = await pickStill(stillCandidates(THUMB, POSTER), decode);
    expect(got).toEqual({ kind: "thumbnail", url: THUMB });
    expect(decode.mock.calls.map(([url]) => url)).toEqual([THUMB]);
  });

  it("a thumbnail that doesn't decode: the poster, each tried in turn", async () => {
    const decode = decoder(THUMB);
    const got = await pickStill(stillCandidates(THUMB, POSTER), decode);
    expect(got).toEqual({ kind: "poster", url: POSTER });
    expect(decode.mock.calls.map(([url]) => url)).toEqual([THUMB, POSTER]);
  });

  it("none decodes, or there is none: null (the video's own first frame)", async () => {
    const decode = decoder(THUMB, POSTER);
    expect(await pickStill(stillCandidates(THUMB, POSTER), decode)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(await pickStill(stillCandidates(THUMB, null), decoder(THUMB))).toBeNull();
    expect(await pickStill([], decoder())).toBeNull();
  });

  it("the frame gone (a new export): stops, nothing more tried", async () => {
    let live = true;
    const decode = vi.fn(async (url: string) => {
      live = false;
      throw new Error(`broken ${url}`);
    });
    expect(await pickStill(stillCandidates(THUMB, POSTER), decode, () => live)).toBeNull();
    expect(decode.mock.calls.map(([url]) => url)).toEqual([THUMB]);
    // one that decodes after the frame went: not taken either
    live = true;
    const late = vi.fn(async () => {
      live = false;
    });
    expect(await pickStill(stillCandidates(THUMB, POSTER), late, () => live)).toBeNull();
  });
});

// Review (picture-1): Safari 17 and older never settle decode() for a
// still that loads but doesn't decode (the old 4:4:4 thumbnails, not
// redone): the chain stopped there, no poster, no first frame.
describe("decodeStill", () => {
  afterEach(() => vi.useRealTimers());

  /** A detached image whose load the test fires, and whose decode answers with `decode`. */
  function image(decode: () => Promise<void>) {
    const img = { decode: vi.fn(decode), onload: null, onerror: null, src: "" };
    return {
      img: img as unknown as StillImage,
      load: () => (img.onload as unknown as () => void)(),
      fail: () => (img.onerror as unknown as () => void)(),
      src: () => img.src,
      decoded: () => img.decode.mock.calls.length,
    };
  }

  it("decodes once it loaded: resolves", async () => {
    const x = image(() => Promise.resolve());
    const p = decodeStill("/jobs/j1/thumbnail?v=1", () => x.img);
    expect(x.src()).toBe("/jobs/j1/thumbnail?v=1");
    expect(x.decoded()).toBe(0);
    x.load();
    await expect(p).resolves.toBeUndefined();
    expect(x.decoded()).toBe(1);
  });

  it("rejects a still that doesn't load (a 404, a body that is no image) and one the browser can't decode", async () => {
    const missing = image(() => Promise.resolve());
    const p = decodeStill("/a", () => missing.img);
    missing.fail();
    await expect(p).rejects.toThrow();
    const broken = image(() => Promise.reject(new DOMException("Decoding error.", "EncodingError")));
    const q = decodeStill("/b", () => broken.img);
    broken.load();
    await expect(q).rejects.toThrow("Decoding error.");
  });

  it("a decode that never settles: rejected DECODE_WAIT_MS after the load, and no limit on the load itself", async () => {
    vi.useFakeTimers();
    const x = image(() => new Promise<void>(() => {}));
    let outcome = "pending";
    void decodeStill("/c", () => x.img).then(
      () => (outcome = "decoded"),
      () => (outcome = "rejected"),
    );
    // a slow link: the still takes 30 s to come
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toBe("pending");
    x.load();
    await vi.advanceTimersByTimeAsync(DECODE_WAIT_MS - 1);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("rejected");
  });
});
