"use client";
/**
 * The UX12 gate: the Projects page, the processing view and the jobs
 * store are for browsers on the v2 editor only (features/editor/v2/flag:
 * the default, or `?editor=v2` with NEXT_PUBLIC_EDITOR_V2=optin); the
 * others (`?editor=v1`, "optin" without it, "off") keep the
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
