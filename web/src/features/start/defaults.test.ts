// The start screen's settings (UX6): what POST /jobs sends, and the
// remembered defaults.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  prefsFromSettings,
  sameSettings,
  settingsFromPrefs,
  uploadSettings,
} from "./defaults";
import { readSettings } from "@/features/upload/settings";

describe("uploadSettings", () => {
  it("sends the TikTok defaults and no caption style for a new browser", () => {
    expect(uploadSettings(DEFAULT_SETTINGS, { returning: false })).toEqual({
      target_aspect: "9:16",
      style: "tight",
      remove_fillers: true,
      voice_triggers: true,
      smartcam_enabled: true,
      smartcam_format: "portrait",
      resolution: "1080",
      output_formats: [],
    });
  });

  it("keeps Clipper for a browser with earlier projects", () => {
    const s = uploadSettings(DEFAULT_SETTINGS, { returning: true });
    expect(s.caption_style_hint).toBe("clipper");
    expect(s.caption_preset).toBe("clipper");
  });

  it("sends the spoken language unless it is auto", () => {
    expect(uploadSettings({ ...DEFAULT_SETTINGS, spokenLanguage: "de" }, { returning: false }).spoken_language).toBe("de");
    expect("spoken_language" in uploadSettings(DEFAULT_SETTINGS, { returning: false })).toBe(false);
  });

  it("turns fillers and voice commands off for No cuts", () => {
    const s = uploadSettings({ ...DEFAULT_SETTINGS, pace: "none" }, { returning: false });
    expect(s).toMatchObject({ style: "none", remove_fillers: false, voice_triggers: false });
  });

  it("never asks a pre-UX6 backend for SmartCam unless the target is 9:16", () => {
    for (const targetAspect of ["16:9", "original"] as const) {
      const s = uploadSettings({ ...DEFAULT_SETTINGS, targetAspect }, { returning: false });
      expect(s).toMatchObject({ target_aspect: targetAspect, smartcam_enabled: false, output_formats: [] });
    }
  });

  it("is read when it is a function", () => {
    let pace: "tight" | "smooth" = "tight";
    const source = () => uploadSettings({ ...DEFAULT_SETTINGS, pace }, { returning: false });
    expect(readSettings(source).style).toBe("tight");
    pace = "smooth";
    expect(readSettings(source).style).toBe("smooth");
  });
});

describe("prefs", () => {
  it("round-trips", () => {
    const s = { ...DEFAULT_SETTINGS, targetAspect: "original" as const, pace: "smooth" as const, spokenLanguage: "ja" };
    expect(settingsFromPrefs(prefsFromSettings(s))).toEqual(s);
  });

  it("keeps the valid keys only", () => {
    expect(
      settingsFromPrefs({ target_aspect: "4:3", style: "balanced", remove_fillers: "yes", spoken_language: "xx-YY" }),
    ).toEqual({ pace: "smooth" });
    expect(settingsFromPrefs({ caption_style_by_aspect: {} })).toBeNull();
    expect(settingsFromPrefs(null)).toBeNull();
    expect(settingsFromPrefs([1])).toBeNull();
  });

  it("compares settings", () => {
    expect(sameSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(sameSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, voiceTriggers: false })).toBe(false);
  });
});
