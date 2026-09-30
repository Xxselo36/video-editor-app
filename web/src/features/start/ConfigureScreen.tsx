"use client";
// Moved from app/app/page.tsx (UX4).
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { SwitchRow } from "@/components/ui/Switch";
import { useT } from "@/i18n";
import { publicUrl } from "@/lib/api";
import { CAPTION_PRESETS, CUT_STYLES, EXPORT_FORMAT_OPTIONS } from "./presets.legacy";

export function ConfigureScreen(props: {
  file: File;
  captionPreset: string;
  setCaptionPreset: (s: string) => void;
  cutStyle: string;
  setCutStyle: (s: string) => void;
  voiceTriggers: boolean;
  setVoiceTriggers: (b: boolean) => void;
  removeFillers: boolean;
  setRemoveFillers: (b: boolean) => void;
  smartcamEnabled: boolean;
  setSmartcamEnabled: (b: boolean) => void;
  smartcamFormat: "portrait" | "landscape";
  setSmartcamFormat: (f: "portrait" | "landscape") => void;
  outputFormats: string[];
  setOutputFormats: (f: string[]) => void;
  onProcess: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const sizeMB = (props.file.size / 1024 / 1024).toFixed(1);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <button
          onClick={props.onBack}
          data-testid="configure-back"
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-strong)]"
        >
          <Icon icon={ArrowLeft} /> {t("app.configure.back")}
        </button>
        <div className="truncate text-xs text-[var(--text-body)]">
          {t("app.configure.fileInfo", { name: props.file.name, size: sizeMB })}
        </div>
      </div>

      <Section title={t("app.configure.captionStyle")}>
        <div className="grid grid-cols-2 gap-2">
          {CAPTION_PRESETS.map((p) => {
            const selected = props.captionPreset === p.id;
            return (
              <button
                key={p.id}
                onClick={() => props.setCaptionPreset(p.id)}
                className={`overflow-hidden rounded-xl border text-left transition-colors ${
                  selected
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={publicUrl(`/caption-previews/${p.id}.png?w=320&h=110`)}
                  alt={t("app.configure.captionPreviewAlt", { style: t(p.labelKey) })}
                  className="block h-[64px] w-full bg-[var(--surface-1)] object-cover"
                  loading="lazy"
                />
                <div className="px-3 py-2 text-xs font-medium">{t(p.labelKey)}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t("app.configure.cutStyle")}>
        <div className="grid grid-cols-3 gap-2">
          {CUT_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => props.setCutStyle(s.id)}
              className={`rounded-xl border px-2 py-3 text-left transition-colors ${
                props.cutStyle === s.id
                  ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                  : "border-[var(--border)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="text-xs font-medium">{t(s.labelKey)}</div>
              <div className="text-[10px] text-[var(--text-muted)]">{t(s.descKey)}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title={t("app.configure.cleanup")}>
        <SwitchRow
          label={t("app.configure.voiceTriggers")}
          desc={t("app.configure.voiceTriggersDesc")}
          checked={props.voiceTriggers}
          onChange={props.setVoiceTriggers}
        />
        <SwitchRow
          label={t("app.configure.removeFillers")}
          desc={t("app.configure.removeFillersDesc")}
          checked={props.removeFillers}
          onChange={props.setRemoveFillers}
        />
      </Section>

      <Section title={t("app.configure.smartReframe")}>
        <SwitchRow
          label={t("app.configure.smartcam")}
          desc={t("app.configure.smartcamDesc")}
          checked={props.smartcamEnabled}
          onChange={props.setSmartcamEnabled}
        />
        {props.smartcamEnabled && (
          <div className="grid grid-cols-2 gap-2">
            {(["portrait", "landscape"] as const).map((f) => (
              <button
                key={f}
                onClick={() => props.setSmartcamFormat(f)}
                className={`rounded-xl border px-3 py-3 text-left text-xs transition-colors ${
                  props.smartcamFormat === f
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                <div className="font-medium capitalize">
                  {f === "portrait" ? t("app.configure.portrait") : t("app.configure.landscape")}
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {f === "portrait" ? t("app.configure.portraitDesc") : t("app.configure.landscapeDesc")}
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("app.configure.extraFormats")}>
        <div className="text-[10px] text-[var(--text-muted)] -mt-1">
          {t("app.configure.extraFormatsHint")}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {EXPORT_FORMAT_OPTIONS.map((f) => {
            const on = props.outputFormats.includes(f.id);
            return (
              <button
                key={f.id}
                onClick={() =>
                  props.setOutputFormats(
                    on
                      ? props.outputFormats.filter((x) => x !== f.id)
                      : [...props.outputFormats, f.id],
                  )
                }
                className={`rounded-xl border px-2 py-3 text-left transition-colors ${
                  on
                    ? "border-[var(--brand)] bg-[var(--brand-tint)]"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                <div className="text-xs font-medium">{f.label}</div>
                <div className="text-[10px] text-[var(--text-muted)]">{t(f.descKey)}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <Button
        size="lg"
        onClick={() => props.onProcess()}
        data-testid="configure-process"
        // Sticky on phones: the options list is ~2 screens tall.
        className="sticky bottom-3 z-20 mt-2 w-full shadow-lg"
      >
        {t("app.configure.process")}
      </Button>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}
