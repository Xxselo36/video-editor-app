import type { Metadata } from "next";
import Link from "next/link";
import { OPERATOR, RETENTION_DAYS } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms – CleoCuts" };

/*
 * TODO(owner): this is a TEMPLATE, not legal advice. Have it reviewed
 * (consumer law, right of withdrawal, liability) before selling plans,
 * and keep it consistent with Lemon Squeezy's own buyer terms — they
 * are the seller (Merchant of Record) of every subscription.
 */

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-8 font-semibold" style={{ color: "var(--text-strong)" }}>{children}</h2>;
}

export default function TermsPage() {
  return (
    <main className="relative z-10 mx-auto w-full max-w-2xl px-5 py-12 text-sm leading-relaxed" style={{ color: "var(--text-body)" }}>
      <Link href="/" className="text-xs" style={{ color: "var(--text-muted)" }}>← CleoCuts</Link>
      <h1 className="mb-2 mt-4 text-3xl font-bold" style={{ color: "var(--text-strong)" }}>Terms of service</h1>
      <p style={{ color: "var(--text-muted)" }}>Nutzungsbedingungen · Template — to be reviewed before launch.</p>

      <H>1. Scope</H>
      <p>These terms apply to the use of CleoCuts (cleocuts.com), operated by {OPERATOR.name}, {OPERATOR.street}, {OPERATOR.city}, {OPERATOR.country} ({OPERATOR.email}). Different terms of the user do not apply.</p>

      <H>2. The service</H>
      <p>CleoCuts edits videos you upload: it transcribes speech, removes pauses, filler words and failed takes, adds captions and renders the result in the formats you choose. Results are produced automatically with AI and may contain mistakes — please check them before publishing. We aim for high availability but cannot guarantee uninterrupted operation; features may change as the product develops.</p>

      <H>3. Your account</H>
      <p>Some features require an account. Keep your sign-in details confidential; you are responsible for activity under your account. An account is personal and may not be shared. You can delete your account at any time.</p>

      <H>4. Plans and payment</H>
      <ul className="list-disc space-y-1 pl-5">
        <li>Paid plans are monthly subscriptions sold by <b>Lemon Squeezy</b> as Merchant of Record. Lemon Squeezy is the seller, charges you, handles taxes and sends your invoices; its buyer terms apply to the purchase.</li>
        <li>Each plan includes a number of minutes of video per billing month, counted by the length of the videos you upload. Unused minutes do not roll over. A video longer than your remaining minutes cannot be uploaded until the next period or an upgrade.</li>
        <li>Prices are shown on the pricing page and include VAT where applicable. You can change or cancel your plan at any time in the customer portal; a cancellation takes effect at the end of the paid period.</li>
        <li>If you are a consumer, you may have a statutory right of withdrawal; details are provided by Lemon Squeezy at checkout.</li>
      </ul>

      <H>5. Your content</H>
      <p>You keep all rights to the videos you upload. You grant us the rights needed to process, store and render them for you, only for providing the service. You may only upload content you have the rights to, and no unlawful content (for example content that infringes rights of others or is illegal to distribute).</p>

      <H>6. Storage</H>
      <p>Projects are deleted automatically after the last change, depending on your plan: {Object.entries(RETENTION_DAYS).map(([plan, days]) => `${days} days (${plan})`).join(", ")}. Download your results in time — deleted projects cannot be restored. Details: <Link href="/privacy" className="underline">privacy policy</Link>.</p>

      <H>7. Liability</H>
      <p>We are liable without limitation for intent and gross negligence and for injury to life, body or health. For slight negligence we are only liable for breach of essential contractual obligations, limited to the typical, foreseeable damage. Liability under product liability law remains unaffected.</p>

      <H>8. Changes</H>
      <p>We may change these terms with reasonable notice (for example by email). If you do not agree, you can cancel before the change takes effect.</p>

      <H>9. Final provisions</H>
      <p>The law of the operator&apos;s country applies, excluding the UN Convention on Contracts for the International Sale of Goods; mandatory consumer protection of your country of residence remains unaffected. Contact: {OPERATOR.email}</p>
    </main>
  );
}
