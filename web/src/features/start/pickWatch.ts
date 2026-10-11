/**
 * Did iOS give up on the video? (iPhone / iPad only, ./videoPicker.)
 *
 * With the original-formats picker iOS sometimes can't hand a very large
 * video over (an 8 GB 4K 60 fps clip in the owner's test): no file comes.
 * The page can't ask why. WebKit reports a failed export as a plain
 * `cancel` event, exactly like the user closing the picker, and on some
 * iOS versions nothing at all fires. What tells them apart is WHEN the
 * cancel comes:
 *
 *   - the Photos picker closes as soon as a video is selected (the page
 *     is "back": focus, visible again, a touch on it) and iOS prepares
 *     the video after that, which can take minutes (the owner's test C:
 *     43 s for a 140 MB clip). A cancel CANCEL_AFTER_BACK_MS or more
 *     after the page came back is iOS giving up on that video: `missed`,
 *     whatever the time the picker was open;
 *   - a user who closes the picker gets the page back and the cancel at
 *     the same moment (in either order: a back signal within
 *     CANCEL_AFTER_BACK_MS after the cancel counts too): nothing to say,
 *     however long they browsed;
 *   - a cancel with no back signal around it: decided by the time the
 *     picker was open (GAVE_UP_CANCEL_MS);
 *   - no cancel at all (some iOS versions): STALL_MS after the page came
 *     back without a file, `stalled`. The preparing status stays (a slow
 *     export or iCloud download may still deliver) and a soft "Still
 *     nothing?" offers "Pick anyway" under it;
 *   - "Pick anyway" (`any`: the unfiltered input, iOS converts the video
 *     first, for minutes): opened from the hint, the hint goes once the
 *     picker closes (the preparing status takes its place) and comes back
 *     on a cancel; it never stalls;
 *   - a file that arrives hides everything.
 *
 * The owner's picker test page (public/picker-test.html) logs the gap
 * between the page coming back and a cancel, to check these numbers.
 */
import { useEffect, useState } from "react";

/** A cancel this long after the picker opened, with no back signal
 *  before it: iOS gave up. */
export const GAVE_UP_CANCEL_MS = 10_000;
/** A cancel this long after the page came back: the picker had closed
 *  with a selection and iOS gave up on it (a user's own cancel comes
 *  with the page coming back). */
export const CANCEL_AFTER_BACK_MS = 1_500;
/** Back without a file and without a cancel for this long: "Still
 *  nothing?" (as long as the start screen's preparing timeout). */
export const STALL_MS = 90_000;
/** "Back" signals this soon after opening are the tap that opened it. */
export const BACK_MIN_OPEN_MS = 1_000;

export type PickState = "none" | "missed" | "stalled";

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
  // "cancelled": a late cancel with no back signal yet, waiting a moment
  // for one (a user closing the picker).
  private phase: "idle" | "open" | "back" | "cancelled" = "idle";
  private openedAt = 0;
  private backAt: number | null = null;
  private any = false;
  private fromHint = false;
  private timer: unknown = null;
  private shown: PickState = "none";

  constructor(
    private readonly onChange: (state: PickState) => void,
    private readonly clock: PickClock = realClock,
  ) {}

  get state(): PickState {
    return this.shown;
  }

  get missed(): boolean {
    return this.shown === "missed";
  }

  get stalled(): boolean {
    return this.shown === "stalled";
  }

  /** A picker opens. `any`: the unfiltered input (iOS converts: it takes
   *  minutes, no stall). `fromHint`: opened from the hint, which stays
   *  until the picker closes and comes back on a cancel. Anything else
   *  is a fresh try: whatever was shown goes. */
  opened({ any = false, fromHint = false }: { any?: boolean; fromHint?: boolean } = {}): void {
    this.stopTimer();
    this.phase = "open";
    this.openedAt = this.clock.now();
    this.backAt = null;
    this.any = any;
    this.fromHint = fromHint;
    this.show(fromHint ? "missed" : "none");
  }

  /** The page is back (focus, visible, a touch) and no file yet. */
  back(): void {
    if (this.phase === "cancelled") {
      // Right after the cancel: the user closed the picker.
      this.stopTimer();
      this.phase = "idle";
      this.show(this.fromHint ? "missed" : "none");
      return;
    }
    if (this.phase !== "open" || this.clock.now() - this.openedAt < BACK_MIN_OPEN_MS) return;
    this.phase = "back";
    this.backAt = this.clock.now();
    // The picker closed: the hint makes way for the preparing status.
    if (this.fromHint) this.show("none");
    if (this.any) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.phase === "back") this.show("stalled");
    }, STALL_MS);
  }

  /** The input's `cancel` event. */
  cancelled(): void {
    if (this.phase === "idle" || this.phase === "cancelled") return;
    const now = this.clock.now();
    this.stopTimer();
    // (Opened from the hint: it comes back either way.)
    const verdict = (gaveUp: boolean): PickState => (gaveUp || this.fromHint ? "missed" : "none");
    if (this.backAt !== null || now - this.openedAt < GAVE_UP_CANCEL_MS) {
      this.phase = "idle";
      this.show(verdict(this.backAt !== null && now - this.backAt >= CANCEL_AFTER_BACK_MS));
      return;
    }
    // Late, and no back signal yet: one may follow the cancel at once.
    this.phase = "cancelled";
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.phase = "idle";
      this.show(verdict(true));
    }, CANCEL_AFTER_BACK_MS);
  }

  /** A file came: nothing missing (any more). */
  arrived(): void {
    this.stopTimer();
    this.phase = "idle";
    this.show("none");
  }

  /** The picker closed with a file that can't be used (the caller says
   *  so): what shows stays as it is. */
  closed(): void {
    this.stopTimer();
    this.phase = "idle";
  }

  dispose(): void {
    this.stopTimer();
    this.phase = "idle";
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private show(state: PickState): void {
    if (this.shown === state) return;
    this.shown = state;
    this.onChange(state);
  }
}

/**
 * A PickWatch fed by the page's "back" signals while `enabled` (iOS).
 * The caller reports opened / cancelled / arrived from its inputs.
 */
export function usePickWatch(enabled: boolean): { missed: boolean; stalled: boolean; watch: PickWatch } {
  const [state, setState] = useState<PickState>("none");
  const [watch] = useState(() => new PickWatch(setState));
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
  return { missed: enabled && state === "missed", stalled: enabled && state === "stalled", watch };
}
