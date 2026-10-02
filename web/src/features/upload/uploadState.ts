/**
 * The in-memory state of this page's uploads (split out of
 * ./uploadManager in UX12): live progress, the paywall a refused upload
 * asks for, local thumbnails. Screens that only show cards / tiles / the
 * paywall import this — not the upload code and its stores.
 */
import { useSyncExternalStore } from "react";
import type { Paywall } from "@/lib/account";

export type LiveUpload = {
  /** The upload's temporary id (upl-…). */
  id: string;
  /** 0–100. */
  pct: number;
  /** Continues an interrupted upload of the same file. */
  resuming: boolean;
};

export const live = new Map<string, LiveUpload>();
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

export function useLocalThumb(id: string): string | null {
  return useSyncExternalStore(subscribe, () => thumbs.get(id) ?? null, () => null);
}

/** A frame ~0.5 s into `file` as an object URL, or null (no decoder,
 *  timeout). */
export function grabFrame(file: File, timeoutMs = 6000): Promise<string | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const src = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(src);
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const d = isFinite(video.duration) ? video.duration : 1;
      video.currentTime = Math.min(0.5, d / 2);
    };
    video.onseeked = () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return finish(null);
        const scale = Math.min(1, 360 / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => finish(b ? URL.createObjectURL(b) : null), "image/jpeg", 0.8);
      } catch {
        finish(null);
      }
    };
    video.src = src;
  });
}

export function setThumb(id: string, url: string | null): void {
  const old = thumbs.get(id);
  if (old && old !== url) URL.revokeObjectURL(old);
  if (url) thumbs.set(id, url);
  else thumbs.delete(id);
  emit();
}

/** The job was created: its tile keeps the upload's thumbnail. */
export function moveThumb(from: string, to: string): void {
  const url = thumbs.get(from);
  if (!url) return;
  thumbs.delete(from);
  thumbs.set(to, url);
  emit();
}
