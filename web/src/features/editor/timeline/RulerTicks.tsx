"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { useEffect, useState } from "react";
import { fmtTimecode } from "@/features/editor/format";

// Ruler marks for the visible part of the strip only (it can be many
// thousands of px wide). Owns its scroll listener so scrolling
// re-renders just the ruler, not the whole editor.
//   - labelled major marks, spaced >= 56px
//   - 0.5s marks (medium) and 0.1s marks (short) once there's room
export function RulerTicks({
  scrollRef,
  contentW,
  totalDur,
  viewW,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentW: number;
  totalDur: number;
  viewW: number;
}) {
  const [scrollLeft, setScrollLeft] = useState(0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrollLeft(sc.scrollLeft));
    };
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      sc.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, contentW]);

  const pps = contentW / totalDur;
  const labelSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const labelStep = labelSteps.find((st) => st * pps >= 56) ?? 600;
  // Finest step that still leaves >= 4px between marks.
  const minorStep =
    0.1 * pps >= 4 ? 0.1 : 0.5 * pps >= 4 && labelStep > 0.5 ? 0.5 : labelStep / 2;

  // Work in tenths of a second to avoid float drift.
  const minorT = Math.max(1, Math.round(minorStep * 10));
  const labelT = Math.round(labelStep * 10);
  const from = Math.max(0, scrollLeft - 100) / pps;
  const to = Math.min(contentW, scrollLeft + viewW + 100) / pps;
  const first = Math.ceil((from * 10) / minorT) * minorT;
  const labelFmt = labelStep < 1 ? fmtTimecode : (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const marks = [];
  for (let k = first; k <= to * 10 + 1e-6 && k <= totalDur * 10 + 1e-6; k += minorT) {
    const t = k / 10;
    const x = t * pps;
    const isMajor = k % labelT === 0;
    const isSecond = !isMajor && k % 10 === 0;
    const isHalf = !isMajor && !isSecond && k % 5 === 0;
    marks.push(
      <div
        key={k}
        className="pointer-events-none absolute bottom-0"
        style={{
          left: `${x}px`,
          width: "1px",
          height: isMajor ? "10px" : isSecond ? "7px" : isHalf ? "5px" : "3px",
          background: isMajor || isSecond
            ? "var(--text-muted)"
            : isHalf
              ? "var(--border-strong)"
              : "var(--border-hover)",
        }}
      />,
    );
    if (isMajor && x < contentW - 28) {
      marks.push(
        <span
          key={`l${k}`}
          className="pointer-events-none absolute top-1 pl-1 text-[9px] tabular-nums"
          style={{ left: `${x}px`, color: "var(--text-muted)" }}
        >
          {labelFmt(t)}
        </span>,
      );
    }
  }
  return <>{marks}</>;
}
