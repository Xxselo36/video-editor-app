"use client";
/**
 * The hero demo: one recording as a strip lying in 3D. In a ~14 s loop
 * the spoken commands and the automatic cleanup remove a failed take
 * (“Cleo cut”), a filler word, a pause and a skipped sentence
 * (“Cleo stop” … “Cleo go”); at “Cleo finish” the captioned 9:16 clip
 * stands up out of the strip's end. Then it rewinds.
 *
 * A small step machine: each step is a set of data-* attributes on the
 * demo, and Landing.module.css transitions between them. Nothing runs
 * between steps, so the long holds cost nothing (keyframe loops kept a
 * phone's main thread busy all the time). The steps advance while the
 * demo is on screen and the tab is visible, unless the visitor paused
 * them (WCAG 2.2.2). Reduced motion shows one still frame with the
 * removed parts marked. The first frame is the finished clip, so a
 * screenshot or a slow start still shows the result.
 *
 * The strip is decoration for sighted visitors (aria-hidden); the list
 * under it says the same in words.
 */
import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useT } from "@/i18n";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { cx } from "@/components/ui/cx";
import { CaptionFrame } from "./CaptionFrame";
import { Cmd, useDocumentVisible, useInView, useReducedMotion } from "./shared";
import styles from "./Landing.module.css";

type Piece = "" | "mark" | "gone";
type Step = {
  ms: number;
  rail?: "start" | "cut" | "filler" | "pause" | "skip" | "finish";
  sweep?: "run" | "end";
  take?: Piece;
  filler?: Piece;
  pause?: Piece;
  skip?: Piece;
  clip?: boolean;
  caption?: boolean;
  li?: "take" | "fillers" | "pauses" | "skip" | "captions";
};

const CLEANED = { take: "gone", filler: "gone", pause: "gone", skip: "gone" } as const;

/** The loop, in order. The last step is the rewind back to the start. */
const STEPS: Step[] = [
  { ms: 2400, rail: "start", sweep: "run" },
  { ms: 700, rail: "cut", sweep: "end", take: "mark", li: "take" },
  { ms: 900, rail: "cut", sweep: "end", take: "gone", li: "take" },
  { ms: 500, rail: "filler", sweep: "end", take: "gone", filler: "mark", li: "fillers" },
  { ms: 900, rail: "filler", sweep: "end", take: "gone", filler: "gone", li: "fillers" },
  { ms: 500, rail: "pause", sweep: "end", take: "gone", filler: "gone", pause: "mark", li: "pauses" },
  { ms: 900, rail: "pause", sweep: "end", take: "gone", filler: "gone", pause: "gone", li: "pauses" },
  { ms: 600, rail: "skip", sweep: "end", take: "gone", filler: "gone", pause: "gone", skip: "mark", li: "skip" },
  { ms: 900, rail: "skip", sweep: "end", ...CLEANED, li: "skip" },
  { ms: 800, rail: "finish", sweep: "end", ...CLEANED, clip: true },
  { ms: 3600, rail: "finish", sweep: "end", ...CLEANED, clip: true, caption: true, li: "captions" },
  { ms: 900 },
];
/** The finished clip: the first frame. */
const FIRST = STEPS.length - 2;
/** Reduced motion: one frame with everything that gets removed marked. */
const STILL: Step = { ms: 0, take: "mark", filler: "mark", pause: "mark", skip: "mark", clip: true, caption: true };

export function TakeStrip() {
  const t = useT();
  const [paused, setPaused] = useState(false);
  const [i, setI] = useState(FIRST);
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.1 });
  const visible = useDocumentVisible();
  const reduced = useReducedMotion();
  const running = !paused && inView && visible && !reduced;

  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => setI((n) => (n + 1) % STEPS.length), STEPS[i].ms);
    return () => window.clearTimeout(id);
  }, [running, i]);

  const s = reduced ? STILL : STEPS[i];
  return (
    <div
      ref={ref}
      className={styles.demo}
      data-rail={s.rail ?? ""}
      data-sweep={s.sweep ?? ""}
      data-take={s.take ?? ""}
      data-filler={s.filler ?? ""}
      data-pause={s.pause ?? ""}
      data-skip={s.skip ?? ""}
      data-clip={s.clip ? "up" : ""}
      data-caption={s.caption ? "on" : ""}
      data-li={s.li ?? ""}
    >
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
            <span style={{ color: "var(--text-body)" }}>{t("site.auto.pause")}</span>
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
