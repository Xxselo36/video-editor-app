// The choices of "Untertitel wählen" (D4, D5) and what POST /jobs sends
// for them (the payload table of the upload flow plan, rows 1 to 5).
import { describe, expect, it } from "vitest";
import { captionDefaultFromPrefs } from "./captionDefault";
import {
  captionsOnlyRow,
  effectiveAspect,
  fillersRow,
  initialChoices,
  lastUsedPrefs,
  moreSummary,
  outputShape,
  resumedChoices,
  settingsOf,
  styleTags,
  styleTiles,
  tileStyle,
  type ChoiceSources,
  type Choices,
} from "./choices";
import { lastStyleFromPrefs, settingsFromPrefs, uploadSettings } from "./defaults";
import type { VideoProbe } from "./probe";

const FIRST_VISIT: ChoiceSources = { saved: null, standard: null, lastStyle: null, live: undefined };
const UPRIGHT: VideoProbe = { width: 1080, height: 1920, duration: 104 };
const LANDSCAPE: VideoProbe = { width: 1920, height: 1080, duration: 104 };
const SQUARE: VideoProbe = { width: 1080, height: 1080, duration: 104 };
const UNKNOWN: VideoProbe = { width: null, height: null, duration: null };

/** What a stored or served prefs object gives the start screen (usePrefs). */
function fromPrefs(prefs: unknown, live?: readonly string[]): ChoiceSources {
  return {
    saved: settingsFromPrefs(prefs),
    standard: captionDefaultFromPrefs(prefs),
    lastStyle: lastStyleFromPrefs(prefs),
    live,
  };
}

/** The settings POST /jobs sends for `c`. */
const payload = (c: Choices, probe: VideoProbe | null = null) => uploadSettings(settingsOf(c, probe), { captionStyle: c.style });

/** A tap on a tile (no saved default). */
const pick = (c: Choices, presetId: string): Choices => ({ ...c, style: tileStyle(presetId, null) });

describe("the style", () => {
  it("first visit: Power, no tag, the TikTok defaults", () => {
    const c = initialChoices(FIRST_VISIT);
    expect(c).toEqual({
      style: { presetId: "power", overrides: {} },
      captionsOnly: false,
      fillers: true,
      aspect: "9:16",
      language: "auto",
    });
    expect(styleTags(FIRST_VISIT)).toEqual({});
    expect(payload(c)).toEqual({
      target_aspect: "9:16",
      style: "tight",
      remove_fillers: true,
      voice_triggers: true,
      smartcam_enabled: true,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "power",
      caption_style: { presetId: "power", overrides: {} },
    });
  });

  it("Dein Standard wins over the last used, drawn and sent with its look", () => {
    // An old "Save as default" of the cut pace changes nothing (row 4).
    const sources = fromPrefs({
      style: "smooth",
      caption_style_default: { presetId: "karaoke", overrides: { wordsPerPage: 2 } },
      caption_style_last: "neon",
    });
    const c = initialChoices(sources);
    expect(c.style).toEqual({ presetId: "karaoke", overrides: { wordsPerPage: 2 } });
    expect(styleTags(sources)).toEqual({ karaoke: "app.start.yourDefault", neon: "app.start.lastUsed" });
    // Its tile draws it with its look; the others plain.
    expect(tileStyle("karaoke", sources.standard)).toEqual({ presetId: "karaoke", overrides: { wordsPerPage: 2 } });
    expect(tileStyle("neon", sources.standard)).toEqual({ presetId: "neon", overrides: {} });
    expect(payload(c)).toEqual({
      target_aspect: "9:16",
      style: "tight",
      remove_fillers: true,
      voice_triggers: true,
      smartcam_enabled: true,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "karaoke",
      caption_style: { presetId: "karaoke", overrides: { wordsPerPage: 2 } },
    });
  });

  it("the last used is preselected and tagged when there is no standard", () => {
    const neon = fromPrefs({ caption_style_last: "neon" });
    expect(initialChoices(neon).style).toEqual({ presetId: "neon", overrides: {} });
    expect(styleTags(neon)).toEqual({ neon: "app.start.lastUsed" });
    // "Ohne Untertitel" too: its row gets the chip.
    const none = fromPrefs({ caption_style_last: "none" });
    expect(initialChoices(none).style).toEqual({ presetId: "none", overrides: {} });
    expect(styleTags(none)).toEqual({ none: "app.start.lastUsed" });
    // The standard is the last used: one tag.
    const same = fromPrefs({ caption_style_default: { presetId: "neon", overrides: {} }, caption_style_last: "neon" });
    expect(styleTags(same)).toEqual({ neon: "app.start.yourDefault" });
  });

  it("a style that isn't live is ignored", () => {
    const live = ["power", "neon", "none"];
    expect(styleTiles(live)).toEqual(["power", "neon"]);
    expect(styleTiles(undefined)).toHaveLength(12);
    const sources = fromPrefs(
      { caption_style_default: { presetId: "karaoke", overrides: { wordsPerPage: 2 } }, caption_style_last: "neon" },
      live,
    );
    expect(initialChoices(sources).style).toEqual({ presetId: "neon", overrides: {} });
    expect(styleTags(sources)).toEqual({ neon: "app.start.lastUsed" });
    expect(initialChoices(fromPrefs({ caption_style_last: "karaoke" }, live)).style.presetId).toBe("power");
    // Power itself not live: the first live style.
    expect(initialChoices({ ...FIRST_VISIT, live: ["boxed", "minimal", "none"] }).style.presetId).toBe("boxed");
    expect(initialChoices({ ...FIRST_VISIT, live: ["none"] }).style.presetId).toBe("none");
  });
});

describe("Mehr Optionen", () => {
  it("Nur Untertitel means no cuts, no fillers, no voice commands", () => {
    const c: Choices = { ...pick(initialChoices(FIRST_VISIT), "karaoke"), captionsOnly: true, aspect: "original", language: "de" };
    expect(captionsOnlyRow(c)).toEqual({ checked: true, disabled: false, note: "app.start.captionsOnlyNote" });
    expect(payload(c)).toEqual({
      target_aspect: "original",
      style: "none",
      remove_fillers: false,
      voice_triggers: false,
      spoken_language: "de",
      smartcam_enabled: false,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "karaoke",
      caption_style: { presetId: "karaoke", overrides: {} },
    });
  });

  it("Nur Untertitel is never preselected, even from the prefs of older screens", () => {
    const c = initialChoices(fromPrefs({ style: "none", voice_triggers: false }));
    expect(c.captionsOnly).toBe(false);
    expect(captionsOnlyRow(c)).toEqual({ checked: false, disabled: false, note: null });
    expect(payload(c)).toEqual({
      target_aspect: "9:16",
      style: "tight",
      remove_fillers: true,
      voice_triggers: true,
      smartcam_enabled: true,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "power",
      caption_style: { presetId: "power", overrides: {} },
    });
  });

  it("Ohne Untertitel turns Nur Untertitel off and gives it back", () => {
    const only: Choices = { ...initialChoices(FIRST_VISIT), captionsOnly: true };
    const none = pick(only, "none");
    expect(captionsOnlyRow(none)).toEqual({ checked: false, disabled: true, note: "app.start.captionsOnlyNeedsCaptions" });
    expect(fillersRow(none)).toEqual({ checked: true, disabled: false, note: null });
    expect(payload(none)).toEqual({
      target_aspect: "9:16",
      style: "tight",
      remove_fillers: true,
      voice_triggers: true,
      smartcam_enabled: true,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
      caption_style_hint: "none",
      caption_style: { presetId: "none", overrides: {} },
    });
    const back = pick(none, "clipper");
    expect(captionsOnlyRow(back)).toEqual({ checked: true, disabled: false, note: "app.start.captionsOnlyNote" });
    expect(payload(back).style).toBe("none");
  });

  it("filler removal keeps its wanted value while Nur Untertitel holds it off", () => {
    for (const fillers of [true, false]) {
      const c: Choices = { ...initialChoices(FIRST_VISIT), fillers, captionsOnly: true };
      expect(fillersRow(c)).toEqual({ checked: false, disabled: true, note: "app.start.fillersNeedCuts" });
      expect(lastUsedPrefs(c).remove_fillers).toBe(fillers);
      const cuts = { ...c, captionsOnly: false };
      expect(fillersRow(cuts)).toEqual({ checked: fillers, disabled: false, note: null });
      expect(payload(cuts).remove_fillers).toBe(fillers);
    }
  });

  it("Quer goes as Original for an upright video; the wish is remembered", () => {
    const c: Choices = { ...initialChoices(FIRST_VISIT), aspect: "16:9" };
    expect(effectiveAspect(c, UPRIGHT)).toBe("original");
    expect(payload(c, UPRIGHT)).toMatchObject({ target_aspect: "original", smartcam_enabled: false });
    expect(lastUsedPrefs(c).target_aspect).toBe("16:9");
    for (const probe of [LANDSCAPE, UNKNOWN, null]) expect(effectiveAspect(c, probe)).toBe("16:9");
    expect(initialChoices(fromPrefs(lastUsedPrefs(c))).aspect).toBe("16:9");
  });

  it("the captions are laid out on the shape the video gets", () => {
    const first = initialChoices(FIRST_VISIT);
    // A landscape video made Hochkant has Hochkant captions.
    for (const probe of [LANDSCAPE, UPRIGHT, UNKNOWN, null]) expect(outputShape(first, probe)).toEqual({ width: 9, height: 16 });
    expect(outputShape({ ...first, aspect: "16:9" }, LANDSCAPE)).toEqual({ width: 16, height: 9 });
    // Original: the video's own shape, unknown until it is measured.
    const original: Choices = { ...first, aspect: "original" };
    expect(outputShape(original, SQUARE)).toEqual({ width: 1080, height: 1080 });
    expect(outputShape({ ...first, aspect: "16:9" }, UPRIGHT)).toEqual({ width: 1080, height: 1920 });
    for (const probe of [UNKNOWN, null]) expect(outputShape(original, probe)).toBeNull();
  });

  it("the summary says what differs from the defaults, and Hochkant for a video that isn't upright", () => {
    const first = initialChoices(FIRST_VISIT);
    for (const probe of [UPRIGHT, UNKNOWN, null]) expect(moreSummary(first, probe)).toEqual([]);
    expect(moreSummary(first, LANDSCAPE)).toEqual(["app.start.formatPortrait"]);
    expect(moreSummary(first, SQUARE)).toEqual(["app.start.formatPortrait"]);
    const c: Choices = { ...first, captionsOnly: true, fillers: false, aspect: "original", language: "de" };
    expect(moreSummary(c, LANDSCAPE)).toEqual(["app.start.summaryCaptionsOnly", "app.start.formatOriginal", { language: "de" }]);
    expect(moreSummary({ ...c, captionsOnly: false }, LANDSCAPE)).toEqual([
      "app.start.summaryFillersKept",
      "app.start.formatOriginal",
      { language: "de" },
    ]);
    // What the video gets: Quer for a landscape one, Original for an upright one.
    expect(moreSummary({ ...first, aspect: "16:9" }, LANDSCAPE)).toEqual(["app.start.formatLandscape"]);
    expect(moreSummary({ ...first, aspect: "16:9" }, UPRIGHT)).toEqual(["app.start.formatOriginal"]);
  });
});

describe("last used", () => {
  it("remembers the format, fillers, language and style, never Nur Untertitel", () => {
    const c: Choices = {
      style: { presetId: "neon", overrides: {} },
      captionsOnly: true,
      fillers: false,
      aspect: "original",
      language: "de",
    };
    expect(lastUsedPrefs(c)).toEqual({
      target_aspect: "original",
      remove_fillers: false,
      spoken_language: "de",
      caption_style_last: "neon",
    });
  });
});

describe("a stopped upload picked again (a reload while it waited for Los geht's)", () => {
  /** The stopped upload's record as the start screen wrote it for `c`. */
  const recordOf = (c: Choices, probe: VideoProbe | null) => ({ settings: payload(c, probe), lastUsed: lastUsedPrefs(c) });
  const first = () => initialChoices(FIRST_VISIT);

  it("comes back with its choices: POST /jobs then sends what it would have (payload rows 1 to 3)", () => {
    const rows: [Choices, VideoProbe | null][] = [
      // 1: first visit.
      [first(), UPRIGHT],
      // 2: Nur Untertitel + Original + de + Karaoke.
      [{ ...pick(first(), "karaoke"), captionsOnly: true, aspect: "original", language: "de" }, LANDSCAPE],
      // 3: Ohne Untertitel.
      [pick(first(), "none"), UPRIGHT],
      // Elegant, fillers kept, Original, French (the review's journey).
      [{ ...pick(first(), "elegant"), fillers: false, aspect: "original", language: "fr" }, LANDSCAPE],
    ];
    for (const [c, probe] of rows) {
      const back = resumedChoices(recordOf(c, probe), undefined);
      expect(back).toEqual(c);
      expect(payload(back!, probe)).toEqual(payload(c, probe));
    }
  });

  it("keeps the wishes the record's settings can't hold: fillers under Nur Untertitel, Quer for an upright video", () => {
    const c: Choices = { ...pick(first(), "neon"), captionsOnly: true, fillers: true, aspect: "16:9", language: "es" };
    expect(resumedChoices(recordOf(c, UPRIGHT), undefined)).toEqual(c);
    // A record without them (older): what the settings say, filler removal as at first.
    expect(resumedChoices({ settings: payload(c, UPRIGHT) }, undefined)).toEqual({ ...c, aspect: "original" });
  });

  it("keeps a saved default's look", () => {
    const std = { presetId: "karaoke", overrides: { wordsPerPage: 2 } };
    const c = initialChoices({ ...FIRST_VISIT, standard: std });
    expect(resumedChoices(recordOf(c, UPRIGHT), undefined)?.style).toEqual(std);
  });

  it("none for a record the screen can't show: no caption style, a broken one, one no longer live", () => {
    const older = payload(first(), UPRIGHT);
    delete older.caption_style;
    expect(resumedChoices({ settings: older }, undefined)).toBeNull();
    expect(resumedChoices({}, undefined)).toBeNull();
    const broken = { ...payload(first(), UPRIGHT), caption_style: { presetId: "power", overrides: null } };
    expect(resumedChoices({ settings: broken as never }, undefined)).toBeNull();
    const neon = recordOf(pick(first(), "neon"), UPRIGHT);
    expect(resumedChoices(neon, ["power", "karaoke"])).toBeNull();
    expect(resumedChoices(recordOf(pick(first(), "none"), UPRIGHT), ["power"])?.style.presetId).toBe("none");
  });
});
