"use client";

/**
 * The landing page (UX15 redesign, concept "take strip"; direction
 * contract in .impeccable/surfaces). One recording, laid out as a strip:
 * spoken commands and the automatic cleanup remove the bad parts and a
 * captioned 9:16 clip stands up. Then the command words, what is cut
 * automatically, real caption styles, format and bonus clips, what the
 * editor leaves to the creator, questions and the closing call.
 *
 * One primary action per view: the hero's button; once it has scrolled
 * away, the header (desktop) or a bottom bar (phones) carries it, until
 * the closing section's own button is on screen.
 */
import Link from "next/link";
import { useEffect } from "react";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import { useBillingEnabled } from "@/lib/account";
import { track } from "@/lib/analytics";
import { COPYRIGHT } from "@/lib/legal";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import { cx } from "@/components/ui/cx";
import { TakeStrip } from "@/features/landing/TakeStrip";
import {
  AutoSection,
  CaptionsSection,
  CommandsSection,
  ControlSection,
  FaqSection,
  FinalSection,
  FormatSection,
} from "@/features/landing/Sections";
import { CtaLink, rich, useCmdNodes, useInView } from "@/features/landing/shared";
import styles from "@/features/landing/Landing.module.css";

export default function Landing() {
  const t = useT();
  const billingOn = useBillingEnabled();
  const cmds = useCmdNodes();
  // The hero's button counts as on screen until measured.
  const [heroCtaRef, heroCtaVisible] = useInView<HTMLAnchorElement>({}, true);
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
          <Link href="/" className="shrink-0" aria-label={t("site.header.homeAria")}>
            <LogoWord />
          </Link>
          <div className={styles.headerActions}>
            <PricingLink className="mr-2 hidden text-sm sm:inline" />
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

        <CommandsSection />
        <AutoSection />
        <CaptionsSection />
        <FormatSection />
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
