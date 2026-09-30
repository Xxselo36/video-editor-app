"use client";
import { ArrowRight } from "lucide-react";
import { IconMic } from "@/components/Icons";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";

/**
 * The chip that opens the voice test (dashboard and picker). Its faint
 * brand border sits inside the padding (11 px + 1 px border = the chip's
 * old 12 px), so the chip keeps its size.
 */
export function VoiceTeaser({ onClick, className }: { onClick: () => void; className?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="voice-teaser"
      className={cx(
        "inline-flex items-center gap-2 rounded-full border border-[var(--brand)]/30 bg-[var(--brand-tint)] px-[11px] py-[5px] text-xs font-medium text-[var(--brand-strong)] transition-colors",
        className,
      )}
    >
      <IconMic size={14} strokeWidth={2.5} />
      {t("app.dashboard.voiceTeaser")}
      <Icon icon={ArrowRight} className="opacity-70" />
    </button>
  );
}
