/**
 * Did iOS give up on the video? (iPhone / iPad only, ./videoPicker.)
 *
 * With the original-formats picker iOS sometimes can't hand a very large
 * video over (an 8 GB 4K 60 fps clip in the owner's test): the picker
 * closes and no file comes. The page can't ask why. WebKit reports a
 * failed export as a plain `cancel` event, exactly like the user closing
 * the picker, and on some iOS versions nothing at all fires. So:
 *
 *   - `cancel` long after the picker opened (GAVE_UP_CANCEL_MS): iOS
 *     tried and gave up (a user who closes the picker does so sooner);
 *   - the page is back (focus, visible again, a touch on it: the picker
 *     sheet no longer covers it) and no file came within BACK_GRACE_MS;
 *   - a file that arrives after all (a slow export) hides the hint again.
 *
 * The hint (./PickMissedHint) shows while `missed` is true.
 */
import { useEffect, useState } from "react";

/** A cancel this long after the picker opened: iOS gave up. */
export const GAVE_UP_CANCEL_MS = 10_000;
/** The page is back without a file for this long: nothing is coming. */
export const BACK_GRACE_MS = 15_000;
/** "Back" signals this soon after opening are the tap that opened it. */
export const BACK_MIN_OPEN_MS = 1_000;

export type PickClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

const realClock: PickClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class PickWatch {
  private state: "idle" | "open" | "back" = "idle";
  private openedAt = 0;
  private timer: unknown = null;
  private shown = false;

  constructor(
    private readonly onMissed: (missed: boolean) => void,
    private readonly clock: PickClock = realClock,
  ) {}

  get missed(): boolean {
    return this.shown;
  }

  /** The picker opens. A fresh try hides the hint; "Pick anyway" (from
   *  the hint) keeps it until something arrives. */
  opened({ fromHint = false }: { fromHint?: boolean } = {}): void {
    this.stopTimer();
    this.state = "open";
    this.openedAt = this.clock.now();
    if (!fromHint) this.show(false);
  }

  /** The page is back (focus, visible, a touch) and no file yet. */
  back(): void {
    if (this.state !== "open" || this.clock.now() - this.openedAt < BACK_MIN_OPEN_MS) return;
    this.state = "back";
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.state !== "back") return;
      this.state = "idle";
      this.show(true);
    }, BACK_GRACE_MS);
  }

  /** The input's `cancel` event. */
  cancelled(): void {
    if (this.state === "idle") return;
    this.stopTimer();
    this.state = "idle";
    if (this.clock.now() - this.openedAt >= GAVE_UP_CANCEL_MS) this.show(true);
  }

  /** A file came: nothing missing (any more). */
  arrived(): void {
    this.stopTimer();
    this.state = "idle";
    this.show(false);
  }

  /** The picker closed with a file that can't be used (the caller says
   *  so): the hint stays as it is. */
  closed(): void {
    this.stopTimer();
    this.state = "idle";
  }

  dispose(): void {
    this.stopTimer();
    this.state = "idle";
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private show(on: boolean): void {
    if (this.shown === on) return;
    this.shown = on;
    this.onMissed(on);
  }
}

/**
 * A PickWatch fed by the page's "back" signals while `enabled` (iOS).
 * The caller reports opened / cancelled / arrived from its inputs.
 */
export function usePickWatch(enabled: boolean): { missed: boolean; watch: PickWatch } {
  const [missed, setMissed] = useState(false);
  const [watch] = useState(() => new PickWatch(setMissed));
  useEffect(() => {
    if (!enabled) return;
    const back = () => watch.back();
    const onVisible = () => {
      if (document.visibilityState === "visible") watch.back();
    };
    window.addEventListener("focus", back);
    window.addEventListener("pageshow", back);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("pointerdown", back, true);
    return () => {
      window.removeEventListener("focus", back);
      window.removeEventListener("pageshow", back);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("pointerdown", back, true);
      watch.dispose();
    };
  }, [enabled, watch]);
  return { missed: enabled && missed, watch };
}
