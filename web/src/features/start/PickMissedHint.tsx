"use client";
/**
 * iPhone / iPad: the video didn't arrive (./pickWatch says iOS gave up).
 * Says why that happens with very large videos and what helps, and
 * offers "Pick anyway": the picker without a format filter, where iOS
 * converts the video first (./videoPicker). A pick there that isn't a
 * video is said here, and the hint stays for another try.
 *
 * `screen`: under the start screen's dropzone (UI kit Button). `tile`:
 * inside a stopped Projects tile, in the tile's own small pills.
 */
import { Info, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";

export function PickMissedHint({
  variant,
  onPickAnyway,
  error,
  testId = "pick-missed",
  className,
}: {
  variant: "screen" | "tile";
  onPickAnyway: () => void;
  /** Why the last "Pick anyway" pick was refused (not a video). */
  error: string | null;
  testId?: string;
  className?: string;
}) {
  const t = useT();
  if (variant === "tile") {
    return (
      <div data-testid={testId} className={cx("flex flex-col items-start gap-1.5", className)}>
        <p role="status" className="text-xs leading-relaxed" style={{ color: "var(--text-body)" }}>
          <span className="font-semibold" style={{ color: "var(--text-strong)" }}>
            {t("app.start.pickMissed")}
          </span>{" "}
          {t("app.start.pickMissedWhy")}
        </p>
        <button
          type="button"
          data-testid="pick-anyway"
          onClick={onPickAnyway}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold"
          style={{ background: "var(--brand-tint)", color: "var(--brand-strong)" }}
        >
          <Icon icon={RotateCw} />
          {t("app.start.pickAnyway")}
        </button>
        {error && (
          <p role="alert" data-testid="pick-missed-error" className="text-xs leading-relaxed" style={{ color: "var(--warn)" }}>
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      data-testid={testId}
      className={cx("phase-fade rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 text-left", className)}
    >
      <div role="status">
        <p className="flex items-start gap-2 text-sm font-semibold text-[var(--text-strong)]">
          <Icon icon={Info} className="mt-[0.2em] text-[var(--brand-hover)]" />
          <span className="min-w-0">{t("app.start.pickMissed")}</span>
        </p>
        <p className="mt-1 pl-[1.35rem] text-sm leading-relaxed text-[var(--text-body)]">{t("app.start.pickMissedWhy")}</p>
      </div>
      <div className="mt-3 flex flex-col items-start gap-1.5 pl-[1.35rem]">
        <Button variant="tint" size="sm" className="min-h-11" onClick={onPickAnyway} data-testid="pick-anyway">
          {t("app.start.pickAnyway")}
        </Button>
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t("app.start.pickAnywayNote")}</p>
        {error && (
          <p role="alert" data-testid="pick-missed-error" className="text-xs leading-relaxed text-[var(--warn)]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
