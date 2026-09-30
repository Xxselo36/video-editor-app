import type { LucideIcon } from "lucide-react";
import { cx } from "./cx";

/**
 * A lucide icon set like a text glyph: on the text's baseline and, by
 * default, 0.84em square — the advance of the arrow and cross glyphs it
 * replaced in the UI font — so it stands where a unicode glyph stood
 * without moving the rest of the line. Decorative (aria-hidden): the
 * control around it carries the name.
 */
export function Icon({
  icon: Glyph,
  size = "0.84em",
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
