"use client";
/**
 * The landing's closing sections: what the editor leaves to the creator,
 * questions, the closing call. (The demos above them live in sections/,
 * captions/ and hero/.) Every claim here is something the product does
 * today.
 *
 * Their motion: the control rows and the questions enter with the page's
 * shared entrance (data-entrance, app/page.tsx); an answer fades in as
 * its question opens; the closing call ends the page like a render
 * finishing (FinalSection).
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, FileText, RefreshCw, Share2, Type } from "lucide-react";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { BILLING_COPY } from "@/lib/auth";
import { useBillingEnabled } from "@/lib/account";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/components/ui/cx";
import { CaptionPoster } from "./CaptionFrame";
import { LiveCaption, type LiveCaptionHandle } from "./captions/LiveCaption";
import { Scene } from "./scene/Scene";
import { presetSupport } from "@/lib/captions/scripts";
import { LAUNCH_PRESETS } from "@/lib/captions/presets";
import { CtaLink, PASS_ROOT_MARGIN, PASS_THRESHOLDS, passShare, useInView, useReducedMotion } from "./shared";
import styles from "./Landing.module.css";

/* ── The creator's control ── */
/* (Restoring cuts is shown, and can be tried, in the cleanup demo.)
 * Each row is a track: its rule draws in, its icon and text arrive with
 * it, row by row in reading order (data-entrance="row"). */

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
            <li key={key} className={styles.controlItem} data-entrance="row">
              <span className={styles.controlRule} data-entrance-part="rule" aria-hidden="true" />
              <span className={cx(styles.controlRule, styles.controlRuleEnd)} data-entrance-part="rule" aria-hidden="true" />
              <span className={styles.controlIcon} data-entrance-part="icon" aria-hidden="true">
                <Icon icon={icon} size={18} />
              </span>
              <span className="pt-1.5" data-entrance-part="text">
                {t(key)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ── Questions ── */

/** How long a question takes to open (the answer's glide,
 *  Landing.module.css .faqItem::details-content). */
const FAQ_OPEN_MS = 240;

export function FaqSection() {
  const t = useT();
  const billingOn = useBillingEnabled();
  const paid = BILLING_COPY || billingOn;
  const reduced = useReducedMotion();
  // Phones: a plain <details> does not follow its answer, which can open
  // under the bottom bar or the fold; once it has opened, bring it in.
  const follow = (e: React.ToggleEvent<HTMLDetailsElement>) => {
    const item = e.currentTarget;
    if (!item.open || !window.matchMedia("(max-width: 767px)").matches) return;
    window.setTimeout(() => {
      if (item.open) item.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    }, FAQ_OPEN_MS);
  };
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
            <details key={q} className={styles.faqItem} data-entrance="phase" onToggle={follow}>
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
/** The reprise can be laid down (armed) only where it can be watched. */
const canArm = () => typeof IntersectionObserver !== "undefined";

/** The reprise counts as up once this much of it is clear of the sticky
 *  header and the phone bar (passShare); it lies down again only once
 *  it is wholly out of view, never while it can be seen. */
const REPRISE_SHOWN = 0.85;
/** The hinge (Landing.module.css .repriseFrame, 600 ms): its caption
 *  starts on its transitionend, or after this long without one. */
const LAND_MS = 620;
/** The title sweeps in once this much of it is clear of the chrome and
 *  the reprise is on its way up (CUE_MS into its hinge, so the two moves
 *  overlap and reading is never held up); without a reprise (scrolled
 *  past), after TITLE_WAIT_MS on screen. */
const TITLE_SHOWN = 0.6;
const TITLE_WAIT_MS = 600;
const CUE_MS = 240;
/** The sweep (640 ms), the note after it (+80, 280 ms) and the button's
 *  bloom (from 640, 600 ms): then the section is at rest. */
const SWEEP_MS = 1300;

/** The finished video once more (the hero's clip): it tips up from its
 *  bottom edge on the page's spring once it is clear of the chrome, and
 *  every time it has landed its caption plays the line again from the
 *  first word (it waits, empty, while the frame is down, so the frame
 *  rises clean), then keeps looping under the settled caption. Laid down
 *  (armed) only once the script runs, so without it the frame stands as
 *  it ends. `onLanded` reports each rise, CUE_MS into the hinge (the
 *  closing sweep waits for the first). */
function FinalReprise({ onLanded }: { onLanded: () => void }) {
  const t = useT();
  const lang = useLang();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<LiveCaptionHandle | null>(null);
  const [shown, setShown] = useState(false);
  const [landed, setLanded] = useState(false);
  // One take per landing: a new one starts the caption over.
  const [take, setTake] = useState(0);
  const armed = useSyncExternalStore(noSubscription, canArm, () => false);
  const preset = presetSupport("power", lang).level !== "unavailable" ? "power" : (LAUNCH_PRESETS.find((p) => presetSupport(p, lang).level !== "unavailable") ?? "power");
  const caption = t("site.demo.caption");

  useEffect(() => {
    const box = ref.current;
    const frame = frameRef.current;
    if (!box || !frame || typeof IntersectionObserver === "undefined") return;
    let up = false;
    let timer = 0;
    let cue = 0;
    function land() {
      window.clearTimeout(timer);
      frame?.removeEventListener("transitionend", onEnd);
      setLanded(true);
      setTake((n) => n + 1);
    }
    function onEnd(e: TransitionEvent) {
      if (e.target === frame && e.propertyName === "transform") land();
    }
    const rise = () => {
      if (up) return;
      up = true;
      setShown(true);
      frame.addEventListener("transitionend", onEnd);
      // Reduced motion: it stands as it is, so it has landed already.
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      timer = window.setTimeout(land, still ? 0 : LAND_MS);
      // The title's sweep starts while the frame is still tipping up.
      cue = window.setTimeout(onLanded, still ? 0 : CUE_MS);
    };
    const fall = () => {
      if (!up) return;
      up = false;
      window.clearTimeout(timer);
      window.clearTimeout(cue);
      frame.removeEventListener("transitionend", onEnd);
      setShown(false);
      setLanded(false);
    };
    const near = new IntersectionObserver(
      (entries) => {
        if (passShare(entries[entries.length - 1]) >= REPRISE_SHOWN - 0.01) rise();
      },
      { rootMargin: PASS_ROOT_MARGIN, threshold: PASS_THRESHOLDS },
    );
    const away = new IntersectionObserver((entries) => {
      if (!entries[entries.length - 1].isIntersecting) fall();
    });
    near.observe(box);
    away.observe(box);
    return () => {
      near.disconnect();
      away.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(cue);
      frame.removeEventListener("transitionend", onEnd);
    };
  }, [onLanded]);

  // While the frame is down, the caption waits on its empty lead-in
  // (again after a new style or line): the frame rises with no words on
  // it, and they come once it has landed.
  useEffect(() => {
    if (armed && !reduced && !landed) capRef.current?.seek(0);
  }, [armed, reduced, landed, preset, caption, lang]);

  return (
    <div ref={ref} className={styles.reprise} data-shown={shown} data-armed={armed || undefined}>
      <div ref={frameRef} className={styles.repriseFrame} aria-hidden="true">
        <Scene clip="hero" playing={shown} />
        <LiveCaption
          preset={preset}
          text={caption}
          lang={lang}
          playing={landed && !reduced}
          loop={false}
          hold={0.4}
          restartKey={take}
          handle={capRef}
        >
          <CaptionPoster preset={preset} text={caption} />
        </LiveCaption>
      </div>
    </div>
  );
}

type Sweep = "rest" | "armed" | "run" | "done";

/** Where the title's ink starts and ends in its box (px from the box's
 *  left edge). Balanced lines are narrower than the heading's box, so
 *  the sweep spans the words, never the empty room beside them. */
function inkSpan(box: HTMLElement): { from: number; to: number } {
  const b = box.getBoundingClientRect();
  let from = Infinity;
  let to = -Infinity;
  const title = box.firstElementChild;
  if (title) {
    const range = document.createRange();
    range.selectNodeContents(title);
    for (const r of range.getClientRects()) {
      if (!r.width) continue;
      from = Math.min(from, r.left);
      to = Math.max(to, r.right);
    }
  }
  return to > from ? { from: from - b.left, to: to - b.left } : { from: 0, to: b.width };
}

/** The closing call, ending like a render finishing: once the reprise
 *  has landed, a playhead sweeps the title in from its first glyph to
 *  its last (its clip edge riding the playhead), the beta note follows
 *  and the button's glow blooms once.
 *  Once per load, and only when the title was below the fold once the
 *  page had hydrated; the server HTML, a page without JS and reduced
 *  motion show it all at rest (Landing.module.css .final[data-sweep]).
 *  The page's shared entrance leaves it alone (data-entrance="own"). */
export function FinalSection({ onCtaInView }: { onCtaInView: (inView: boolean) => void }) {
  const t = useT();
  // Its button counts once it is clear of the bottom edge (the page's
  // phone bar leaves before it can cover it).
  const [ctaRef, ctaInView] = useInView<HTMLAnchorElement>({ rootMargin: "0px 0px -15% 0px" });
  useEffect(() => onCtaInView(ctaInView), [ctaInView, onCtaInView]);
  const billingOn = useBillingEnabled();
  const paid = BILLING_COPY || billingOn;
  const titleRef = useRef<HTMLDivElement>(null);
  const [sweep, setSweep] = useState<Sweep>("rest");
  const landedRef = useRef(false);
  const kickRef = useRef<() => void>(() => {});
  const onLanded = useCallback(() => {
    landedRef.current = true;
    kickRef.current();
  }, []);

  useEffect(() => {
    const box = titleRef.current;
    if (!box || typeof IntersectionObserver === "undefined") return;
    let state: Sweep = "rest";
    let measured = false;
    let inView = false;
    let wait = 0;
    let finish = 0;
    const run = () => {
      if (state !== "armed" || !inView) return;
      state = "run";
      window.clearTimeout(wait);
      io.disconnect();
      // The playhead and the clip edge both run over the title's ink
      // (Landing.module.css .finalHead).
      const ink = inkSpan(box);
      box.style.setProperty("--sweep-from", `${ink.from}px`);
      box.style.setProperty("--sweep-to", `${ink.to}px`);
      setSweep("run");
      finish = window.setTimeout(() => setSweep("done"), SWEEP_MS);
    };
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!measured) {
          // The first report: where the title is once the page is up.
          measured = true;
          if (e.boundingClientRect.top < window.innerHeight || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            io.disconnect();
            return;
          }
          state = "armed";
          setSweep("armed");
        }
        inView = passShare(e) >= TITLE_SHOWN - 0.01;
        window.clearTimeout(wait);
        if (!inView) return;
        if (landedRef.current) run();
        else wait = window.setTimeout(run, TITLE_WAIT_MS);
      },
      { rootMargin: PASS_ROOT_MARGIN, threshold: PASS_THRESHOLDS },
    );
    kickRef.current = run;
    io.observe(box);
    return () => {
      io.disconnect();
      window.clearTimeout(wait);
      window.clearTimeout(finish);
      kickRef.current = () => {};
    };
  }, []);

  return (
    <section
      className={styles.final}
      aria-labelledby="final-title"
      data-entrance="own"
      data-sweep={sweep === "rest" ? undefined : sweep}
    >
      <div className={styles.wrap}>
        <FinalReprise onLanded={onLanded} />
        <div ref={titleRef} className={styles.finalTitleBox}>
          <h2 id="final-title" className={styles.finalTitle}>
            {t("site.final.title")}
          </h2>
          <span className={styles.finalHead} aria-hidden="true" />
        </div>
        {!paid && <p className={styles.finalNote}>{t("site.final.beta")}</p>}
        <div className={styles.finalCta}>
          <CtaLink ref={ctaRef} location="final" className={styles.finalCtaLink} />
        </div>
      </div>
    </section>
  );
}
