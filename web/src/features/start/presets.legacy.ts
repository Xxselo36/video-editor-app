/**
 * The workflow presets of the /app start screens, and the caption-style,
 * cut-style and export-format options (moved from
 * app/app/page.tsx in UX4). Legacy: one workflow replaces the presets
 * (flows.md §2.6).
 */
import { IconCaptions, IconMic, IconPhone, IconSliders, IconVlog } from "@/components/Icons";
import type { TFn } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";

export const CAPTION_PRESETS: { id: string; labelKey: MessageKey }[] = [
  { id: "clean", labelKey: "app.captions.clean" },
  { id: "classic", labelKey: "app.captions.classic" },
  { id: "clipper", labelKey: "app.captions.clipper" },
  { id: "highlight", labelKey: "app.captions.highlight" },
  { id: "flash", labelKey: "app.captions.flash" },
  { id: "punch", labelKey: "app.captions.punch" },
  { id: "elegant", labelKey: "app.captions.elegant" },
  { id: "subtle", labelKey: "app.captions.subtle" },
  { id: "none", labelKey: "app.captions.none" },
];

// Display name of a caption preset id (falls back to the raw id).
export function captionLabel(id: string, t: TFn): string {
  const c = CAPTION_PRESETS.find((x) => x.id === id);
  return c ? t(c.labelKey) : id;
}

export const CUT_STYLES: { id: string; labelKey: MessageKey; descKey: MessageKey }[] = [
  { id: "tight", labelKey: "app.cutStyle.tight.label", descKey: "app.cutStyle.tight.desc" },
  { id: "balanced", labelKey: "app.cutStyle.balanced.label", descKey: "app.cutStyle.balanced.desc" },
  { id: "smooth", labelKey: "app.cutStyle.smooth.label", descKey: "app.cutStyle.smooth.desc" },
];

// Workflow presets — Tool-Picker cards on the /app landing.
// Each preset pre-loads a bundle of settings tuned for a use case.
// "custom" opens the full Configure screen for tinkerers.
export type PresetId = "tiktok" | "podcast" | "captions" | "vlog" | "custom";

export const PRESETS: Record<
  PresetId,
  {
    labelKey: MessageKey;
    taglineKey: MessageKey;
    descKey: MessageKey;
    settings: {
      captionPreset: string;
      cutStyle: string;
      voiceTriggers: boolean;
      removeFillers: boolean;
      smartcamEnabled: boolean;
      smartcamFormat: "portrait" | "landscape";
      outputFormats: string[];
    };
    skipConfigure: boolean;
  }
> = {
  tiktok: {
    labelKey: "app.preset.tiktok.label",
    taglineKey: "app.preset.tiktok.tagline",
    descKey: "app.preset.tiktok.desc",
    settings: {
      captionPreset: "clipper",
      cutStyle: "tight",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: true,
      smartcamFormat: "portrait",
      outputFormats: ["9:16"],
    },
    skipConfigure: true,
  },
  podcast: {
    labelKey: "app.preset.podcast.label",
    taglineKey: "app.preset.podcast.tagline",
    descKey: "app.preset.podcast.desc",
    settings: {
      captionPreset: "clean",
      cutStyle: "smooth",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: false,
      smartcamFormat: "landscape",
      outputFormats: ["16:9", "9:16"],
    },
    skipConfigure: true,
  },
  vlog: {
    labelKey: "app.preset.vlog.label",
    taglineKey: "app.preset.vlog.tagline",
    descKey: "app.preset.vlog.desc",
    settings: {
      captionPreset: "subtle",
      cutStyle: "balanced",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: false,
      smartcamFormat: "portrait",
      outputFormats: [],
    },
    skipConfigure: true,
  },
  captions: {
    labelKey: "app.preset.captions.label",
    taglineKey: "app.preset.captions.tagline",
    descKey: "app.preset.captions.desc",
    settings: {
      captionPreset: "clean",
      cutStyle: "smooth",
      voiceTriggers: false,
      removeFillers: false,
      smartcamEnabled: false,
      smartcamFormat: "portrait",
      outputFormats: [],
    },
    skipConfigure: true,
  },
  custom: {
    labelKey: "app.preset.custom.label",
    taglineKey: "app.preset.custom.tagline",
    descKey: "app.preset.custom.desc",
    settings: {
      captionPreset: "clean",
      cutStyle: "balanced",
      voiceTriggers: true,
      removeFillers: true,
      smartcamEnabled: false,
      smartcamFormat: "portrait",
      outputFormats: [],
    },
    skipConfigure: false,
  },
};

// Label shown for a stored job/library entry: translated when the
// preset id is known, else whatever label was stored.
export function presetLabelFor(
  presetId: string | null | undefined,
  stored: string | null | undefined,
  t: TFn,
): string | null {
  if (presetId && presetId in PRESETS) return t(PRESETS[presetId as PresetId].labelKey);
  return stored ?? null;
}

// Maps preset ids → icon component. Emoji-free so the picker reads
// professional instead of like a Notion doc.
export const PRESET_ICONS: Record<PresetId, (p: { size?: number; className?: string; strokeWidth?: number }) => React.ReactNode> = {
  tiktok: IconPhone,
  podcast: IconMic,
  vlog: IconVlog,
  captions: IconCaptions,
  custom: IconSliders,
};

// What each preset actually does — used as feature bullets in the card
// so the user sees the value up front, not just a vague label.
export const PRESET_BULLETS: Record<PresetId, MessageKey[]> = {
  tiktok: [
    "app.preset.tiktok.bullet1",
    "app.preset.tiktok.bullet2",
    "app.preset.tiktok.bullet3",
  ],
  podcast: [
    "app.preset.podcast.bullet1",
    "app.preset.podcast.bullet2",
    "app.preset.podcast.bullet3",
  ],
  vlog: [
    "app.preset.vlog.bullet1",
    "app.preset.vlog.bullet2",
    "app.preset.vlog.bullet3",
  ],
  captions: [
    "app.preset.captions.bullet1",
    "app.preset.captions.bullet2",
    "app.preset.captions.bullet3",
  ],
  custom: [
    "app.preset.custom.bullet1",
    "app.preset.custom.bullet2",
    "app.preset.custom.bullet3",
  ],
};

// Per-preset ambient accent — colored radial glow on each card's
// top-right corner. Gives each workflow a distinct visual identity
// without changing the base surface color.
export const PRESET_ACCENTS: Record<PresetId, string> = {
  tiktok: "rgba(236, 72, 153, 0.55)",   // pink — TikTok energy
  podcast: "rgba(139, 92, 246, 0.55)",  // violet — brand
  vlog: "rgba(56, 189, 248, 0.45)",     // sky — outdoor / camera
  captions: "rgba(168, 85, 247, 0.5)",  // purple — text focus
  custom: "rgba(139, 92, 246, 0.35)",
};

export function getPresetChips(p: (typeof PRESETS)[PresetId], t: TFn): string[] {
  const chips: string[] = [];

  // Aspect ratios — primary is smartcam format if enabled, else outputs
  const ratios = new Set<string>();
  if (p.settings.smartcamEnabled) {
    ratios.add(p.settings.smartcamFormat === "portrait" ? "9:16" : "16:9");
  }
  p.settings.outputFormats.forEach((f) => ratios.add(f));
  if (ratios.size > 0) {
    chips.push(Array.from(ratios).join(" · "));
  }

  // Caption style
  const capKey = CAPTION_PRESETS.find(
    (c) => c.id === p.settings.captionPreset,
  )?.labelKey;
  if (capKey && p.settings.captionPreset !== "none") {
    chips.push(t("app.picker.chipCaptions", { style: t(capKey) }));
  } else if (p.settings.captionPreset === "none") {
    chips.push(t("app.captions.none"));
  }

  // Voice triggers indicator
  if (p.settings.voiceTriggers) {
    chips.push(t("app.picker.chipVoice"));
  }

  return chips;
}

// Labels are aspect ratios (not translated); descriptions are keys.
export const EXPORT_FORMAT_OPTIONS: { id: string; label: string; descKey: MessageKey }[] = [
  { id: "9:16", label: "9:16", descKey: "app.format.9x16.desc" },
  { id: "1:1", label: "1:1", descKey: "app.format.1x1.desc" },
  { id: "16:9", label: "16:9", descKey: "app.format.16x9.desc" },
];
