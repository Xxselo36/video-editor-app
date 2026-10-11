/**
 * A 9:16 frame with one caption page drawn in a real preset's look:
 * its font (public/fonts/captions), case, outline, highlight and number
 * colours from lib/captions/presets.ts. A still of what the engine
 * renders, not the engine itself (that would load harfbuzz here).
 *
 * The caption text marks its highlighted word with [brackets]; digits
 * get the preset's number colour where it has one.
 */
import { cx } from "@/components/ui/cx";
import styles from "./Landing.module.css";

export type FramePreset = "power" | "clipper" | "boxed" | "elegant";

const PRESET_CLASS: Record<FramePreset, string> = {
  power: styles.capPower,
  clipper: styles.capClipper,
  boxed: styles.capBoxed,
  elegant: styles.capElegant,
};

function withNumbers(text: string, key: string): React.ReactNode[] {
  return text.split(/(\d+)/).map((part, i) =>
    /^\d+$/.test(part) ? (
      <span key={`${key}-${i}`} className={styles.num}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function captionNodes(text: string): React.ReactNode[] {
  return text.split(/(\[[^\]]+\])/).flatMap((part, i) =>
    part.startsWith("[") && part.endsWith("]") ? (
      <span key={i} className={styles.hl}>
        {withNumbers(part.slice(1, -1), `h${i}`)}
      </span>
    ) : (
      withNumbers(part, `t${i}`)
    ),
  );
}

export function CaptionFrame({
  preset,
  text,
  tag,
  showText = true,
  captionClassName,
  className,
}: {
  preset: FramePreset;
  text: string;
  /** Small label in the corner ("Example"). */
  tag?: string;
  /** false: the frame without its caption (fonts not loaded yet). */
  showText?: boolean;
  captionClassName?: string;
  className?: string;
}) {
  return (
    <div className={cx(styles.frame, className)}>
      {tag && <span className={styles.frameTag}>{tag}</span>}
      {showText && <p className={cx(styles.caption, PRESET_CLASS[preset], captionClassName)}>{captionNodes(text)}</p>}
    </div>
  );
}
