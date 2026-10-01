"use client";
/**
 * Header of the Text & cuts tab (UX7, shared by the word-level Text tab
 * of UX8 and the sentence fallback): "0:35 → 0:28 · N cuts ▾" with the
 * cuts menu (UX10 adds the bulk restore items) and the visible search
 * button (owner decision, DF round 3).
 */
import { ArrowRight, ChevronDown, Search } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useLang, useT, type TFn } from "@/i18n";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { kbd } from "../hooks";
import { cutDuration, cutTimeOfSource, decimalSeparator, fmtClock, fmtSeconds, removedRanges } from "../model";
import { Popover } from "../Popover";
import s from "../editor.module.css";

export function plural(t: TFn, lang: string, one: "editor.cuts.one", other: "editor.cuts.other", count: number) {
  let cat = "other";
  try {
    cat = new Intl.PluralRules(lang).select(count);
  } catch {
    /* default */
  }
  return t(cat === "one" ? one : other, { count });
}

export function CutsHeader({
  phone,
  editSegs,
  duration,
  seekCut,
  findOpen,
  setFindOpen,
  extra,
}: {
  phone: boolean;
  editSegs: EditorSeg[];
  duration: number;
  seekCut: (cut: number) => void;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  /** Phone sheet: the close button next to search. */
  extra?: ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const dec = decimalSeparator(lang);
  const cutsBtn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const removed = useMemo(() => removedRanges(editSegs, duration), [editSegs, duration]);
  const outDur = cutDuration(editSegs);
  const cutsLabel = plural(t, lang, "editor.cuts.one", "editor.cuts.other", removed.length);
  return (
    <>
      <div className={s.panelHead}>
        <button
          ref={cutsBtn}
          type="button"
          className={`${s.gb} ${s.cutsBtn}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          title={t("editor.cuts.tip")}
          onClick={() => setMenu((m) => !m)}
          data-testid="ed-cuts"
        >
          <span className={`${s.mono} ${s.cutsFrom}`}>{fmtClock(duration)}</span>
          <ArrowRight size={12} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-text-3)" }} />
          <span className={`${s.mono} ${s.cutsTo}`}>{fmtClock(outDur)}</span>
          <span className={s.cutsDot} aria-hidden>
            ·
          </span>
          <span className={s.cutsLabel}>{cutsLabel}</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden style={{ color: "var(--ed-text-3)" }} />
        </button>
        <span className={s.flex1} />
        <button
          type="button"
          className={`${phone ? s.mb : s.gb} ${s.ico}`}
          aria-label={t("editor.search")}
          aria-pressed={findOpen}
          title={t("editor.searchTip").replace("⌘F", kbd("⌘F"))}
          onClick={() => setFindOpen(!findOpen)}
          data-testid="ed-search"
        >
          <Search size={16} strokeWidth={1.75} aria-hidden />
        </button>
        {extra}
      </div>
      {menu && (
        <Popover anchor={cutsBtn} onClose={() => setMenu(false)} role="menu" label={t("editor.cuts.menu")} testId="ed-cuts-menu">
          {removed.length === 0 ? (
            <button type="button" role="menuitem" className={s.mi} disabled>
              {t("editor.cuts.none")}
            </button>
          ) : (
            removed.map((r, i) => (
              <button
                key={`${r.start}-${i}`}
                type="button"
                role="menuitem"
                className={s.mi}
                onClick={() => {
                  setMenu(false);
                  seekCut(cutTimeOfSource(editSegs, r.start));
                }}
              >
                <span className={s.dot} style={{ background: "var(--ed-removed)" }} aria-hidden />
                <span>
                  {t("editor.cuts.item", {
                    time: fmtClock(cutTimeOfSource(editSegs, r.start)),
                    len: fmtSeconds(r.end - r.start, dec),
                  })}
                </span>
              </button>
            ))
          )}
        </Popover>
      )}
    </>
  );
}
