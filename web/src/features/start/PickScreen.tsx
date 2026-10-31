"use client";
/**
 * "Neues Video" (mockup 1-video): one big card that is the chooser's
 * button (on desktop also a drop zone), the limits on it, and under it
 * what the pick needs to say: "Video wird vorbereitet…" with the iPhone
 * hint, why iOS's video didn't come, why the video can't go up (the
 * pick-time check), the minutes left. An interrupted upload of this
 * browser is offered above the card; it goes on through "Untertitel
 * wählen" like a new pick.
 */
import { RotateCw, Upload } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageTitle } from "@/components/PageTitle";
import { Button, buttonClass } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { Icon } from "@/components/ui/Icon";
import { useResumableUploads } from "@/features/upload/useResumable";
import { useLang, useT } from "@/i18n";
import { fmtMinutes } from "@/lib/account";
import type { Limits } from "@/lib/config";
import { formatPct } from "@/lib/percent";
import { discardResumable } from "@/lib/uploadResume";
import { useStartActions } from "./pendingStart";
import { PickMissedHint } from "./PickMissedHint";
import { useBillingHint } from "./useBillingHint";
import { resumeWithAny } from "./videoPicker";
import s from "./start.module.css";

/** The card's button: focus comes back here after X. */
export const DROP_ID = "start-choose";

/** What the pick has to say (StartScreen owns the inputs and the checks). */
export type PickStatus = {
  ios: boolean;
  /** "Video wird vorbereitet…": the chooser closed and the file hasn't
   *  come, or it is being checked. */
  preparing: boolean;
  /** Preparing for a while already. */
  slow: boolean;
  /** iOS: no word for a long while ("Immer noch nichts?"). */
  stalled: boolean;
  /** iOS gave up on the video. */
  missed: boolean;
  /** "Trotzdem wählen" gave something that isn't a video. */
  pickError: string | null;
  /** iOS: the original is over the upload cap. */
  tooBig: string | null;
  /** The pick-time check refused the video. */
  refusal: string | null;
};

export function PickScreen({ status, limits }: { status: PickStatus; limits: Limits }) {
  const t = useT();
  const lang = useLang();
  const { choose, chooseAny, drop } = useStartActions();
  const billing = useBillingHint();
  // The newest interrupted upload of this browser with bytes left to send
  // (one whose bytes are all stored isn't offered here: picked again, it
  // goes on with its choices all the same).
  const resume = useResumableUploads()?.find((r) => !r.completed) ?? null;
  const [discarding, setDiscarding] = useState(false);
  const [over, setOver] = useState(false);
  const { ios, preparing } = status;

  const discard = async (fp: string) => {
    setDiscarding(true);
    try {
      await discardResumable(fp);
    } finally {
      setDiscarding(false);
    }
  };

  const gb = fmtMinutes(limits.max_upload_bytes / 1e9, lang);
  const limitsLine =
    limits.max_seconds !== null
      ? t("app.start.limits", { minutes: fmtMinutes(limits.max_seconds / 60, lang), gb })
      : t("app.start.limitsNoLength", { gb });
  // One filled button per view: with the resume card's, the card's is tint.
  const pill = resume ? "tint" : "primary";

  return (
    <div className={cx("phase-fade", s.pick)}>
      <PageTitle bar={t("app.start.title")}>{t("app.start.title")}</PageTitle>

      {resume && (
        <div role="region" aria-labelledby="start-resume-text" data-testid="start-resume" className={s.resume}>
          <p id="start-resume-text" className={s.resumeText}>
            <Icon icon={RotateCw} />
            <span className="min-w-0">{t("app.start.resumeCard", { name: resume.name, pct: formatPct(resume.pct, lang) })}</span>
          </p>
          <div className={s.resumeActions}>
            <Button
              // Picked with "Pick anyway" (iOS converted it): that chooser
              // again, the other one hands over different bytes.
              onClick={resumeWithAny(ios, resume.source) ? () => chooseAny(false) : choose}
              data-testid="start-resume-choose"
              className="inline-flex min-h-11 items-center gap-2"
            >
              <Icon icon={Upload} />
              {t("app.start.resumeChoose")}
            </Button>
            <button
              type="button"
              onClick={() => void discard(resume.fp)}
              disabled={discarding}
              data-testid="start-resume-discard"
              className={s.resumeDiscard}
            >
              {t("app.start.resumeDiscard")}
            </button>
          </div>
        </div>
      )}

      <div
        className={s.drop}
        data-testid="upload-dropzone"
        data-over={over || undefined}
        data-resume={resume ? "" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          drop(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        <button
          type="button"
          id={DROP_ID}
          className={s.dropButton}
          aria-label={t("app.start.choose")}
          aria-describedby="start-limits"
          onClick={choose}
        />
        <div className={s.face} aria-hidden>
          <span className={s.ghost}>
            <Icon icon={Upload} size={30} />
          </span>
          <span className={cx(buttonClass(pill, "lg"), s.pill)} data-variant={pill}>
            {t("app.start.choose")}
          </span>
          <span className={s.or}>{t("app.start.drop")}</span>
          <span id="start-limits" className={s.limits} data-testid="start-limits">
            {limitsLine}
          </span>
        </div>
        <div className={s.extras}>
          {billing && (
            <Link href={billing.href} data-testid="start-minutes" className={s.minutes}>
              {billing.text}
            </Link>
          )}
          {preparing ? (
            <>
              <div role="status">
                <p className={s.preparing} data-testid="start-preparing">
                  {t("app.start.preparing")}
                </p>
                {status.slow && (
                  <p className={s.note} data-testid="start-preparing-slow">
                    {t("app.start.preparingSlow")}
                  </p>
                )}
                {ios && (
                  <p className={s.note} data-testid="start-ios-hint">
                    {t("app.start.iosHint")}
                  </p>
                )}
              </div>
              {ios && status.stalled && (
                // No word from iOS for a long while: maybe it gave up
                // without saying so. Softly: it may still deliver.
                <p className={s.note} data-testid="pick-stalled">
                  {t("app.start.stillNothing")}{" "}
                  <button type="button" onClick={() => chooseAny(true)} data-testid="pick-anyway" className={s.quiet}>
                    {t("app.start.pickAnyway")}
                  </button>
                </p>
              )}
            </>
          ) : (
            ios && (
              <>
                {/* MOV / MP4 / HEVC only in the card's chooser (./videoPicker). */}
                <button type="button" onClick={() => chooseAny(false)} data-testid="start-other-formats" className={s.quiet}>
                  {t("app.start.otherFormats")}
                </button>
                {(status.missed || status.pickError || status.tooBig) && (
                  <PickMissedHint
                    variant="screen"
                    className="w-full"
                    onPickAnyway={() => chooseAny(true)}
                    error={status.pickError}
                    tooBig={status.tooBig}
                  />
                )}
              </>
            )
          )}
          {status.refusal && (
            <p role="alert" data-testid="start-pick-error" className={s.pickError}>
              {status.refusal}
            </p>
          )}
        </div>
      </div>

      <Link href="/privacy" data-testid="upload-privacy" className={s.privacy}>
        {t("app.upload.privacyLink")}
      </Link>
    </div>
  );
}
