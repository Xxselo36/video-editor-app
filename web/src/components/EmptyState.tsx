// A screen with nothing to show yet, or that couldn't load: a title, a
// line on what to do, and its actions (children). An error is an alert.
import type { ReactNode } from "react";
import { PRESS, buttonClass } from "./ui/Button";
import { cx } from "./ui/cx";
import s from "./emptyState.module.css";

/** Its way on as a link: the view's one filled button ("Video
 *  hochladen"), or a tint one. */
/** A control's touch: no double-tap zoom wait, no selected label or link
 *  callout on a long press. */
export const CONTROL_TOUCH = "touch-manipulation select-none [-webkit-touch-callout:none]";
export const EMPTY_PRIMARY = cx(buttonClass("primary", "md"), PRESS, CONTROL_TOUCH, "inline-flex min-h-11 items-center");
export const EMPTY_TINT = cx(buttonClass("tint", "md"), PRESS, CONTROL_TOUCH, "inline-flex min-h-11 items-center");

export function EmptyState({
  testId,
  title,
  body,
  alert = false,
  children,
}: {
  testId: string;
  title: string;
  body?: string;
  alert?: boolean;
  children?: ReactNode;
}) {
  return (
    <div data-testid={testId} role={alert ? "alert" : undefined} className={s.box}>
      <h2 className={s.title}>{title}</h2>
      {body && <p className={s.body}>{body}</p>}
      {children && <div className={s.actions}>{children}</div>}
    </div>
  );
}
