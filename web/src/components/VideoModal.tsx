"use client";

import { useEffect } from "react";

function backendUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

/* ── Inline video preview modal ──
 * Full-screen overlay used from Library + Picker's Recent-Projects.
 * Click backdrop or press Escape to close. Body-scroll lock while open.
 * Uses /jobs/:id/watch (no attachment header) so <video> can stream
 * with HTTP Range for smooth seeking.
 */
export function VideoModal({
  jobId,
  onClose,
}: {
  jobId: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)" }}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[92vh] w-full max-w-[440px] flex-col items-center"
      >
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 flex items-center gap-1.5 text-xs text-white/70 transition-opacity hover:opacity-100"
          aria-label="Close preview"
        >
          Close ✕
        </button>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={`${backendUrl()}/jobs/${jobId}/watch`}
          controls
          autoPlay
          playsInline
          className="max-h-[92vh] w-full rounded-2xl"
          style={{
            background: "#000",
            boxShadow:
              "0 0 0 1px rgba(139,92,246,0.35), 0 12px 60px rgba(139,92,246,0.35)",
          }}
        />
      </div>
    </div>
  );
}
