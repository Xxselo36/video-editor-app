"use client";
/**
 * First-open tour (owner decision, DF round 3): four steps — Preview →
 * Text & cuts → Style → Export — each spotlighting its region (violet
 * 2 px ring, the rest dimmed to 55 %), with step dots, "n/4", Skip and
 * Next; the last step says "Let's go". The card button is light-filled so
 * Export stays the only violet fill. Positions come from the live layout
 * (`data-tour` targets). Escape skips.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import s from "../editor.module.css";

type Place = "right" | "left" | "below" | "above";
type Step = { target: string; title: MessageKey; text: MessageKey; desktop: Place; phone: Place; align?: "end" };

const STEPS: Step[] = [
  { target: "preview", title: "editor.tour.previewTitle", text: "editor.tour.previewText", desktop: "right", phone: "below" },
  { target: "text", title: "editor.tour.textTitle", text: "editor.tour.textText", desktop: "left", phone: "above" },
  { target: "style", title: "editor.tour.styleTitle", text: "editor.tour.styleText", desktop: "below", phone: "above" },
  { target: "export", title: "editor.tour.exportTitle", text: "editor.tour.exportText", desktop: "below", phone: "below", align: "end" },
];

type Box = { left: number; top: number; width: number; height: number };

export function Tour({
  root,
  phone,
  step,
  onStep,
  onDone,
}: {
  root: HTMLElement | null;
  phone: boolean;
  step: number;
  onStep: (n: number) => void;
  onDone: () => void;
}) {
  const t = useT();
  const cur = STEPS[step];
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [spot, setSpot] = useState<Box | null>(null);
  const [card, setCard] = useState<{ left: number; top: number; arrow: { left?: number; top?: number; side: Place } } | null>(
    null,
  );

  const measure = useCallback(() => {
    const el = root?.querySelector<HTMLElement>(`[data-tour="${cur.target}"]`);
    const c = cardRef.current;
    if (!el || !c) return;
    const r = el.getBoundingClientRect();
    const pad = cur.target === "text" && !phone ? 0 : 4;
    const box = { left: r.left - pad, top: r.top - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
    setSpot(box);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cw = c.offsetWidth;
    const ch = c.offsetHeight;
    const gap = 16;
    const place = phone ? cur.phone : cur.desktop;
    let left = 0;
    let top = 0;
    if (place === "right") {
      left = box.left + box.width + gap;
      top = Math.max(16, Math.min(box.top + box.height / 2 - ch / 2, H - ch - 16));
    } else if (place === "left") {
      left = box.left - gap - cw;
      top = Math.max(16, Math.min(box.top + 140, H - ch - 16));
    } else if (place === "below") {
      top = box.top + box.height + gap;
      left = cur.align === "end" ? box.left + box.width - cw : box.left + box.width / 2 - cw / 2;
    } else {
      top = box.top - gap - ch;
      left = box.left + box.width / 2 - cw / 2;
    }
    left = Math.max(16, Math.min(left, W - cw - 16));
    top = Math.max(8, Math.min(top, H - ch - 8));
    const arrow =
      place === "right" || place === "left"
        ? { top: Math.max(16, Math.min(box.top + box.height / 2 - top - 6, ch - 28)), side: place }
        : { left: Math.max(16, Math.min(box.left + box.width / 2 - left - 6, cw - 28)), side: place };
    setCard({ left, top, arrow });
  }, [root, cur, phone]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    const id = window.setTimeout(measure, 250); // after layout transitions
    return () => {
      window.removeEventListener("resize", measure);
      window.clearTimeout(id);
    };
  }, [measure]);
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  const last = step === STEPS.length - 1;
  const arrowStyle = (() => {
    const a = card?.arrow;
    if (!a) return { display: "none" };
    const edge = "rgba(255,255,255,.12)";
    if (a.side === "right") return { left: -6, top: a.top, boxShadow: `-1px 1px 0 ${edge}` };
    if (a.side === "left") return { right: -6, top: a.top, boxShadow: `1px -1px 0 ${edge}` };
    if (a.side === "below") return { top: -6, left: a.left, boxShadow: `-1px -1px 0 ${edge}` };
    return { bottom: -6, left: a.left, boxShadow: `1px 1px 0 ${edge}` };
  })();
  return (
    <>
      <div className={s.tourBlock} aria-hidden onClick={(e) => e.stopPropagation()} />
      {spot && (
        <div
          className={s.spot}
          aria-hidden
          style={{ ...spot, borderRadius: cur.target === "text" && !phone ? 0 : 10 }}
          data-testid="ed-tour-spot"
        />
      )}
      <div
        ref={cardRef}
        className={s.coach}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ed-tour-title"
        aria-describedby="ed-tour-text"
        data-testid="ed-tour"
        style={{
          left: card?.left ?? -9999,
          top: card?.top ?? -9999,
          width: phone ? "calc(100vw - 32px)" : step === 0 ? 300 : 320,
          visibility: card ? "visible" : "hidden",
        }}
      >
        <span className={s.coachArrow} aria-hidden style={arrowStyle} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className={s.cdots} aria-hidden>
            {STEPS.map((_, i) => (
              <span key={i} data-on={i === step} />
            ))}
          </div>
          <span className={s.mono} style={{ fontSize: 11, color: "var(--ed-text-3)" }}>
            {step + 1}/{STEPS.length}
          </span>
        </div>
        <h2 id="ed-tour-title" className={s.coachTitle}>
          {t(cur.title)}
        </h2>
        <p id="ed-tour-text" className={s.coachText}>
          {t(cur.text)}
        </p>
        <div className={s.coachFoot}>
          {last ? (
            <span />
          ) : (
            <button type="button" className={phone ? s.mb : s.gb} style={{ marginLeft: -8 }} onClick={onDone}>
              {t("editor.tour.skip")}
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className={s.cbtn}
            onClick={() => (last ? onDone() : onStep(step + 1))}
            data-testid="ed-tour-next"
          >
            {last ? t("editor.tour.done") : t("editor.tour.next")}
          </button>
        </div>
      </div>
    </>
  );
}
