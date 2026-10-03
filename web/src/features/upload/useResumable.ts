/**
 * The interrupted uploads of this browser (lib/uploadResume) for the v2
 * screens: the start screen's "continue" card and the Projects tile of a
 * stopped upload. One read shared by every component, re-read whenever a
 * record changes and when the page comes back (another tab may have
 * finished or discarded one).
 */
import { useSyncExternalStore } from "react";
import { listResumable, subscribeResumable, type ResumableUpload } from "@/lib/uploadResume";

let list: ResumableUpload[] | null = null;
let seq = 0;
const subs = new Set<() => void>();
let unsubRecords: (() => void) | null = null;

function read(): void {
  const mine = ++seq;
  void listResumable()
    .catch(() => [] as ResumableUpload[])
    .then((l) => {
      if (mine !== seq) return;
      list = l;
      subs.forEach((f) => f());
    });
}

function onShow(): void {
  if (document.visibilityState === "visible") read();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (subs.size === 1) {
    unsubRecords = subscribeResumable(read);
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pageshow", onShow);
    read();
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0) {
      unsubRecords?.();
      unsubRecords = null;
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pageshow", onShow);
    }
  };
}

/** null until read (read again whenever the first screen using it
 *  mounts: the list may be from long ago). */
export function useResumableUploads(): ResumableUpload[] | null {
  return useSyncExternalStore(subscribe, () => list, () => null);
}

/** The interrupted upload a stopped tile stands for: the same size (the
 *  exact byte count), the same name preferred. */
export function matchResumable(
  items: ResumableUpload[] | null,
  size: number | undefined,
  name: string,
): ResumableUpload | null {
  if (!items || !size) return null;
  const same = items.filter((r) => r.size === size);
  return same.find((r) => r.name === name) ?? same[0] ?? null;
}
