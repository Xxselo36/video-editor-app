/**
 * Caption engine v2 (UT2) — public API.
 *
 * Typical use (editor overlay, UT1/UT5):
 *   const style = resolveStyle(doc.style.presetId, doc.style.overrides, { W, H });
 *   const { words, breaks } = mapToOutput(clips, doc.words, { offsetMs: doc.style.overrides.offsetMs });
 *   await ensureFonts(style, { lang: doc.language, text: words.map((w) => w.text) });
 *   const r = new CaptionRenderer({ words, breaks, style, W, H, lang: doc.language });
 *   // every presented video frame (requestVideoFrameCallback):
 *   r.drawFrame(ctx, outputTime);
 *
 * Render worker (UT4, Node): the same, with a @napi-rs/canvas surface
 * factory and node/fonts.ts `nodeFontLoader`.
 */
export type * from "./types";
export { ANIM_STEPS, activeIndex, buildPages, drawCaptions, frameState, hitTest, layoutPage, pageIndexAt } from "./engine";
export type { DrawResult, FrameState } from "./engine";
export { caseText, geometry, layoutJSON, segmentChunk } from "./layout";
export { CaptionRenderer, browserSurface } from "./cache";
export type { RendererInput, RendererOptions } from "./cache";
export {
  DEFAULT_LIVE_PRESETS,
  DEFAULT_PRESET,
  LAUNCH_PRESETS,
  PRESET_IDS,
  defaultY,
  getPreset,
  isPresetId,
  listPresets,
  parseLiveList,
  presetStatus,
  resolveStyle,
} from "./presets";
export type { PresetInfo, PresetStatus } from "./presets";
export { PRESET_NAMES, presetName } from "./presetNames";
export { V1_PRESETS, migratePresetId } from "./migrate";
export { isEmphasis } from "./emphasis";
export {
  SUPPORT,
  normLang,
  presetSupport,
  scriptOfCodepoint,
  scriptOfLang,
  segmentsWithoutSpaces,
  wordScript,
} from "./scripts";
export type { PresetSupport, SupportLevel } from "./scripts";
export {
  browserFontLoader,
  cssFont,
  ensureFonts,
  faceChain,
  registerCaptionFont,
  setDefaultFontLoader,
} from "./fonts";
export type { FontLoader, FontStatus } from "./fonts";
export { fontTables, getFont, loadFontTables, measureText, setFontTables } from "./metrics";
export type { Face, FontJson, FontTables } from "./metrics";
export { loadShaper, shaperReady } from "./shape-hb";
export { OFFSET_LIMIT_MS, mapToOutput, outToSrc, outputDuration, srcToOut } from "./timeline";
export type { Clip, OutputTimeline, OutputWord, SourceWord } from "./timeline";
