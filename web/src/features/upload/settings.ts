/**
 * The job settings POST /jobs stores (backend _clean_settings). Its own
 * module: uploadManager needs them without pulling in the upload code
 * (uploadJob.ts is a chunk of its own).
 *
 * UX6: target_aspect, the pace in `style` (tight / none; smooth in older
 * records), spoken_language and the caption-style hint; the SmartCam keys
 * stay for a backend from before UX6. The caption style picked on the
 * start screen goes whole in `caption_style` (D7: the server drops one
 * that isn't valid, the hint stays).
 */
export type UploadSettings = {
  target_aspect?: "9:16" | "16:9" | "original";
  style: string;
  voice_triggers: boolean;
  remove_fillers: boolean;
  spoken_language?: string;
  smartcam_enabled: boolean;
  smartcam_format: "portrait" | "landscape";
  resolution: string;
  output_formats: string[];
  caption_style_hint?: string;
  caption_style?: { presetId: string; overrides: Record<string, unknown> };
  caption_preset?: string;
};

/** The settings of an upload, or how to read them: a function is read
 *  when POST /jobs goes out, after the bytes are up and the gate opened
 *  — so a choice changed meanwhile still counts (UX6, D1). */
export type SettingsSource = UploadSettings | (() => UploadSettings);

export function readSettings(source: SettingsSource): UploadSettings {
  return typeof source === "function" ? source() : source;
}
