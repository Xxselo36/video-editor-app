import Link from "next/link";

export default function Landing() {
  return (
    <main className="flex min-h-screen flex-col bg-black text-white">
      <header className="flex items-center justify-between border-b border-zinc-900 px-6 py-4">
        <span className="text-xl font-bold tracking-tight">Cleo</span>
        <nav className="flex items-center gap-6 text-sm text-zinc-400">
          <Link href="/#features" className="hover:text-white">
            Features
          </Link>
          <Link href="/#pricing" className="hover:text-white">
            Pricing
          </Link>
          <Link
            href="/app"
            className="rounded-lg bg-violet-500 px-4 py-2 font-medium text-white hover:bg-violet-400"
          >
            Try free
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <div className="mb-3 text-xs uppercase tracking-[0.3em] text-zinc-500">
          Voice-first video editing
        </div>
        <h1 className="mb-6 text-6xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
          Talk freely.
          <br />
          <span className="text-violet-400">Cleo cuts.</span>
        </h1>
        <p className="mb-10 max-w-lg text-lg text-zinc-400 sm:text-xl">
          Say <span className="text-white">&ldquo;Cleo cut&rdquo;</span> when you
          mess up, <span className="text-white">&ldquo;Cleo go&rdquo;</span> to
          start over. AI cleans the rest — captions, cuts, ready-to-post clips.
        </p>
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/app"
            className="w-full rounded-xl bg-violet-500 px-8 py-4 text-base font-semibold hover:bg-violet-400 sm:w-auto"
          >
            Try free · no signup
          </Link>
          <Link
            href="/#how-it-works"
            className="text-sm text-zinc-500 hover:text-white"
          >
            See how it works ↓
          </Link>
        </div>
      </section>

      {/* Features */}
      <section
        id="features"
        className="mx-auto w-full max-w-5xl px-6 py-24 sm:py-32"
      >
        <div className="mb-16 text-center">
          <div className="mb-2 text-xs uppercase tracking-[0.3em] text-zinc-500">
            Everything you need
          </div>
          <h2 className="text-4xl font-bold tracking-tight">
            One tool. Post-ready output.
          </h2>
        </div>

        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            title="Voice triggers"
            body='Say "Cleo cut" mid-take when you mess up. We remove those seconds. Say "Cleo go" to continue. Bulletproof for solo creators.'
          />
          <Feature
            title="AI cleanup"
            body="Claude fixes transcription typos, brand names, capitalization. Detects unconscious repeats — cuts the worse take."
          />
          <Feature
            title="Auto captions"
            body="9 caption styles from Clean to Clipper. Real fonts, real timing. Preview before render."
          />
          <Feature
            title="Smart reframe"
            body="Landscape footage → 9:16 vertical with face tracking. TikTok / Reels / Shorts ready without manual crop."
          />
          <Feature
            title="Multi-format export"
            body="One render, three outputs: 9:16 for TikTok, 1:1 for Instagram, 16:9 for YouTube. Download any."
          />
          <Feature
            title="Hook detection"
            body="For long-form: AI finds your 3 best viral moments and cuts them as standalone clips. Podcast → ready-to-post shorts."
          />
        </div>
      </section>

      {/* How it works */}
      <section
        id="how-it-works"
        className="border-t border-zinc-900 px-6 py-24 sm:py-32"
      >
        <div className="mx-auto max-w-3xl">
          <div className="mb-16 text-center">
            <div className="mb-2 text-xs uppercase tracking-[0.3em] text-zinc-500">
              How it works
            </div>
            <h2 className="text-4xl font-bold tracking-tight">
              Record. Upload. Post.
            </h2>
          </div>
          <ol className="space-y-8">
            <Step
              num="1"
              title="Record your video"
              body='On your phone, laptop, wherever. If you mess up, say "Cleo cut" and keep going — no need to stop.'
            />
            <Step
              num="2"
              title="Upload to Cleo"
              body="Drag-drop or pick from camera roll. Choose a caption style, or let us pick sensible defaults."
            />
            <Step
              num="3"
              title="Review the edit"
              body="See exactly what got cut and why. Fix any caption typos. Undo any cut you want to keep."
            />
            <Step
              num="4"
              title="Download & post"
              body="Get 9:16 for TikTok, 1:1 for Instagram, 16:9 for YouTube. Plus AI-picked hook clips for long content."
            />
          </ol>
        </div>
      </section>

      {/* Pricing teaser */}
      <section
        id="pricing"
        className="border-t border-zinc-900 px-6 py-24 sm:py-32"
      >
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-2 text-xs uppercase tracking-[0.3em] text-zinc-500">
            Pricing
          </div>
          <h2 className="mb-4 text-4xl font-bold tracking-tight">
            Free while in beta
          </h2>
          <p className="mb-10 text-lg text-zinc-400">
            Cleo is in open beta. No credit card, no signup required. Paid tiers
            with 4K, longer videos and priority processing coming soon.
          </p>
          <Link
            href="/app"
            className="inline-block rounded-xl bg-violet-500 px-8 py-4 text-base font-semibold hover:bg-violet-400"
          >
            Try Cleo now
          </Link>
        </div>
      </section>

      <footer className="border-t border-zinc-900 px-6 py-8 text-center text-xs text-zinc-600">
        © 2026 Cleo · Voice-first video editing
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
      <div className="mb-2 text-base font-semibold text-white">{title}</div>
      <div className="text-sm leading-relaxed text-zinc-400">{body}</div>
    </div>
  );
}

function Step({
  num,
  title,
  body,
}: {
  num: string;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-violet-400/40 text-sm font-semibold text-violet-300">
        {num}
      </div>
      <div>
        <div className="mb-1 text-lg font-semibold">{title}</div>
        <div className="text-zinc-400">{body}</div>
      </div>
    </li>
  );
}
