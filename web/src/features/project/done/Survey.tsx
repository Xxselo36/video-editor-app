"use client";
/**
 * "Did you have to edit this video anywhere else?" (UX11, review A5):
 * from this browser's 2nd export on, at most once a week. The editor's
 * Done view and the Vorschau's done state.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import type { JobStatus } from "@/features/jobs/types";
import { noteExport, surveyAnswered } from "../exportsInfo";
import { sendSurvey } from "../projectApi";

// The buttons' tap area reaches 44 px high (::after); they stay small.
const TAP = "relative after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']";

export function Survey({ job }: { job: Pick<JobStatus, "id" | "renders_ok"> }) {
  const t = useT();
  const [survey, setSurvey] = useState<"off" | "ask" | "what" | "thanks">("off");
  const [surveyText, setSurveyText] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage only exists in the browser
    if (noteExport(`${job.id}:${job.renders_ok ?? 0}`)) setSurvey("ask");
  }, [job.id, job.renders_ok]);
  const answer = (a: "yes" | "no") => {
    if (a === "yes") {
      setSurvey("what");
      return;
    }
    sendSurvey(job.id, "no");
    surveyAnswered();
    setSurvey("thanks");
  };

  if (survey === "off") return null;
  return (
    <section
      className="w-full max-w-md rounded-xl border border-[var(--border)] p-3 text-center text-sm text-[var(--text-body)]"
      data-testid="done-survey"
      aria-live="polite"
    >
      {survey === "thanks" ? (
        <p>{t("app.done.surveyThanks")}</p>
      ) : (
        <>
          <p className="mb-2">{t("app.done.surveyQuestion")}</p>
          {survey === "ask" ? (
            <div className="flex justify-center gap-2">
              <Button size="sm" variant="tint" className={TAP} onClick={() => answer("yes")} data-testid="done-survey-yes">
                {t("app.done.surveyYes")}
              </Button>
              <Button size="sm" variant="tint" className={TAP} onClick={() => answer("no")} data-testid="done-survey-no">
                {t("app.done.surveyNo")}
              </Button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendSurvey(job.id, "yes", surveyText.trim() || undefined);
                surveyAnswered();
                setSurvey("thanks");
              }}
            >
              <input
                value={surveyText}
                onChange={(e) => setSurveyText(e.target.value)}
                maxLength={300}
                aria-label={t("app.done.surveyWhat")}
                placeholder={t("app.done.surveyWhat")}
                // 16 px on touch screens: iOS zooms into a smaller field.
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1 text-sm text-[var(--text-strong)] pointer-coarse:text-base"
              />
              <Button size="sm" type="submit" className={TAP} data-testid="done-survey-send">
                {t("app.done.surveySend")}
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
