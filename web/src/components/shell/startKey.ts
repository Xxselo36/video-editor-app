"use client";
/**
 * The upload tab, pressed while Neues Video is open, starts that screen
 * over: NewVideoPage keys its StartScreen with this. A video still
 * waiting for "Los geht's" comes back on its "Untertitel wählen" (PR1
 * D3); after "Los geht's" the screen starts with a new video.
 */
import { useSyncExternalStore } from "react";

let key = 0;
const listeners = new Set<() => void>();

export function bumpStartKey(): void {
  key += 1;
  listeners.forEach((f) => f());
}

export function useStartKey(): number {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    () => key,
    () => 0,
  );
}
