import type { Metadata } from "next";
import Link from "next/link";
import { OPERATOR, RETENTION_DAYS } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy – CleoCuts" };

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-8 font-semibold" style={{ color: "var(--text-strong)" }}>{children}</h2>;
}

export default function PrivacyPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-5 py-12 text-sm leading-relaxed" style={{ color: "var(--text-body)" }}>
      <Link href="/" className="text-xs" style={{ color: "var(--text-muted)" }}>← CleoCuts</Link>
      <h1 className="mb-2 mt-4 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>Privacy policy</h1>
      <p style={{ color: "var(--text-muted)" }}>Datenschutzerklärung · Template — to be reviewed before launch.</p>

      <H>1. Controller</H>
      <p>{OPERATOR.name}, {OPERATOR.street}, {OPERATOR.city}, {OPERATOR.country} · {OPERATOR.email}</p>

      <H>2. What we process</H>
      <ul className="list-disc space-y-1 pl-5">
        <li><b>Videos you upload</b> (image and audio) to cut them, create a transcript and captions, and render the result.</li>
        <li><b>Transcript and edits</b> you make in the editor (cuts, effects, caption text).</li>
        <li><b>Technical data</b> needed to run the service (IP address, browser, time of requests) in server logs.</li>
        <li><b>Voice test</b>: only if you start it, camera and microphone are used live in your browser; nothing is uploaded.</li>
      </ul>
      <p className="mt-2">Legal basis: performance of the service you request (Art. 6(1)(b) GDPR) and our legitimate interest in operating it securely (Art. 6(1)(f) GDPR).</p>

      <H>3. Processors</H>
      <p>To provide the service we use: hosting of the website (Vercel), the processing server (Railway), file storage (Cloudflare R2), cloud rendering (Modal), speech-to-text (Groq) and text cleanup (Anthropic). They process data only on our behalf. Some of them are located outside the EU; transfers rely on the EU standard contractual clauses or an adequacy decision.</p>

      <H>4. Storage period</H>
      <p>Uploaded videos, previews, rendered results and transcripts are deleted automatically after the last change to a project, depending on your plan: {Object.entries(RETENTION_DAYS).map(([plan, days]) => `${days} days (${plan})`).join(", ")}. You can delete a project yourself at any time in your library; this removes it from our servers immediately. Your list of projects is stored only in your browser (local storage) and can be removed by clearing site data.</p>

      <H>5. Cookies and tracking</H>
      <p>We use no advertising or tracking cookies. The browser&apos;s local storage keeps your projects list and language setting on your device.</p>

      <H>6. Your rights</H>
      <p>You have the right to access, rectification, erasure, restriction, data portability and objection, and to lodge a complaint with a supervisory authority. Contact: {OPERATOR.email}</p>
    </main>
  );
}
