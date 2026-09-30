"use client";

import { useT } from "@/i18n";
import { useMediaUrl } from "@/lib/api";
import { Dialog } from "@/components/ui/Dialog";

/* ── Inline video preview modal ──
 * Full-screen overlay used from Library + Picker's Recent-Projects.
 * Click backdrop or press Escape to close (components/ui/Dialog: portal,
 * focus trap, body-scroll lock). Uses /jobs/:id/watch (no attachment
 * header) so <video> can stream with HTTP Range for smooth seeking. The
 * URL is fixed while the modal is open (and waits for the media token
 * when accounts are on).
 */
export function VideoModal({
  jobId,
  onClose,
}: {
  jobId: string;
  onClose: () => void;
}) {
  const t = useT();
  const src = useMediaUrl(jobId, "watch");

  return (
    <Dialog
      onClose={onClose}
      label={t("common.videoModal.dialogLabel")}
      testId="dialog-video"
      backdrop="rgba(0,0,0,0.85)"
      panelClassName="relative flex max-h-[92vh] w-full max-w-[440px] flex-col items-center"
    >
      <button
        onClick={onClose}
        data-testid="dialog-close"
        className="absolute -top-10 right-0 flex items-center gap-1.5 text-xs text-white/70 transition-opacity hover:opacity-100"
        aria-label={t("common.videoModal.closeAria")}
      >
        {t("common.videoModal.close")} ✕
      </button>
      {src && (
        <video
          src={src}
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
      )}
    </Dialog>
  );
}
