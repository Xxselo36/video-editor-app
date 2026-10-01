"use client";
/**
 * "New captions (test)": a small note next to the export while this
 * browser asks for the v2 export captions (flag.ts), so the owner knows
 * his test is on. Nothing otherwise.
 */
import { useT } from "@/i18n";
import { useCaptionsV2 } from "./flag";

export function CaptionsV2Marker({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const t = useT();
  const on = useCaptionsV2();
  if (!on) return null;
  return (
    <span
      data-testid="captions-v2-marker"
      className={className}
      style={{ fontSize: 11, lineHeight: 1.2, opacity: 0.7, whiteSpace: "nowrap", ...style }}
    >
      {t("editor.captionsV2Test")}
    </span>
  );
}
