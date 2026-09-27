import type { Metadata } from "next";
import Link from "next/link";
import { OPERATOR } from "@/lib/legal";

export const metadata: Metadata = { title: "Imprint – CleoCuts" };

export default function ImprintPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-5 py-12 text-sm leading-relaxed" style={{ color: "var(--text-body)" }}>
      <Link href="/" className="text-xs" style={{ color: "var(--text-muted)" }}>← CleoCuts</Link>
      <h1 className="mb-6 mt-4 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>Imprint</h1>
      <p className="mb-6" style={{ color: "var(--text-muted)" }}>Impressum · Information according to § 5 DDG</p>
      <section className="mb-6">
        <h2 className="mb-2 font-semibold" style={{ color: "var(--text-strong)" }}>Operator</h2>
        <p>{OPERATOR.name}<br />{OPERATOR.street}<br />{OPERATOR.city}<br />{OPERATOR.country}</p>
      </section>
      <section className="mb-6">
        <h2 className="mb-2 font-semibold" style={{ color: "var(--text-strong)" }}>Contact</h2>
        <p>Email: {OPERATOR.email}{OPERATOR.phone && <><br />Phone: {OPERATOR.phone}</>}</p>
      </section>
      {OPERATOR.vatId && (
        <section className="mb-6">
          <h2 className="mb-2 font-semibold" style={{ color: "var(--text-strong)" }}>VAT ID</h2>
          <p>{OPERATOR.vatId}</p>
        </section>
      )}
      <section className="mb-6">
        <h2 className="mb-2 font-semibold" style={{ color: "var(--text-strong)" }}>Responsible for content</h2>
        <p>{OPERATOR.name}, address as above.</p>
      </section>
      <section>
        <h2 className="mb-2 font-semibold" style={{ color: "var(--text-strong)" }}>EU dispute resolution</h2>
        <p>We are neither willing nor obliged to take part in dispute resolution proceedings before a consumer arbitration board.</p>
      </section>
    </main>
  );
}
