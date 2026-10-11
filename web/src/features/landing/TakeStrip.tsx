"use client";
/**
 * The hero demo: one recording as a strip lying in 3D. In a 14 s loop
 * the spoken commands and the automatic cleanup remove a failed take
 * (“Cleo cut”), a filler word, a pause and a skipped sentence
 * (“Cleo stop” … “Cleo go”); at “Cleo finish” the captioned 9:16 clip
 * stands up out of the strip's end. Then it rewinds.
 *
 * CSS animations only (Landing.module.css). They run while the demo is
 * on screen and the tab is visible, unless the visitor paused them
 * (WCAG 2.2.2); reduced motion shows one still frame with the removed
 * parts marked. The first frame (negative delay) is the finished clip,
 * so a screenshot or a slow start still shows the result.
 *
 * The strip is decoration for sighted visitors (aria-hidden); the list
 * under it says the same in words.
 */
import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { useT } from "@/i18n";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CaptionFrame } from "./CaptionFrame";
import { Cmd, useDocumentVisible, useInView } from "./shared";
import styles from "./Landing.module.css";

export function TakeStrip() {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.1 });
  const visible = useDocumentVisible();
  const running = !paused && inView && visible;

  return (
    <div ref={ref} className={styles.demo} data-running={running}>
      <div className={styles.stage} aria-hidden="true">
        <div className={styles.rail}>
          <span className={cx(styles.railItem, styles.railStart)}>
            <Cmd id="start" />
          </span>
          <span className={cx(styles.railItem, styles.railCut)}>
            <Cmd id="cut" />
          </span>
          <span className={cx(styles.railItem, styles.railFiller)}>
            <span className={styles.struck}>{t("site.demo.filler")}</span>
          </span>
          <span className={cx(styles.railItem, styles.railPause)}>
            <span className={styles.hatch} />
            <span style={{ color: "var(--text-muted)" }}>{t("site.auto.pause")}</span>
          </span>
          <span className={cx(styles.railItem, styles.railSkip)}>
            <Cmd id="stop" /> <span style={{ color: "var(--text-muted)" }}>…</span> <Cmd id="go" />
          </span>
          <span className={cx(styles.railItem, styles.railFinish)}>
            <Cmd id="finish" />
          </span>
        </div>

        <div className={styles.stripArea}>
          <div className={styles.strip}>
            <span className={cx(styles.post, styles.postStart)} />
            <span className={cx(styles.seg, styles.segBad)} />
            <span className={cx(styles.post, styles.postCut)} />
            <span className={cx(styles.seg, styles.segTake)} />
            <span className={cx(styles.seg, styles.segFiller)} />
            <span className={cx(styles.seg, styles.segTake2)} />
            <span className={cx(styles.post, styles.postKeep)} />
            <span className={cx(styles.seg, styles.segPause)} />
            <span className={cx(styles.post, styles.postStop)} />
            <span className={cx(styles.seg, styles.segSkip)} />
            <span className={cx(styles.post, styles.postGo)} />
            <span className={cx(styles.seg, styles.segTake3)} />
            <span className={cx(styles.post, styles.postFinish)} />
            <span className={styles.sweep} />
          </div>
        </div>

        <div className={styles.clip}>
          <CaptionFrame
            preset="power"
            text={t("site.demo.caption")}
            tag={t("site.demo.example")}
            captionClassName={styles.clipCaption}
          />
        </div>
      </div>

      <div className={styles.legend}>
        <ul className={styles.legendList} aria-label={t("site.demo.listAria")}>
          <li className={cx(styles.legendItem, styles.liTake)}>
            <span className={styles.swatch} aria-hidden="true" />
            {t("site.demo.take")}
          </li>
          <li className={cx(styles.legendItem, styles.liFillers)}>
            <span className={styles.swatch} aria-hidden="true" />
            {t("site.demo.fillers")}
          </li>
          <li className={cx(styles.legendItem, styles.liPauses)}>
            <span className={cx(styles.swatch, styles.swatchHatch)} aria-hidden="true" />
            {t("site.demo.pauses")}
          </li>
          <li className={cx(styles.legendItem, styles.liSkip)}>
            <span className={styles.swatch} aria-hidden="true" />
            {t("site.demo.skip")}
          </li>
          <li className={cx(styles.legendItem, styles.liCaptions)}>
            <span className={styles.swatch} aria-hidden="true" />
            {t("site.demo.captions")}
          </li>
        </ul>
        <IconButton
          label={paused ? t("site.demo.play") : t("site.demo.pause")}
          className={styles.playToggle}
          onClick={() => setPaused((p) => !p)}
        >
          <Icon icon={paused ? Play : Pause} size={16} />
        </IconButton>
      </div>
    </div>
  );
}
