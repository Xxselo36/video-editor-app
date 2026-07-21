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
      className="flex min-h-screen flex-col"
      style={{ background: "var(--surface-0)", color: "var(--text-strong)" }}
    >
      {/* ── Header ─────────────────────────────────── */}
      <header
        className="flex items-center justify-between px-6 py-4"
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
          <Link href="/#pricing" className="hidden transition-colors hover:opacity-70 sm:inline">
            Pricing
          </Link>
          <Link
            href="/app"
            className="rounded-full px-5 py-2 font-medium transition-transform hover:scale-105"
            style={{
              background: "var(--brand)",
              color: "white",
              boxShadow: "var(--shadow-md)",
            }}
          >
            Try it free
          </Link>
        </nav>
      </header>

      {/* ── Hero ───────────────────────────────────── */}
      <section className="phase-fade mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-6 py-20 text-center sm:py-28">
        <div
          className="mb-4 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium"
          style={{
            background: "var(--brand-tint)",
            color: "var(--brand-strong)",
          }}
        >
          <IconSparkle size={14} strokeWidth={2} />
          Voice-controlled AI editor
        </div>

        <h1
          className="mb-6 text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl"
          style={{ color: "var(--text-strong)" }}
        >
          Just talk. <br />
          <span style={{ color: "var(--brand)" }}>I&apos;ll handle the rest.</span>
        </h1>

        <p
          className="mb-10 max-w-xl text-lg leading-relaxed sm:text-xl"
          style={{ color: "var(--text-body)" }}
        >
          Say <span style={{ color: "var(--text-strong)", fontWeight: 500 }}>&ldquo;Cleo cut&rdquo;</span>{" "}
          when you mess up. Say{" "}
          <span style={{ color: "var(--text-strong)", fontWeight: 500 }}>&ldquo;Cleo go&rdquo;</span>{" "}
          to start over. I&apos;ll clean it up, add captions, and hand you a
          ready-to-post video.
        </p>

        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <Link
            href="/app"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-full px-8 py-4 text-base font-semibold transition-transform hover:scale-[1.02] sm:w-auto"
            style={{
              background: "var(--brand)",
              color: "white",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            Start editing — it&apos;s free
            <IconArrowRight size={18} />
          </Link>
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>
            No signup · no card · just a video
          </span>
        </div>

        {/* Trust strip */}
        <div
          className="mt-16 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="inline-flex items-center gap-1.5">
            <IconCheck size={14} strokeWidth={2.5} /> Works from your phone
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconCheck size={14} strokeWidth={2.5} /> German + English + more
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconCheck size={14} strokeWidth={2.5} /> Post-ready in seconds
          </span>
        </div>
      </section>

      {/* ── How it works ───────────────────────────── */}
      <section
        id="how"
        className="px-6 py-24 sm:py-32"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--surface-1)",
        }}
      >
        <div className="mx-auto max-w-4xl">
          <div className="mb-16 text-center">
            <div
              className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]"
              style={{ color: "var(--brand-strong)" }}
            >
              How it works
            </div>
            <h2
              className="text-4xl font-bold tracking-tight sm:text-5xl"
              style={{ color: "var(--text-strong)" }}
            >
              Four steps. That&apos;s it.
            </h2>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Step
              n="1"
              title="Record"
              body="On your phone. Talk normally. If you mess up, just say &ldquo;Cleo cut&rdquo; and keep going."
            />
            <Step
              n="2"
              title="Upload"
              body="Drop it into Cleo. Pick a workflow — TikTok, Podcast, Vlog — or let me pick for you."
            />
            <Step
              n="3"
              title="Review"
              body="I&apos;ll show you what I cut and why. Fix any captions you don&apos;t like. Undo any cut."
            />
            <Step
              n="4"
              title="Post"
              body="Download 9:16 for TikTok, 1:1 for Insta, 16:9 for YouTube. Copy your suggested caption."
            />
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────── */}
      <section
        id="features"
        className="px-6 py-24 sm:py-32"
        style={{ background: "var(--surface-0)" }}
      >
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <div
              className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]"
              style={{ color: "var(--brand-strong)" }}
            >
              What&apos;s inside
            </div>
            <h2
              className="text-4xl font-bold tracking-tight sm:text-5xl"
              style={{ color: "var(--text-strong)" }}
            >
              Made for creators.
              <br />
              <span style={{ color: "var(--text-muted)" }}>
                Not a video degree required.
              </span>
            </h2>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              Icon={IconMic}
              title="Voice triggers"
              body='&ldquo;Cleo cut&rdquo; marks a bad take. &ldquo;Cleo go&rdquo; means try again. Everything between is gone.'
            />
            <FeatureCard
              Icon={IconSparkle}
              title="AI cleanup"
              body="I fix your transcription typos, canonicalize brand names, catch unconscious repeats."
            />
            <FeatureCard
              Icon={IconCaptions}
              title="Beautiful captions"
              body="Nine styles from clean to TikTok-bounce. Real fonts, timing-locked to your voice."
            />
            <FeatureCard
              Icon={IconPhone}
              title="Smart reframe"
              body="Landscape footage becomes vertical with face-tracking. TikTok-ready without cropping by hand."
            />
            <FeatureCard
              Icon={IconVlog}
              title="Multi-format export"
              body="One render, three ratios. Download 9:16, 1:1, 16:9 all at once."
            />
            <FeatureCard
              Icon={IconArrowRight}
              title="Hook detection"
              body="For long videos, I find your 3 best punchlines and cut them as standalone clips."
            />
          </div>
        </div>
      </section>

      {/* ── Pricing teaser ───────────────────────── */}
      <section
        id="pricing"
        className="px-6 py-24 sm:py-32"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <div
            className="mb-3 text-xs font-semibold uppercase tracking-[0.2em]"
            style={{ color: "var(--brand-strong)" }}
          >
            Pricing
          </div>
          <h2
            className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--text-strong)" }}
          >
            Free while we&apos;re in beta.
          </h2>
          <p
            className="mx-auto mb-10 max-w-lg text-lg"
            style={{ color: "var(--text-body)" }}
          >
            No credit card, no signup. Paid plans with 4K, longer videos and
            priority processing will come once we&apos;re out of beta — and
            you&apos;ll get plenty of notice.
          </p>
          <Link
            href="/app"
            className="inline-flex items-center gap-2 rounded-full px-8 py-4 text-base font-semibold transition-transform hover:scale-[1.02]"
            style={{
              background: "var(--brand)",
              color: "white",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            Try Cleo now
            <IconArrowRight size={18} />
          </Link>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────── */}
      <footer
        className="px-6 py-10"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--surface-1)",
        }}
      >
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <LogoWord size={22} />
          <div
            className="flex items-center gap-6 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Link href="/app" className="transition-colors hover:opacity-70">
              App
            </Link>
            <Link href="/app/library" className="transition-colors hover:opacity-70">
              Library
            </Link>
            <Link href="/#how" className="transition-colors hover:opacity-70">
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

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <div
        className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold"
        style={{
          background: "var(--brand-tint)",
          color: "var(--brand-strong)",
        }}
      >
        {n}
      </div>
      <div
        className="mb-1.5 text-lg font-semibold"
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
      className="rounded-2xl p-6 transition-all hover:-translate-y-0.5"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl"
        style={{
          background: "var(--brand-tint)",
          color: "var(--brand-strong)",
        }}
      >
        <Icon size={20} strokeWidth={2} />
      </div>
      <div
        className="mb-2 text-lg font-semibold"
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
