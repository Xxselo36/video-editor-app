"use client";
// Moved from app/app/page.tsx (UX4).
import { useEffect, useState } from "react";
import { fmtTimecode } from "@/features/editor/format";
import { rulerMarks } from "./mechanics";

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

  // Which marks, where: mechanics.ts rulerMarks (shared with the v2 dock).
  const { marks: ticks, labelStep } = rulerMarks(scrollLeft, contentW, totalDur, viewW);
  const labelFmt = labelStep < 1 ? fmtTimecode : (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.round(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const marks = [];
  for (const { t, x, kind } of ticks) {
    const k = Math.round(t * 10);
    const isMajor = kind === "major";
    const isSecond = kind === "second";
    const isHalf = kind === "half";
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
