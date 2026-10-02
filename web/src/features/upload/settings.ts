/**
 * The job settings POST /jobs stores (backend _clean_settings). Its own
 * module: uploadManager needs them without pulling in the upload code
 * (uploadJob.ts is a chunk of its own).
 *
 * UX6: target_aspect, the pace in `style` (tight / smooth / none),
 * spoken_language and the caption-style hint; the SmartCam keys stay for
 * a backend from before UX6.
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
  caption_preset?: string;
};

/** The settings of an upload, or how to read them: a function is read
 *  when POST /jobs goes out, after the bytes are up — so a setting
 *  changed during the upload still counts (UX6). */
export type SettingsSource = UploadSettings | (() => UploadSettings);

export function readSettings(source: SettingsSource): UploadSettings {
  return typeof source === "function" ? source() : source;
}
