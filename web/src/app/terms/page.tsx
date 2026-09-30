import type { Metadata } from "next";
import Link from "next/link";
import { H, LegalPage, LegalTitle, Mail, Ul } from "@/components/legal/LegalPage";
import { BETA_RETENTION_DAYS, LEGAL_DRAFT, OPERATOR, RETENTION_DAYS } from "@/lib/legal";
import { BILLING_COPY } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Terms – Nutzungsbedingungen",
  description: "Terms of service of CleoCuts (beta): your content and our rights to process it, prohibited content, plans, cancellation and refunds.",
};

/*
 * Beta terms. TODO(owner/lawyer): review before selling plans (consumer
 * law, the right of withdrawal for digital services, liability, minimum
 * age) and keep them consistent with Lemon Squeezy's buyer terms — Lemon
 * Squeezy is the seller (Merchant of Record) of every subscription.
 * No voluntary money-back guarantee (owner decision 5): never promise
 * one here.
 */

const PLANS_LIVE = BILLING_COPY;

const retention = (lang: "de" | "en") =>
  PLANS_LIVE
    ? Object.entries(RETENTION_DAYS)
        .map(([plan, days]) => (lang === "de" ? `${days} Tage (${plan})` : `${days} days (${plan})`))
        .join(", ")
    : lang === "de"
      ? `${BETA_RETENTION_DAYS} Tage während der Beta`
      : `${BETA_RETENTION_DAYS} days during the beta`;

const German = (
  <>
    <LegalTitle lang="de" title="Nutzungsbedingungen" subtitle="Beta-Fassung" draft={LEGAL_DRAFT.terms} />

    <H>1. Geltungsbereich</H>
    <p>
      Diese Bedingungen gelten für die Nutzung von CleoCuts (cleocuts.com), betrieben von {OPERATOR.name} (Angaben
      im <Link href="/imprint" className="underline underline-offset-2">Impressum</Link>). Abweichende Bedingungen
      von Nutzern gelten nicht. CleoCuts befindet sich in einer offenen Beta.
    </p>

    <H>2. Der Dienst</H>
    <p>
      CleoCuts bearbeitet Videos, die du hochlädst: Es erkennt die Sprache, entfernt Pausen, Füllwörter und
      verpatzte Takes, fügt Untertitel hinzu und rendert das Ergebnis. Die Ergebnisse entstehen automatisch mit
      KI und können Fehler enthalten — bitte prüfe sie vor dem Veröffentlichen. Während der Beta können sich
      Funktionen ändern und der Dienst kann zeitweise nicht verfügbar sein; einen Anspruch auf eine bestimmte
      Verfügbarkeit gibt es nicht.
    </p>

    <H>3. Mindestalter und Konto</H>
    <p>
      Du musst mindestens 16 Jahre alt sein. Bist du jünger, darfst du CleoCuts nur mit Zustimmung deiner Eltern
      oder anderer Erziehungsberechtigter nutzen. Wenn du ein Konto anlegst, halte deine Zugangsdaten geheim; du
      bist für die Nutzung unter deinem Konto verantwortlich. Ein Konto ist persönlich und darf nicht geteilt
      werden. Du kannst es jederzeit löschen.
    </p>

    <H>4. Deine Inhalte und unser Recht, sie zu verarbeiten</H>
    <p>
      Alle Rechte an deinen Videos bleiben bei dir. Du räumst uns das einfache, auf die Dauer der Speicherung
      beschränkte Recht ein, deine Inhalte zu speichern, zu vervielfältigen, zu bearbeiten (schneiden,
      transkribieren, untertiteln, umwandeln) und dir bereitzustellen — ausschließlich, um den Dienst für dich zu
      erbringen, auch durch unsere Dienstleister (siehe{" "}
      <Link href="/privacy" className="underline underline-offset-2">Datenschutzerklärung</Link>). Wir
      veröffentlichen deine Inhalte nicht und nutzen sie nicht zu Werbezwecken.
    </p>

    <H>5. Deine Zusicherungen</H>
    <p>
      Du lädst nur Inhalte hoch, an denen du die nötigen Rechte hast. Insbesondere sicherst du zu, dass alle
      Personen, die in deinen Videos zu sehen oder zu hören sind (Gesicht, Stimme), mit der Aufnahme und ihrer
      Bearbeitung einverstanden sind, und dass du die Rechte an verwendeter Musik und an sonstigem Material
      Dritter besitzt. Verletzt du diese Zusicherungen schuldhaft, stellst du uns von daraus folgenden Ansprüchen
      Dritter frei.
    </p>

    <H>6. Verbotene Inhalte und Nutzung</H>
    <p className="mb-2">Nicht erlaubt sind insbesondere Inhalte, die</p>
    <Ul>
      <li>gegen geltendes Recht verstoßen oder Rechte Dritter verletzen (etwa Urheber-, Marken- oder Persönlichkeitsrechte);</li>
      <li>sexuelle Darstellungen von Minderjährigen, nicht einvernehmliche intime Aufnahmen oder pornografische Inhalte enthalten;</li>
      <li>Gewalt verherrlichen, zu Hass oder Gewalt aufrufen oder Menschen wegen geschützter Merkmale herabwürdigen;</li>
      <li>Terrorismus unterstützen oder verfassungswidrige Kennzeichen verbreiten;</li>
      <li>andere belästigen, bedrohen oder private Daten Dritter offenlegen;</li>
      <li>echte Personen ohne deren Einwilligung täuschend echt nachahmen (Deepfakes).</li>
    </Ul>
    <p className="mt-2">
      Ebenso verboten ist es, den Dienst zu stören oder zu überlasten, Limits zu umgehen, Schadsoftware
      hochzuladen oder den Dienst ohne unsere Erlaubnis automatisiert zu nutzen. Bei Verstößen dürfen wir Inhalte
      löschen und den Zugang sperren.
    </p>

    <H>7. Speicherung</H>
    <p>
      Projekte werden nach der letzten Änderung automatisch gelöscht: {retention("de")}. Lade deine Ergebnisse
      rechtzeitig herunter — gelöschte Projekte können nicht wiederhergestellt werden.
    </p>

    <H>8. Tarife und Zahlung</H>
    {!PLANS_LIVE && (
      <p className="mb-2">
        Während der offenen Beta ist CleoCuts kostenlos. Bevor du einen bezahlten Tarif kaufen kannst, siehst du
        Preis und Leistung auf der Preisseite; für bezahlte Tarife gilt dann:
      </p>
    )}
    <Ul>
      <li>
        Bezahlte Tarife sind Monatsabos, die <b>Lemon Squeezy</b> als „Merchant of Record“ verkauft: Lemon Squeezy
        ist der Verkäufer, bucht den Betrag ab, führt die Steuern ab und stellt die Rechnungen aus. Für den Kauf
        gelten zusätzlich die Käuferbedingungen von Lemon Squeezy.
      </li>
      <li>
        Jeder Tarif enthält Videominuten pro Abrechnungsmonat, gezählt nach der Länge der hochgeladenen Videos.
        Nicht genutzte Minuten verfallen am Ende des Monats. Ein Video, das länger ist als deine restlichen Minuten,
        kann erst im nächsten Zeitraum oder nach einem Upgrade hochgeladen werden.
      </li>
      <li>
        Scheitert die Verarbeitung aus einem technischen Grund auf unserer Seite, oder enthält ein Video keine oder
        kaum Sprache (weniger als 10 Sekunden), werden die Minuten automatisch gutgeschrieben.
      </li>
      <li>Preise enthalten die gesetzliche Umsatzsteuer, soweit sie anfällt.</li>
    </Ul>

    <H>9. Kündigung</H>
    <p>
      Du kannst dein Abo jederzeit im Kundenportal von Lemon Squeezy (erreichbar über dein Konto) kündigen. Die
      Kündigung wird zum Ende des bezahlten Abrechnungszeitraums wirksam; bis dahin kannst du CleoCuts weiter
      nutzen. Die Nutzung ohne Abo kannst du jederzeit beenden und deine Projekte löschen. Wir können die Nutzung
      mit einer Frist von 30 Tagen beenden, bei schweren Verstößen gegen die Abschnitte 5 oder 6 auch fristlos.
    </p>

    <H>10. Widerrufsrecht und Erstattungen</H>
    <p>
      Eine freiwillige Geld-zurück-Garantie bieten wir nicht an. Als Verbraucher hast du gegebenenfalls ein
      gesetzliches Widerrufsrecht. Da Lemon Squeezy der Verkäufer ist, informiert dich Lemon Squeezy beim Kauf
      über dieses Recht und wickelt einen Widerruf ab; maßgeblich sind die dort bereitgestellten Informationen und
      die Käuferbedingungen von Lemon Squeezy. Bei digitalen Leistungen kann das Widerrufsrecht vorzeitig
      erlöschen, wenn du ausdrücklich zustimmst, dass die Leistung vor Ablauf der Widerrufsfrist beginnt, und
      bestätigst, dass du dein Widerrufsrecht damit verlierst (§ 356 Abs. 4 und 5 BGB).
    </p>

    <H>11. Haftung</H>
    <p>
      Wir haften unbeschränkt für Vorsatz und grobe Fahrlässigkeit sowie für Schäden aus der Verletzung von
      Leben, Körper oder Gesundheit. Bei leichter Fahrlässigkeit haften wir nur für die Verletzung wesentlicher
      Vertragspflichten und begrenzt auf den typischen, vorhersehbaren Schaden. Die Haftung nach dem
      Produkthaftungsgesetz bleibt unberührt.
    </p>

    <H>12. Änderungen</H>
    <p>
      Wir können diese Bedingungen mit angemessener Ankündigung ändern (etwa per E-Mail). Bist du nicht
      einverstanden, kannst du vor Wirksamwerden der Änderung kündigen.
    </p>

    <H>13. Schlussbestimmungen</H>
    <p>
      Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts; zwingende Verbraucherschutzvorschriften des
      Staates, in dem du lebst, bleiben unberührt. Kontakt: <Mail address={OPERATOR.email} />
    </p>
  </>
);

const English = (
  <>
    <LegalTitle lang="en" title="Terms of service" subtitle="Beta version" draft={LEGAL_DRAFT.terms} />

    <H>1. Scope</H>
    <p>
      These terms apply to the use of CleoCuts (cleocuts.com), operated by {OPERATOR.name} (details in the{" "}
      <Link href="/imprint" className="underline underline-offset-2">imprint</Link>). Different terms of users do
      not apply. CleoCuts is in an open beta.
    </p>

    <H>2. The service</H>
    <p>
      CleoCuts edits videos you upload: it recognises the speech, removes pauses, filler words and failed takes,
      adds captions and renders the result. Results are produced automatically with AI and may contain mistakes
      — please check them before publishing. During the beta, features may change and the service may be
      unavailable at times; there is no claim to a particular availability.
    </p>

    <H>3. Minimum age and account</H>
    <p>
      You must be at least 16 years old. If you are younger, you may use CleoCuts only with the consent of your
      parents or other legal guardians. If you create an account, keep your sign-in details confidential; you are
      responsible for activity under your account. An account is personal and may not be shared. You can delete
      it at any time.
    </p>

    <H>4. Your content and our right to process it</H>
    <p>
      You keep all rights to your videos. You grant us the simple (non-exclusive) right, limited to the time we
      store them, to store, copy, edit (cut, transcribe, caption, convert) and provide your content to you — only
      to provide the service to you, including through our service providers (see the{" "}
      <Link href="/privacy" className="underline underline-offset-2">privacy policy</Link>). We do not publish
      your content and do not use it for advertising.
    </p>

    <H>5. Your assurances</H>
    <p>
      You only upload content you have the necessary rights to. In particular, you assure that every person who
      can be seen or heard in your videos (face, voice) has agreed to the recording and to its editing, and that
      you hold the rights to any music and other third-party material you use. If you culpably breach these
      assurances, you indemnify us against the resulting claims of third parties.
    </p>

    <H>6. Prohibited content and use</H>
    <p className="mb-2">In particular, content is not allowed that</p>
    <Ul>
      <li>breaks the law or infringes the rights of others (such as copyright, trademarks or personality rights);</li>
      <li>contains sexual depictions of minors, non-consensual intimate imagery or pornographic content;</li>
      <li>glorifies violence, incites hatred or violence, or degrades people for protected characteristics;</li>
      <li>supports terrorism or spreads unconstitutional symbols;</li>
      <li>harasses or threatens others or discloses private data of third parties;</li>
      <li>deceptively imitates real people without their consent (deepfakes).</li>
    </Ul>
    <p className="mt-2">
      It is also prohibited to disrupt or overload the service, circumvent limits, upload malware or use the
      service in an automated way without our permission. In case of violations we may delete content and block
      access.
    </p>

    <H>7. Storage</H>
    <p>
      Projects are deleted automatically after their last change: {retention("en")}. Download your results in
      time — deleted projects cannot be restored.
    </p>

    <H>8. Plans and payment</H>
    {!PLANS_LIVE && (
      <p className="mb-2">
        CleoCuts is free during the open beta. Before you can buy a paid plan, you see its price and what it
        includes on the pricing page; paid plans are then subject to the following:
      </p>
    )}
    <Ul>
      <li>
        {/* Explicit space: the compiler drops it before a multi-line text
            with an entity in it ("Lemon Squeezyas"). */}
        Paid plans are monthly subscriptions sold by <b>Lemon Squeezy</b>{" "}
        as Merchant of Record: Lemon Squeezy is the seller, charges you, handles taxes and issues your invoices.
        Lemon Squeezy&apos;s buyer terms also apply to the purchase.
      </li>
      <li>
        Each plan includes minutes of video per billing month, counted by the length of the videos you upload.
        Unused minutes expire at the end of the month. A video longer than your remaining minutes can only be
        uploaded in the next period or after an upgrade.
      </li>
      <li>
        If processing fails for a technical reason on our side, or a video contains no or hardly any speech (less
        than 10 seconds), the minutes are credited back automatically.
      </li>
      <li>Prices include statutory VAT where applicable.</li>
    </Ul>

    <H>9. Cancellation</H>
    <p>
      You can cancel your subscription at any time in the Lemon Squeezy customer portal (reachable from your
      account). The cancellation takes effect at the end of the paid billing period; until then you can keep using
      CleoCuts. Without a subscription you can stop using the service and delete your projects at any time. We may
      end your use with 30 days&apos; notice, or without notice for serious violations of sections 5 or 6.
    </p>

    <H>10. Right of withdrawal and refunds</H>
    <p>
      We do not offer a voluntary money-back guarantee. As a consumer you may have a statutory right of
      withdrawal. Because Lemon Squeezy is the seller, Lemon Squeezy informs you about this right at checkout and
      handles a withdrawal; the information provided there and Lemon Squeezy&apos;s buyer terms apply. For digital
      services the right of withdrawal can expire early if you expressly agree that the service starts before the
      withdrawal period ends and acknowledge that you thereby lose your right of withdrawal (§ 356(4) and (5) of
      the German Civil Code).
    </p>

    <H>11. Liability</H>
    <p>
      We are liable without limitation for intent and gross negligence and for injury to life, body or health.
      For slight negligence we are only liable for breach of essential contractual obligations, limited to the
      typical, foreseeable damage. Liability under the Product Liability Act remains unaffected.
    </p>

    <H>12. Changes</H>
    <p>
      We may change these terms with reasonable notice (for example by e-mail). If you do not agree, you can
      cancel before the change takes effect.
    </p>

    <H>13. Final provisions</H>
    <p>
      German law applies, excluding the UN Convention on Contracts for the International Sale of Goods; mandatory
      consumer protection rules of the country where you live remain unaffected. Contact:{" "}
      <Mail address={OPERATOR.email} />
    </p>
  </>
);

// Always available — the beta takes uploads without accounts too.
export default function TermsPage() {
  return <LegalPage de={German} en={English} />;
}
