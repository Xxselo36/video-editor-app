"use client";
/**
 * The title of an app screen: its <h1> (`children`), which takes focus
 * when the screen changes in place (tabIndex -1), so a screen reader
 * starts there.
 *
 * In the app shell (components/shell): `bar` is the phone top bar's
 * title, `trailing` an action at the bar's end (the Vorschau's menu),
 * `edge` "none" when the screen draws the line under the bar itself.
 * The <h1> is for screen readers on phones (the bar shows the title) and
 * stands above the screen from 960 px. Without the shell (v1) the heading
 * is all there is.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShell, useTopBarTitle } from "@/components/shell/useShell";
import s from "@/components/shell/shell.module.css";

const PLAIN =
  "text-[26px] font-extrabold leading-[1.15] tracking-[-0.025em] text-balance text-[var(--text-strong)] outline-none min-[960px]:text-[40px] min-[960px]:leading-[1.1] min-[960px]:tracking-[-0.03em]";

export function PageTitle({
  bar,
  children,
  id,
  trailing,
  edge = "line",
}: {
  bar: string;
  children?: ReactNode;
  id?: string;
  trailing?: ReactNode;
  edge?: "line" | "none";
}) {
  const shell = useShell();
  useTopBarTitle(bar, edge, shell !== null);
  const slot = shell?.trailing ?? null;
  return (
    <>
      {children != null && (
        <h1 id={id} tabIndex={-1} className={shell ? s.h1 : PLAIN}>
          {children}
        </h1>
      )}
      {slot && trailing ? createPortal(trailing, slot) : null}
    </>
  );
}
