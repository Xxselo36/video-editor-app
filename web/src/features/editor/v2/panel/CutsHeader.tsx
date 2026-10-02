"use client";
/**
 * Header of the Text & cuts tab (UX7, shared by the word-level Text tab
 * of UX8 and the sentence fallback): "0:35 → 0:28 · N cuts ▾" with the
 * cuts menu and the visible search button (owner decision, DF round 3).
 *
 * UX10 (review A6, DF menu): with `cuts` the menu restores in bulk —
 * every pause, every "um", every Cleo-cut take, every AI cut — each one
 * op and one undo step; the user's own cuts are never touched. Without
 * (the sentence fallback) it lists the cuts to jump to, as before.
 */
import { ArrowRight, ChevronDown, Search } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useLang, useT, type TFn } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { countKinds, type CutKind } from "@/features/editor/state/cuts";
import type { EditorSeg } from "@/features/editor/timeline/mechanics";
import { kbd } from "../hooks";
import { cutDuration, cutTimeOfSource, decimalSeparator, fmtClock, fmtSeconds, removedRanges } from "../model";
import { Popover } from "../Popover";
import type { CutsApi } from "../useCuts";
import s from "../editor.module.css";

export function plural(t: TFn, lang: string, one: MessageKey, other: MessageKey, count: number) {
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
  cuts,
  seekCut,
  findOpen,
  setFindOpen,
  extra,
}: {
  phone: boolean;
  editSegs: EditorSeg[];
  duration: number;
  /** UX10: the cuts by reason and the bulk restore (word-level Text tab). */
  cuts?: CutsApi;
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
  const pieces = cuts?.pieces;
  const counts = useMemo(() => (pieces ? countKinds(pieces) : null), [pieces]);
  const bulk = (kind: CutKind | "ai") => {
    setMenu(false);
    cuts?.restoreKind(kind);
  };
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
          {counts ? (
            <BulkItems counts={counts} onRestore={bulk} />
          ) : removed.length === 0 ? (
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

const KIND_ITEMS: { kind: CutKind; key: MessageKey; color: string }[] = [
  { kind: "silence", key: "editor.cuts.restorePauses", color: "var(--ed-removed)" },
  { kind: "filler", key: "editor.cuts.restoreFillers", color: "var(--ed-filler)" },
  { kind: "voice_cmd", key: "editor.cuts.restoreTakes", color: "var(--ed-cleo)" },
  { kind: "bad_take", key: "editor.cuts.restoreBadTakes", color: "var(--ed-cleo)" },
];

/** The bulk restore items (DF "N Schnitte ▾" menu): per reason with its count, then all AI cuts. */
function BulkItems({ counts, onRestore }: { counts: ReturnType<typeof countKinds>; onRestore: (k: CutKind | "ai") => void }) {
  const t = useT();
  const items = KIND_ITEMS.filter((x) => counts[x.kind] > 0);
  const ai = counts.silence + counts.filler + counts.voice_cmd + counts.bad_take;
  if (!ai) {
    return (
      <button type="button" role="menuitem" className={s.mi} disabled>
        {counts.user ? t("editor.cuts.onlyYours") : t("editor.cuts.none")}
      </button>
    );
  }
  return (
    <>
      {items.map((x) => (
        <button
          key={x.kind}
          type="button"
          role="menuitem"
          className={s.mi}
          onClick={() => onRestore(x.kind)}
          data-testid={`ed-restore-${x.kind}`}
        >
          <span className={s.dot} style={{ background: x.color }} aria-hidden />
          <span>{t(x.key)}</span>
          <span className={`${s.miCnt} ${s.mono}`}>{counts[x.kind]}</span>
        </button>
      ))}
      <div className={s.msep} role="separator" />
      <button type="button" role="menuitem" className={s.mi} onClick={() => onRestore("ai")} data-testid="ed-restore-ai">
        <span>{t("editor.cuts.restoreAll")}</span>
        <span className={`${s.miCnt} ${s.mono}`}>{ai}</span>
      </button>
      {counts.user > 0 && <div className={s.miNote}>{t("editor.cuts.yoursStay")}</div>}
    </>
  );
}
