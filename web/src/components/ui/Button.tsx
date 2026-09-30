import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

const VARIANT = {
  /** Brand-filled: the screen's main action. */
  primary: "bg-[var(--brand-solid)] text-white hover:bg-[var(--brand-solid-hover)]",
  /** Brand tint: a secondary action. */
  tint: "bg-[var(--brand-tint)] text-[var(--brand-strong)]",
} as const;

const SIZE = {
  /** Full-width action at the end of a screen (Apply & render). */
  lg: "rounded-xl px-6 py-4 text-base font-semibold active:scale-[0.99]",
  /** Dialog action. */
  md: "rounded-xl px-6 py-2.5 text-sm font-semibold",
  /** Inline action (Undo). */
  sm: "rounded-lg px-3 py-1.5 text-sm font-semibold",
  /** Rounded header action (New video). */
  pill: "rounded-full px-4 py-2 text-sm font-semibold",
} as const;

/**
 * A text button. `className` adds layout (width, margins, flex); it must
 * not repeat what the variant and size set.
 */
export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
}) {
  return (
    <button
      type={type}
      className={cx(SIZE[size], VARIANT[variant], "disabled:opacity-60", className)}
      {...rest}
    />
  );
}
