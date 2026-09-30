import type { InputHTMLAttributes } from "react";
import { cx } from "./cx";

/** A range input in the brand colour. */
export function Slider({ className, style, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <input
      type="range"
      className={cx("flex-1", className)}
      style={{ accentColor: "var(--brand)", ...style }}
      {...rest}
    />
  );
}
