"use client";
/**
 * The picked video's upload on "Untertitel wählen" (D2): "Wird
 * hochgeladen · 42 %", the file name, X (gives the video up: nothing was
 * started), and a thin bar in the uploading hue; a second line when
 * needed (waiting for the connection, resuming, the minutes this video
 * uses). Done: "Hochgeladen". X goes once POST /jobs is out, unless it
 * waits for the connection. Failed: "Upload gestoppt", why, "Nochmal
 * versuchen" (the screen's one primary action then: the go button rests).
 * On phones a strip that sticks to the top, opaque with a line once it
 * does; on desktop under the preview.
 */
import { RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useLocalJobs } from "@/features/jobs/jobsStore";
import { useLiveUpload } from "@/features/upload/uploadState";
import { useLang, useT } from "@/i18n";
import { fmtMinutes, useMe } from "@/lib/account";
import { describeError } from "@/lib/errors";
import { formatPct } from "@/lib/percent";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { useBarHeight } from "./barHeight";
import { useStartActions, useStartView } from "./pendingStart";
import s from "./start.module.css";

/** m:ss of `seconds`. */
function clock(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// Stands for the percentage in the translated status, so it can be set
// in bold wherever the language puts it.
const SLOT = "\u0000";

/** Why the upload stopped: its record's code (the jobs store keeps it). */
function FailureReason({ tempId }: { tempId: string }) {
  const t = useT();
  const upload = useLocalJobs().find((j) => j.jobId === tempId)?.upload;
  if (!upload?.errorCode) return null;
  return <p className={s.reason}>{describeError({ code: upload.errorCode, params: upload.errorParams }, t, { v2: true })}</p>;
}

export function UploadStatus() {
  const t = useT();
  const lang = useLang();
  const desktop = useIsDesktop();
  const { start } = useStartView();
  const { cancel, retry } = useStartActions();
  const live = useLiveUpload(start.tempId);
  const { me } = useMe();
  const sentinel = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useBarHeight(strip, "--start-strip-h");

  useEffect(() => {
    const mark = sentinel.current;
    const bar = strip.current;
    if (desktop || !mark || !bar) return;
    // Stuck once the spot it started from is above its sticky top.
    const top = parseFloat(getComputedStyle(bar).top) || 0;
    const io = new IntersectionObserver(
      ([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < top + 1),
      { rootMargin: `${-(top + 1)}px 0px 0px 0px` },
    );
    io.observe(mark);
    return () => io.disconnect();
  }, [desktop]);

  const name = start.file.name;
  // (POST /jobs out: also once the job exists, on the way to Projects.)
  const done = Boolean(live?.uploaded || live?.starting || start.starting);
  const pct = done ? 100 : (live?.pct ?? 0);
  const state = live?.paused ? "paused" : done ? "uploaded" : live?.resuming ? "resuming" : "uploading";
  const shownPct = formatPct(pct, lang);
  const text = done ? t("app.processing.step.uploaded") : t("app.start.uploadingPct", { pct: shownPct });
  const [before, after = ""] = t("app.start.uploadingPct", { pct: SLOT }).split(SLOT);
  // X until POST /jobs is out, unless it waits for the connection.
  const canCancel = live ? !live.starting || Boolean(live.paused) : !start.starting;
  // Billing on: what this video takes of the minutes left.
  const used = start.probe?.duration ?? null;
  const minutesLeft = me?.minutes ? Math.max(0, me.minutes.remaining) : null;
  const x = (
    <button type="button" className={s.x} aria-label={t("app.start.cancelUpload")} data-testid="start-cancel" onClick={cancel}>
      <Icon icon={X} size={16} />
    </button>
  );
  const file = (
    <span className={s.file} title={name}>
      {name}
    </span>
  );

  return (
    <>
      {!desktop && <div ref={sentinel} aria-hidden className={s.sentinel} />}
      <div ref={strip} className={s.status} data-testid="start-upload" data-stuck={stuck || undefined}>
        {start.failed ? (
          <div role="alert" data-testid="start-upload-failed">
            <div className={s.statusRow}>
              <span className={s.statusText} data-testid="start-upload-status" data-state="failed">
                {t("app.projects.badge.uploadFailed")}
              </span>
              <span className={s.statusEnd}>
                {file}
                {x}
              </span>
            </div>
            <FailureReason tempId={start.tempId} />
            <Button
              size="sm"
              className={cx("inline-flex min-h-11 items-center gap-1.5", s.retry)}
              onClick={retry}
              data-testid="start-retry"
            >
              <Icon icon={RotateCw} />
              {t("app.projects.retry")}
            </Button>
          </div>
        ) : (
          <>
            <div className={s.statusRow}>
              <span className={s.statusText} data-testid="start-upload-status" data-state={state}>
                {done ? (
                  text
                ) : (
                  <>
                    {before}
                    <span className={s.pct}>{shownPct}</span>
                    {after}
                  </>
                )}
              </span>
              <span className={s.statusEnd}>
                {file}
                {canCancel && x}
              </span>
            </div>
            <div
              className={s.track}
              role="progressbar"
              aria-label={t("app.start.uploading")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-valuetext={text}
            >
              <span className={s.fill} style={{ "--p": pct / 100 } as CSSProperties} />
            </div>
            {live?.paused ? (
              <p role="status" className={cx(s.line, s.warn)} data-testid="start-paused">
                {t("app.upload.paused")}
              </p>
            ) : (
              state === "resuming" && (
                <p className={s.line} data-testid="start-resuming">
                  {t("app.upload.resuming")}
                </p>
              )
            )}
            {used !== null && minutesLeft !== null && (
              <p className={cx(s.line, s.uses)} data-testid="start-uses">
                {t("app.start.usesMinutes", { used: clock(used), left: fmtMinutes(minutesLeft, lang) })}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
