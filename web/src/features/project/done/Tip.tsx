"use client";
/**
 * The "Cleo cut" tip (UX11, review E3): for a video recorded without
 * voice commands, until it is dismissed. The editor's Done view and the
 * Vorschau's done state.
 */
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import type { JobStatus } from "@/features/jobs/types";
import { dismissTip, tipDismissed } from "../exportsInfo";

export function Tip({ job }: { job: Pick<JobStatus, "scene_events"> }) {
  const t = useT();
  const [tip, setTip] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage only exists in the browser
    setTip(!(job.scene_events && job.scene_events.length) && !tipDismissed());
  }, [job.scene_events]);

  if (!tip) return null;
  return (
    <p
      className="flex w-full max-w-md items-start gap-2 rounded-lg bg-[var(--surface-1)] px-3 py-2 text-xs text-[var(--text-body)]"
      data-testid="done-tip"
    >
      <span className="flex-1">{t("app.done.cleoCutTip")}</span>
      <button
        type="button"
        aria-label={t("app.done.dismiss")}
        // The tap area reaches 44 px (::after); the cross stays small.
        className="relative text-[var(--text-muted)] after:absolute after:-inset-[15px] after:content-[''] hover:text-[var(--text-strong)]"
        onClick={() => {
          dismissTip();
          setTip(false);
        }}
      >
        <Icon icon={X} size={14} />
      </button>
    </p>
  );
}
