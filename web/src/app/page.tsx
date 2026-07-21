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
          <PhoneMockup />
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

function PhoneMockup() {
  return (
    <div className="relative">
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
          <div className="flex items-center justify-center py-2">
            <div className="h-4 w-20 rounded-full" style={{ background: "#000" }} />
          </div>

          <div
            className="relative flex-1 overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, #1a1830 0%, #2a1f4a 60%, #14122a 100%)",
            }}
          >
            <div className="absolute inset-x-8 top-8">
              <div
                className="mx-auto h-32 w-32 rounded-full"
                style={{
                  background:
                    "radial-gradient(circle at 40% 40%, #ddd6fe, #a78bfa 40%, #5b21b6 100%)",
                  opacity: 0.85,
                }}
              />
              <div
                className="mx-auto -mt-6 h-40 w-56 rounded-[40%]"
                style={{
                  background: "linear-gradient(180deg, #2a1f4a 0%, #14122a 100%)",
                }}
              />
            </div>

            <div className="absolute inset-x-6 bottom-24 flex justify-center">
              <div
                className="rounded-lg px-3 py-1.5 text-center text-[13px] font-black italic tracking-wide"
                style={{
                  background: "rgba(0,0,0,0.65)",
                  color: "#ffffff",
                  textShadow: "0 2px 6px rgba(0,0,0,0.6)",
                  border: "1px solid rgba(167,139,250,0.4)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}
              >
                POST-READY IN <span style={{ color: "var(--brand)" }}>SECONDS</span>
              </div>
            </div>

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
            <div className="text-[10px] font-semibold" style={{ color: "var(--brand)" }}>
              67%
            </div>
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
