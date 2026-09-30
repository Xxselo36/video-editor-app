"use client";
/**
 * First editor open (owner decision, DF round 3): the 4-step tour, then
 * the one-line hint in the Text tab until it's closed. Both only on the
 * very first open: the flag is stored when the tour ends or is skipped,
 * so the next open shows neither. localStorage (per browser); storage
 * errors mean "not first" (no tour on a locked-down browser each time).
 */
import { useCallback, useState } from "react";

export const TOUR_KEY = "cleocuts.editor.tourDone.v1";

function isFirstOpen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === null;
  } catch {
    return false;
  }
}

export function useFirstRun() {
  const [first] = useState(isFirstOpen);
  const [step, setStep] = useState<number | null>(first ? 0 : null);
  const [hint, setHint] = useState(false);
  const finish = useCallback(() => {
    try {
      localStorage.setItem(TOUR_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setStep(null);
    setHint(true);
  }, []);
  return {
    tourStep: step,
    setTourStep: setStep,
    finishTour: finish,
    hint,
    closeHint: useCallback(() => setHint(false), []),
  };
}
