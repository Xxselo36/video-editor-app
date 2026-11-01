"use client";
/**
 * The export's captions as files (UX11, F8): SRT and VTT, in output
 * time. The editor's Done view and the Vorschau's "Mehr zum Video".
 */
import { FileText } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { track } from "@/lib/analytics";
import { mediaUrl } from "@/lib/api";
import type { JobStatus } from "@/features/jobs/types";

export function CaptionFiles({ job }: { job: Pick<JobStatus, "id" | "has_captions_file"> }) {
  const t = useT();
  if (!job.has_captions_file) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-body)]" data-testid="done-captions">
      <Icon icon={FileText} size={14} />
      <span>{t("app.done.captionFiles")}</span>
      {(["srt", "vtt"] as const).map((kind) => (
        <a
          key={kind}
          href={mediaUrl(job.id, `captions.${kind}`)}
          download
          onClick={() => track("srt_downloaded", { kind })}
          // The tap area reaches 44 px high (::after); the chip stays small.
          className="relative rounded-md border border-[var(--border-hover)] px-2 py-0.5 font-semibold text-[var(--text-strong)] after:absolute after:-inset-x-1 after:-inset-y-3 after:content-[''] hover:border-[var(--brand)]"
          data-testid={`done-${kind}`}
        >
          {/* "SRT", not "srt": a screen reader spells the format out. */}
          {kind.toUpperCase()}
        </a>
      ))}
    </div>
  );
}
