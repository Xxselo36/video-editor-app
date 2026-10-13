"use client";
/**
 * The page headline: one line per sentence (the loop's two acts), centred
 * and fitted to the width per language in CSS (Landing.module.css .h1,
 * the table heroFit.test.ts keeps honest), so nothing is measured here.
 * The word that does the cutting is inked in the brand gradient with a
 * soft glow: the glow on the outer span, the ink on the inner one, so no
 * engine has to combine a filter with background-clip: text on one box.
 */
import { useT } from "@/i18n";
import styles from "../Landing.module.css";
import { headlineLines } from "./headline";

export function HeroTitle({ id }: { id: string }) {
  const t = useT();
  return (
    <h1 id={id} className={styles.h1}>
      {headlineLines(t("site.hero.title"), t("site.hero.cutWord")).map((line, i) => (
        <span key={i} className={styles.h1Line}>
          {line.before}
          {line.cut && (
            <span className={styles.h1Cut}>
              <span className={styles.h1Ink}>{line.cut}</span>
            </span>
          )}
          {line.after}
        </span>
      ))}
    </h1>
  );
}
