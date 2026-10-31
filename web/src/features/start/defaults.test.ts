// The settings of a new video (UX6, D6, D7): what POST /jobs sends, and
// what the prefs remember of them.
import { describe, expect, it } from "vitest";
import { initialChoices, lastUsedPrefs, settingsOf } from "./choices";
import { DEFAULT_SETTINGS, lastStyleFromPrefs, settingsFromPrefs, uploadSettings, type Pace } from "./defaults";
import { readSettings } from "@/features/upload/settings";

const POWER = { presetId: "power", overrides: {} };

describe("uploadSettings", () => {
  it("sends the TikTok defaults and the picked style, as the hint and whole", () => {
    expect(uploadSettings(DEFAULT_SETTINGS, { captionStyle: POWER })).toEqual({
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

  it("never sends Clipper or a v1 caption preset", () => {
    for (const presetId of ["power", "karaoke", "none"]) {
      const s = uploadSettings(DEFAULT_SETTINGS, { captionStyle: { presetId, overrides: {} } });
      expect(s.caption_style_hint).toBe(presetId);
      expect(s).not.toHaveProperty("caption_preset");
    }
  });

  it("sends the spoken language unless it is auto", () => {
    expect(uploadSettings({ ...DEFAULT_SETTINGS, spokenLanguage: "de" }, { captionStyle: POWER }).spoken_language).toBe("de");
    expect("spoken_language" in uploadSettings(DEFAULT_SETTINGS, { captionStyle: POWER })).toBe(false);
  });

  it("turns fillers and voice commands off for No cuts", () => {
    const s = uploadSettings({ ...DEFAULT_SETTINGS, pace: "none" }, { captionStyle: POWER });
    expect(s).toMatchObject({ style: "none", remove_fillers: false, voice_triggers: false });
  });

  it("never asks a pre-UX6 backend for SmartCam unless the target is 9:16", () => {
    for (const targetAspect of ["16:9", "original"] as const) {
      const s = uploadSettings({ ...DEFAULT_SETTINGS, targetAspect }, { captionStyle: POWER });
      expect(s).toMatchObject({ target_aspect: targetAspect, smartcam_enabled: false, output_formats: [] });
    }
  });

  it("is read when it is a function", () => {
    let pace: Pace = "tight";
    const source = () => uploadSettings({ ...DEFAULT_SETTINGS, pace }, { captionStyle: POWER });
    expect(readSettings(source).style).toBe("tight");
    pace = "none";
    expect(readSettings(source).style).toBe("none");
  });
});

describe("prefs", () => {
  it("round-trip the last used choices; the cut stays tight", () => {
    const used = {
      style: { presetId: "neon", overrides: {} },
      captionsOnly: true,
      fillers: false,
      aspect: "original" as const,
      language: "ja",
    };
    const stored: unknown = JSON.parse(JSON.stringify(lastUsedPrefs(used)));
    expect(settingsFromPrefs(stored)).toEqual({ targetAspect: "original", removeFillers: false, spokenLanguage: "ja" });
    expect(lastStyleFromPrefs(stored)).toBe("neon");
    const next = initialChoices({ saved: settingsFromPrefs(stored), standard: null, lastStyle: lastStyleFromPrefs(stored), live: undefined });
    expect(next).toEqual({ ...used, captionsOnly: false });
    expect(settingsOf(next, null).pace).toBe("tight");
  });

  it("keeps the valid keys only, never the pace or voice commands older screens saved", () => {
    expect(
      settingsFromPrefs({ target_aspect: "4:3", style: "balanced", remove_fillers: "yes", spoken_language: "xx-YY", voice_triggers: false }),
    ).toBeNull();
    expect(settingsFromPrefs({ style: "none", voice_triggers: false, remove_fillers: false })).toEqual({ removeFillers: false });
    expect(settingsFromPrefs({ caption_style_by_aspect: {} })).toBeNull();
    expect(settingsFromPrefs(null)).toBeNull();
    expect(settingsFromPrefs([1])).toBeNull();
  });

  it("reads the last used style, refusing junk", () => {
    expect(lastStyleFromPrefs({ caption_style_last: "none" })).toBe("none");
    expect(lastStyleFromPrefs({ caption_style_last: "bogus" })).toBeNull();
    expect(lastStyleFromPrefs({ caption_style_last: 3 })).toBeNull();
    expect(lastStyleFromPrefs({ style: "tight" })).toBeNull();
    expect(lastStyleFromPrefs(null)).toBeNull();
  });
});
