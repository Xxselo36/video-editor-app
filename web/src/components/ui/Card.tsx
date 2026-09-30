import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** A panel on the page: surface-1, hairline border, rounded 2xl. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)]", className)}
      {...rest}
    />
  );
}

/** The small uppercase label above a group ("In progress", "Timeline"). */
export function SectionLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]", className)}
      {...rest}
    />
  );
}
