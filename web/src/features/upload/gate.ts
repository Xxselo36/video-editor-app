/**
 * The upload gate (D1): a picked video uploads at once, but POST /jobs
 * (the job, its cuts, its charge) waits until the gate opens. Only "Let's
 * go" opens it: never a timer, never leaving the screen.
 */
export type Gate = { readonly promise: Promise<void>; open(): void; readonly isOpen: boolean };

/** A new gate, closed unless `open`. Opening it again does nothing. */
export function createGate(open = false): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  let isOpen = false;
  const gate: Gate = {
    promise,
    open() {
      if (isOpen) return;
      isOpen = true;
      release();
    },
    get isOpen() {
      return isOpen;
    },
  };
  if (open) gate.open();
  return gate;
}
