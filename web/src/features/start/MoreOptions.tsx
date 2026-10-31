"use client";
/**
 * "Mehr Optionen" (D5, mockup 2b-optionen): folded under the styles, its
 * closed row sums up what differs from the defaults. Open: "Nur
 * Untertitel, nichts schneiden" (not with "Ohne Untertitel"), the filler
 * words (only when Cleo cuts), the format (no Quer for an upright video)
 * and the spoken language. A switch that can't apply shows off and keeps
 * what was wanted (choices.ts). Folded, the rows are inert; on phones the
 * opened panel is scrolled clear of the go bar.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/Switch";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { captionsOnlyRow, effectiveAspect, fillersRow, moreSummary, type SwitchRow } from "./choices";
import type { TargetAspect } from "./defaults";
import { languageName, spokenLanguages } from "./languages";
import { useStartActions, useStartView } from "./pendingStart";
import { isPortrait } from "./probe";
import s from "./start.module.css";

const FORMATS: { aspect: TargetAspect; id: string; label: MessageKey; shape: string }[] = [
  { aspect: "9:16", id: "9x16", label: "app.start.formatPortrait", shape: s.shapeV },
  { aspect: "16:9", id: "16x9", label: "app.start.formatLandscape", shape: s.shapeH },
  { aspect: "original", id: "original", label: "app.start.formatOriginal", shape: s.shapeO },
];

// The voice command in a note, with its quotes: drawn in its own colour.
const COMMAND = /[„“"«]?Cleo cut[“”"»]?/;

function withCommand(text: string): ReactNode {
  const m = COMMAND.exec(text);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.index)}
      <span className={s.cmdCut}>{m[0]}</span>
      {text.slice(m.index + m[0].length)}
    </>
  );
}

/** A switch row: a label, the note when there is one, the track. */
function OptionSwitch({
  id,
  label,
  row,
  locked,
  onToggle,
}: {
  id: string;
  label: string;
  row: SwitchRow;
  locked: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const noteId = `${id}-note`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={row.checked}
      aria-disabled={row.disabled || locked || undefined}
      aria-describedby={row.note ? noteId : undefined}
      className={s.orow}
      data-testid={id}
      onClick={() => {
        if (!row.disabled && !locked) onToggle();
      }}
    >
      <span className={s.lbl}>
        <span className={s.rowLabel}>{label}</span>
        {row.note && (
          <span id={noteId} className={s.sub}>
            {withCommand(t(row.note))}
          </span>
        )}
      </span>
      <span className={s.switch}>
        <Switch checked={row.checked} size="lg" />
      </span>
    </button>
  );
}

export function MoreOptions() {
  const t = useT();
  const lang = useLang();
  const desktop = useIsDesktop();
  const { start, languages } = useStartView();
  const { setChoices } = useStartActions();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const { choices: c, probe } = start;
  // POST /jobs has the choices (read when it went out): no changes.
  const locked = start.sent || start.starting;
  const aspect = effectiveAspect(c, probe);
  const portrait = isPortrait(probe);
  const summary = moreSummary(c, probe)
    .map((p) => (typeof p === "string" ? t(p) : languageName(p.language, lang)))
    .join(" · ");
  const spoken = useMemo(() => {
    const list = spokenLanguages(languages, lang);
    // A remembered language the list doesn't have (yet) is still offered.
    return c.language === "auto" || list.some((l) => l.code === c.language)
      ? list
      : [{ code: c.language, name: languageName(c.language, lang) }, ...list];
  }, [languages, lang, c.language]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    const el = panel.current;
    if (!next || desktop || !el) return;
    // Phones: once the panel has its height, its end comes up above the
    // go bar (the page's scroll padding keeps it clear).
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let timer = 0;
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === "grid-template-rows") reveal();
    };
    const reveal = () => {
      el.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
      // (Closed again meanwhile: nothing to bring up.)
      if (el.parentElement?.hasAttribute("data-open")) {
        el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      }
    };
    el.addEventListener("transitionend", onEnd);
    timer = window.setTimeout(reveal, reduce ? 60 : 380);
  };

  const pickFormat = (a: TargetAspect) => {
    if (!locked && !(a === "16:9" && portrait)) setChoices((x) => ({ ...x, aspect: a }));
  };
  // Arrow keys go round the formats that can be picked.
  const onFormatKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const usable = FORMATS.filter((f) => !(f.aspect === "16:9" && portrait));
    const i = usable.findIndex((f) => f.aspect === aspect);
    const to = usable[(i + d + usable.length) % usable.length];
    document.getElementById(`start-format-${to.id}`)?.focus();
    pickFormat(to.aspect);
  };

  return (
    <div className={s.more} data-open={open || undefined}>
      <button
        type="button"
        className={s.disc}
        aria-expanded={open}
        aria-controls="start-more-panel"
        data-testid="start-more"
        onClick={toggle}
      >
        <span className={s.discRow}>
          {t("app.start.moreOptions")}
          <Icon icon={ChevronRight} size={17} />
        </span>
        {!open && summary && (
          <span className={s.discSum} data-testid="start-more-summary">
            {summary}
          </span>
        )}
      </button>
      <div ref={panel} id="start-more-panel" className={s.panel} data-testid="start-more-panel">
        <div className={s.panelClip} inert={!open}>
          <div className={s.opts}>
            <OptionSwitch
              id="start-captions-only"
              label={t("app.start.captionsOnly")}
              row={captionsOnlyRow(c)}
              locked={locked}
              onToggle={() => setChoices((x) => ({ ...x, captionsOnly: !x.captionsOnly }))}
            />
            <OptionSwitch
              id="start-fillers"
              label={t("app.start.removeFillers")}
              row={fillersRow(c)}
              locked={locked}
              onToggle={() => setChoices((x) => ({ ...x, fillers: !x.fillers }))}
            />
            <div className={cx(s.orow, s.fmtRow)}>
              <span id="start-format-label" className={s.lbl}>
                {t("app.start.format")}
              </span>
              <div role="radiogroup" aria-labelledby="start-format-label" className={s.fmt} onKeyDown={onFormatKey}>
                {FORMATS.map((f) => {
                  const off = f.aspect === "16:9" && portrait;
                  const on = aspect === f.aspect;
                  return (
                    <button
                      key={f.aspect}
                      type="button"
                      role="radio"
                      id={`start-format-${f.id}`}
                      aria-checked={on}
                      aria-disabled={off || locked || undefined}
                      aria-describedby={off ? "start-vertical-hint" : undefined}
                      tabIndex={on ? 0 : -1}
                      data-testid={`start-format-${f.id}`}
                      onClick={() => pickFormat(f.aspect)}
                    >
                      <span className={cx(s.shape, f.shape)} aria-hidden />
                      {t(f.label)}
                    </button>
                  );
                })}
              </div>
              {portrait && (
                <p id="start-vertical-hint" className={s.fmtHint} data-testid="start-vertical-hint">
                  {t("app.start.verticalHint")}
                </p>
              )}
            </div>
            <label className={cx(s.orow, s.langRow)}>
              <span className={s.lbl}>
                <span className={s.rowLabel}>{t("app.start.language")}</span>
                <span className={s.val}>
                  {c.language === "auto" ? t("app.start.languageAuto") : languageName(c.language, lang)}
                </span>
              </span>
              <Icon icon={ChevronDown} size={16} />
              <select
                value={c.language}
                aria-label={t("app.start.language")}
                disabled={locked}
                data-testid="start-language"
                onChange={(e) => {
                  const language = e.target.value;
                  setChoices((x) => ({ ...x, language }));
                }}
              >
                <option value="auto">{t("app.start.languageAuto")}</option>
                {spoken.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
