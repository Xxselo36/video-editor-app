"use client"; // Error boundaries must be Client Components

import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { reportError } from "@/components/ErrorReporting";
import {
  PRIMARY_BUTTON,
  PRIMARY_STYLE,
  SECONDARY_BUTTON,
  SECONDARY_STYLE,
  SiteShell,
} from "@/components/site/SiteShell";
import { hasPendingSaves, waitForAllSaves } from "@/lib/pendingSaves";

type SaveState = "none" | "saving" | "saved" | "unsaved";

/**
 * The editor, library or account page crashed. The editor sends its
 * last, still-debounced edit when it unmounts (flushOnLeave) — this
 * boundary lets those saves finish before it offers the reload, so
 * reloading loads what the user last did. The legal footer comes from
 * app/app/layout.tsx.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const t = useT();
  const [saves, setSaves] = useState<SaveState>("none");

  useEffect(() => {
    console.error(error);
    reportError(error);
  }, [error]);

  useEffect(() => {
    // Runs after the crashed editor's cleanup queued its last save.
    if (!hasPendingSaves()) return;
    let alive = true;
    setSaves("saving");
    void waitForAllSaves().then((ok) => {
      if (alive) setSaves(ok ? "saved" : "unsaved");
    });
    return () => {
      alive = false;
    };
  }, []);

  const saving = saves === "saving";
  return (
    <SiteShell footer={false}>
      <h1 className="mb-3 text-3xl font-bold tracking-tight">{t("common.error.title")}</h1>
      {saves !== "none" && (
        <p
          role="status"
          className="mb-3 text-sm font-medium"
          style={{ color: saves === "unsaved" ? "var(--warn)" : "var(--text-body)" }}
        >
          {saving ? t("app.crash.saving") : saves === "saved" ? t("app.crash.saved") : t("app.crash.unsaved")}
        </p>
      )}
      <p className="mb-8 text-base" style={{ color: "var(--text-body)" }}>
        {t("app.crash.body")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          disabled={saving}
          className={`${PRIMARY_BUTTON} disabled:opacity-60 disabled:hover:scale-100`}
          style={PRIMARY_STYLE}
        >
          {t("app.crash.reload")}
        </button>
        <button
          type="button"
          onClick={() => unstable_retry()}
          disabled={saving}
          className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          style={SECONDARY_STYLE}
        >
          {t("common.error.retry")}
        </button>
      </div>
      {error.digest && (
        <p className="mt-8 font-mono text-xs" style={{ color: "var(--text-muted)" }}>
          {t("common.error.ref", { id: error.digest })}
        </p>
      )}
    </SiteShell>
  );
}
