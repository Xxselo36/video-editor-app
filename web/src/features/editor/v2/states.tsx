"use client";
/**
 * Editor v2 states (editor.md §4.7): the skeleton of the exact layout
 * while the job loads, and the full-screen view of a project that no
 * longer exists (404/410) instead of a broken editor.
 */
import { ChevronLeft, FileX } from "lucide-react";
import { useT } from "@/i18n";
import s from "./editor.module.css";

export function EditorSkeleton({ phone, onBack }: { phone: boolean; onBack?: () => void }) {
  const t = useT();
  const back = (
    <button
      type="button"
      className={`${phone ? s.mb : s.gb} ${s.ico}`}
      aria-label={t("editor.back")}
      onClick={onBack}
      disabled={!onBack}
    >
      <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
    </button>
  );
  return (
    <>
      <header className={s.top} aria-busy="true">
        {back}
        <div className={s.skel} style={{ width: 160, height: 14, marginLeft: 8 }} />
        <span className={s.flex1} />
        <div className={s.skel} style={{ width: phone ? 96 : 118, height: 32 }} />
      </header>
      <section className={s.stage} data-testid="ed-skeleton" aria-label={t("editor.loading")}>
        <span className={s.sr} role="status">
          {t("editor.loading")}
        </span>
        <div className={s.skel} style={phone ? { width: 186, height: 330, marginTop: 12 } : { width: 338, height: 600, maxHeight: "calc(100% - 96px)", aspectRatio: "9 / 16" }} />
        {!phone && <div className={s.skel} style={{ width: 338, height: 20, opacity: 0.6 }} />}
      </section>
      {!phone && (
        <aside className={s.side}>
          <div className={s.tablist} />
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            {[92, 80, 96, 70, 88, 60].map((w, i) => (
              <div key={i} className={s.skel} style={{ width: `${w}%`, height: 12 }} />
            ))}
          </div>
        </aside>
      )}
      <section className={s.dock}>
        <div style={{ display: "flex", gap: 6, padding: phone ? "84px 16px 0" : "66px 20px 0" }}>
          {[14, 22, 12, 18, 26, 8].map((w, i) => (
            <div key={i} className={s.skel} style={{ flex: w, height: phone ? 80 : 52, borderRadius: 4 }} />
          ))}
        </div>
      </section>
      {phone && <nav className={s.tabbar} />}
    </>
  );
}

export function ExpiredView({ onBack }: { onBack: () => void }) {
  const t = useT();
  return (
    <div className={s.center} data-testid="ed-expired" role="alert">
      <FileX size={32} strokeWidth={1.5} aria-hidden style={{ color: "var(--ed-text-3)" }} />
      <h1 className={s.centerTitle}>{t("editor.expired.title")}</h1>
      <p className={s.centerText}>{t("editor.expired.text")}</p>
      <button type="button" className={s.gb} style={{ marginTop: 8, color: "var(--ed-text-1)" }} onClick={onBack}>
        <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
        {t("editor.expired.back")}
      </button>
    </div>
  );
}
