// "Save as default" of the v2 Style tab: what is kept, and what new
// uploads send (captionDefault.ts, defaults.ts uploadSettings).
import { describe, expect, it } from "vitest";
import { captionDefaultFromPrefs, defaultOfStyle, sameCaptionStyle } from "./captionDefault";
import { DEFAULT_SETTINGS, uploadSettings } from "./defaults";

describe("caption style default", () => {
  it("keeps the preset and the look, never a caption's own position", () => {
    expect(
      defaultOfStyle({ presetId: "karaoke", overrides: { sizeScale: 1.2, captions: { w0001: { y: 0.3 } }, offsetMs: undefined } }),
    ).toEqual({ presetId: "karaoke", overrides: { sizeScale: 1.2 } });
  });

  it("reads a stored prefs object, refusing junk", () => {
    expect(captionDefaultFromPrefs({ caption_style_default: { presetId: "boxed", overrides: { case: "upper" } } })).toEqual({
      presetId: "boxed",
      overrides: { case: "upper" },
    });
    expect(captionDefaultFromPrefs({ caption_style_default: { presetId: "<b>" } })).toBeNull();
    expect(captionDefaultFromPrefs({ style: "tight" })).toBeNull();
    expect(captionDefaultFromPrefs(null)).toBeNull();
  });

  it("compares regardless of key order", () => {
    const a = { presetId: "power", overrides: { y: 0.5, case: "upper" } };
    const b = { presetId: "power", overrides: { case: "upper", y: 0.5 } };
    expect(sameCaptionStyle(a, b)).toBe(true);
    expect(sameCaptionStyle(a, { ...b, presetId: "mega" })).toBe(false);
    expect(sameCaptionStyle(null, null)).toBe(true);
  });

  it("new uploads send its preset as the hint, instead of Clipper", () => {
    const s = uploadSettings(DEFAULT_SETTINGS, { returning: true, captionPreset: "karaoke" });
    expect(s.caption_style_hint).toBe("karaoke");
    expect(s.caption_preset).toBeUndefined();
    expect(uploadSettings(DEFAULT_SETTINGS, { returning: true }).caption_style_hint).toBe("clipper");
  });
});
