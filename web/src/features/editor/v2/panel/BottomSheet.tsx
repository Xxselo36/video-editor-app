"use client";
/**
 * Phone bottom sheet (UX7): opens at 54 % of the screen (the preview
 * stays visible above it), a drag on the handle snaps it to 54 % or 90 %
 * or closes it; safe-area insets; not modal (the preview above still
 * plays on tap). Focus moves into the sheet on open and back to the
 * trigger on close (review F8); Escape closes.
 */
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useT } from "@/i18n";
import s from "../editor.module.css";

const SNAPS = [0.54, 0.9];

export function BottomSheet({
  title,
  onClose,
  returnFocus,
  headerExtra,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  headerExtra?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const [snap, setSnap] = useState(SNAPS[0]);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number } | null>(null);
  const titleId = `ed-sheet-${testId ?? "x"}`;

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const trigger = returnFocus.current;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      trigger?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  const vh = typeof window !== "undefined" ? window.innerHeight : 844;
  const height = drag ?? Math.round(snap * vh);
  return (
    <section
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={s.sheet}
      style={{ height }}
      data-dragging={drag !== null}
      data-testid={testId}
    >
      <div
        className={s.sheetHandle}
        role="separator"
        aria-label={t("editor.sheetHandle")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { y: e.clientY, h: height };
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const h = start.current.h + (start.current.y - e.clientY);
          setDrag(Math.max(80, Math.min(vh * 0.94, h)));
        }}
        onPointerUp={() => {
          const h = drag;
          start.current = null;
          setDrag(null);
          if (h === null) {
            // a tap on the handle toggles the size
            setSnap((x) => (x === SNAPS[0] ? SNAPS[1] : SNAPS[0]));
            return;
          }
          const f = h / vh;
          if (f < 0.35) onClose();
          else setSnap(Math.abs(f - SNAPS[0]) < Math.abs(f - SNAPS[1]) ? SNAPS[0] : SNAPS[1]);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
      >
        <span />
      </div>
      <div className={s.sheetHead}>
        <h2 id={titleId} className={s.sheetTitle}>
          {title}
        </h2>
        <span className={s.flex1} />
        {headerExtra}
        <button type="button" className={`${s.mb} ${s.ico}`} aria-label={t("editor.close")} onClick={onClose}>
          <X size={20} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className={s.tabpanel}>{children}</div>
    </section>
  );
}
