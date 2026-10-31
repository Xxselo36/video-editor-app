"use client";
/**
 * "Untertitel wählen" (mockups 2-untertitel, 2b-optionen, the waiting
 * state and the desktop one): the caption style, "Mehr Optionen" and
 * "Los geht's" while the picked video uploads. One upload status and one
 * go button, placed by the screen's width: on phones the status is a
 * strip that sticks to the top and the button a bar that sticks to the
 * bottom; on desktop both sit under the preview, beside the choices. DOM
 * order is the visual order.
 */
import { useEffect, useState } from "react";
import { PageTitle } from "@/components/PageTitle";
import { cx } from "@/components/ui/cx";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { GoBar, useUploadPhase } from "./GoBar";
import { MoreOptions } from "./MoreOptions";
import { useStartView } from "./pendingStart";
import { StylePicker } from "./StylePicker";
import { StylePreview } from "./StylePreview";
import { UploadStatus } from "./UploadStatus";
import s from "./start.module.css";

/** The heading: focus goes here when the screen comes up; it names the
 *  styles' radio group. */
export const TITLE_ID = "start-captions-h";

/** The start's frame, decoded (null until it is, or when the browser
 *  can't decode the video). */
function useFrame(frame: Promise<string | null>): HTMLImageElement | null {
  const [img, setImg] = useState<{ of: Promise<string | null>; el: HTMLImageElement } | null>(null);
  useEffect(() => {
    let alive = true;
    void frame
      .then(async (url) => {
        if (!url) return;
        const el = new Image();
        el.src = url;
        await el.decode();
        if (alive) setImg({ of: frame, el });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [frame]);
  return img?.of === frame ? img.el : null;
}

/** One polite line for what the buttons' own text can't announce: the
 *  wait after "Los geht's", the start, the upload done. */
function Announcer() {
  const t = useT();
  const { start } = useStartView();
  const phase = useUploadPhase(start.tempId);
  let say: MessageKey | null = null;
  if (start.failed) say = null;
  else if (phase === "starting") say = "app.projects.starting";
  else if (start.committed) say = phase === "running" ? "app.start.goWaiting" : null;
  else if (phase === "uploaded") say = "app.start.uploadedNote";
  return (
    <p role="status" className="sr-only" data-testid="start-announce">
      {say ? t(say) : ""}
    </p>
  );
}

export function StyleScreen() {
  const t = useT();
  const desktop = useIsDesktop();
  const { start } = useStartView();
  const frame = useFrame(start.frame);
  const title = t("app.start.chooseCaptions");
  const choose = (
    <section className={s.choose} aria-labelledby={TITLE_ID}>
      <PageTitle bar={title} id={TITLE_ID}>
        {title}
      </PageTitle>
      <StylePicker labelledBy={TITLE_ID} frame={frame} />
      <MoreOptions />
    </section>
  );
  return (
    <div className={cx("phase-fade", s.style)}>
      {desktop ? (
        <>
          {choose}
          <div className={s.aside}>
            <StylePreview frame={frame} />
            <UploadStatus />
            <GoBar />
          </div>
        </>
      ) : (
        <>
          <UploadStatus />
          {choose}
          <GoBar />
        </>
      )}
      <Announcer />
    </div>
  );
}
