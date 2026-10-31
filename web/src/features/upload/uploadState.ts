/**
 * The in-memory state of this page's uploads (split out of
 * ./uploadManager in UX12): live progress, which uploads wait for "Let's
 * go", the paywall a refused upload asks for, local thumbnails. Screens
 * that only show cards / tiles / the paywall import this — not the upload
 * code and its stores.
 */
import { useSyncExternalStore } from "react";
import type { Paywall } from "@/lib/account";
import type { PresetId } from "@/features/start/presets.legacy";
import type { Gate } from "./gate";
import type { SettingsSource } from "./settings";

/** How an upload ended: its job exists (also when a cancel came too
 *  late), it was cancelled before POST /jobs, or it failed (its record
 *  says why). */
export type EndHow = "created" | "failed" | "cancelled";

/** The start screen's part of an upload (uploadManager StartOpts): its
 *  gate, the length read at the pick and its callbacks. */
export type StartPart = {
  gate: Gate;
  duration?: number | null;
  onCard?(tempId: string): void;
  onSettingsRead?(): void;
  onStarting?(): void;
  onCreated?(jobId: string): void;
  onEnd?(jobId: string | null, how: EndHow): void;
};

/** What a failed upload of this page needs to go again without asking
 *  for the file ("Try again", UX12). */
export type Retry = {
  file: File;
  settings: SettingsSource;
  preset: PresetId | null;
  /** "any": picked with the unfiltered iOS input (lib/uploadResume). */
  source?: "any";
  /** Started on the start screen: "Try again" on its Projects tile goes
   *  on with the same gate and callbacks (the last used choices are
   *  written when its POST /jobs goes out) and keeps the frame. */
  start?: StartPart;
};
export const retries = new Map<string, Retry>();
/** Cancel (UX12): the abort of each running upload of this page. */
export const controllers = new Map<string, AbortController>();

export type LiveUpload = {
  /** The upload's temporary id (upl-…). */
  id: string;
  /** 0–100. */
  pct: number;
  /** Continues an interrupted upload of the same file. */
  resuming: boolean;
  /** The file is stored and POST /jobs went out: no cancel any more. */
  starting?: boolean;
  /** Waiting for the connection: it continues by itself. */
  paused?: boolean;
  /** The bytes are stored (R2): POST /jobs waits for the gate, or went
   *  out (`starting`). */
  uploaded?: boolean;
};

export const live = new Map<string, LiveUpload>();
// Uploads whose POST /jobs waits for "Let's go" (./gate, D1): from the
// pick until the gate opens or the upload is given up (cancelled, or a
// failed one removed or tried again). A failure keeps the mark: Projects
// still sends the user back to the start screen, not to "Try again".
// A new set per change (useAwaitingGoIds hands it out as a snapshot).
let awaitingGo: ReadonlySet<string> = new Set<string>();
const NONE_AWAITING: ReadonlySet<string> = new Set<string>();
const subs = new Set<() => void>();
let paywall: Paywall | null = null;
// A new object per change (useSyncExternalStore compares snapshots).
let version = 0;

export function emit(): void {
  version++;
  subs.forEach((f) => f());
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** The live state of an upload, or null (not uploading in this page). */
export function getLiveUpload(id: string): LiveUpload | null {
  return live.get(id) ?? null;
}

/** Uploads running in this page. */
export function getLiveUploads(): LiveUpload[] {
  return [...live.values()];
}

export function useLiveUpload(id: string): LiveUpload | null {
  return useSyncExternalStore(
    subscribe,
    () => live.get(id) ?? null,
    () => null,
  );
}

/** Does upload `id` wait for "Let's go"? (Also after it failed.) */
export function isAwaitingGo(id: string): boolean {
  return awaitingGo.has(id);
}

export function useAwaitingGo(id: string): boolean {
  return useSyncExternalStore(subscribe, () => awaitingGo.has(id), () => false);
}

/** The uploads of this page that wait for "Let's go" (Projects: nothing
 *  is processed until then). */
export function useAwaitingGoIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => awaitingGo, () => NONE_AWAITING);
}

export function setAwaitingGo(id: string, on: boolean): void {
  if (awaitingGo.has(id) === on) return;
  const next = new Set(awaitingGo);
  if (on) next.add(id);
  else next.delete(id);
  awaitingGo = next;
  emit();
}

export function getPaywall(): Paywall | null {
  return paywall;
}

export function setPaywall(pw: Paywall | null): void {
  paywall = pw;
  emit();
}

export function dismissPaywall(): void {
  paywall = null;
  emit();
}

export function usePaywall(): Paywall | null {
  return useSyncExternalStore(subscribe, () => paywall, () => null);
}

/** For tests: how often the state changed. */
export function _version(): number {
  return version;
}

// ── local thumbnails ─────────────────────────────────────────────────
// A frame of the picked file (a <video> frame drawn to a canvas), shown
// on the tile while it uploads and until the server has its own. Memory
// only (object URLs); none when the browser can't decode the file (a
// generic tile then, §1.7 row 5).
const thumbs = new Map<string, string>();
// Frames still being grabbed, by the upload they are for. The id follows
// the upload to its job (moveThumb) or to its retry (takeThumb); a frame
// whose upload went meanwhile (setThumb) is let go when it comes.
type Coming = { id: string; url: Promise<string | null> };
const coming = new Map<string, Coming>();

export function useLocalThumb(id: string): string | null {
  return useSyncExternalStore(subscribe, () => thumbs.get(id) ?? null, () => null);
}

/** The thumbnail of `id` once the frame being grabbed comes. */
export function setThumbWhenReady(id: string, url: Promise<string | null>): void {
  const c: Coming = { id, url };
  coming.set(id, c);
  void url.then(
    (u) => {
      if (coming.get(c.id) !== c) return;
      coming.delete(c.id);
      if (u) setThumb(c.id, u);
    },
    () => {
      if (coming.get(c.id) === c) coming.delete(c.id);
    },
  );
}

export function setThumb(id: string, url: string | null): void {
  // (A frame still on its way for this upload is let go when it comes.)
  const c = coming.get(id);
  if (c) {
    coming.delete(id);
    void c.url.then((u) => u && URL.revokeObjectURL(u), () => {});
  }
  const old = thumbs.get(id);
  if (old && old !== url) URL.revokeObjectURL(old);
  if (url) thumbs.set(id, url);
  else thumbs.delete(id);
  emit();
}

/** The job was created: its tile keeps the upload's thumbnail. */
export function moveThumb(from: string, to: string): void {
  const c = coming.get(from);
  if (c) {
    coming.delete(from);
    c.id = to;
    coming.set(to, c);
  }
  const url = thumbs.get(from);
  if (!url) return;
  thumbs.delete(from);
  thumbs.set(to, url);
  emit();
}

/** Takes `id`'s thumbnail (or the frame still on its way) without
 *  revoking it: "Try again" hands it to the new upload. */
export function takeThumb(id: string): Promise<string | null> {
  const c = coming.get(id);
  if (c) {
    coming.delete(id);
    return c.url;
  }
  const url = thumbs.get(id) ?? null;
  if (url) {
    thumbs.delete(id);
    emit();
  }
  return Promise.resolve(url);
}
