"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/* ── Modal dialog ──
 * Rendered into document.body through a portal, so no transformed or
 * filtered ancestor (an animated screen, a blurred header) can become
 * the containing block of its `position: fixed` overlay (audit T1).
 *
 * - role="dialog" + aria-modal, named by `labelledBy` or `label`
 * - focus moves into the dialog on open (`initialFocus`, else the first
 *   focusable element, else the panel) and back to the element that had
 *   it on close
 * - Tab / Shift+Tab stay inside the dialog; Escape closes it
 * - a click on the backdrop closes it; the page behind doesn't scroll
 *
 * The overlay covers the viewport and carries `testId`; `children` is
 * the panel (clicks inside it don't reach the backdrop).
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "video[controls]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getClientRects().length > 0,
  );
}

export function Dialog({
  onClose,
  label,
  labelledBy,
  testId,
  initialFocus,
  backdrop = "rgba(0,0,0,0.7)",
  panelClassName,
  panelStyle,
  children,
}: {
  onClose: () => void;
  /** Accessible name (when there is no visible title to point at). */
  label?: string;
  /** Id of the element holding the dialog's title. */
  labelledBy?: string;
  testId?: string;
  /** Element to focus on open (default: the first focusable one). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Backdrop colour. */
  backdrop?: string;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // The latest onClose without re-running the open/close effect.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const first = initialFocus?.current ?? focusables(panel)[0] ?? panel;
    first.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      const head = items[0];
      const tail = items[items.length - 1];
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? tail : head).focus();
      } else if (e.shiftKey && (active === head || active === panel)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    // Capture: the dialog sees keys before any page-level shortcut.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
    // Runs once per open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      data-testid={testId}
      onClick={() => onCloseRef.current()}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: backdrop, backdropFilter: "blur(6px)" }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={panelClassName}
        style={{ outline: "none", ...panelStyle }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
