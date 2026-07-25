"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoWord } from "@/components/Logo";
import {
  IconArrowRight,
  IconCaptions,
  IconMic,
  IconPhone,
  IconSparkle,
  IconVlog,
} from "@/components/Icons";

export default function Landing() {
  return (
    <main
      className="relative flex min-h-screen flex-col"
      style={{ color: "var(--text-strong)" }}
    >
      {/* ── Header ─── */}
      <header
        className="relative z-10 flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="transition-opacity hover:opacity-80" aria-label="CleoCuts home">
          <LogoWord />
        </Link>
        <Link
          href="/app"
          className="inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-sm font-semibold transition-transform hover:scale-105"
          style={{
            background: "var(--brand)",
            color: "white",
            boxShadow: "var(--shadow-glow)",
          }}
        >
          Open editor <IconArrowRight size={14} strokeWidth={2.5} />
        </Link>
      </header>

      {/* ── Hero — tight ─── */}
      <section className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-16 lg:grid-cols-[1.15fr_1fr] lg:py-24">
        <div className="phase-fade">
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
            Open beta · free
          </div>

          <h1
            className="mb-6 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl"
            style={{ color: "var(--text-strong)" }}
          >
            World&apos;s first
            <br />
            <span
              style={{
                background: "linear-gradient(120deg, var(--brand) 0%, var(--accent) 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              voice-controlled
            </span>{" "}
            editor.
          </h1>

          <p
            className="mb-8 max-w-md text-lg"
            style={{ color: "var(--text-body)" }}
          >
            Just say{" "}
            <span style={{ color: "var(--brand)", fontWeight: 600 }}>&ldquo;Cleo cut&rdquo;</span>{" "}
            when you mess up. AI does the rest — captions, cuts, ready-to-post clips.
          </p>

          <Link
            href="/app"
            className="group inline-flex items-center gap-2 rounded-full px-7 py-4 text-base font-semibold transition-transform hover:scale-[1.02]"
            style={{
              background: "var(--brand)",
              color: "white",
              boxShadow: "var(--shadow-glow)",
            }}
          >
            Try CleoCuts
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
            What CleoCuts does.
          </h2>

          <div className="grid gap-3 sm:grid-cols-6">
            {/* Row 1: hero feature (wide) + accent card */}
            <BentoCard
              Icon={IconMic}
              title="Voice triggers"
              body='Say "Cleo cut" mid-take. CleoCuts removes the failed attempt.'
              span={4}
              decoration={<VoiceWaveDecoration />}
              accent="var(--brand)"
            />
            <BentoCard
              Icon={IconSparkle}
              title="AI cleanup"
              body="Fixes typos, brand names, homophones."
              span={2}
              accent="var(--accent)"
            />

            {/* Row 2: three equal */}
            <BentoCard
              Icon={IconCaptions}
              title="9 caption styles"
              body="Clean to Clipper. Real fonts."
              span={2}
              decoration={<CaptionMiniPreview />}
            />
            <BentoCard
              Icon={IconPhone}
              title="Auto vertical"
              body="Landscape → 9:16 with face tracking."
              span={2}
              decoration={<FaceFrameDecoration />}
            />
            <BentoCard
              Icon={IconVlog}
              title="Multi-format"
              body="9:16, 1:1, 16:9 in one render."
              span={2}
              decoration={<FormatStackDecoration />}
            />

            {/* Row 3: wide feature */}
            <BentoCard
              Icon={IconArrowRight}
              title="Hook clip picker"
              body="CleoCuts finds the 3 best moments in your long-form and cuts them as standalone reels."
              span={6}
              decoration={<HookClipStrip />}
              accent="var(--brand)"
            />
          </div>
        </div>
      </section>

      {/* ── How — 3 steps, single line each ─── */}
      <section
        className="relative z-10 px-6 py-16"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="mx-auto max-w-5xl">
          <h2
            className="mb-10 text-2xl font-bold tracking-tight sm:text-3xl"
            style={{ color: "var(--text-strong)" }}
          >
            Three steps.
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <Step n="01" title="Record" body='Say "Cleo cut" when you mess up.' />
            <Step n="02" title="Upload" body="Pick a workflow." />
            <Step n="03" title="Post" body="Download for TikTok, IG, YouTube." />
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
            className="flex items-center gap-5 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Link href="/app" className="hover:opacity-70">Editor</Link>
            <Link href="/app/library" className="hover:opacity-70">Library</Link>
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            © 2026 CleoCuts
          </div>
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
  label: string;
  text: string;
  render: (t: string) => React.ReactNode;
};

const STYLES: Style[] = [
  {
    label: "Clipper",
    text: "TALK IS THE EDITOR",
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
    text: "READY TO POST",
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
    text: "SAY CUT",
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
    text: "NAILED IT",
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
    text: "It just listens.",
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
            CleoCuts listening
          </span>
        </div>

        {/* Center: rotating caption */}
        <div className="relative z-10 flex flex-1 items-center justify-center px-8">
          <div key={idx} className="phase-fade max-w-full">
            {style.render(style.text)}
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
              caption style
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

function CaptionMiniPreview() {
  return (
    <div className="absolute inset-0 flex items-end justify-center pb-4 opacity-70">
      <div
        className="rounded-md px-2 py-1 text-[10px] font-black italic"
        style={{
          background: "rgba(0,0,0,0.5)",
          color: "#ffffff",
          textShadow: "0 1px 3px rgba(0,0,0,.7)",
          border: "1px solid rgba(139,92,246,0.35)",
        }}
      >
        REAL FONTS
      </div>
    </div>
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

function FormatStackDecoration() {
  return (
    <div className="absolute -bottom-2 -right-2 flex items-end gap-1 opacity-70">
      <div
        className="rounded-sm"
        style={{
          width: 14,
          height: 24,
          border: "1.5px solid var(--brand)",
        }}
      />
      <div
        className="rounded-sm"
        style={{
          width: 20,
          height: 20,
          border: "1.5px solid var(--brand-hover)",
        }}
      />
      <div
        className="rounded-sm"
        style={{
          width: 30,
          height: 18,
          border: "1.5px solid var(--accent)",
        }}
      />
    </div>
  );
}

function HookClipStrip() {
  return (
    <div className="absolute inset-y-0 right-0 flex items-center overflow-hidden opacity-60">
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

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: "rgba(19, 18, 23, 0.5)",
        border: "1px solid var(--border-hover)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <div
        className="mb-3 font-mono text-xs font-semibold"
        style={{ color: "var(--brand)" }}
      >
        {n}
      </div>
      <div
        className="mb-1 text-lg font-bold"
        style={{ color: "var(--text-strong)" }}
      >
        {title}
      </div>
      <div className="text-sm" style={{ color: "var(--text-body)" }}>
        {body}
      </div>
    </div>
  );
}
