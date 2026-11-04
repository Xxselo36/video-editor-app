"use client";
/**
 * The export's bonus clips (UX11): only what the backend kept (an
 * untouched timeline of 90 s or more, G6), each a download. The editor's
 * Done view (its heading under the sheet's h2) and the Vorschau's "Mehr
 * zum Video" (under the page's h1: `level` 2).
 */
import { Download, Sparkles } from "lucide-react";
import { PRESS } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import type { JobStatus } from "@/features/jobs/types";
import { clock } from "../exportsInfo";
import { downloadHref } from "./useShareFile";

export function BonusClips({
  job,
  level = 3,
}: {
  job: Pick<JobStatus, "id" | "renders_ok" | "hook_clips" | "download_names">;
  /** The heading's level under the page's or the sheet's own heading. */
  level?: 2 | 3;
}) {
  const t = useT();
  const hooks = job.hook_clips ?? [];
  if (hooks.length === 0) return null;
  const names = job.download_names ?? {};
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className="w-full max-w-md" data-testid="done-hooks">
      <Heading className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text-body)]">
        <Icon icon={Sparkles} size={14} />
        {t("app.done.bonusClips")}
        <span className="rounded bg-[var(--brand-tint)] px-1.5 py-0.5 text-[10px] text-[var(--brand-strong)]">
          {t("app.done.aiPicked")}
        </span>
      </Heading>
      <div className="flex flex-col gap-2">
        {hooks.map((h) => (
          <a
            key={h.key}
            href={downloadHref(job, h.key)}
            download={names[h.key] ?? true}
            className={cx("block rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 hover:border-[var(--brand)]", PRESS)}
          >
            <div className="mb-0.5 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-[var(--text-strong)]">{h.title}</span>
              <span className="flex items-center gap-1 text-xs tabular-nums text-[var(--text-muted)]">
                {clock(h.end - h.start)}
                <Icon icon={Download} size={13} />
              </span>
            </div>
            {h.reason && <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{h.reason}</p>}
          </a>
        ))}
      </div>
    </section>
  );
}
