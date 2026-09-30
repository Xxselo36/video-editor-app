"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { TriangleAlert } from "lucide-react";
import { useT } from "@/i18n";

export function ErrorView({
  message,
  onReset,
}: {
  message: string;
  onReset: () => void;
}) {
  const t = useT();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4" data-testid="error-screen">
      {/* Filled amber with a dark mark, like the ⚠️ it replaced. */}
      <TriangleAlert
        aria-hidden
        size={48}
        strokeWidth={1.75}
        className="fill-[var(--warn)] text-[var(--surface-0)]"
      />
      <div className="text-base font-semibold">{t("app.errors.title")}</div>
      <div className="max-w-xs text-center text-xs text-[var(--text-muted)]">{message}</div>
      <button
        onClick={onReset}
        className="mt-2 rounded-xl border border-[var(--border-hover)] px-5 py-2 text-sm hover:border-[var(--brand)]"
      >
        {t("app.errors.tryAgain")}
      </button>
    </div>
  );
}
