import Link from "next/link";
import { LogoWord } from "@/components/Logo";
import {
  IconArrowRight,
  IconCaptions,
  IconCheck,
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
      {/* ── Header ─────────────────────────────────── */}
      <header
        className="relative z-10 flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" className="transition-opacity hover:opacity-80" aria-label="Cleo home">
          <LogoWord />
        </Link>
        <nav
          className="flex items-center gap-6 text-sm"
          style={{ color: "var(--text-body)" }}
        >
          <Link href="/#how" className="hidden transition-colors hover:opacity-70 sm:inline">
            How it works
          </Link>
          <Link href="/#features" className="hidden transition-colors hover:opacity-70 sm:inline">
            Features
          </Link>
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 rounded-full px-5 py-2 font-semibold transition-transform hover:scale-105"
            style={{
              background: "var(--brand)",
              color: "#1a1208",
              boxShadow: "var(--shadow-glow)",
            }}
          >
            Open editor <IconArrowRight size={14} strokeWidth={2.5} />
          </Link>
        </nav>
      </header>

      {/* ── Hero ───────────────────────────────────── */}
      <section className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-16 lg:grid-cols-[1.15fr_1fr] lg:py-24">
        <div className="phase-fade">
          {/* Beta pill with pulsing dot */}
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
            Open beta — free while it lasts
          </div>

          {/* Headline */}
          <h1
            className="mb-6 text-5xl font-bold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl"
            style={{ color: "var(--text-strong)" }}
          >
            Talk.
            <br />
            That&apos;s{" "}
            <span
              className="italic"
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
            className="mb-8 max-w-xl text-lg leading-relaxed"
            style={{ color: "var(--text-body)" }}
          >
            Record on your phone. Say{" "}
            <span style={{ color: "var(--brand)", fontWeight: 600 }}>
              &ldquo;Cleo cut&rdquo;
            </span>{" "}
            when you mess up. Cleo removes the bad takes, adds captions in your
            style, and hands you a post-ready video in seconds.
          </p>

          <div className="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <Link
              href="/app"
              className="group inline-flex w-full items-center justify-center gap-2 rounded-full px-7 py-4 text-base font-semibold transition-transform hover:scale-[1.02] sm:w-auto"
              style={{
                background: "var(--brand)",
                color: "#1a1208",
                boxShadow: "var(--shadow-glow)",
              }}
            >
              Try Cleo now
              <IconArrowRight size={18} strokeWidth={2.5} />
            </Link>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              No signup · no card · just a video
            </span>
          </div>

          <div
            className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <IconCheck size={13} strokeWidth={2.5} /> Works on your phone
            </span>
            <span className="inline-flex items-center gap-1.5">
              <IconCheck size={13} strokeWidth={2.5} /> DE + EN + more
            </span>
            <span className="inline-flex items-center gap-1.5">
              <IconCheck size={13} strokeWidth={2.5} /> Post-ready output
            </span>
          </div>
        </div>

        {/* Phone mockup showing the editor mid-flow */}
        <div className="phase-fade flex justify-center lg:justify-end">
          <PhoneMockup />
        </div>
      </section>

      {/* ── How it works — 4 tight steps ───────────── */}
      <section
        id="how"
        className="relative z-10 px-6 py-20"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="mx-auto max-w-5xl">
          <div className="mb-14 max-w-2xl">
            <div
              className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]"
              style={{ color: "var(--brand)" }}
            >
              How it works
            </div>
            <h2
              className="text-3xl font-bold tracking-tight sm:text-4xl"
              style={{ color: "var(--text-strong)" }}
            >
              Record. Upload. Post.
              <br />
              <span style={{ color: "var(--text-muted)" }}>
                Editing happens in between — automatically.
              </span>
            </h2>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <Step n="01" title="Record">
              On your phone, in one take. Say{" "}
              <em style={{ color: "var(--brand)" }}>&ldquo;Cleo cut&rdquo;</em>{" "}
              if you mess up. Keep talking.
            </Step>
            <Step n="02" title="Upload">
              Drag the file in. Pick TikTok, Podcast or Vlog — or let Cleo pick
              for you.
            </Step>
            <Step n="03" title="Review">
              See what got cut and why. Fix any caption typo. Undo any cut.
            </Step>
            <Step n="04" title="Post">
              Download 9:16 for TikTok, 1:1 for IG, 16:9 for YouTube. Grab the
              suggested caption.
            </Step>
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────── */}
      <section
        id="features"
        className="relative z-10 px-6 py-20"
        style={{
          background: "var(--surface-1)",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div className="mx-auto max-w-5xl">
          <div className="mb-14 max-w-2xl">
            <div
              className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]"
              style={{ color: "var(--brand)" }}
            >
              Under the hood
            </div>
            <h2
              className="text-3xl font-bold tracking-tight sm:text-4xl"
              style={{ color: "var(--text-strong)" }}
            >
              Six things you no longer do by hand.
            </h2>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              Icon={IconMic}
              title="Voice triggers"
              body='Cleo listens for &ldquo;cut&rdquo; and &ldquo;go&rdquo; in your recording. Everything between the two is gone.'
            />
            <FeatureCard
              Icon={IconSparkle}
              title="AI cleanup"
              body="Claude fixes transcription typos, canonicalizes brand names, catches unconscious repeat takes."
            />
            <FeatureCard
              Icon={IconCaptions}
              title="9 caption styles"
              body="Clean, Clipper, Highlight, Flash… all with real fonts, timing locked to your voice."
            />
            <FeatureCard
              Icon={IconPhone}
              title="Smart reframe"
              body="Landscape footage becomes vertical with face tracking. No manual cropping."
            />
            <FeatureCard
              Icon={IconVlog}
              title="Multi-format"
              body="One render, three ratios. 9:16, 1:1, 16:9 in one go. Download all."
            />
            <FeatureCard
              Icon={IconArrowRight}
              title="Hook clips"
              body="Long video? Cleo picks 3 punchy moments and cuts them as standalone reels."
            />
          </div>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────── */}
      <section
        className="relative z-10 px-6 py-24"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <h2
            className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--text-strong)" }}
          >
            Want to try it?
          </h2>
          <p
            className="mx-auto mb-8 max-w-lg"
            style={{ color: "var(--text-body)" }}
          >
            Open the editor, drop a video in, and see what Cleo does with it.
            Takes about a minute.
          </p>
          <Link
            href="/app"
            className="inline-flex items-center gap-2 rounded-full px-8 py-4 text-base font-semibold transition-transform hover:scale-[1.02]"
            style={{
              background: "var(--brand)",
              color: "#1a1208",
              boxShadow: "var(--shadow-glow)",
            }}
          >
            Open editor
            <IconArrowRight size={18} strokeWidth={2.5} />
          </Link>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────── */}
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
            <Link href="/app" className="hover:opacity-70">
              Editor
            </Link>
            <Link href="/app/library" className="hover:opacity-70">
              Library
            </Link>
            <Link href="/#how" className="hover:opacity-70">
              How it works
            </Link>
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            © 2026 Cleo
          </div>
        </div>
      </footer>
    </main>
  );
}

/* ── Phone mockup ──
 * Fake iPhone frame showing Cleo mid-render — captions burning in,
 * "Cleo cut" phrase highlighted. Sells the product visually, no
 * animated demo needed for v1.
 */
function PhoneMockup() {
  return (
    <div className="relative">
      {/* Glow behind phone */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--brand-glow) 0%, transparent 60%)",
        }}
      />
      <div
        className="relative overflow-hidden rounded-[2.5rem] p-2"
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--shadow-md)",
          width: "min(300px, 80vw)",
          aspectRatio: "9 / 19",
        }}
      >
        <div
          className="flex h-full flex-col overflow-hidden rounded-[2rem]"
          style={{ background: "var(--surface-0)" }}
        >
          {/* Notch */}
          <div className="flex items-center justify-center py-2">
            <div
              className="h-4 w-20 rounded-full"
              style={{ background: "#000" }}
            />
          </div>

          {/* Fake video content area */}
          <div
            className="relative flex-1 overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, #2a2118 0%, #3a2a1c 60%, #221b13 100%)",
            }}
          >
            {/* Fake face silhouette */}
            <div className="absolute inset-x-8 top-8">
              <div
                className="mx-auto h-32 w-32 rounded-full"
                style={{
                  background:
                    "radial-gradient(circle at 40% 40%, #ffd396, #d99551 40%, #7a4d24 100%)",
                  opacity: 0.85,
                }}
              />
              <div
                className="mx-auto -mt-6 h-40 w-56 rounded-[40%]"
                style={{
                  background:
                    "linear-gradient(180deg, #3a2a1c 0%, #221b13 100%)",
                }}
              />
            </div>

            {/* Caption bar burning in */}
            <div className="absolute inset-x-6 bottom-24 flex justify-center">
              <div
                className="rounded-lg px-3 py-1.5 text-center text-[13px] font-black italic tracking-wide"
                style={{
                  background: "rgba(0,0,0,0.65)",
                  color: "#ffffff",
                  textShadow: "0 2px 6px rgba(0,0,0,0.6)",
                  border: "1px solid rgba(245,176,84,0.35)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}
              >
                POST-READY IN{" "}
                <span style={{ color: "var(--brand)" }}>SECONDS</span>
              </div>
            </div>

            {/* Voice-trigger indicator */}
            <div className="absolute inset-x-4 top-4 flex items-center gap-2">
              <span
                className="pulse-dot inline-block h-2 w-2 rounded-full"
                style={{ background: "var(--brand)" }}
              />
              <span
                className="text-[10px] font-semibold uppercase tracking-widest"
                style={{ color: "var(--brand)" }}
              >
                Listening
              </span>
            </div>
          </div>

          {/* Fake progress toolbar at bottom */}
          <div
            className="flex items-center gap-2 px-4 py-3"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <IconMic size={16} className="shrink-0" strokeWidth={2} />
            <div
              className="h-1 flex-1 overflow-hidden rounded-full"
              style={{ background: "var(--surface-2)" }}
            >
              <div
                className="h-full w-2/3 rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, var(--brand) 0%, var(--accent) 100%)",
                }}
              />
            </div>
            <div
              className="text-[10px] font-semibold"
              style={{ color: "var(--brand)" }}
            >
              67%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl p-5"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="mb-4 text-xs font-mono font-semibold"
        style={{ color: "var(--brand)" }}
      >
        {n}
      </div>
      <div
        className="mb-1.5 text-base font-bold"
        style={{ color: "var(--text-strong)" }}
      >
        {title}
      </div>
      <div
        className="text-sm leading-relaxed"
        style={{ color: "var(--text-body)" }}
      >
        {children}
      </div>
    </div>
  );
}

function FeatureCard({
  Icon,
  title,
  body,
}: {
  Icon: (p: { size?: number; className?: string; strokeWidth?: number }) => React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      className="group rounded-2xl p-5 transition-all hover:-translate-y-0.5"
      style={{
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors group-hover:scale-105"
        style={{
          background: "var(--brand-tint)",
          color: "var(--brand)",
        }}
      >
        <Icon size={18} strokeWidth={2} />
      </div>
      <div
        className="mb-1.5 text-base font-bold"
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
  );
}
