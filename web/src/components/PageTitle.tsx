"use client";
// The title of a redesigned /app screen: its <h1> (`children`), which
// takes focus when the screen changes in place (tabIndex -1), so a
// screen reader starts there. `bar`, `trailing` and `edge` are for the
// phone top bar of the app shell (the bar's title, an action at its end,
// whether it draws a line once the page scrolls); until the shell
// exists the page header stands there and the heading is all there is.
import type { ReactNode } from "react";

export function PageTitle({
  children,
  id,
}: {
  bar: string;
  children?: ReactNode;
  id?: string;
  trailing?: ReactNode;
  edge?: "line" | "none";
}) {
  if (children == null) return null;
  return (
    <h1
      id={id}
      tabIndex={-1}
      className="text-[26px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance text-[var(--text-strong)] outline-none min-[960px]:text-[40px] min-[960px]:leading-[1.1] min-[960px]:tracking-[-0.03em]"
    >
      {children}
    </h1>
  );
}
