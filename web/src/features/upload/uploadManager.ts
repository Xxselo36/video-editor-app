/**
 * The uploads of this page (UX5): a module-level singleton, so an upload
 * keeps running — and its card keeps moving — while the user goes from
 * /app/new to the dashboard, into the editor of another project and back.
 * Nothing about an upload lives in a component.
 *
 * Two kinds of state:
 *   - live progress (percent, "resuming"), in memory only: subscribe() /
 *     useLiveUpload() re-render the card on every tick;
 *   - the card itself (lib/activeJobs, localStorage): written once per
 *     state change — started, resuming, job created, failed — plus a
 *     heartbeat every UPLOAD_HEARTBEAT_MS (uploadJob.ts) so another tab (or this one after a
 *     reload) can tell a live upload from a dead one (markStaleUploads,
 *     20 s). Never per progress tick.
 *   - the paywall a refused upload (402) asks for, shown wherever the
 *     user is by <UploadPaywall/> (app/app/layout.tsx).
 */
import { useSyncExternalStore } from "react";
import type { Paywall } from "@/lib/account";
import { addActiveJob, liveUploads, updateActiveJob } from "@/lib/activeJobs";
import { cardError, tEn } from "@/lib/errors";
import { PRESETS, type PresetId } from "@/features/start/presets.legacy";
import type { UploadSettings } from "./uploadJob";

export type LiveUpload = {
  /** The card's temporary id (upl-…). */
  id: string;
  /** 0–100. */
  pct: number;
  /** Continues an interrupted upload of the same file. */
  resuming: boolean;
};

const live = new Map<string, LiveUpload>();
const subs = new Set<() => void>();
let paywall: Paywall | null = null;
// A new object per change (useSyncExternalStore compares snapshots).
let version = 0;

function emit(): void {
  version++;
  subs.forEach((f) => f());
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** The live state of an upload card, or null (not uploading in this page). */
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

export function getPaywall(): Paywall | null {
  return paywall;
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

/** Put up the card of a new upload (its temporary id until POST /jobs
 *  names the job); marked as this page's (liveUploads). */
export function uploadCard(file: File, settings: UploadSettings, preset: PresetId | null): string {
  const tempId = `upl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const info = preset ? PRESETS[preset] : null;
  liveUploads.add(tempId);
  addActiveJob({
    jobId: tempId,
    phase: "uploading",
    timestamp: Date.now(),
    filename: file.name,
    fileSize: file.size,
    presetId: preset,
    presetLabel: info ? tEn(info.labelKey) : null,
    presetIcon: null,
    captionPreset: settings.caption_preset,
    uploadPct: 0,
    lastProgressAt: Date.now(),
  });
  live.set(tempId, { id: tempId, pct: 0, resuming: false });
  emit();
  return tempId;
}

/**
 * Upload `file` and create its job, in the background whatever route is
 * shown; resolves when that is over (callers don't wait for it). Never
 * throws: a failure ends on the card. `onCreated`: the job exists (its
 * card replaced the upload's).
 */
export async function startUpload(
  file: File,
  settings: UploadSettings,
  preset: PresetId | null,
  onCreated?: (jobId: string) => void,
): Promise<void> {
  // The card goes up now, before anything is awaited: the dashboard the
  // user is sent to shows it the moment it opens.
  const tempId = uploadCard(file, settings, preset);
  // The upload code is its own chunk: pages that only show cards (the
  // dashboard) don't load it.
  let uploadJob: typeof import("./uploadJob").uploadJob;
  try {
    ({ uploadJob } = await import("./uploadJob"));
  } catch {
    // The chunk didn't load (offline): the card says so.
    liveUploads.delete(tempId);
    live.delete(tempId);
    updateActiveJob(tempId, cardError({ code: "connection_lost" }));
    emit();
    return;
  }
  return uploadJob(file, settings, preset, {
    tempId,
    onPaywall: (pw) => {
      paywall = pw;
      emit();
    },
    onCreated: (jobId) => onCreated?.(jobId),
    onProgress: (id, pct, resuming) => {
      const cur = live.get(id);
      if (cur && cur.pct === pct && cur.resuming === resuming) return;
      live.set(id, { id, pct, resuming });
      emit();
    },
    onEnd: (id) => {
      if (live.delete(id)) emit();
    },
  });
}
