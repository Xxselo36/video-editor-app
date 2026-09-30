"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { useState } from "react";
import { useT } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import { formatRelativeTime, type LibraryEntry } from "@/lib/library";
import { presetLabelFor } from "@/features/start/presets.legacy";

/* Recent-project tile: thumbnail on top, meta below. Click plays the
 * video in the shared modal — same UX as the Library cards. */
export function RecentProjectCard({
  entry,
  onPlay,
}: {
  entry: LibraryEntry;
  onPlay: (jobId: string) => void;
}) {
  const t = useT();
  const [thumbFailed, setThumbFailed] = useState(false);
  // null until the media token is known (accounts on).
  const thumbSrc = useMediaUrl(entry.jobId, "thumbnail");
  return (
    <button
      onClick={() => onPlay(entry.jobId)}
      data-testid="recent-project"
      className="group flex flex-col overflow-hidden rounded-xl text-left transition-all hover:-translate-y-0.5"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="relative w-full overflow-hidden"
        style={{
          aspectRatio: "9 / 16",
          background: "var(--surface-2)",
        }}
      >
        {!thumbFailed && thumbSrc && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={thumbSrc}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
            loading="lazy"
          />
        )}
        {thumbFailed && (
          <div
            className="flex h-full w-full items-center justify-center text-[9px] font-semibold uppercase tracking-widest"
            style={{ color: "var(--text-faint)" }}
          >
            {t("app.card.noPreview")}
          </div>
        )}
        {/* Preset chip pinned bottom-left over the thumbnail */}
        <div className="absolute bottom-1.5 left-1.5">
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            style={{
              background: "rgba(0,0,0,0.7)",
              color: "var(--brand-strong)",
              backdropFilter: "blur(4px)",
            }}
          >
            {presetLabelFor(entry.presetId, entry.presetLabel, t) ?? t("app.preset.custom.label")}
          </span>
        </div>
        {/* Play triangle on hover */}
        <div
          className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        >
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full"
            style={{
              background: "rgba(0,0,0,0.7)",
              backdropFilter: "blur(4px)",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      </div>
      <div className="p-2">
        <div
          className="mb-0.5 truncate text-xs font-semibold"
          style={{ color: "var(--text-strong)" }}
        >
          {entry.filename || t("app.library.untitled")}
        </div>
        <div
          className="text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          {formatRelativeTime(entry.timestamp)}
        </div>
      </div>
    </button>
  );
}
