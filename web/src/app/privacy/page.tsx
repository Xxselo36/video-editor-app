import type { Metadata } from "next";
import { H, LegalPage, LegalTitle, Mail, Ul } from "@/components/legal/LegalPage";
import {
  BETA_RETENTION_DAYS,
  EVENTS_KEEP_DAYS,
  LEGAL_DRAFT,
  OPERATOR,
  PROCESSORS,
  RETENTION_DAYS,
  TRANSFER_BASIS,
  type ProcessorWhen,
} from "@/lib/legal";
import { AUTH_ENABLED, BILLING_COPY } from "@/lib/auth";
import { ERROR_REPORTING_ENABLED } from "@/lib/errorReporting";
import { ANALYTICS_ENABLED } from "@/lib/analytics";

export const metadata: Metadata = {
  title: "Privacy policy – Datenschutz",
  description: "How CleoCuts processes your videos and data: purposes, service providers, storage periods and your rights.",
};

// Build-time switches (NEXT_PUBLIC_*): the policy describes only what is
// switched on — accounts (Clerk), paid plans (Lemon Squeezy), error
// reports (Sentry), cookieless analytics.
const ON: Record<ProcessorWhen, boolean> = {
  always: true,
  accounts: AUTH_ENABLED,
  errorReports: ERROR_REPORTING_ENABLED,
  analytics: ANALYTICS_ENABLED,
};
const processors = PROCESSORS.filter((p) => ON[p.when]);
const PLANS_LIVE = BILLING_COPY;

function Controller({ lang }: { lang: "de" | "en" }) {
  const o = OPERATOR;
  return (
    <p>
      {o.name}
      {o.representative && `, ${o.representative}`}, {o.street}, {o.postcode} {o.city}, {o.country[lang]} ·{" "}
      <Mail address={o.email} />
    </p>
  );
}

function Processors({ lang }: { lang: "de" | "en" }) {
  return (
    <Ul>
      {processors.map((p) => (
        <li key={p.name}>
          <b>{p.name}</b> ({p.company[lang]}): {p.purpose[lang]}. {lang === "de" ? "Daten" : "Data"}: {p.data[lang]}.
        </li>
      ))}
    </Ul>
  );
}

const retentionPerPlan = (lang: "de" | "en") =>
  Object.entries(RETENTION_DAYS)
    .map(([plan, days]) => (lang === "de" ? `${days} Tage (${plan})` : `${days} days (${plan})`))
    .join(", ");

const German = (
  <>
    <LegalTitle lang="de" title="Datenschutzerklärung" draft={LEGAL_DRAFT.privacy} />

    <H>1. Verantwortlicher</H>
    <Controller lang="de" />

    <H>2. Was wir verarbeiten und wofür</H>
    <Ul>
      <li>
        <b>Deine hochgeladenen Videos</b> (Bild und Ton), um sie zu schneiden, ein Transkript und Untertitel zu
        erstellen und das fertige Video zu rendern.
      </li>
      <li>
        <b>Transkript und Bearbeitungen</b>, die du im Editor vornimmst (Schnitte, Effekte, Untertiteltext).
      </li>
      <li>
        <b>Technische Daten</b>, die für den Betrieb nötig sind: IP-Adresse, Browser, Zeitpunkt der Anfragen
        (Server-Logs), sowie eine Verarbeitungsstatistik je Auftrag (Beginn, Ende, Dauer, Fehlercode — ohne
        Inhalte), mit der wir die Zuverlässigkeit messen.
      </li>
      <li>
        <b>Stimmtest</b> (optional): siehe Abschnitt 5.
      </li>
      {ERROR_REPORTING_ENABLED && (
        <li>
          <b>Fehlerberichte</b>: Wenn die Website in deinem Browser oder unser Server bei der Verarbeitung einen
          Fehler hat, ein technischer Bericht (Fehlermeldung, Seitenadresse ohne Parameter, Browser,
          Betriebssystem, Sprache und Zeitzone, die Klicks, Seitenwechsel und Anfragen kurz vor dem Fehler) sowie
          je Seitenaufruf ein anonymer Sitzungsvermerk (Start, abgestürzt ja/nein, Version, Browser), aus dem wir
          die Absturzrate berechnen. Berichte enthalten keine Videoinhalte und keine Kontodaten; IP-Adressen
          werden nicht gespeichert.
        </li>
      )}
      {ANALYTICS_ENABLED && (
        <li>
          <b>Reichweitenmessung</b> ohne Cookies: Seitenaufrufe und einzelne Aktionen (z. B. „Upload gestartet“,
          „Export fertig“), ohne Seitenparameter. Es werden keine Cookies gesetzt und keine Kennung in deinem
          Browser gespeichert; Besucher werden nur über einen täglich wechselnden Hashwert unterschieden, eine
          seitenübergreifende Verfolgung findet nicht statt.
        </li>
      )}
      {AUTH_ENABLED && (
        <>
          <li>
            <b>Dein Konto</b>: E-Mail-Adresse, Anmeldemethode und Sitzungsdaten, damit du dich anmelden und deine
            Projekte auf jedem Gerät finden kannst; deine Projektliste (Dateiname, Einstellungen, Daten) liegt mit
            deinem Konto auf unserem Server.
          </li>
          <li>
            <b>Tarif und Nutzung</b>: Wenn du einen Tarif kaufst, der Tarif, der Abostatus und der
            Abrechnungszeitraum, die wir von Lemon Squeezy erhalten, und wie viele Videominuten du je Zeitraum
            hochgeladen hast.
          </li>
        </>
      )}
    </Ul>
    <p className="mt-2">
      Rechtsgrundlagen: die Erbringung des von dir angeforderten Dienstes (Art. 6 Abs. 1 lit. b DSGVO)
      {AUTH_ENABLED && ", unsere gesetzlichen Aufbewahrungspflichten für Abrechnungsdaten (Art. 6 Abs. 1 lit. c DSGVO)"}{" "}
      und unser berechtigtes Interesse an einem sicheren, zuverlässigen Betrieb
      {(ERROR_REPORTING_ENABLED || ANALYTICS_ENABLED) && ", an der Fehleranalyse und an einer datensparsamen Reichweitenmessung"}{" "}
      (Art. 6 Abs. 1 lit. f DSGVO).
    </p>

    <H>3. Dienstleister (Auftragsverarbeiter)</H>
    <p className="mb-2">
      Für den Dienst setzen wir die folgenden Anbieter ein. Sie verarbeiten die Daten nur in unserem Auftrag und
      nach unseren Weisungen (Art. 28 DSGVO).
    </p>
    <Processors lang="de" />
    <p className="mt-2">{TRANSFER_BASIS.de}</p>
    {AUTH_ENABLED && (
      <p className="mt-2">
        <b>Zahlungen.</b> Bezahlte Tarife verkauft Lemon Squeezy (Lemon Squeezy LLC, USA) als „Merchant of
        Record“: Lemon Squeezy ist der Verkäufer deines Abos und verarbeitet deine Zahlungs- und
        Rechnungsdaten (Name, Anschrift, Zahlungsmittel, Steuerangaben) als eigener Verantwortlicher nach seiner
        eigenen Datenschutzerklärung. Wir erhalten deine E-Mail-Adresse, den Tarif und den Abostatus — nie deine
        Kartendaten.
      </p>
    )}

    <H>4. Speicherdauer</H>
    <p>
      {PLANS_LIVE
        ? `Hochgeladene Videos, Vorschauen, fertige Videos und Transkripte werden nach der letzten Änderung an einem Projekt automatisch gelöscht, je nach Tarif nach ${retentionPerPlan("de")}.`
        : `Während der Beta werden hochgeladene Videos, Vorschauen, fertige Videos und Transkripte ${BETA_RETENTION_DAYS} Tage nach der letzten Änderung an einem Projekt automatisch gelöscht.`}{" "}
      Du kannst ein Projekt jederzeit selbst löschen; es wird dann sofort von unseren Servern entfernt.{" "}
      {AUTH_ENABLED
        ? "Deine Projektliste liegt mit deinem Konto auf unserem Server und wird mit jedem Projekt gelöscht. Kontodaten bleiben gespeichert, bis du dein Konto löschst; Abo- und Nutzungsdaten, solange sie für die Abrechnung und die gesetzlichen Aufbewahrungsfristen nötig sind."
        : "Deine Projektliste liegt nur in deinem Browser (lokaler Speicher) und verschwindet, wenn du die Websitedaten löschst."}{" "}
      Die Verarbeitungsstatistik wird nach {EVENTS_KEEP_DAYS} Tagen gelöscht, Server-Logs nach der
      Aufbewahrungsfrist des jeweiligen Hosting-Anbieters.
    </p>

    <H>5. Stimmtest</H>
    <p>
      Der optionale Stimmtest nutzt die eingebaute Spracherkennung deines Browsers. Je nach Browser schickt der
      Browser deine Sprache dafür an Server seines Herstellers — in Chrome und anderen Chromium-Browsern an Google
      (Google LLC, USA), in Safari an Apple — nach dessen Bedingungen. Mikrofon (und, falls der Test sie
      anfragt, die Kamera) werden nur live in deinem Browser verwendet; CleoCuts erhält keine Aufnahme und
      speichert nichts davon. Du musst den Stimmtest nicht nutzen, um CleoCuts zu verwenden.
    </p>

    <H>6. Cookies und lokaler Speicher</H>
    <p>
      Wir verwenden keine Werbe- oder Tracking-Cookies. Der lokale Speicher deines Browsers hält deine
      Projektliste, deine Spracheinstellung und Angaben zum Fortsetzen unterbrochener Uploads auf deinem Gerät;
      das ist für den von dir genutzten Dienst erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG).
    </p>
    {AUTH_ENABLED && (
      <p className="mt-2">
        Die Anmeldung setzt technisch notwendige Cookies unseres Anmeldedienstes Clerk (etwa{" "}
        <code>__session</code> und <code>__client_uat</code>), die dich angemeldet halten. Sie werden nicht zum
        Tracking verwendet. Checkout und Kundenportal von Lemon Squeezy setzen beim Öffnen eigene Cookies.
      </p>
    )}

    <H>7. Keine automatisierten Entscheidungen</H>
    <p>
      Die KI-Schritte (Transkript, Schnitte, Untertitel) bereiten dein Video vor; du prüfst und änderst das
      Ergebnis im Editor. Eine automatisierte Entscheidung mit rechtlicher Wirkung für dich (Art. 22 DSGVO)
      findet nicht statt.
    </p>

    <H>8. Deine Rechte</H>
    <p>
      Du hast das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung
      der Verarbeitung (Art. 18) und Datenübertragbarkeit (Art. 20). Einer Verarbeitung auf Grundlage unseres
      berechtigten Interesses kannst du jederzeit widersprechen (Art. 21). Außerdem kannst du dich bei einer
      Datenschutz-Aufsichtsbehörde beschweren (Art. 77), insbesondere in dem Mitgliedstaat deines Aufenthaltsorts.
      Kontakt: <Mail address={OPERATOR.email} />
    </p>

    <H>9. Änderungen</H>
    <p>
      Wir passen diese Erklärung an, wenn sich der Dienst oder die Rechtslage ändert. Es gilt die jeweils hier
      veröffentlichte Fassung.
    </p>
  </>
);

const English = (
  <>
    <LegalTitle lang="en" title="Privacy policy" draft={LEGAL_DRAFT.privacy} />

    <H>1. Controller</H>
    <Controller lang="en" />

    <H>2. What we process and why</H>
    <Ul>
      <li>
        <b>Videos you upload</b> (image and audio), to cut them, create a transcript and captions, and render the
        finished video.
      </li>
      <li>
        <b>Transcript and edits</b> you make in the editor (cuts, effects, caption text).
      </li>
      <li>
        <b>Technical data</b> needed to run the service: IP address, browser and time of requests (server logs),
        and processing statistics per job (start, end, duration, error code — no content) that we use to measure
        reliability.
      </li>
      <li>
        <b>Voice test</b> (optional): see section 5.
      </li>
      {ERROR_REPORTING_ENABLED && (
        <li>
          <b>Error reports</b>: if the website fails in your browser or our server fails while processing your
          video, a technical report (the error message, the page address without parameters, browser, operating
          system, language and time zone, the clicks, page changes and requests just before the error), plus one
          anonymous session record per page load (started, crashed or not, version, browser) from which we
          compute the crash rate. Reports contain no video content and no account data; IP addresses are not
          stored.
        </li>
      )}
      {ANALYTICS_ENABLED && (
        <li>
          <b>Usage statistics</b> without cookies: page views and single actions (such as “upload started”,
          “export done”), without page parameters. No cookies are set and no identifier is stored in your
          browser; visitors are only told apart by a hash that changes daily, and nothing tracks you across
          sites.
        </li>
      )}
      {AUTH_ENABLED && (
        <>
          <li>
            <b>Your account</b>: e-mail address, sign-in method and session data, so you can sign in and find your
            projects on every device; your list of projects (file name, settings, dates) is stored with your
            account on our server.
          </li>
          <li>
            <b>Plan and usage</b>: if you buy a plan, the plan, subscription status and billing period we receive
            from Lemon Squeezy, and how many minutes of video you uploaded in each period.
          </li>
        </>
      )}
    </Ul>
    <p className="mt-2">
      Legal bases: performance of the service you request (Art. 6(1)(b) GDPR)
      {AUTH_ENABLED && ", our legal obligations to keep billing records (Art. 6(1)(c) GDPR)"} and our legitimate
      interest in operating it securely and reliably
      {(ERROR_REPORTING_ENABLED || ANALYTICS_ENABLED) && ", in analysing errors and in privacy-friendly usage statistics"}{" "}
      (Art. 6(1)(f) GDPR).
    </p>

    <H>3. Service providers (processors)</H>
    <p className="mb-2">
      We use the following providers to run the service. They process data only on our behalf and on our
      instructions (Art. 28 GDPR).
    </p>
    <Processors lang="en" />
    <p className="mt-2">{TRANSFER_BASIS.en}</p>
    {AUTH_ENABLED && (
      <p className="mt-2">
        <b>Payments.</b> Paid plans are sold by Lemon Squeezy (Lemon Squeezy LLC, USA) as Merchant of Record:
        Lemon Squeezy is the seller of your subscription and processes your payment and billing data (name,
        address, payment method, tax details) as an independent controller under its own privacy policy. We
        receive your e-mail address, the plan and the subscription status — never your card details.
      </p>
    )}

    <H>4. Storage period</H>
    <p>
      {PLANS_LIVE
        ? `Uploaded videos, previews, finished videos and transcripts are deleted automatically after the last change to a project, depending on your plan: ${retentionPerPlan("en")}.`
        : `During the beta, uploaded videos, previews, finished videos and transcripts are deleted automatically ${BETA_RETENTION_DAYS} days after the last change to a project.`}{" "}
      You can delete a project yourself at any time; it is then removed from our servers immediately.{" "}
      {AUTH_ENABLED
        ? "Your list of projects is stored with your account and removed together with each project. Account data is kept until you delete your account; records of subscriptions and usage are kept as long as needed for billing and the statutory retention periods."
        : "Your list of projects is stored only in your browser (local storage) and can be removed by clearing the site data."}{" "}
      The processing statistics are deleted after {EVENTS_KEEP_DAYS} days, server logs after the hosting
      provider's log retention period.
    </p>

    <H>5. Voice test</H>
    <p>
      The optional voice test uses your browser&apos;s built-in speech recognition. Depending on the browser, it
      sends your speech to its maker&apos;s servers for that — in Chrome and other Chromium browsers to Google
      (Google LLC, USA), in Safari to Apple — under their terms. The microphone (and the camera, if the test asks
      for it) is used live in your browser only; CleoCuts receives no recording and stores nothing of it. You
      don&apos;t need the voice test to use CleoCuts.
    </p>

    <H>6. Cookies and local storage</H>
    <p>
      We use no advertising or tracking cookies. Your browser&apos;s local storage keeps your list of projects,
      your language setting and what is needed to resume an interrupted upload on your device; this is required
      for the service you use (§ 25(2) no. 2 TDDDG).
    </p>
    {AUTH_ENABLED && (
      <p className="mt-2">
        Signing in sets strictly necessary cookies of our sign-in provider Clerk (such as <code>__session</code>{" "}
        and <code>__client_uat</code>) that keep you signed in. They are not used for tracking. The Lemon Squeezy
        checkout and customer portal set their own cookies when you open them.
      </p>
    )}

    <H>7. No automated decisions</H>
    <p>
      The AI steps (transcript, cuts, captions) prepare your video; you review and change the result in the
      editor. No automated decision with legal effect on you (Art. 22 GDPR) is made.
    </p>

    <H>8. Your rights</H>
    <p>
      You have the right to access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction of
      processing (Art. 18) and data portability (Art. 20). You can object at any time to processing based on our
      legitimate interest (Art. 21). You can also lodge a complaint with a data protection supervisory authority
      (Art. 77), in particular in the member state where you live. Contact: <Mail address={OPERATOR.email} />
    </p>

    <H>9. Changes</H>
    <p>
      We update this policy when the service or the law changes. The version published here applies.
    </p>
  </>
);

export default function PrivacyPage() {
  return <LegalPage de={German} en={English} />;
}
