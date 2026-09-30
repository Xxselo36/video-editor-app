import { beforeAll, describe, expect, it } from "vitest";
import { registerCaptionFont } from "../fonts";
import { buildPages, layoutPage } from "../layout";
import type { FontJson } from "../metrics";
import { resolveStyle } from "../presets";
import type { CaptionStyle, CaptionWord, Page } from "../types";
import { AUDIT_WORDS, timed, loadRealFonts } from "./helpers";

const W = 1080;
const H = 1920;
const style = (id: string, o = {}) => resolveStyle(id, o, { W, H }) as CaptionStyle;
const texts = (pages: Page[]) => pages.map((p) => p.words.map((w) => w.source).join(" "));

beforeAll(() => {
  loadRealFonts();
});

describe("paging rules (captions.md §4.4)", () => {
  it("never crosses a cut", () => {
    const words = timed("we keep talking about the thing that matters most to all of us here today");
    const cut = words[5].start - 0.01; // between "that" and "matters"
    for (const id of ["power", "karaoke", "subtitle", "minimal"]) {
      const pages = buildPages(words, style(id), { W, H, lang: "en", breaks: [cut] });
      for (const p of pages) {
        const before = p.words.some((w) => w.start < cut);
        const after = p.words.some((w) => w.start >= cut);
        expect(before && after, `${id}: ${p.words.map((w) => w.source).join(" ")}`).toBe(false);
        if (before) expect(p.end).toBeLessThanOrEqual(cut + 1e-9);
      }
    }
  });

  it("never crosses a sentence end", () => {
    const pages = buildPages(timed("Stop now. Start again! Really? Yes… fine"), style("subtitle"), { W, H, lang: "en" });
    expect(texts(pages)).toEqual(["Stop now.", "Start again!", "Really?", "Yes…", "fine"]);
  });

  it("never crosses a pause longer than maxGapSec", () => {
    const s = style("power"); // maxGapSec 0.6
    const words: CaptionWord[] = [
      { text: "one", start: 0, end: 0.3 },
      { text: "two", start: 0.8, end: 1.1 }, // gap 0.5: same page
      { text: "three", start: 1.75, end: 2.0 }, // gap 0.65: new page
    ];
    expect(texts(buildPages(words, s, { W, H, lang: "en" }))).toEqual(["one two", "three"]);
  });

  it("starts a page at a user break", () => {
    const words = timed("alpha beta gamma delta");
    words[2].breakBefore = true;
    expect(texts(buildPages(words, style("power"), { W, H, lang: "en" }))).toEqual(["alpha beta", "gamma delta"]);
  });

  it("orphan rule: no lonely last word after a page of 3+", () => {
    // 7 short words, power holds 6 (3 × 2): greedy would leave "go" alone
    const pages = buildPages(timed("we can do it if we go."), style("power"), { W, H, lang: "en" });
    expect(pages.map((p) => p.words.length)).toEqual([5, 2]);
    // One Word is one word per page by design
    const punch = buildPages(timed("we can do it if we go."), style("punch"), { W, H, lang: "en" });
    expect(punch.every((p) => p.words.length === 1)).toBe(true);
  });

  it("a clause end closes a page once it is half full", () => {
    const pages = buildPages(timed("one two three, four five six seven"), style("power"), { W, H, lang: "en" });
    expect(texts(pages)[0]).toBe("one two three,");
    const early = buildPages(timed("well, we will see what happens"), style("power"), { W, H, lang: "en" });
    expect(texts(early)[0].startsWith("well, we")).toBe(true);
  });

  it("never leaves a punctuation-only token alone ('100 %', 'kommst –', '« oui')", () => {
    const pages = buildPages(timed("mehr als 100 % – sagt er « oui »"), style("subtitle"), { W, H, lang: "de" });
    const ws = pages.flatMap((p) => p.words.map((w) => w.source));
    expect(ws).toEqual(["mehr", "als", "100 % –", "sagt", "er", "« oui »"]);
    expect(pages[0].words.find((w) => w.source.startsWith("100"))?.emphasis).toBe(true);
  });

  it("caps words per caption with the wordsPerPage override", () => {
    const words = timed("this sentence has quite a few words to show on screen");
    for (const n of [1, 2, 3] as const) {
      const pages = buildPages(words, style("power", { wordsPerPage: n }), { W, H, lang: "en" });
      expect(Math.max(...pages.map((p) => p.words.length))).toBeLessThanOrEqual(n);
      expect(pages.flatMap((p) => p.words.map((w) => w.source))).toEqual(words.map((w) => w.text));
    }
  });

  it("pages fit maxLines and maxWidth with the real metrics", () => {
    for (const id of ["power", "mega", "clipper", "karaoke", "boxed", "subtitle", "neon", "gradient", "elegant"]) {
      const s = style(id);
      const pages = buildPages(timed("Nobody waits ten seconds for you to get to the point, so start with the result"), s, {
        W,
        H,
        lang: "en",
      });
      for (const p of pages) {
        const l = layoutPage(p, s, { W, H, lang: "en" });
        expect(l.lines.length).toBeLessThanOrEqual(s.layout.maxLines);
        for (const line of l.lines) {
          expect(line.words.length).toBeLessThanOrEqual(s.layout.wordsPerLine);
          if (!p.oversized) expect(line.right - line.left).toBeLessThanOrEqual(s.layout.maxWidth * W + 1e-6);
          for (let i = 1; i < line.words.length; i++) {
            expect(line.words[i].x).toBeGreaterThan(line.words[i - 1].x + line.words[i - 1].width);
          }
        }
      }
    }
  });

  it("page timing: first word start → min(last end + hold, next page, next cut)", () => {
    const s = style("power"); // hold 0.35
    const pages = buildPages(AUDIT_WORDS, s, { W, H, lang: "en" });
    expect(pages[0].start).toBe(0);
    for (let i = 0; i + 1 < pages.length; i++) expect(pages[i].end).toBeLessThanOrEqual(pages[i + 1].start);
    const last = pages[pages.length - 1];
    expect(last.end).toBeCloseTo(2.974 + 0.35, 9);
    const cutPages = buildPages(AUDIT_WORDS, s, { W, H, lang: "en", breaks: [3.1] });
    expect(cutPages[cutPages.length - 1].end).toBeCloseTo(3.1, 9);
  });
});

describe("font size", () => {
  it("is the same on every page, except a single oversized word", () => {
    const s = style("punch"); // 0.15 of the short side: long words overflow
    const words = timed("go internationalization now wow", {});
    const pages = buildPages(words, s, { W, H, lang: "en" });
    const pxs = pages.map((p) => layoutPage(p, s, { W, H, lang: "en" }).px);
    const normal = pages.filter((p) => !p.oversized).map((p) => layoutPage(p, s, { W, H, lang: "en" }).px);
    expect(new Set(normal).size).toBe(1);
    const big = pages.find((p) => p.oversized)!;
    expect(big.words.map((w) => w.source)).toEqual(["internationalization"]);
    const l = layoutPage(big, s, { W, H, lang: "en" });
    expect(l.px).toBeLessThan(normal[0]);
    expect(l.lines[0].right - l.lines[0].left).toBeLessThanOrEqual(s.layout.maxWidth * W + 1e-6);
    expect(pxs).toHaveLength(4);
  });

  it("does not shrink pages in the other presets either", () => {
    for (const id of ["power", "karaoke", "subtitle", "clipper"]) {
      const s = style(id);
      const pages = buildPages(timed("a short line and then a considerably longer continuation of the sentence"), s, {
        W,
        H,
        lang: "en",
      });
      const px = new Set(pages.filter((p) => !p.oversized).map((p) => layoutPage(p, s, { W, H, lang: "en" }).px));
      expect(px.size).toBe(1);
      expect([...px][0]).toBeCloseTo(s.font.size * W, 9);
    }
  });
});

describe("case mapping", () => {
  it("uses the transcript language (Turkish i/İ, German ß)", () => {
    const s = style("power");
    const tr = buildPages(timed("istanbul ılık"), s, { W, H, lang: "tr" });
    expect(tr[0].words.map((w) => w.text)).toEqual(["İSTANBUL", "ILIK"]);
    const en = buildPages(timed("istanbul"), s, { W, H, lang: "en" });
    expect(en[0].words[0].text).toBe("ISTANBUL");
    const de = buildPages(timed("straße"), s, { W, H, lang: "de" });
    expect(de[0].words[0].text).toBe("STRASSE");
    // "İ" has real metrics (latin subset), so the layout is exact
    expect(tr[0].words[0].approximate).toBeUndefined();
  });

  it("keeps the spoken case for as-spoken presets", () => {
    const pages = buildPages(timed("Hello there"), style("karaoke"), { W, H, lang: "en" });
    expect(pages[0].words.map((w) => w.text)).toEqual(["Hello", "there"]);
  });
});

describe("CJK (Intl.Segmenter, fixture metrics)", () => {
  // A tiny stand-in for a job's Noto Sans JP subset (UT3): 1 em per character.
  const chars = "今日はとてもいい天気ですね。明日も晴れるでしょう！";
  const fixture: FontJson = {
    name: "Fixture JP",
    weight: 800,
    italic: false,
    unitsPerEm: 1000,
    ascender: 880,
    descender: -120,
    capHeight: 733,
    xHeight: 543,
    subsets: {
      job: {
        family: "cc-fixture-jp",
        file: "fixture.woff2",
        bytes: 0,
        sha256: "",
        unicodeRange: [...new Set(chars)].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`).join(","),
      },
    },
    advances: [...new Set(chars)].map((c) => [c.codePointAt(0)!, 1000]),
    kerning: { left: [], right: [], nRight: 0, values: [] },
  };

  beforeAll(() => {
    registerCaptionFont("noto-sans-jp-800", fixture);
  });

  // Whisper-like tokens: one or two characters each
  const tokens = ["今日", "は", "と", "ても", "いい", "天", "気", "です", "ね", "。", "明日", "も", "晴れ", "る", "で", "しょう", "！"];
  const words: CaptionWord[] = tokens.map((t, i) => ({ id: `t${i}`, text: t, start: i * 0.2, end: i * 0.2 + 0.18 }));

  it("re-segments tokens into words, keeps text and time order, no spaces", () => {
    const s = style("power");
    const pages = buildPages(words, s, { W, H, lang: "ja" });
    const all = pages.flatMap((p) => p.words);
    expect(all.map((w) => w.source).join("")).toBe(tokens.join(""));
    expect(all.map((w) => w.source)).toContain("天気");
    expect(all.find((w) => w.source.includes("。"))?.source).toBe("ね。");
    for (let i = 1; i < all.length; i++) expect(all[i].start).toBeGreaterThanOrEqual(all[i - 1].start);
    for (const p of pages) {
      p.words.slice(0, -1).forEach((w) => expect(w.spaceAfterEm).toBe(0));
      expect(p.words.every((w) => w.approximate === undefined)).toBe(true);
    }
    // the sentence end (。) ends a page
    const firstSentence = pages.findIndex((p) => p.words.some((w) => w.source.endsWith("。")));
    expect(pages[firstSentence].words[pages[firstSentence].words.length - 1].source).toBe("ね。");
  });

  it("lays out CJK words by the fixture advances (1 em each)", () => {
    const s = style("power");
    const pages = buildPages(words, s, { W, H, lang: "ja" });
    const l = layoutPage(pages[0], s, { W, H, lang: "ja" });
    const first = l.lines[0].words;
    const px = s.font.size * W;
    expect(first[0].width).toBeCloseTo([...pages[0].words[0].text].length * px, 6);
    // words touch: no space between CJK words
    for (let i = 1; i < first.length; i++) expect(first[i].x).toBeCloseTo(first[i - 1].x + first[i - 1].width, 6);
  });

  it("splits a token the segmenter cuts, with times interpolated by character", () => {
    const one: CaptionWord[] = [{ id: "x", text: "今日はいい天気", start: 0, end: 1.4 }];
    const pages = buildPages(one, style("subtitle"), { W, H, lang: "ja" });
    const ws = pages.flatMap((p) => p.words);
    expect(ws.map((w) => w.source)).toEqual(["今日", "は", "いい", "天気"]);
    expect(ws[0].start).toBe(0);
    expect(ws[1].start).toBeCloseTo(0.4, 9);
    expect(ws[3].end).toBeCloseTo(1.4, 9);
    expect(ws.every((w) => w.id === "x")).toBe(true);
  });
});
