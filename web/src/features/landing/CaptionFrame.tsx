/**
 * A 9:16 frame with one caption page drawn in a real preset's look:
 * its font (public/fonts/captions), case, outline, highlight and number
 * colours and how much of the line it shows (lib/captions/presets.ts).
 * A still of what the engine renders, not the engine itself (that would
 * load harfbuzz here).
 *
 * The caption text marks its highlighted (spoken) word with [brackets];
 * digits get the preset's number colour where it has one.
 */
import { cx } from "@/components/ui/cx";
import styles from "./Landing.module.css";

export type FramePreset = "power" | "boxed" | "clipper" | "elegant" | "karaoke" | "reveal" | "subtitle" | "minimal";

const PRESET_CLASS: Record<FramePreset, string> = {
  power: styles.capPower,
  boxed: styles.capBoxed,
  clipper: styles.capClipper,
  elegant: styles.capElegant,
  karaoke: styles.capKaraoke,
  reveal: styles.capReveal,
  subtitle: styles.capSubtitle,
  minimal: styles.capMinimal,
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

/** The sample split around its [highlighted] word. */
export function splitCaption(text: string): { before: string; word: string; after: string } {
  const m = /^([\s\S]*?)\[([^\]]+)\]([\s\S]*)$/.exec(text);
  return m ? { before: m[1], word: m[2], after: m[3] } : { before: text, word: "", after: "" };
}

/** The page with word `active` (0-based, spaces split words) spoken
 *  instead of the [bracketed] one: captions that follow the speech. */
function steppedNodes(text: string, active: number): React.ReactNode {
  const parts = text.replace(/[[\]]/g, "").split(/(\s+)/);
  let w = -1;
  return parts.map((part, i) => {
    if (!part.trim()) return part;
    w += 1;
    return w === active ? (
      <span key={i} className={styles.hl}>
        {withNumbers(part, `s${i}`)}
      </span>
    ) : (
      <span key={i}>{withNumbers(part, `s${i}`)}</span>
    );
  });
}

/** The number of words `steppedNodes` counts. */
export function wordCount(text: string): number {
  return text.replace(/[[\]]/g, "").split(/\s+/).filter(Boolean).length;
}

/** The visible text and highlight of one page, per preset:
 *  karaoke fills every word spoken so far, word-by-word shows the line
 *  only up to the spoken word, Clipper shows one line of three words. */
function pageNodes(preset: FramePreset, text: string): React.ReactNode {
  const { before, word, after } = splitCaption(text);
  if (preset === "subtitle") return <span className={styles.line}>{before + word + after}</span>;
  if (preset === "karaoke") {
    return (
      <>
        <span className={styles.hl}>{withNumbers(before + word, "k")}</span>
        {after}
      </>
    );
  }
  if (preset === "reveal") {
    return (
      <>
        {withNumbers(before, "b")}
        <span className={styles.hl}>{word}</span>
      </>
    );
  }
  if (preset === "clipper" && /\s/.test(before.trim())) {
    // One line: the spoken word and up to two words before it.
    const words = before.trim().split(/\s+/);
    return (
      <>
        {words.slice(-2).join(" ")} <span className={styles.hl}>{word}</span>
        {after}
      </>
    );
  }
  return (
    <>
      {withNumbers(before, "b")}
      {word && <span className={styles.hl}>{withNumbers(word, "h")}</span>}
      {withNumbers(after, "a")}
    </>
  );
}

export function CaptionFrame({
  preset,
  text,
  tag,
  showText = true,
  active,
  captionClassName,
  className,
  children,
}: {
  preset: FramePreset;
  text: string;
  /** Small label in the corner ("Example"). */
  tag?: string;
  /** false: the frame without its caption (fonts not loaded yet). */
  showText?: boolean;
  /** The spoken word's index, instead of the [bracketed] word. */
  active?: number;
  captionClassName?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cx(styles.frame, className)}>
      {tag && <span className={styles.frameTag}>{tag}</span>}
      {showText && (
        <p className={cx(styles.caption, PRESET_CLASS[preset], captionClassName)}>
          {active === undefined ? pageNodes(preset, text) : steppedNodes(text, active)}
        </p>
      )}
      {children}
    </div>
  );
}
