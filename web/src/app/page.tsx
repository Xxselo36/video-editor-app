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
      style={{ background: "var(--surface-0)", color: "var(--text-strong)" }}
    >
      {/* ── Header ─── */}
      <header
        className="relative z-10 flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="transition-opacity hover:opacity-80" aria-label="Cleo home">
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
            className="mb-6 text-5xl font-bold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl"
            style={{ color: "var(--text-strong)" }}
          >
            Talk.
            <br />
            That&apos;s{" "}
            <span
              style={{
                background: "linear-gradient(120deg, var(--brand) 0%, var(--accent) 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              the editor.
            </span>
          </h1>

          <p
            className="mb-8 max-w-md text-lg"
            style={{ color: "var(--text-body)" }}
          >
            Say <span style={{ color: "var(--brand)", fontWeight: 600 }}>&ldquo;Cleo cut&rdquo;</span>{" "}
            when you mess up. Get a post-ready video in seconds.
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
            Try Cleo
            <IconArrowRight size={18} strokeWidth={2.5} />
          </Link>
        </div>

        <div className="phase-fade flex justify-center lg:justify-end">
          <CaptionShowcase />
        </div>
      </section>

      {/* ── Features — icon grid, minimal copy ─── */}
      <section
        className="relative z-10 px-6 py-16"
        style={{
          background: "var(--surface-1)",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div className="mx-auto max-w-5xl">
          <h2
            className="mb-10 text-2xl font-bold tracking-tight sm:text-3xl"
            style={{ color: "var(--text-strong)" }}
          >
            What Cleo does.
          </h2>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Feat Icon={IconMic} label="Voice triggers" />
            <Feat Icon={IconSparkle} label="AI cleanup" />
            <Feat Icon={IconCaptions} label="9 caption styles" />
            <Feat Icon={IconPhone} label="Auto vertical" />
            <Feat Icon={IconVlog} label="Multi-format export" />
            <Feat Icon={IconArrowRight} label="Hook clip picker" />
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
          background: "var(--surface-1)",
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
            © 2026 Cleo
          </div>
        </div>
      </footer>
    </main>
  );
}

/* ── Caption Showcase ──
 * Rotates through caption styles inside a video-preview frame. No fake
 * face, no fake progress bar — just the actual product feature (caption
 * variety) rendered live. Reads as: "here's what Cleo makes."
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
            Cleo listening
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

function Feat({
  Icon,
  label,
}: {
  Icon: (p: { size?: number; className?: string; strokeWidth?: number }) => React.ReactNode;
  label: string;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-4 py-3.5 transition-colors hover:-translate-y-0.5"
      style={{
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: "var(--brand-tint)", color: "var(--brand)" }}
      >
        <Icon size={16} strokeWidth={2} />
      </div>
      <span className="text-sm font-semibold" style={{ color: "var(--text-strong)" }}>
        {label}
      </span>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
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
