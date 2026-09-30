"use client";
// Moved from app/app/page.tsx (UX4).
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
      {/* Yellow with a dark mark, as large as the ⚠️ it replaced (which
          overflowed its 48 px line; -my-1 keeps that height). */}
      <TriangleAlert
        aria-hidden
        size={56}
        strokeWidth={1.5}
        className="-my-1 fill-[#fbbf24] text-[var(--surface-0)]"
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
