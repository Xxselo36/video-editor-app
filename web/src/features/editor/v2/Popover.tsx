"use client";
/**
 * A popover / menu anchored to a button (editor v2): rendered into the
 * editor root (the tokens apply, no clipping by the dock), placed below
 * the anchor or above it when there's no room. Escape or a click outside
 * closes it; focus moves into it on open and back to the anchor on close.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEditorRoot } from "./hooks";
import s from "./editor.module.css";

export function Popover({
  anchor,
  onClose,
  role = "dialog",
  label,
  placement = "below",
  align = "start",
  width,
  children,
  testId,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  role?: "dialog" | "menu";
  label: string;
  placement?: "below" | "above";
  align?: "start" | "end";
  width?: number;
  children: ReactNode;
  testId?: string;
}) {
  const root = useEditorRoot();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === "start" ? a.left : a.right - w;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const below = a.bottom + 4;
    const above = a.top - 4 - h;
    const fitsBelow = below + h <= window.innerHeight - 8;
    const top = placement === "below" ? (fitsBelow || above < 8 ? below : above) : above >= 8 ? above : below;
    setPos({ left, top });
  }, [anchor, align, placement]);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const a = anchor.current;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    (first ?? box)?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box?.contains(t) || a?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      if (a && document.activeElement && box?.contains(document.activeElement)) a.focus({ preventScroll: true });
      else if (a && (!document.activeElement || document.activeElement === document.body)) a.focus({ preventScroll: true });
    };
  }, [anchor]);

  // Arrow keys move between menu items.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (role !== "menu" || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  };

  const node = (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      className={s.menu}
      onKeyDown={onKeyDown}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: width ? `min(${width}px, calc(100vw - 16px))` : undefined,
        maxWidth: width ? "none" : undefined,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>
  );
  return root ? createPortal(node, root) : node;
}
