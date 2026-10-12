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
 * away, the header (desktop) or a bottom bar (phones) carries it, until
 * the closing section's own button is on screen.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect } from "react";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher, registerEnglish, useT } from "@/i18n";
import { enLanding } from "@/i18n/messages/en/landing";
import { useBillingEnabled } from "@/lib/account";
import { track } from "@/lib/analytics";
import { COPYRIGHT } from "@/lib/legal";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import { cx } from "@/components/ui/cx";
import { TakeStrip } from "@/features/landing/hero/TakeStrip";
import { ControlSection, FaqSection, FinalSection } from "@/features/landing/Sections";

// The demos below the hero: server-rendered as usual, their code in
// separate chunks, so the first load carries only the hero.
const CommandRowsSection = dynamic(() => import("@/features/landing/sections/CommandRows").then((m) => m.CommandRowsSection));
const AutoCleanupSection = dynamic(() => import("@/features/landing/sections/AutoCleanup").then((m) => m.AutoCleanupSection));
const CaptionPlayerSection = dynamic(() => import("@/features/landing/captions/CaptionPlayer").then((m) => m.CaptionPlayerSection));
const ReframeSection = dynamic(() => import("@/features/landing/sections/ReframeDemo").then((m) => m.ReframeSection));
const BonusClipsSection = dynamic(() => import("@/features/landing/sections/BonusClips").then((m) => m.BonusClipsSection));
import { CtaLink, rich, useCmdNodes, useInView } from "@/features/landing/shared";
import styles from "@/features/landing/Landing.module.css";

// The landing's English strings live outside the shared `en` bundle.
registerEnglish(enLanding);

export default function Landing() {
  const t = useT();
  const billingOn = useBillingEnabled();
  const cmds = useCmdNodes();
  // The hero's button counts as on screen until measured, and as gone
  // once it is under the sticky header (4rem + its border).
  const [heroCtaRef, heroCtaVisible] = useInView<HTMLAnchorElement>({ rootMargin: "-65px 0px 0px 0px" }, true);
  const [finalCtaRef, finalCtaVisible] = useInView<HTMLAnchorElement>();
  const extraShown = !heroCtaVisible && !finalCtaVisible;

  useEffect(() => {
    track("landing_view");
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
              own the SVG gradient ids and blank the visible one. */}
          <Link href="/" className={cx("shrink-0", styles.logo)} aria-label={t("site.header.homeAria")}>
            <LogoWord />
          </Link>
          <div className={styles.headerActions}>
            <PricingLink className="mr-2 hidden sm:inline" />
            <LanguageSwitcher />
            {/* Accounts on: "Sign in" (stays visible on phones) or the avatar. */}
            <AccountMenu returnHere={false} />
            {/* Hidden (visibility) while another button is on screen. */}
            <CtaLink location="header" size="pill" className={styles.headerCta} data-shown={extraShown} />
          </div>
        </div>
      </header>

      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.wrap}>
            <div className={styles.heroText}>
              <h1 id="hero-title" className={styles.h1}>
                {t("site.hero.title")}
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
        <FinalSection ctaRef={finalCtaRef} />
      </main>

      <footer className={styles.footer}>
        <div className={cx(styles.wrap, styles.footerInner)}>
          <LogoWord size={22} />
          <div className={styles.footerLinks}>
            <Link href="/app" className={styles.footerLink}>
              {t("site.footer.editor")}
            </Link>
            <Link href="/app/library" className={styles.footerLink}>
              {t("site.footer.library")}
            </Link>
            {billingOn && (
              <Link href="/pricing" className={styles.footerLink}>
                {t("site.footer.pricing")}
              </Link>
            )}
            <nav aria-label={t("common.footer.legalAria")}>
              <ul>
                <li>
                  <Link href="/imprint" className={styles.footerLink}>
                    {t("site.footer.imprint")}
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className={styles.footerLink}>
                    {t("site.footer.privacy")}
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className={styles.footerLink}>
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
