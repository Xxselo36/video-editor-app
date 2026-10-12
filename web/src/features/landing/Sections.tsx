"use client";
/**
 * The landing's closing sections: what the editor leaves to the creator,
 * questions, the closing call. (The demos above them live in sections/,
 * captions/ and hero/.) Every claim here is something the product does
 * today.
 */
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ChevronDown, FileText, RefreshCw, Share2, Type } from "lucide-react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { BILLING_COPY } from "@/lib/auth";
import { useBillingEnabled } from "@/lib/account";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "./CaptionFrame";
import { LiveCaption } from "./captions/LiveCaption";
import { Scene } from "./scene/Scene";
import { presetSupport } from "@/lib/captions/scripts";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import { CtaLink, useInView, useReducedMotion } from "./shared";
import styles from "./Landing.module.css";

/* ── The creator's control ── */
/* (Restoring cuts is shown, and can be tried, in the cleanup demo.) */

const CONTROL: { key: MessageKey; icon: typeof Type }[] = [
  { key: "site.control.text", icon: Type },
  { key: "site.control.post", icon: Share2 },
  { key: "site.control.files", icon: FileText },
  { key: "site.control.reedit", icon: RefreshCw },
];

export function ControlSection() {
  const t = useT();
  return (
    <section className={styles.section} aria-labelledby="control-title">
      <div className={styles.wrap}>
        <h2 id="control-title" className={styles.h2}>
          {t("site.control.title")}
        </h2>
        <ul className={styles.controlList}>
          {CONTROL.map(({ key, icon }) => (
            <li key={key} className={styles.controlItem}>
              <span className={styles.controlIcon} aria-hidden="true">
                <Icon icon={icon} size={18} />
              </span>
              <span className="pt-1.5">{t(key)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ── Questions ── */

export function FaqSection() {
  const t = useT();
  const billingOn = useBillingEnabled();
  const paid = BILLING_COPY || billingOn;
  const items: { q: MessageKey; a: React.ReactNode }[] = [
    { q: "site.faq.record.q", a: t("site.faq.record.a") },
    { q: "site.faq.commands.q", a: t("site.faq.commands.a") },
    { q: "site.faq.languages.q", a: t("site.faq.languages.a") },
    {
      q: "site.faq.price.q",
      a: paid ? (
        <>
          {t("site.faq.price.plans")}{" "}
          <Link href="/pricing" className={styles.inlineLink}>
            {t("site.faq.price.link")}
          </Link>
        </>
      ) : (
        t("site.faq.price.beta")
      ),
    },
    { q: "site.faq.delete.q", a: t("site.faq.delete.a") },
  ];
  return (
    <section className={styles.section} aria-labelledby="faq-title">
      <div className={cx(styles.wrap, styles.faqLayout)}>
        <h2 id="faq-title" className={styles.h2}>
          {t("site.faq.title")}
        </h2>
        <div className={styles.faq}>
          {items.map(({ q, a }) => (
            <details key={q} className={styles.faqItem}>
              <summary>
                {t(q)}
                <Icon icon={ChevronDown} size={18} className={styles.faqChevron} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Closing call ── */

/** Nothing to subscribe to: the value only differs between the server
 *  (and hydration) and the client. */
const noSubscription = () => () => {};

/** The finished video once more: it tips up from its bottom edge and
 *  plays its captions once. Laid down (armed) only once the script runs,
 *  so without it the frame stands as it ends. */
function FinalReprise() {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const [ref, shown] = useInView<HTMLDivElement>({ threshold: 0.5 });
  const armed = useSyncExternalStore(noSubscription, () => true, () => false);
  const preset = presetSupport("power", lang).level !== "unavailable" ? "power" : (LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? "power");
  const caption = t("site.demo.caption");
  return (
    <div ref={ref} className={styles.reprise} data-shown={shown} data-armed={armed || undefined} aria-hidden="true">
      <div className={styles.repriseFrame}>
        <Scene shot="passport" talking={shown && !reduced} sizes="10.5rem" />
        <LiveCaption preset={preset} text={caption} lang={lang} playing={shown && !reduced} loop={false} hold={0.4}>
          <CaptionPoster preset={preset} text={caption} />
        </LiveCaption>
        <span className={styles.frameTag}>{t("site.demo.example")}</span>
      </div>
    </div>
  );
}

export function FinalSection({ ctaRef }: { ctaRef: React.Ref<HTMLAnchorElement> }) {
  const t = useT();
  const billingOn = useBillingEnabled();
  const paid = BILLING_COPY || billingOn;
  return (
    <section className={styles.final} aria-labelledby="final-title">
      <div className={styles.wrap}>
        <FinalReprise />
        <h2 id="final-title" className={styles.finalTitle}>
          {t("site.final.title")}
        </h2>
        {!paid && <p className={styles.finalNote}>{t("site.final.beta")}</p>}
        <div className={styles.finalCta}>
          <CtaLink ref={ctaRef} location="final" />
        </div>
      </div>
    </section>
  );
}
