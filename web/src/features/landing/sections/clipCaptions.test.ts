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
import { frameState } from "@/lib/captions/engine";
import { buildPages } from "@/lib/captions/layout";
import { getFont } from "@/lib/captions/metrics";
import { resolveStyle } from "@/lib/captions/presets";
import { scriptOfLang, segmentsWithoutSpaces } from "@/lib/captions/scripts";
import { hasShapingFont, loadShaper, registerShapingFont } from "@/lib/captions/shape-hb";
import type { Page } from "@/lib/captions/types";
import { captionWords, FIRST_WORD_AT, splitPhrases, spokenAt, spokenUntil } from "../captions/words";
import { SMALL_FRAME_OVERRIDES } from "../shared";
import {
  CLIP_LOOP_S,
  JOIN_S,
  WAIT_S,
  clipClock,
  clipPreset,
  firstPhrase,
  pausedAt,
  stepClipCaption,
  stillAt,
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
/** The last part of each clip that crossfades into its start (s,
 *  scene/clips.ts). */
const CROSSFADE_S = 0.4;

/** A phrase's or a page's characters, without spaces and brackets. */
const chars = (s: string) => s.normalize("NFC").replace(/[[\]\s]/g, "");
/** Where the [marked] word sits in a phrase's characters. */
function markSpan(phrase: string): [number, number] {
  const open = phrase.indexOf("[");
  const close = phrase.indexOf("]", open);
  const from = chars(phrase.slice(0, open)).length;
  return [from, from + chars(phrase.slice(open + 1, close)).length];
}
/** Each page word's span of the page's characters. */
function wordSpans(page: Page): [number, number][] {
  let at = 0;
  return page.words.map((w) => {
    const n = chars(w.source).length;
    at += n;
    return [at - n, at];
  });
}

/** Every line in every language, in its tile's style at both tile sizes. */
function* everyLine() {
  for (const lang of Object.keys(LANGS) as Lang[]) {
    const preset = clipPreset(lang)!;
    for (const key of CAPS) {
      const text = MESSAGES[lang][key] ?? "";
      for (const { W, H } of TILES) {
        const style = resolveStyle(preset, SMALL_FRAME_OVERRIDES[preset], { W, H })!;
        const pages = buildPages(captionWords(text, lang), style, { W, H, lang });
        const shown = pages.map((p) => p.words.map((w) => w.text).join(" ") + (p.oversized ? " (shrunk)" : ""));
        yield { lang, key, text, style, pages, where: `${lang} ${key} ${W}x${H}: ${text} -> ${shown.join(" / ")}` };
      }
    }
  }
}

describe("bonus clip captions: three phrases, one page each, in every language", () => {
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

  it("says each line in three phrases, each with its highlighted word marked", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      for (const key of CAPS) {
        const text = MESSAGES[lang][key];
        expect(text, `${lang} ${key}`).toBeTruthy();
        const phrases = splitPhrases(text!);
        expect(phrases, `${lang} ${key}: ${text}`).toHaveLength(3);
        for (const p of phrases) expect(p, `${lang} ${key}: ${text}`).toMatch(/^[^[\]]*\[[^[\]]+\][^[\]]*$/);
      }
    }
  });

  it("pages each line into its three phrases in the tile's style and size, none shrunk", () => {
    for (const { lang, text, pages, where } of everyLine()) {
      const phrases = splitPhrases(text);
      expect(pages, where).toHaveLength(3);
      pages.forEach((page, k) => {
        // the page is its phrase, whole
        expect(chars(page.words.map((w) => w.source).join("")), where).toBe(chars(phrases[k]));
        expect(page.oversized, where).toBe(false);
        // measured with the real fonts (CJK by estimate, as on the page:
        // its font is a per-job subset, fonts.ts deferred)
        if (scriptOfLang(lang) !== "cjk") expect(page.words.some((w) => w.approximate), where).toBe(false);
      });
      // the breath between two phrases never blanks the caption
      for (let k = 1; k < pages.length; k++) expect(pages[k - 1].end, where).toBeCloseTo(pages[k].start, 9);
    }
  });

  it("shows the first phrase whole at its still, its highlighted word lit, as the poster does", () => {
    const partly = new Set<string>();
    for (const { lang, key, text, style, pages, where } of everyLine()) {
      const state = frameState(pages, stillAt(text, lang), style);
      expect(state?.page, where).toBe(0);
      // at rest: the page's and the word's entrances done
      expect(state!.pageP, where).toBe(1);
      expect(state!.wordP, where).toBe(1);
      // the lit word is the marked one
      const [from, to] = markSpan(splitPhrases(text)[0]);
      const [a, b] = wordSpans(pages[0])[state!.active];
      const lit = pages[0].words[state!.active].source;
      expect(a, `${where}: lit ${lit}`).toBe(from);
      if (b !== to) {
        // unspaced text: the layout may cut it in pieces, its first is lit
        expect(segmentsWithoutSpaces(lang) && b < to, `${where}: lit ${lit}`).toBe(true);
        partly.add(`${lang} ${key}: ${lit} of ${chars(splitPhrases(text)[0]).slice(from, to)}`);
      }
      // karaoke: filled up to it, as the poster fills it
      if (state!.sweep !== null) expect(state!.sweep, where).toBe(1);
    }
    // the poster lights a marked word whole: no copy may mark a word the
    // layout lights in pieces (mark one it keeps whole instead)
    expect([...partly]).toEqual([]);
  });

  it("is spoken well before its clip loops: the last phrase holds, clear of the crossfade", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      for (const key of CAPS) {
        const spoken = spokenUntil(captionWords(MESSAGES[lang][key]!, lang));
        expect(CLIP_LOOP_S - CROSSFADE_S - spoken, `${lang} ${key}`).toBeGreaterThanOrEqual(1.1);
      }
    }
  });
});

describe("bonus clip captions: the still of a line", () => {
  /** The words of `text` and where its still stands among them. */
  const at = (text: string, lang = "en") => ({ w: captionWords(text, lang), t: stillAt(text, lang) });

  it("is the first phrase, as the poster draws it", () => {
    expect(firstPhrase("My best [tip] | for more [views] | hook them [fast]")).toBe("My best [tip]");
    expect(firstPhrase(" 3 tips for better [hooks] ")).toBe("3 tips for better [hooks]");
    expect(firstPhrase("")).toBe("");
  });

  it("stands where a line without '|' always settled: its last word spoken", () => {
    for (const lang of Object.keys(LANGS) as Lang[]) {
      const { w, t } = at(MESSAGES[lang]["site.demo.caption"]!, lang);
      expect(t, lang).toBe(spokenAt(w, w.length - 1));
    }
  });

  it("shows the first phrase with its marked word spoken, before the next word", () => {
    // the mark ends the phrase: the word fully spoken (karaoke: filled to
    // its end), phrase 2 not yet in
    const a = at("My best [tip] | for more [views] | hook them [fast]");
    expect(a.t).toBeGreaterThanOrEqual(a.w[2].end);
    expect(a.t).toBeLessThan(a.w[3].start);
    const long = at("Game [changer] | cut every [pause]");
    expect(long.t).toBe(long.w[1].end);
    // the mark opens the phrase: lit, its entrance done, "this" not yet
    const b = at("[Try] this out | add big [captions] | most are on [mute]");
    expect(b.t).toBeGreaterThanOrEqual(b.w[0].end - 0.02);
    expect(b.t).toBeGreaterThanOrEqual(b.w[0].start + 0.2);
    expect(b.t).toBeLessThan(b.w[1].start);
    // a one-letter mark in the middle (Korean): it stays the lit word
    const c = at("이걸로 [다] 바뀌어요 | 공백은 [잘라요] | 끝까지 [봐요]", "ko");
    expect(c.w[1].text).toBe("다");
    expect(c.t).toBeGreaterThanOrEqual(c.w[1].end - 0.02);
    expect(c.t).toBeLessThan(c.w[2].start);
    // a mark inside a joined word (3초에) and in unspaced Japanese
    const d = at("첫 [3초]에 잡아요", "ko");
    expect(d.t).toBeGreaterThanOrEqual(d.w[1].end - 0.02);
    expect(d.t).toBeLessThan(d.w[2].start);
    const e = at("これで[全部]変わる | 無言を[カット]", "ja");
    expect(e.w[1].text).toBe("全部");
    expect(e.t).toBeGreaterThanOrEqual(e.w[1].end - 0.02);
    expect(e.t).toBeLessThan(e.w[2].start);
    // a word the layout lights in pieces (試し, then て): its first piece,
    // its entrance done, before the second (timed by characters)
    const f = at("ぜひ[試して] | 字幕は[大きく]", "ja");
    expect(f.w[1].text).toBe("試して");
    expect(f.t).toBeGreaterThanOrEqual(f.w[1].start + 0.15);
    expect(f.t).toBeLessThan(f.w[1].start + ((f.w[1].end - f.w[1].start) * 2) / 3);
  });

  it("falls back to the first phrase's last word without a mark", () => {
    const { w, t } = at("one two | three");
    expect(t).toBeGreaterThanOrEqual(w[1].end);
    expect(t).toBeGreaterThanOrEqual(w[1].start + 0.3);
    expect(t).toBeLessThan(w[2].start);
    expect(stillAt("", "en")).toBe(0);
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

  it("paused, holds whichever phrase is showing; on its lead-in (between two loops), its still", () => {
    const still = 0.6;
    expect(pausedAt(0, still)).toBe(still);
    expect(pausedAt(FIRST_WORD_AT - 0.01, still)).toBe(still);
    // in the first phrase, the second, the last one's hold
    expect(pausedAt(0.4, still)).toBe(0.4);
    expect(pausedAt(1.9, still)).toBe(1.9);
    expect(pausedAt(5, still)).toBe(5);
  });
});

/** A caption 1.8 s long, its still (the first phrase) at 0.6 s, whose
 *  clip loops and plays. */
const STILL = 0.6;
const state = (o: Partial<ClipCaptionState> = {}): ClipCaptionState => ({
  loops: true,
  paused: false,
  video: video(),
  end: 1.8,
  still: STILL,
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

  it("plays once and settles on its still where the clips cannot move", () => {
    const c = clipClock();
    expect(stepClipCaption(c, 1, state({ loops: false, video: unloaded }))).toEqual({ at: 1, seek: null, busy: true });
    expect(stepClipCaption(c, 1, state({ loops: false, video: unloaded }))).toEqual({ at: STILL, seek: null, busy: false });
    expect(c.done).toBe(true);
    // settled: it stays on the first phrase, the ticker can stop
    expect(stepClipCaption(c, 1, state({ loops: false, video: unloaded }))).toEqual({ at: STILL, seek: null, busy: false });
  });

  it("does not hold half a line when data saver comes on while paused (no control is left)", () => {
    const c = clipClock();
    stepClipCaption(c, 0.016, state({ video: video({ time: 0.9 }) }));
    expect(stepClipCaption(c, 0.016, state({ paused: true })).at).toBe(0.9);
    expect(stepClipCaption(c, 0.5, state({ loops: false, paused: true, video: unloaded }))).toEqual({
      at: 1.4,
      seek: null,
      busy: true,
    });
    expect(stepClipCaption(c, 0.5, state({ loops: false, paused: true, video: unloaded }))).toEqual({
      at: STILL,
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
    // still paused from before data saver: the first phrase until resumed
    const p = clipClock();
    stepClipCaption(p, 2, state({ loops: false, video: unloaded }));
    expect(stepClipCaption(p, 0.016, state({ paused: true, video: loading }))).toEqual({ at: STILL, seek: null, busy: false });
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
