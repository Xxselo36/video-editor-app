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
  /** Larger rounded action under a big headline (the landing hero's):
   *  44 px tall on phones, 48 px from tablets. */
  pillLg: "rounded-full min-h-11 px-[1.375rem] py-2.5 text-[0.9375rem]/6 font-semibold md:min-h-12 md:px-6 md:py-3 md:text-base/6",
} as const;

/** The classes of a Button, for a link that looks like one (the
 *  landing's calls to action are links to other pages). */
export function buttonClass(variant: keyof typeof VARIANT = "primary", size: keyof typeof SIZE = "md"): string {
  return cx(SIZE[size], VARIANT[variant]);
}

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
