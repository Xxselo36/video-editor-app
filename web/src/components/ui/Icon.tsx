import type { LucideIcon } from "lucide-react";
import { cx } from "./cx";

/**
 * A lucide icon set like a text glyph: 1em square by default, sitting on
 * the text's baseline, so it can stand where a unicode arrow or cross
 * stood without changing the line. Decorative (aria-hidden): the control
 * around it carries the name.
 */
export function Icon({
  icon: Glyph,
  size = "1em",
  strokeWidth = 2,
  className,
}: {
  icon: LucideIcon;
  size?: number | string;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <Glyph
      aria-hidden
      size={size}
      strokeWidth={strokeWidth}
      className={cx("inline-block shrink-0 align-[-0.125em]", className)}
    />
  );
}
