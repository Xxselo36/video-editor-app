"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { LogoWord } from "@/components/Logo";
import { LanguageSwitcher, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";
import { BILLING_COPY, useBillingEnabled } from "@/lib/account";
import { track } from "@/lib/analytics";
import { COPYRIGHT } from "@/lib/legal";
import { AccountMenu, PricingLink } from "@/components/auth/AccountMenu";
import {
  IconArrowRight,
  IconCaptions,
  IconCheck,
  IconMic,
  IconPhone,
  IconSparkle,
} from "@/components/Icons";

/* Voice commands stay literal in every language — they are passed into
 * translations as placeholders. */
const CUT = "Cleo cut";
const FINISH = "Cleo finish";
/** Hook clips: at most this many (backend/llm.py detect_hook_moments),
 *  only for videos of 90 s or more (pipeline.detect_hooks). */
const MAX_HOOK_CLIPS = 3;

/** Replace "{name}" placeholders in a translated string with React nodes. */
function rich(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>;
  });
}

export default function Landing() {
  const t = useT();
  const billingOn = useBillingEnabled();
  useEffect(() => {
    track("landing_view");
  }, []);
  const brandQuote = (phrase: string) => (
    <span style={{ color: "var(--brand)", fontWeight: 600 }}>&ldquo;{phrase}&rdquo;</span>
  );
  const strong = (text: React.ReactNode) => (
    <span style={{ color: "var(--brand-strong)", fontWeight: 600 }}>{text}</span>
  );
  return (
    <main
      className="relative flex min-h-screen flex-col"
      style={{ color: "var(--text-strong)" }}
    >
      {/* ── Header ─── */}
      <header
        className="relative z-10 flex items-center justify-between gap-3 px-4 py-4 sm:px-6"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="shrink-0 transition-opacity hover:opacity-80" aria-label={t("site.header.homeAria")}>
          <LogoWord />
        </Link>
        <div className="flex items-center gap-2">
          <PricingLink className="mr-2 hidden sm:inline" />
          <LanguageSwitcher />
          {/* Accounts on: "Sign in" (stays visible on phones) or the avatar. */}
          <AccountMenu returnHere={false} />
          {/* Hidden on phones: the hero CTA right below does the same job. */}
          <Link
            href="/app"
            onClick={() => track("cta_click", { location: "header" })}
            className="hidden items-center gap-1.5 rounded-full px-5 py-2 text-sm font-semibold transition-transform hover:scale-105 sm:inline-flex"
            style={{
              background: "var(--brand-solid)",
              color: "white",
              boxShadow: "var(--shadow-glow)",
            }}
          >
            {t("site.header.openEditor")} <IconArrowRight size={14} strokeWidth={2.5} />
          </Link>
        </div>
      </header>

      {/* ── Hero — tight ─── */}
      <section className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-16 lg:grid-cols-[1.15fr_1fr] lg:py-24">
        <div className="phase-fade">
          {BILLING_COPY ? (
            // Paid plans live (NEXT_PUBLIC_BILLING_ENABLED): the beta badge
            // becomes the way to the plans.
            <Link
              href="/pricing"
              className="mb-6 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium transition-opacity hover:opacity-80"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border-hover)",
                color: "var(--text-body)",
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--brand)" }}
              />
              {t("site.hero.badgePricing")} <IconArrowRight size={12} strokeWidth={2.5} />
            </Link>
          ) : (
            <div
              className="mb-6 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium"
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border-hover)",
                color: "var(--text-body)",
              }}
            >
              <span
                className="pulse-dot inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: "var(--brand)" }}
              />
              {t("site.hero.badge")}
            </div>
          )}

          <h1
            className="mb-6 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl"
            style={{ color: "var(--text-strong)" }}
          >
            {t("site.hero.titleLead")}{" "}
            <span
              style={{
                background: "linear-gradient(120deg, var(--brand) 0%, var(--accent) 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              {t("site.hero.titleAccent")}
            </span>
          </h1>

          <p
            className="mb-8 max-w-md text-lg"
            style={{ color: "var(--text-body)" }}
          >
            {rich(t("site.hero.sub"), { cut: brandQuote(CUT), finish: brandQuote(FINISH) })}
          </p>

          <Link
            href="/app"
            onClick={() => track("cta_click", { location: "hero" })}
            className="group inline-flex items-center gap-2 rounded-full px-7 py-4 text-base font-semibold transition-transform hover:scale-[1.02]"
            style={{
              background: "var(--brand-solid)",
              color: "white",
              boxShadow: "var(--shadow-glow)",
            }}
          >
            {/* No free tier once plans are live (owner decision): no "try". */}
            {BILLING_COPY ? t("site.header.openEditor") : t("site.hero.cta")}
            <IconArrowRight size={18} strokeWidth={2.5} />
          </Link>
        </div>

        <div className="phase-fade flex justify-center lg:justify-end">
          <CaptionShowcase />
        </div>
      </section>

      {/* ── Features — bento grid, mixed sizes, each with its own visual note ─── */}
      <section
        className="relative z-10 px-6 py-20"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="mx-auto max-w-5xl">
          <h2
            className="mb-10 text-2xl font-bold tracking-tight sm:text-3xl"
            style={{ color: "var(--text-strong)" }}
          >
            {t("site.features.title")}
          </h2>

          <div className="grid gap-3 sm:grid-cols-6">
            {/* Row 1: hero feature (wide) + accent card */}
            <BentoCard
              Icon={IconMic}
              title={t("site.features.voice.title")}
              body={t("site.features.voice.body", { cut: `“${CUT}”` })}
              span={4}
              decoration={<VoiceWaveDecoration />}
              accent="var(--brand)"
            />
            <BentoCard
              Icon={IconSparkle}
              title={t("site.features.cleanup.title")}
              body={t("site.features.cleanup.body")}
              span={2}
              accent="var(--accent)"
            />

            {/* Row 2: two equal. Only what the product does today: no
                style count, no extra formats (they were letterboxed). */}
            <BentoCard
              Icon={IconCaptions}
              title={t("site.features.captions.title")}
              body={t("site.features.captions.body")}
              span={3}
            />
            <BentoCard
              Icon={IconPhone}
              title={t("site.features.vertical.title")}
              body={t("site.features.vertical.body")}
              span={3}
              decoration={<FaceFrameDecoration />}
            />

            {/* Row 3: wide feature */}
            <BentoCard
              Icon={IconArrowRight}
              title={t("site.features.hooks.title")}
              body={t("site.features.hooks.body", { count: MAX_HOOK_CLIPS })}
              span={6}
              decoration={<HookClipStrip />}
              accent="var(--brand)"
            />
          </div>
        </div>
      </section>

      {/* ── How — 3 steps as a connected timeline flow ─── */}
      <section
        className="relative z-10 px-6 py-20"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="mx-auto max-w-5xl">
          <h2
            className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl"
            style={{ color: "var(--text-strong)" }}
          >
            {t("site.steps.title")}
          </h2>
          <p
            className="mb-14 text-sm"
            style={{ color: "var(--text-muted)" }}
          >
            {t("site.steps.sub")}
          </p>

          <div className="relative">
            {/* Horizontal connector — only on md+ where steps are side-by-side */}
            <div
              aria-hidden
              className="absolute left-0 right-0 hidden h-px md:block"
              style={{
                top: "36px",
                background:
                  "linear-gradient(90deg, transparent 0%, var(--brand-hover) 18%, var(--accent) 50%, var(--brand-hover) 82%, transparent 100%)",
                opacity: 0.5,
              }}
            />

            <div className="relative grid gap-12 md:grid-cols-3 md:gap-8">
              <Step
                n="01"
                title={t("site.steps.record.title")}
                body={rich(t("site.steps.record.body"), {
                  cut: strong(<>&ldquo;{CUT}&rdquo;</>),
                })}
                hint={t("site.steps.record.hint")}
                Icon={IconMic}
              />
              <Step
                n="02"
                title={t("site.steps.upload.title")}
                body={t("site.steps.upload.body")}
                hint={t("site.steps.upload.hint")}
                Icon={IconUploadInline}
              />
              <Step
                n="03"
                title={t("site.steps.post.title")}
                body={t("site.steps.post.body")}
                hint={t("site.steps.post.hint")}
                Icon={IconCheck}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ─── */}
      <footer
        className="relative z-10 px-6 py-8"
        style={{
          borderTop: "1px solid var(--border)",
        }}
      >
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <LogoWord size={22} />
          <div
            className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Link href="/app" className="hover:opacity-70">{t("site.footer.editor")}</Link>
            <Link href="/app/library" className="hover:opacity-70">{t("site.footer.library")}</Link>
            {billingOn && (
              <Link href="/pricing" className="hover:opacity-70">{t("site.footer.pricing")}</Link>
            )}
            <nav aria-label={t("common.footer.legalAria")}>
              <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                <li>
                  <Link href="/imprint" className="hover:opacity-70">{t("site.footer.imprint")}</Link>
                </li>
                <li>
                  <Link href="/privacy" className="hover:opacity-70">{t("site.footer.privacy")}</Link>
                </li>
                <li>
                  <Link href="/terms" className="hover:opacity-70">{t("site.footer.terms")}</Link>
                </li>
              </ul>
            </nav>
          </div>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            {COPYRIGHT}
          </p>
        </div>
      </footer>
    </main>
  );
}

/* ── Caption Showcase ──
 * Rotates through caption styles inside a video-preview frame. No fake
 * face, no fake progress bar — just the actual product feature (caption
 * variety) rendered live. Reads as: "here's what CleoCuts makes."
 */
type Style = {
  /** Caption style name — a product name, not translated. */
  label: string;
  /** Message key of the sample caption. */
  text: MessageKey;
  render: (t: string) => React.ReactNode;
};

const STYLES: Style[] = [
  {
    label: "Clipper",
    text: "site.showcase.clipper",
    render: (t) => {
      const words = t.split(" ");
      return (
        <div className="text-center leading-tight">
          {words.map((w, i) => (
            <span
              key={i}
              className="mx-1 inline-block text-[32px] font-black tracking-wide sm:text-[38px]"
              style={{
                color: i === 1 ? "var(--brand)" : "#ffffff",
                textShadow:
                  "0 0 6px rgba(0,0,0,.85), 2px 2px 0 #000, -2px 2px 0 #000, 2px -2px 0 #000, -2px -2px 0 #000",
              }}
            >
              {w}
            </span>
          ))}
        </div>
      );
    },
  },
  {
    label: "Highlight",
    text: "site.showcase.highlight",
    render: (t) => (
      <div
        className="rounded-md px-3 py-1.5 text-center text-[26px] font-bold uppercase sm:text-[32px]"
        style={{
          background: "var(--accent)",
          color: "#ffffff",
          letterSpacing: "0.02em",
        }}
      >
        {t}
      </div>
    ),
  },
  {
    label: "Flash",
    text: "site.showcase.flash",
    render: (t) => (
      <div
        className="text-center text-[32px] font-black italic sm:text-[40px]"
        style={{
          color: "#ffffff",
          textShadow:
            "0 2px 8px rgba(139,92,246,.85), 0 0 24px rgba(139,92,246,.5)",
          letterSpacing: "0.01em",
        }}
      >
        {t}
      </div>
    ),
  },
  {
    label: "Punch",
    text: "site.showcase.punch",
    render: (t) => (
      <div
        className="text-center text-[36px] font-black uppercase sm:text-[44px]"
        style={{
          color: "var(--brand-hover)",
          textShadow: "0 0 10px #000, 3px 3px 0 #000, -3px -3px 0 #000",
          letterSpacing: "0.02em",
        }}
      >
        {t}
      </div>
    ),
  },
  {
    label: "Elegant",
    text: "site.showcase.elegant",
    render: (t) => (
      <div
        className="text-center italic sm:text-[30px]"
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: "26px",
          color: "#ffffff",
          textShadow: "0 2px 6px rgba(0,0,0,.7)",
        }}
      >
        {t}
      </div>
    ),
  },
];

function CaptionShowcase() {
  const t = useT();
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIdx((i) => (i + 1) % STYLES.length);
    }, 2400);
    return () => clearInterval(timer);
  }, []);

  const style = STYLES[idx];

  return (
    <div className="relative">
      {/* Glow */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--brand-glow) 0%, transparent 60%)",
        }}
      />

      <div
        className="relative flex flex-col overflow-hidden rounded-3xl"
        style={{
          background:
            "linear-gradient(135deg, #14122a 0%, #1c1735 40%, #12112a 100%)",
          border: "1px solid var(--border-hover)",
          boxShadow: "var(--shadow-md)",
          width: "min(440px, 90vw)",
          aspectRatio: "4 / 5",
        }}
      >
        {/* Subtle dotted texture — evokes "video content" without being a fake person */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-40"
          style={{
            background:
              "radial-gradient(rgba(139,92,246,0.18) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        />

        {/* Top-right: listening indicator */}
        <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
          <span
            className="pulse-dot inline-block h-2 w-2 rounded-full"
            style={{ background: "var(--brand)" }}
          />
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: "var(--brand-strong)" }}
          >
            {t("site.showcase.listening")}
          </span>
        </div>

        {/* Center: rotating caption */}
        <div className="relative z-10 flex flex-1 items-center justify-center px-8">
          <div key={idx} className="phase-fade max-w-full">
            {style.render(t(style.text))}
          </div>
        </div>

        {/* Bottom: style name + step dots */}
        <div className="relative z-10 flex items-center justify-between px-5 pb-5">
          <div className="flex items-center gap-2">
            <div
              className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
              style={{
                background: "var(--brand-tint)",
                color: "var(--brand-strong)",
              }}
            >
              {style.label}
            </div>
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {t("site.showcase.captionStyle")}
            </span>
          </div>

          <div className="flex gap-1">
            {STYLES.map((_, i) => (
              <div
                key={i}
                className="h-1 w-4 rounded-full transition-colors"
                style={{
                  background:
                    i === idx ? "var(--brand)" : "rgba(255,255,255,0.15)",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Bento grid components ── */

function BentoCard({
  Icon,
  title,
  body,
  span,
  decoration,
  accent,
}: {
  Icon: (p: { size?: number; className?: string; strokeWidth?: number }) => React.ReactNode;
  title: string;
  body: string;
  span: 2 | 3 | 4 | 6;
  decoration?: React.ReactNode;
  accent?: string;
}) {
  const spanClass = {
    2: "sm:col-span-3 lg:col-span-2",
    3: "sm:col-span-3",
    4: "sm:col-span-6 lg:col-span-4",
    6: "sm:col-span-6",
  }[span];

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-2xl p-5 transition-all hover:-translate-y-0.5 ${spanClass}`}
      style={{
        background: "rgba(19, 18, 23, 0.5)",
        border: "1px solid var(--border-hover)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        minHeight: "160px",
      }}
    >
      {/* Decoration sits behind text, absolute */}
      {decoration && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          {decoration}
        </div>
      )}

      <div className="relative z-10 flex flex-col">
        <div
          className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg"
          style={{
            background: "var(--brand-tint)",
            color: accent ?? "var(--brand)",
          }}
        >
          <Icon size={18} strokeWidth={2} />
        </div>
        <div
          className="mb-1 text-base font-bold"
          style={{ color: "var(--text-strong)" }}
        >
          {title}
        </div>
        <div
          className="text-sm leading-relaxed"
          style={{ color: "var(--text-body)" }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

/* ── Decorations ── */

function VoiceWaveDecoration() {
  return (
    <svg
      className="absolute -right-8 top-1/2 h-24 -translate-y-1/2 opacity-60"
      viewBox="0 0 200 100"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="wave-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      {[10, 30, 50, 70, 90, 110, 130, 150, 170, 190].map((x, i) => {
        const h = [30, 50, 20, 70, 40, 55, 30, 45, 60, 25][i];
        return (
          <rect
            key={x}
            x={x}
            y={50 - h / 2}
            width="8"
            height={h}
            rx="3"
            fill="url(#wave-grad)"
          />
        );
      })}
    </svg>
  );
}

function FaceFrameDecoration() {
  return (
    <div
      className="absolute right-4 top-4 h-10 w-10 rounded"
      style={{ border: "2px solid var(--brand)", opacity: 0.7 }}
    >
      <div
        className="absolute -top-1 -left-1 h-2 w-2 rounded-full"
        style={{ background: "var(--brand)" }}
      />
      <div
        className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full"
        style={{ background: "var(--accent)" }}
      />
    </div>
  );
}

function HookClipStrip() {
  // Only where the card is wide enough: on phones it covered the text.
  return (
    <div className="absolute inset-y-0 right-0 hidden items-center overflow-hidden opacity-60 lg:flex">
      <div
        className="flex gap-1"
        style={{ transform: "translateX(20%)" }}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded"
            style={{
              width: 40,
              height: 68,
              background: `linear-gradient(180deg, rgba(139,92,246,${0.15 + i * 0.08}) 0%, rgba(236,72,153,${0.1 + i * 0.05}) 100%)`,
              border: "1px solid var(--border-strong)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function IconUploadInline({
  size = 22,
  strokeWidth = 1.75,
}: {
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function Step({
  n,
  title,
  body,
  hint,
  Icon,
}: {
  n: string;
  title: string;
  body: React.ReactNode;
  hint: string;
  Icon: (p: { size?: number; strokeWidth?: number }) => React.ReactNode;
}) {
  return (
    <div className="relative flex flex-col items-start">
      {/* Icon badge that sits ON the timeline connector */}
      <div
        className="relative mb-6 flex h-[72px] w-[72px] items-center justify-center rounded-full"
        style={{
          background: "var(--surface-1)",
          border: "1.5px solid var(--border-hover)",
          color: "var(--brand)",
          boxShadow:
            "0 0 0 6px var(--surface-0), 0 8px 24px rgba(139, 92, 246, 0.25), inset 0 0 0 1px rgba(139, 92, 246, 0.08)",
        }}
      >
        <Icon size={26} strokeWidth={1.75} />
        {/* Step number chip pinned bottom-right of icon */}
        <div
          className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full font-mono text-[10px] font-bold"
          style={{
            background: "var(--brand-solid)",
            color: "white",
            border: "2px solid var(--surface-0)",
          }}
        >
          {n}
        </div>
      </div>

      <div
        className="mb-2 text-xl font-bold"
        style={{ color: "var(--text-strong)" }}
      >
        {title}
      </div>

      <div
        className="mb-4 text-sm leading-relaxed"
        style={{ color: "var(--text-body)" }}
      >
        {body}
      </div>

      <div
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em]"
        style={{
          background: "var(--brand-tint)",
          color: "var(--brand-strong)",
        }}
      >
        <span
          className="inline-block h-1 w-1 rounded-full"
          style={{ background: "var(--brand)" }}
        />
        {hint}
      </div>
    </div>
  );
}
