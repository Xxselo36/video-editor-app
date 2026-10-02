"use client";
/**
 * The "Change" settings of the start screen (UX6, PLAN 3.6): cut pace
 * (Tight / Natural / No cuts), filler words, voice commands with a
 * "What's this?" link to the voice test, the spoken language, and "Save
 * as default". Inline under the summary on wide screens; a bottom sheet
 * on phones (StartScreen decides).
 */
import { useMemo, useState } from "react";
import { cx } from "@/components/ui/cx";
import { SwitchRow } from "@/components/ui/Switch";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { PACES, type JobSettings, type Pace } from "./defaults";

const PACE_LABEL: Record<Pace, MessageKey> = {
  tight: "app.start.paceTight",
  smooth: "app.start.paceSmooth",
  none: "app.start.paceNone",
};
const PACE_DESC: Record<Pace, MessageKey> = {
  tight: "app.start.paceTightDesc",
  smooth: "app.start.paceSmoothDesc",
  none: "app.start.paceNoneDesc",
};

/** A language's name in the UI language (the code when the browser
 *  can't name it). */
export function languageName(code: string, uiLang: string): string {
  try {
    const name = new Intl.DisplayNames([uiLang], { type: "language" }).of(code);
    return name && name !== code ? name.charAt(0).toLocaleUpperCase(uiLang) + name.slice(1) : code;
  } catch {
    return code;
  }
}

export function SettingsPanel({
  settings,
  onChange,
  languages,
  locked,
  onVoiceHelp,
  onSave,
  saveState,
}: {
  settings: JobSettings;
  onChange: (patch: Partial<JobSettings>) => void;
  /** ISO codes the server accepts (GET /config, without "auto"). */
  languages: string[];
  /** An upload is running: the note that settings lock when processing
   *  starts. */
  locked: boolean;
  onVoiceHelp: () => void;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved" | "failed" | "same";
}) {
  const t = useT();
  const lang = useLang();
  const noCuts = settings.pace === "none";
  const options = useMemo(
    () =>
      languages
        .map((code) => ({ code, name: languageName(code, lang) }))
        .sort((a, b) => a.name.localeCompare(b.name, lang)),
    [languages, lang],
  );
  // Roving focus of the pace radios (arrow keys move and select).
  const [paceFocus, setPaceFocus] = useState<Pace | null>(null);
  const onPaceKey = (e: React.KeyboardEvent) => {
    const i = PACES.indexOf(settings.pace);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? PACES[(i + 1) % PACES.length]
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? PACES[(i + PACES.length - 1) % PACES.length]
          : null;
    if (!next) return;
    e.preventDefault();
    onChange({ pace: next });
    setPaceFocus(next);
    const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-pace="${next}"]`);
    el?.focus();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="start-settings">
      <div>
        <div id="start-pace-label" className="mb-2 text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
          {t("app.start.pace")}
        </div>
        <div
          role="radiogroup"
          aria-labelledby="start-pace-label"
          onKeyDown={onPaceKey}
          className="grid grid-cols-3 gap-1 rounded-xl border border-[var(--border)] p-1"
        >
          {PACES.map((p) => {
            const on = settings.pace === p;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on || paceFocus === p ? 0 : -1}
                data-pace={p}
                data-testid={`start-pace-${p}`}
                onClick={() => onChange({ pace: p })}
                className={cx(
                  "min-h-11 rounded-lg px-2 py-2 text-center transition-colors",
                  on ? "bg-[var(--brand-tint)] text-[var(--brand-strong)]" : "text-[var(--text-body)] hover:bg-[var(--surface-1)]",
                )}
              >
                <div className="text-sm font-semibold">{t(PACE_LABEL[p])}</div>
                <div className="text-[11px] leading-tight text-[var(--text-muted)]">{t(PACE_DESC[p])}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className={cx("flex flex-col gap-2", noCuts && "opacity-60")}>
        <SwitchRow
          label={t("app.configure.removeFillers")}
          desc={t("app.configure.removeFillersDesc")}
          checked={!noCuts && settings.removeFillers}
          onChange={(v) => !noCuts && onChange({ removeFillers: v })}
        />
        <SwitchRow
          label={t("app.configure.voiceTriggers")}
          desc={t("app.configure.voiceTriggersDesc")}
          checked={!noCuts && settings.voiceTriggers}
          onChange={(v) => !noCuts && onChange({ voiceTriggers: v })}
        />
      </div>
      <button
        type="button"
        onClick={onVoiceHelp}
        data-testid="start-voice-help"
        className="-mt-2 w-fit text-xs font-medium text-[var(--brand-strong)] underline underline-offset-2 hover:opacity-80"
      >
        {t("app.start.whatsThis")}
      </button>

      <label className="flex flex-col gap-2">
        <span className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">{t("app.start.language")}</span>
        <select
          value={settings.spokenLanguage}
          onChange={(e) => onChange({ spokenLanguage: e.target.value })}
          data-testid="start-language"
          className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-3 text-sm text-[var(--text-strong)]"
        >
          <option value="auto">{t("app.start.languageAuto")}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saveState === "saving" || saveState === "same"}
          data-testid="start-save-default"
          className="min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm font-semibold text-[var(--text-strong)] hover:border-[var(--brand)] disabled:opacity-50"
        >
          {t("app.start.saveDefault")}
        </button>
        <span role="status" aria-live="polite" className="text-xs text-[var(--text-muted)]" data-testid="start-save-status">
          {saveState === "saved" || saveState === "same"
            ? t("app.start.savedDefault")
            : saveState === "failed"
              ? t("app.start.saveFailed")
              : ""}
        </span>
      </div>
      {locked && (
        <p className="text-xs text-[var(--text-muted)]" data-testid="start-lock-note">
          {t("app.start.lockNote")}
        </p>
      )}
    </div>
  );
}
