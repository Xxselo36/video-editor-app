/**
 * The phone / desktop switch of the redesigned screens (D19): desktop
 * from 960 px wide, the mockups' breakpoint. CSS switches at the same
 * width; widths inside a layout come from container queries.
 */
import { useSyncExternalStore } from "react";

export const DESK_QUERY = "(min-width: 960px)";

// One list for every caller: matchMedia makes a new one per call, and
// the snapshot is read on every render.
let desk: MediaQueryList | null = null;
const query = () => (desk ??= window.matchMedia(DESK_QUERY));

function subscribe(cb: () => void): () => void {
  const m = query();
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** Is the window desktop wide? (false on the server: phones first) */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => query().matches, () => false);
}
