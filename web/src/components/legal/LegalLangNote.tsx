"use client";
/**
 * The legal pages exist in German and English only: visitors with
 * another UI language read the English text, with this note (in their
 * language) above it.
 */
import { useLang, useT } from "@/i18n";

export function LegalLangNote() {
  const lang = useLang();
  const t = useT();
  if (lang === "en" || lang === "de") return null;
  return (
    <p
      role="note"
      className="mb-6 rounded-xl px-4 py-3 text-sm"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text-body)" }}
    >
      {t("legal.onlyDeEn")}
    </p>
  );
}
