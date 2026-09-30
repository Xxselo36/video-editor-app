import type { ButtonHTMLAttributes } from "react";

/**
 * A button that shows only an icon, so `label` (its accessible name) is
 * required. The look comes from `className` / `style` (toolbar segments,
 * dialog close, row actions); `title` adds a tooltip.
 */
export function IconButton({
  label,
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { label: string }) {
  return <button type={type} aria-label={label} {...rest} />;
}
