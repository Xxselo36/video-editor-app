/**
 * Everything the imprint, the privacy policy and the terms need to know
 * about the operator — THE one place to fill in.
 *
 * TODO(owner) before the paid launch:
 *   1. OPERATOR: replace every value in [square brackets] (postal
 *      address; for a company also the representative and the register
 *      entry) and switch `email` to the support mailbox (e.g.
 *      support@cleocuts.com — not a personal address). A second fast
 *      contact route (phone or contact form) is recommended.
 *   2. PROCESSORS: confirm each provider's data processing agreement
 *      (DPA / AVV) and whether it is certified under the EU-US Data
 *      Privacy Framework (the text names both bases).
 *   3. After the lawyer's review: set LEGAL_DRAFT.privacy / .terms to
 *      false (removes the "Entwurf" banner) and update LEGAL_UPDATED.
 * A value still in [brackets] is shown as it is, so nothing missing
 * goes unnoticed on the page.
 */

export const OPERATOR = {
  /** Natural person, or the company with its legal form ("… UG (haftungsbeschränkt)"). */
  name: "Selim Alcibuga",
  /** Company only: who represents it (Geschäftsführer); "" for a sole trader. */
  representative: "",
  street: "[Straße und Hausnummer]",
  postcode: "[PLZ]",
  city: "[Ort]",
  country: { de: "Deutschland", en: "Germany" },
  /** Contact e-mail shown everywhere. TODO(owner): the support mailbox. */
  email: "selimalcibuga@gmail.com",
  /** Optional second contact route: phone number ("" hides it). */
  phone: "",
  /** USt-IdNr. under § 27a UStG, if there is one ("" hides it). */
  vatId: "",
  /** Company only: register court and number ("" hides it). */
  register: "",
};

/** Still a placeholder? (for checks; the pages show the value as is) */
export function isPlaceholder(value: string): boolean {
  return /^\[.*\]$/.test(value.trim());
}

/** The legal texts are drafts until a lawyer has reviewed them. */
export const LEGAL_DRAFT = { imprint: false, privacy: true, terms: true } as const;

/** "Stand" / "Last updated" of the legal texts. */
export const LEGAL_UPDATED = { de: "30. September 2026", en: "30 September 2026" } as const;

export const COPYRIGHT = "© 2026 CleoCuts";

/**
 * Days an idle project is kept on the server, per plan (counted from
 * the last change). Must match PLAN_RETENTION_DAYS in backend/jobs.py.
 * The beta (no paid plans yet) runs every job on the Starter period.
 */
export const RETENTION_DAYS = { Starter: 14, Pro: 30, Studio: 90 } as const;
export const BETA_RETENTION_DAYS = RETENTION_DAYS.Starter;

/** Days the backend keeps its processing statistics (backend/jobs.py EVENTS_KEEP_DAYS). */
export const EVENTS_KEEP_DAYS = 90;

export type Localized = { de: string; en: string };

/** When a provider is used: always, or only with a feature switched on. */
export type ProcessorWhen = "always" | "accounts" | "errorReports" | "analytics";

export type Processor = {
  name: string;
  company: Localized;
  purpose: Localized;
  data: Localized;
  when: ProcessorWhen;
};

/** Service providers that process data on our behalf (Art. 28 GDPR). */
export const PROCESSORS: Processor[] = [
  {
    name: "Vercel",
    company: { de: "Vercel Inc., USA", en: "Vercel Inc., USA" },
    purpose: { de: "Hosting der Website", en: "Hosting of the website" },
    data: {
      de: "Seitenaufrufe mit IP-Adresse, Browser- und Geräteangaben, Zeitpunkt",
      en: "Page requests with IP address, browser and device data, time",
    },
    when: "always",
  },
  {
    name: "Railway",
    company: { de: "Railway Corporation, USA", en: "Railway Corporation, USA" },
    purpose: {
      de: "Verarbeitungsserver und Datenbank (Projekte, Bearbeitungen, Konten)",
      en: "Processing server and database (projects, edits, accounts)",
    },
    data: {
      de: "Videos während der Verarbeitung, Transkripte, Projekt- und Kontodaten, Server-Logs",
      en: "Videos while they are processed, transcripts, project and account data, server logs",
    },
    when: "always",
  },
  {
    name: "Cloudflare R2",
    company: { de: "Cloudflare, Inc., USA", en: "Cloudflare, Inc., USA" },
    purpose: { de: "Speicherung von Uploads und Ergebnissen", en: "Storage of uploads and results" },
    data: {
      de: "Hochgeladene Videos, Vorschauen, fertige Videos",
      en: "Uploaded videos, previews, finished videos",
    },
    when: "always",
  },
  {
    name: "Modal",
    company: { de: "Modal Labs, Inc., USA", en: "Modal Labs, Inc., USA" },
    purpose: { de: "Rendern des fertigen Videos (Rechenleistung)", en: "Rendering the finished video (compute)" },
    data: { de: "Video und Untertiteltext", en: "Video and caption text" },
    when: "always",
  },
  {
    name: "Groq",
    company: { de: "Groq, Inc., USA", en: "Groq, Inc., USA" },
    purpose: { de: "Spracherkennung (Transkript)", en: "Speech recognition (transcript)" },
    data: { de: "Tonspur des Videos", en: "The video's audio track" },
    when: "always",
  },
  {
    name: "Anthropic",
    company: { de: "Anthropic PBC, USA", en: "Anthropic PBC, USA" },
    purpose: {
      de: "Text-KI: Transkript bereinigen, Sprachbefehle erkennen, Highlights und Beschreibungsvorschläge",
      en: "Text AI: cleaning up the transcript, recognising voice commands, highlights and post caption suggestions",
    },
    data: { de: "Nur der Transkripttext (kein Bild, kein Ton)", en: "Only the transcript text (no picture, no sound)" },
    when: "always",
  },
  {
    name: "Clerk",
    company: { de: "Clerk, Inc., USA", en: "Clerk, Inc., USA" },
    purpose: { de: "Benutzerkonten und Anmeldung", en: "User accounts and sign-in" },
    data: {
      de: "E-Mail-Adresse, Anmeldemethode, Sitzungsdaten",
      en: "E-mail address, sign-in method, session data",
    },
    when: "accounts",
  },
  {
    name: "Sentry",
    company: { de: "Functional Software, Inc. (Sentry), USA", en: "Functional Software, Inc. (Sentry), USA" },
    purpose: { de: "Fehlerberichte", en: "Error reports" },
    data: {
      de: "Technische Fehlerdaten ohne Videoinhalte und ohne Kontodaten",
      en: "Technical error data without video content and without account data",
    },
    when: "errorReports",
  },
  {
    name: "Vercel Web Analytics",
    company: { de: "Vercel Inc., USA", en: "Vercel Inc., USA" },
    purpose: { de: "Cookielose Reichweitenmessung", en: "Cookieless usage statistics" },
    data: {
      de: "Seitenaufrufe und einzelne Aktionen, ohne Cookies und ohne gespeicherte Kennung",
      en: "Page views and single actions, without cookies and without a stored identifier",
    },
    when: "analytics",
  },
];

/** The transfer basis for the providers in the USA. */
export const TRANSFER_BASIS: Localized = {
  de: "Übermittlungen in die USA stützen sich auf das EU-US Data Privacy Framework (Angemessenheitsbeschluss, Art. 45 DSGVO), soweit der Anbieter danach zertifiziert ist, im Übrigen auf die EU-Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO).",
  en: "Transfers to the USA are based on the EU-US Data Privacy Framework (adequacy decision, Art. 45 GDPR) where the provider is certified under it, otherwise on the EU Standard Contractual Clauses (Art. 46(2)(c) GDPR).",
};
