"use client";
/**
 * "Los geht's" (D1, D2): opens the start's gate. While the video still
 * uploads the button turns into "Startet nach dem Hochladen" (the choices
 * stay open until POST /jobs reads them); with the bytes up the job
 * starts at once, "Wird gestartet…". While the upload is stopped nothing
 * would start from here: the button rests (the alert's "Nochmal
 * versuchen" is the way on; after "Los geht's" the job then starts by
 * itself). Under it, while the upload runs, the note to keep the page
 * open.
 */
import { Check } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { getLiveUpload, subscribe } from "@/features/upload/uploadState";
import { useT } from "@/i18n";
import { useBarHeight } from "./barHeight";
import { useStartActions, useStartView } from "./pendingStart";
import s from "./start.module.css";

/** Where upload `id` is: its bytes going up, all stored (R2: waiting for
 *  the gate), POST /jobs out, or over. Changes a few times per upload,
 *  not with every progress tick. */
export function useUploadPhase(id: string): "running" | "uploaded" | "starting" | "over" {
  return useSyncExternalStore(
    subscribe,
    () => {
      const live = getLiveUpload(id);
      if (!live) return "over";
      if (live.starting) return "starting";
      return live.uploaded ? "uploaded" : "running";
    },
    () => "over",
  );
}

export function GoBar() {
  const t = useT();
  const { start } = useStartView();
  const { go } = useStartActions();
  const phase = useUploadPhase(start.tempId);
  const bar = useRef<HTMLDivElement>(null);
  useBarHeight(bar, "--start-go-h");
  const state = start.failed
    ? "idle"
    : start.starting || phase === "starting"
      ? "starting"
      : start.committed
        ? "waiting"
        : "idle";
  const ready = state === "idle" && !start.failed;
  return (
    <div ref={bar} className={s.go}>
      <Button
        size="lg"
        variant={ready ? "primary" : "tint"}
        className={s.goBtn}
        data-testid="start-go"
        data-state={state}
        aria-disabled={!ready || undefined}
        onClick={ready ? go : undefined}
      >
        {/* One line box: wrapped, the check leads the first line. */}
        <span className={s.goLabel}>
          {state === "waiting" && <Icon icon={Check} size={19} className={s.goCheck} />}
          {t(state === "idle" ? "app.start.go" : state === "waiting" ? "app.start.goWaiting" : "app.projects.starting")}
        </span>
      </Button>
      {phase === "running" && (
        <p className={s.goNote} data-testid="start-keep-open">
          {t("app.start.keepOpen")}
        </p>
      )}
    </div>
  );
}
