"use client";
/**
 * The UX12 gate: the Projects page, the processing view and the jobs
 * store are for browsers on the v2 opt-in only (features/editor/v2/flag:
 * `?editor=v2`, or NEXT_PUBLIC_EDITOR_V2=1); everyone else keeps the
 * dashboard, the library and the cards of before.
 *
 * null during the server render and hydration (the choice lives in
 * localStorage and the URL), then true / false — screens show their
 * skeleton until it is known, so the two never mismatch.
 */
import { useSyncExternalStore } from "react";
import { readChoice } from "@/features/editor/v2/flag";

let cached: boolean | null = null;
const noop = () => () => {};

export function useProjectsV2(): boolean | null {
  return useSyncExternalStore(
    noop,
    () => (cached ??= readChoice()),
    () => null,
  );
}
