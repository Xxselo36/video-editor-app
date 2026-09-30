"use client";
// Moved verbatim from app/app/page.tsx (UX4).
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { IconPhone } from "@/components/Icons";
import { Icon } from "@/components/ui/Icon";
import { useT } from "@/i18n";
import { useBillingHint } from "./useBillingHint";

export function IdleScreen({
  onPick,
  onDrop,
  onBack,
}: {
  onPick: () => void;
  onDrop: (e: React.DragEvent) => void;
  onBack: () => void;
}) {
  const t = useT();
  const billingHint = useBillingHint();
  return (
    <div className="relative z-10 flex flex-col">
      <button
        onClick={onBack}
        data-testid="upload-back"
        className="mb-4 -ml-2 w-fit rounded-lg px-2 py-2 text-sm"
        style={{ color: "var(--text-muted)" }}
      >
        <Icon icon={ArrowLeft} /> {t("app.upload.back")}
      </button>
      <h1
        className="mb-2 text-4xl font-bold tracking-tight sm:text-5xl"
        style={{ color: "var(--text-strong)" }}
      >
        {t("app.upload.title")}
      </h1>
      <p className="mb-8 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("app.upload.hint")}{" "}
        <Link
          href="/privacy"
          data-testid="upload-privacy"
          className="whitespace-nowrap text-xs underline underline-offset-2 hover:opacity-80"
          style={{ color: "var(--text-muted)" }}
        >
          {t("app.upload.privacyLink")}
        </Link>
      </p>
      {billingHint && (
        <Link
          href={billingHint.href}
          className="-mt-5 mb-6 w-fit text-xs font-medium transition-opacity hover:opacity-80"
          style={{ color: "var(--brand-strong)" }}
        >
          {billingHint.text} <Icon icon={ArrowRight} />
        </Link>
      )}

      <button
        onClick={onPick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        data-testid="upload-dropzone"
        className="group w-full rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface-1)] px-6 py-16 text-center transition-all hover:scale-[1.01] hover:border-[var(--brand)]"
      >
        <div
          className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl transition-transform group-hover:scale-110"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand)",
          }}
        >
          <IconPhone size={26} strokeWidth={2} />
        </div>
        <div
          className="text-base font-bold"
          style={{ color: "var(--text-strong)" }}
        >
          {t("app.upload.tapToChoose")}
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {t("app.upload.orDrag")}
        </div>
      </button>
    </div>
  );
}
