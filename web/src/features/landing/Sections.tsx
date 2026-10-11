"use client";
/**
 * The landing's sections below the hero, in reading order: the command
 * words, the automatic cleanup, caption styles, format and bonus clips,
 * what the editor leaves to the creator, questions, the closing call.
 * Every claim here is something the product does today.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronDown, FileText, RefreshCw, Share2, Type, Undo2 } from "lucide-react";
import { useLang, useT, type Lang } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { BILLING_COPY } from "@/lib/auth";
import { useBillingEnabled } from "@/lib/account";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/components/ui/cx";
import { CaptionFrame, type FramePreset } from "./CaptionFrame";
import { CMD_COLOR, Cmd, CtaLink, rich, useCmdNodes, useInView, useReducedMotion, type CmdId } from "./shared";
import styles from "./Landing.module.css";

/** Bonus clips: at most this many (backend/llm.py detect_hook_moments),
 *  only for videos of 90 s or more (pipeline.detect_hooks). */
const MAX_HOOK_CLIPS = 3;

/* ── The command words ── */

type MiniPart = { kind: "seg" | "gone" | "post"; g?: number; c?: CmdId };

const COMMAND_ROWS: { ids: CmdId[]; desc: MessageKey; mini: MiniPart[] }[] = [
  {
    ids: ["start"],
    desc: "site.commands.start",
    mini: [{ kind: "gone", g: 2, c: "start" }, { kind: "post", c: "start" }, { kind: "seg", g: 3 }, { kind: "seg", g: 2 }],
  },
  {
    ids: ["cut"],
    desc: "site.commands.cut",
    mini: [{ kind: "seg", g: 2 }, { kind: "gone", g: 3, c: "cut" }, { kind: "post", c: "cut" }, { kind: "seg", g: 3 }],
  },
  {
    ids: ["keep"],
    desc: "site.commands.keep",
    mini: [{ kind: "seg", g: 3 }, { kind: "post", c: "keep" }, { kind: "seg", g: 3 }],
  },
  {
    ids: ["stop", "go"],
    desc: "site.commands.stopgo",
    mini: [
      { kind: "seg", g: 2 },
      { kind: "post", c: "stop" },
      { kind: "gone", g: 2, c: "stop" },
      { kind: "post", c: "go" },
      { kind: "seg", g: 2 },
    ],
  },
  {
    ids: ["finish"],
    desc: "site.commands.finish",
    mini: [{ kind: "seg", g: 3 }, { kind: "seg", g: 2 }, { kind: "post", c: "finish" }, { kind: "gone", g: 2, c: "finish" }],
  },
];

function Mini({ parts }: { parts: MiniPart[] }) {
  return (
    <span className={styles.mini} aria-hidden="true">
      {parts.map((p, i) => (
        <span
          key={i}
          className={cx(p.kind === "post" ? styles.miniPost : styles.miniSeg, p.kind === "gone" && styles.miniGone)}
          style={{ "--g": p.g, "--c": p.c ? CMD_COLOR[p.c] : undefined } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

export function CommandsSection() {
  const t = useT();
  const cmds = useCmdNodes();
  return (
    <section className={styles.section} aria-labelledby="commands-title">
      <div className={styles.wrap}>
        <h2 id="commands-title" className={styles.h2}>
          {t("site.commands.title")}
        </h2>
        <p className={styles.body}>{rich(t("site.commands.sub"), cmds)}</p>
        <ul className={styles.cmdList}>
          {COMMAND_ROWS.map((row) => (
            <li key={row.ids.join("-")} className={styles.cmdRow}>
              <h3 className={styles.cmdWord} style={{ "--c": CMD_COLOR[row.ids[0]] } as React.CSSProperties}>
                {row.ids.length === 2 ? (
                  <>
                    <Cmd id={row.ids[0]} inherit /> <small>…</small> <Cmd id={row.ids[1]} inherit />
                  </>
                ) : (
                  <Cmd id={row.ids[0]} inherit />
                )}
              </h3>
              <p className={styles.cmdDesc}>{t(row.desc)}</p>
              <Mini parts={row.mini} />
            </li>
          ))}
        </ul>
        <p className={styles.cleanupNote}>{t("site.commands.note")}</p>
      </div>
    </section>
  );
}

/* ── Automatic cleanup ── */

export function AutoSection() {
  const t = useT();
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLParagraphElement>({ threshold: 0.6 });
  const [clean, setClean] = useState(false);
  useEffect(() => {
    if (!inView || clean || reduced) return;
    const id = window.setTimeout(() => setClean(true), 700);
    return () => window.clearTimeout(id);
  }, [inView, clean, reduced]);

  const filler = t("site.demo.filler");
  const sample = t("site.auto.sample");
  const raw = rich(sample, {
    um: <span className={cx(styles.token, styles.tokenFiller)}>{filler}</span>,
    pause: <span className={cx(styles.token, styles.tokenPause)}>{t("site.auto.pause")}</span>,
  });
  // The same sentence without the pauses and filler words.
  const cleaned = sample
    .replace(/\{(um|pause)\}/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:。、，！？])/g, "$1")
    .trim();
  const body = rich(t("site.auto.body"), {
    um: t("site.quote", { text: filler }),
    tight: <strong className="font-semibold text-[var(--text-strong)]">{t("app.start.paceTight")}</strong>,
    natural: <strong className="font-semibold text-[var(--text-strong)]">{t("app.start.paceSmooth")}</strong>,
    none: <strong className="font-semibold text-[var(--text-strong)]">{t("app.start.paceNone")}</strong>,
  });

  return (
    <section className={styles.section} aria-labelledby="auto-title">
      <div className={cx(styles.wrap, styles.auto)}>
        <div>
          <h2 id="auto-title" className={styles.h2}>
            {t("site.auto.title")}
          </h2>
          <p className={styles.body}>{body}</p>
          <p className={styles.cleanupNote}>{t("site.auto.cleanup")}</p>
        </div>
        {/* Both versions sit in one grid cell and cross-fade, so the
            page never shifts; screen readers get the cleaned one. */}
        <p ref={ref} className={styles.sentence} data-clean={clean}>
          <span className={styles.sentenceRaw} aria-hidden="true">
            {raw}
          </span>
          <span className={styles.sentenceClean}>{cleaned}</span>
        </p>
      </div>
    </section>
  );
}

/* ── Caption styles ── */

/** Four styles the page language's script really gets
 *  (lib/captions/script-support.json: Cyrillic has no Mega, Clipper,
 *  One Word; CJK also no Elegant; Devanagari only five styles). */
const STYLE_FRAMES: Record<"latin" | "cyrillic" | "cjk" | "devanagari", FramePreset[]> = {
  latin: ["power", "boxed", "clipper", "elegant"],
  cyrillic: ["power", "boxed", "karaoke", "elegant"],
  cjk: ["power", "boxed", "karaoke", "minimal"],
  devanagari: ["karaoke", "reveal", "subtitle", "minimal"],
};
function scriptOf(lang: Lang): keyof typeof STYLE_FRAMES {
  if (lang === "ru") return "cyrillic";
  if (lang === "ja" || lang === "ko") return "cjk";
  if (lang === "hi") return "devanagari";
  return "latin";
}
/** The CSS font of each frame preset (Landing.module.css @font-face). */
const PRESET_FONT: Record<FramePreset, string> = {
  power: '900 1em "CleoCap Montserrat"',
  boxed: '800 1em "CleoCap Montserrat"',
  clipper: '1em "CleoCap Bangers"',
  elegant: 'italic 800 1em "CleoCap Playfair"',
  karaoke: '800 1em "CleoCap Poppins"',
  reveal: '800 1em "CleoCap Poppins"',
  subtitle: '700 1em "CleoCap Inter"',
  minimal: '700 1em "CleoCap Inter"',
};

/** Once the section is near (or the page has settled), fetch the frames'
 *  fonts for this text, then show the captions: no fallback-font flash. */
function useLateFonts(presets: FramePreset[], text: string): [React.RefObject<HTMLUListElement | null>, boolean] {
  const [ref, near] = useInView<HTMLUListElement>({ rootMargin: "600px 0px" });
  const [idle, setIdle] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setIdle(true), 3000);
    return () => window.clearTimeout(id);
  }, []);
  const key = presets.join(",");
  useEffect(() => {
    if (!(near || idle)) return;
    let live = true;
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    const loads = fonts ? key.split(",").map((p) => fonts.load(PRESET_FONT[p as FramePreset], text).catch(() => [])) : [];
    // Show the captions anyway after a while (slow network, blocked fonts).
    const late = window.setTimeout(() => live && setReady(true), 2500);
    Promise.all(loads).then(() => live && setReady(true));
    return () => {
      live = false;
      window.clearTimeout(late);
    };
  }, [near, idle, key, text]);
  return [ref, ready];
}

export function CaptionsSection() {
  const t = useT();
  const presets = STYLE_FRAMES[scriptOf(useLang())];
  const sample = t("site.demo.caption");
  const [ref, ready] = useLateFonts(presets, sample.replace(/[[\]]/g, ""));
  return (
    <section className={styles.section} aria-labelledby="captions-title">
      <div className={styles.wrap}>
        <h2 id="captions-title" className={styles.h2}>
          {t("site.captions.title")}
        </h2>
        <p className={styles.body}>{t("site.captions.body")}</p>
        <ul ref={ref} className={styles.styles}>
          {presets.map((p) => (
            <li key={p} className={styles.styleItem}>
              <CaptionFrame preset={p} text={sample} showText={ready} />
              <p className={styles.styleName}>{t(`editor.style.preset.${p}` as MessageKey)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ── Format and bonus clips ── */

export function FormatSection() {
  const t = useT();
  // The crop follows the face once, when the figure comes into view.
  const [figRef, figSeen] = useInView<HTMLDivElement>({ threshold: 0.5 });
  return (
    <section className={styles.section}>
      <div className={cx(styles.wrap, styles.pair)}>
        <div>
          <div className={styles.figure} aria-hidden="true">
            <div ref={figRef} className={styles.wide} data-shown={figSeen}>
              <div className={styles.pan}>
                <span className={styles.subject} />
                <span className={styles.window} />
              </div>
            </div>
          </div>
          <h2 className={styles.h3}>{t("site.format.title")}</h2>
          <p className={styles.body}>{t("site.format.body")}</p>
        </div>
        <div>
          <div className={styles.figure} aria-hidden="true">
            <div className={styles.clips}>
              <div className={styles.timeline}>
                {[5, 3, 6, 4, 7, 3, 5, 4].map((g, i) => (
                  <span
                    key={i}
                    className={cx(styles.tlSeg, (i === 1 || i === 4 || i === 6) && styles.tlPick)}
                    style={{ "--g": g } as React.CSSProperties}
                  />
                ))}
              </div>
              <div className={styles.tiles}>
                <span className={styles.tile} />
                <span className={styles.tile} />
                <span className={styles.tile} />
              </div>
            </div>
          </div>
          <h2 className={styles.h3}>{t("site.clips.title")}</h2>
          <p className={styles.body}>{t("site.clips.body", { count: MAX_HOOK_CLIPS })}</p>
        </div>
      </div>
    </section>
  );
}

/* ── The creator's control ── */

const CONTROL: { key: MessageKey; icon: typeof Undo2 }[] = [
  { key: "site.control.restore", icon: Undo2 },
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
      <div className={styles.wrap}>
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

export function FinalSection({ ctaRef }: { ctaRef: React.Ref<HTMLAnchorElement> }) {
  const t = useT();
  const billingOn = useBillingEnabled();
  const paid = BILLING_COPY || billingOn;
  return (
    <section className={styles.final} aria-labelledby="final-title">
      <div className={styles.wrap}>
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
