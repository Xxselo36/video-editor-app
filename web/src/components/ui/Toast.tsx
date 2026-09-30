import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * A short message pinned to the top of the viewport (role status, so
 * screen readers announce it). `compact` is a one-line pill; otherwise
 * a card that a click dismisses (`onDismiss`).
 */
export function Toast({
  children,
  compact = false,
  onDismiss,
  testId,
}: {
  children: ReactNode;
  compact?: boolean;
  onDismiss?: () => void;
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      onClick={onDismiss}
      className={cx(
        "fixed left-1/2 top-4 z-50 -translate-x-1/2",
        compact
          ? "rounded-full px-4 py-2 text-xs font-semibold"
          : "w-[min(92vw,420px)] rounded-2xl px-4 py-3 text-sm",
      )}
      style={{
        background: "var(--surface-2)",
        color: "var(--text-strong)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      {children}
    </div>
  );
}
