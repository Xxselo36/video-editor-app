import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LANGS, type Lang } from "@/i18n/langs";
import { deLanding } from "@/i18n/messages/de/landing";
import { enLanding } from "@/i18n/messages/en/landing";
import { esLanding } from "@/i18n/messages/es/landing";
import { frLanding } from "@/i18n/messages/fr/landing";
import { hiLanding } from "@/i18n/messages/hi/landing";
import { idLanding } from "@/i18n/messages/id/landing";
import { itLanding } from "@/i18n/messages/it/landing";
import { jaLanding } from "@/i18n/messages/ja/landing";
import { koLanding } from "@/i18n/messages/ko/landing";
import { nlLanding } from "@/i18n/messages/nl/landing";
import { plLanding } from "@/i18n/messages/pl/landing";
import { ptLanding } from "@/i18n/messages/pt/landing";
import { ruLanding } from "@/i18n/messages/ru/landing";
import { trLanding } from "@/i18n/messages/tr/landing";
import { FONTS_DIR, loadRealFonts } from "@/lib/captions/__tests__/helpers";
import { buildPages } from "@/lib/captions/layout";
import { getFont } from "@/lib/captions/metrics";
import { resolveStyle } from "@/lib/captions/presets";
import { scriptOfLang } from "@/lib/captions/scripts";
import { hasShapingFont, loadShaper, registerShapingFont } from "@/lib/captions/shape-hb";
import { captionWords, FIRST_WORD_AT } from "../captions/words";
import { SMALL_FRAME_OVERRIDES } from "../shared";
import {
  CLIP_LOOP_S,
  JOIN_S,
  WAIT_S,
  clipClock,
  clipPreset,
  pausedAt,
  stepClipCaption,
  tickClipClock,
  type ClipCaptionState,
  type ClipVideo,
} from "./clipCaptions";

const MESSAGES: Record<Lang, Partial<Record<keyof typeof enLanding, string>>> = {
  en: enLanding,
  de: deLanding,
  es: esLanding,
  fr: frLanding,
  pt: ptLanding,
  it: itLanding,
  tr: trLanding,
  pl: plLanding,
  nl: nlLanding,
  ru: ruLanding,
  ja: jaLanding,
  ko: koLanding,
  id: idLanding,
  hi: hiLanding,
};
const CAPS = ["site.clips.cap1", "site.clips.cap2", "site.clips.cap3"] as const;
/** The tile's canvas (Format.module.css .clipsFig --tw, 9:16) at its
 *  narrowest and widest, at 2x: the pages only depend on the shape. */
const TILES = [
  { W: 188, H: 334 },
  { W: 272, H: 484 },
];

describe("bonus clip captions: one page in every language", () => {
  beforeAll(async () => {
    loadRealFonts();
    // Hindi is measured by HarfBuzz in the browser (fonts.ts ensureFonts)
    await loadShaper();
    const face = getFont("poppins-800")!.face("devanagari")!;
    if (!hasShapingFont(face.key)) registerShapingFont(face.key, fs.readFileSync(path.join(FONTS_DIR, face.file)));
  });

  it("has a style for every language: Power, Karaoke for Hindi", () => {
    for (const lang of Object.keys(LANGS)) expect(clipPreset(lang), lang).toBe(lang === "hi" ? "karaoke" : "power");
  });

  it("fits each line on one page in the tile's style and size, so any still shows the whole sentence", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      const preset = clipPreset(lang)!;
      for (const key of CAPS) {
        const text = MESSAGES[lang][key];
        expect(text, `${lang} ${key}`).toBeTruthy();
        // the highlighted word is marked
        expect(text, `${lang} ${key}`).toMatch(/\[[^\]]+\]/);
        for (const { W, H } of TILES) {
          const style = resolveStyle(preset, SMALL_FRAME_OVERRIDES[preset], { W, H })!;
          const pages = buildPages(captionWords(text!, lang), style, { W, H, lang });
          const shown = pages.map((p) => p.words.map((w) => w.text).join(" ") + (p.oversized ? " (shrunk)" : ""));
          expect(shown, `${lang} ${key}: ${text}`).toHaveLength(1);
          expect(pages[0].oversized, `${lang} ${key}: ${text}`).toBe(false);
          // measured with the real fonts (CJK by estimate, as on the page:
          // its font is a per-job subset, fonts.ts deferred)
          if (scriptOfLang(lang) !== "cjk") expect(pages[0].words.some((w) => w.approximate), `${lang} ${key}`).toBe(false);
        }
      }
    }
  });
});

const video = (o: Partial<ClipVideo> = {}): ClipVideo => ({
  src: true,
  frame: true,
  playing: true,
  time: 0,
  duration: 6,
  ...o,
});

describe("bonus clip captions: the clock", () => {
  it("follows a playing video and starts the line again when the clip loops", () => {
    const c = clipClock();
    expect(tickClipClock(c, 0.016, video({ time: 0.01 }))).toEqual({ seek: null, held: false });
    expect(c.t).toBe(0.01);
    tickClipClock(c, 0.016, video({ time: 5.98 }));
    expect(c.t).toBe(5.98);
    tickClipClock(c, 0.016, video({ time: 0.02 }));
    expect(c.t).toBe(0.02);
  });

  it("holds with its paused or stalled video", () => {
    const c = clipClock();
    tickClipClock(c, 0.016, video({ time: 1.2 }));
    expect(tickClipClock(c, 0.016, video({ time: 1.2, playing: false }))).toEqual({ seek: null, held: true });
    expect(c.t).toBe(1.2);
    // stalled (playing, its time not moving): the caption waits with it
    tickClipClock(c, 0.1, video({ time: 1.2 }));
    expect(c.t).toBe(1.2);
  });

  it("stays in step through the clip's own loop, a frame missing while it seeks", () => {
    const c = clipClock();
    tickClipClock(c, 0.016, video({ time: 5.98 }));
    expect(tickClipClock(c, 0.016, video({ time: 0, frame: false }))).toEqual({ seek: null, held: false });
    expect(c.t).toBe(5.98);
    expect(c.synced).toBe(true);
    expect(tickClipClock(c, 0.016, video({ time: 0.02 }))).toEqual({ seek: null, held: false });
    expect(c.t).toBe(0.02);
  });

  it("waits a moment for a video that is about to play, then goes on without it", () => {
    const c = clipClock();
    const still = video({ playing: false });
    tickClipClock(c, WAIT_S / 2, still);
    tickClipClock(c, WAIT_S / 2, still);
    expect(c.t).toBe(0);
    tickClipClock(c, 0.1, still);
    expect(c.t).toBeCloseTo(0.1);
  });

  it("runs on its own clock with the clip's length when there is no video to follow", () => {
    // data saver: no source at all
    const c = clipClock();
    tickClipClock(c, 0.1, video({ src: false, frame: false, playing: false, duration: NaN }));
    expect(c.t).toBeCloseTo(0.1);
    c.t = CLIP_LOOP_S - 0.05;
    tickClipClock(c, 0.1, null);
    expect(c.t).toBeCloseTo(0.05);
    // a refused autoplay: the video knows its length
    const r = clipClock();
    r.waited = WAIT_S;
    r.t = 6.95;
    tickClipClock(r, 0.1, video({ playing: false, duration: 7 }));
    expect(r.t).toBeCloseTo(0.05);
  });

  it("starts in step with a video that plays on time, and a late video jumps to the caption", () => {
    // waited (t still 0): the caption takes the video's time, no seek
    const onTime = clipClock();
    expect(tickClipClock(onTime, 0.016, video({ time: 0.06 }))).toEqual({ seek: null, held: false });
    expect(onTime.t).toBe(0.06);
    // within a frame behind: no seek either
    const close = clipClock();
    close.t = 0.03;
    expect(tickClipClock(close, 0.016, video({ time: 0.03 - JOIN_S + 0.001 })).seek).toBeNull();
    // it went on alone: the video joins it, the words never restart
    const late = clipClock();
    late.t = 1.3;
    expect(tickClipClock(late, 0.016, video({ time: 0 }))).toEqual({ seek: 1.3, held: false });
    expect(late.t).toBe(1.3);
    expect(late.synced).toBe(true);
    // once in step it only follows
    tickClipClock(late, 0.016, video({ time: 1.33 }));
    expect(late.t).toBe(1.33);
  });

  it("goes on alone when its video is unloaded (data saver switched on)", () => {
    const c = clipClock();
    tickClipClock(c, 0.016, video({ time: 2 }));
    tickClipClock(c, 0.1, video({ src: false, frame: false, playing: false, time: 0 }));
    expect(c.synced).toBe(false);
    expect(c.t).toBeCloseTo(2.1);
  });

  it("paused on its lead-in (between two loops) shows the whole sentence", () => {
    expect(pausedAt(0, 1.8)).toBe(1.8);
    expect(pausedAt(FIRST_WORD_AT - 0.01, 1.8)).toBe(1.8);
    expect(pausedAt(1.2, 1.8)).toBe(1.2);
    expect(pausedAt(4, 1.8)).toBe(4);
  });
});

/** A caption 1.8 s long whose clip loops and plays. */
const state = (o: Partial<ClipCaptionState> = {}): ClipCaptionState => ({
  loops: true,
  paused: false,
  video: video(),
  end: 1.8,
  ...o,
});
/** Data saver: the clip is unloaded, its control gone. */
const unloaded = video({ src: false, frame: false, playing: false, time: 0, duration: NaN });

describe("bonus clip captions: a caption on the section's ticker", () => {
  it("follows its clip and holds with the pause control", () => {
    const c = clipClock();
    expect(stepClipCaption(c, 0.016, state({ video: video({ time: 1.2 }) }))).toEqual({ at: 1.2, seek: null, busy: true });
    expect(stepClipCaption(c, 0.016, state({ paused: true }))).toEqual({ at: 1.2, seek: null, busy: false });
    expect(c.t).toBe(1.2);
  });

  it("plays once and settles where the clips cannot move", () => {
    const c = clipClock();
    expect(stepClipCaption(c, 1, state({ loops: false, video: unloaded }))).toEqual({ at: 1, seek: null, busy: true });
    expect(stepClipCaption(c, 1, state({ loops: false, video: unloaded }))).toEqual({ at: 1.8, seek: null, busy: false });
    expect(c.done).toBe(true);
    // settled: it stays on the whole sentence, the ticker can stop
    expect(stepClipCaption(c, 1, state({ loops: false, video: unloaded }))).toEqual({ at: 1.8, seek: null, busy: false });
  });

  it("does not hold half a sentence when data saver comes on while paused (no control is left)", () => {
    const c = clipClock();
    stepClipCaption(c, 0.016, state({ video: video({ time: 0.9 }) }));
    expect(stepClipCaption(c, 0.016, state({ paused: true })).at).toBe(0.9);
    expect(stepClipCaption(c, 0.5, state({ loops: false, paused: true, video: unloaded }))).toEqual({
      at: 1.4,
      seek: null,
      busy: true,
    });
    expect(stepClipCaption(c, 0.5, state({ loops: false, paused: true, video: unloaded }))).toEqual({
      at: 1.8,
      seek: null,
      busy: false,
    });
  });

  it("starts a settled line over with its clip once the clips can move again", () => {
    const c = clipClock();
    stepClipCaption(c, 2, state({ loops: false, video: unloaded }));
    expect(c.done).toBe(true);
    // the clip loads again: the caption waits for it on its lead-in
    const loading = video({ frame: false, playing: false, time: 0 });
    expect(stepClipCaption(c, 0.016, state({ video: loading }))).toEqual({ at: 0, seek: null, busy: true });
    expect(c.done).toBe(false);
    // it plays from its first frame: the line plays with it, no jump
    expect(stepClipCaption(c, 0.016, state({ video: video({ time: 0.02 }) }))).toEqual({ at: 0.02, seek: null, busy: true });
    // still paused from before data saver: the whole sentence until resumed
    const p = clipClock();
    stepClipCaption(p, 2, state({ loops: false, video: unloaded }));
    expect(stepClipCaption(p, 0.016, state({ paused: true, video: loading }))).toEqual({ at: 1.8, seek: null, busy: false });
  });

  it("joins a line still under way to its clip, which comes back from its first frame", () => {
    const c = clipClock();
    stepClipCaption(c, 0.016, state({ video: video({ time: 0.5 }) }));
    stepClipCaption(c, 0.5, state({ loops: false, video: unloaded }));
    expect(c.synced).toBe(false);
    expect(c.done).toBe(false);
    // the words never start over mid-line: the clip jumps to them
    expect(stepClipCaption(c, 0.016, state({ video: video({ time: 0 }) }))).toEqual({ at: 1, seek: 1, busy: true });
  });
});
