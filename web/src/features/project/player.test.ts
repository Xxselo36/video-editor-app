// The Vorschau player's logic (player.ts): when it waits for the file
// (spinner, aria-busy) and when it has none of it yet (after 10 s "the
// preview is still being prepared"), the scrub line, the clips the
// preview's captions map through, and what it shows of the captions.
import { describe, expect, it } from "vitest";
import type { Fetched } from "@/features/editor/state/docFetch";
import { BUSY, EMPTY, PLAYING, editSegsOf, playbackOf, previewCaptions, progressOf } from "./player";

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
