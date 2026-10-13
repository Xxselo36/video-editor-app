"use client";

/**
 * The landing page (UX15 redesign, concept "take strip"; direction
 * contract in .impeccable/surfaces; v2 polish in October 2026). One
 * recording of one example creator: the hero's tape loses its bad parts
 * and becomes a captioned 9:16 video. Then the command words, what is
 * cut automatically, the caption styles live, the 9:16 reframe, bonus
 * clips, what the editor leaves to the creator, questions and the
 * closing call. Every video frame shows the same recording (scene/).
 *
 * One primary action per view: the hero's button; once it has scrolled
 * away, the header (desktop: the pill slides in at the right edge while
 * the other actions glide aside) or a bottom bar (phones) carries it,
 * until the closing section's own button is clear of the bottom edge.
 *
 * Between the demos the page never sits still: every section below the
 * hero enters once (useEntrances below).
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher, registerEnglish, useT } from "@/i18n";
import { enLanding } from "@/i18n/messages/en/landing";
import { useBillingEnabled } from "@/lib/account";
import { track } from "@/lib/analytics";
import { COPYRIGHT } from "@/lib/legal";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import { cx } from "@/components/ui/cx";
import { TakeStrip } from "@/features/landing/hero/TakeStrip";

// Everything below the hero: server-rendered as usual, its code in
// separate chunks, so the first load carries only the hero.
const CommandRowsSection = dynamic(() => import("@/features/landing/sections/CommandRows").then((m) => m.CommandRowsSection));
const AutoCleanupSection = dynamic(() => import("@/features/landing/sections/AutoCleanup").then((m) => m.AutoCleanupSection));
const CaptionPlayerSection = dynamic(() => import("@/features/landing/captions/CaptionPlayer").then((m) => m.CaptionPlayerSection));
const ReframeSection = dynamic(() => import("@/features/landing/sections/ReframeDemo").then((m) => m.ReframeSection));
const BonusClipsSection = dynamic(() => import("@/features/landing/sections/BonusClips").then((m) => m.BonusClipsSection));
const ControlSection = dynamic(() => import("@/features/landing/Sections").then((m) => m.ControlSection));
const FaqSection = dynamic(() => import("@/features/landing/Sections").then((m) => m.FaqSection));
const FinalSection = dynamic(() => import("@/features/landing/Sections").then((m) => m.FinalSection));
import { CtaLink, rich, useCmdNodes, useInView } from "@/features/landing/shared";
import styles from "@/features/landing/Landing.module.css";

// The landing's English strings live outside the shared `en` bundle.
registerEnglish(enLanding);

/* ── Section entrances ── */

/** Every section below the hero enters once (features/landing/
 *  entrances.ts, a lazy chunk: it only moves what is below the fold, so
 *  it can wait for the page to be up). */
function useEntrances(mainRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof IntersectionObserver === "undefined" || typeof main.animate !== "function") return;
    let stop: (() => void) | null = null;
    let gone = false;
    void import("@/features/landing/entrances").then((m) => {
      if (!gone) stop = m.startEntrances(main, styles.hero);
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, [mainRef]);
}

export default function Landing() {
  const t = useT();
  const billingOn = useBillingEnabled();
  const cmds = useCmdNodes();
  // The hero's button counts as on screen until measured, and as gone
  // once it is under the sticky header (4rem + its border). The closing
  // button counts once it is clear of the bottom edge (the phone bar
  // leaves before it can cover it).
  const [heroCtaRef, heroCtaVisible] = useInView<HTMLAnchorElement>({ rootMargin: "-65px 0px 0px 0px" }, true);
  // The closing section is a lazy chunk: it reports its button itself.
  const [finalCtaVisible, setFinalCtaVisible] = useState(false);
  const extraShown = !heroCtaVisible && !finalCtaVisible;
  const mainRef = useRef<HTMLElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const headerCtaRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    track("landing_view");
  }, []);

  useEntrances(mainRef);

  // The header pill's width (it changes with the language and the
  // label) for the glide of the actions beside it (--cta-w).
  useEffect(() => {
    const tools = toolsRef.current;
    const pill = headerCtaRef.current;
    if (!tools || !pill || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => tools.style.setProperty("--cta-w", `${pill.offsetWidth}px`));
    ro.observe(pill);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={styles.page}>
      <a href="#main" className={styles.skip}>
        {t("site.skipToContent")}
      </a>

      <header className={styles.header}>
        <div className={cx(styles.wrap, styles.headerInner)}>
          {/* The narrowest phones show the mark only (room for "Sign in").
              One LogoWord, not two logos: a hidden copy of the mark would
              own the SVG gradient ids and blank the visible one. No
              prefetch: it links to this page. */}
          <Link href="/" prefetch={false} className={cx("shrink-0", styles.logo)} aria-label={t("site.header.homeAria")}>
            <LogoWord />
          </Link>
          <div className={styles.headerActions} data-cta={extraShown}>
            <div ref={toolsRef} className={styles.headerTools}>
              <PricingLink className="mr-2 hidden sm:inline" />
              <LanguageSwitcher />
              {/* Accounts on: "Sign in" (stays visible on phones) or the avatar. */}
              <AccountMenu returnHere={false} />
            </div>
            {/* Out of the flow at the right edge; hidden (visibility)
                while another button is on screen. */}
            <CtaLink ref={headerCtaRef} location="header" size="pill" className={styles.headerCta} data-shown={extraShown} />
          </div>
        </div>
      </header>

      <main id="main" ref={mainRef}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.wrap}>
            <div className={styles.heroText}>
              {/* One line per sentence (the loop's two acts); a one-sentence
                  title (ko, tr) wraps as usual. The space after a sentence
                  stays in its line, so the heading still reads as one. */}
              <h1 id="hero-title" className={styles.h1}>
                {t("site.hero.title")
                  .split(/(?<=[.!?。।]\s*)(?=\S)/)
                  .map((line, i) => (
                    <span key={i} className={styles.h1Line}>
                      {line}
                    </span>
                  ))}
              </h1>
              <p className={styles.lead}>{rich(t("site.hero.sub"), cmds)}</p>
              <div className={styles.heroCta}>
                <CtaLink ref={heroCtaRef} location="hero" wide />
              </div>
            </div>
            <TakeStrip />
          </div>
        </section>

        <CommandRowsSection />
        <AutoCleanupSection />
        <CaptionPlayerSection />
        <ReframeSection />
        <BonusClipsSection />
        <ControlSection />
        <FaqSection />
        <FinalSection onCtaInView={setFinalCtaVisible} />
      </main>

      <footer className={styles.footer}>
        <div className={cx(styles.wrap, styles.footerInner)}>
          <LogoWord size={22} />
          {/* No prefetch: the closing button's route is the likely next
              one, and these would compete with the demos' chunks. */}
          <div className={styles.footerLinks}>
            <Link href="/app" prefetch={false} className={styles.footerLink}>
              {t("site.footer.editor")}
            </Link>
            <Link href="/app/library" prefetch={false} className={styles.footerLink}>
              {t("site.footer.library")}
            </Link>
            {billingOn && (
              <Link href="/pricing" prefetch={false} className={styles.footerLink}>
                {t("site.footer.pricing")}
              </Link>
            )}
            <nav aria-label={t("common.footer.legalAria")}>
              <ul>
                <li>
                  <Link href="/imprint" prefetch={false} className={styles.footerLink}>
                    {t("site.footer.imprint")}
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" prefetch={false} className={styles.footerLink}>
                    {t("site.footer.privacy")}
                  </Link>
                </li>
                <li>
                  <Link href="/terms" prefetch={false} className={styles.footerLink}>
                    {t("site.footer.terms")}
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
          <p className={styles.copyright}>{COPYRIGHT}</p>
        </div>
      </footer>

      <div className={styles.sticky} data-shown={extraShown}>
        <CtaLink location="sticky" wide />
      </div>
    </div>
  );
}
