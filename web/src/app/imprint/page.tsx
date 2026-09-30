import type { Metadata } from "next";
import { H, LegalPage, LegalTitle, Mail } from "@/components/legal/LegalPage";
import { LEGAL_DRAFT, OPERATOR } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Imprint – Impressum",
  description: "Legal notice (Impressum) of CleoCuts: operator, address and contact.",
};

// The operator data lives in lib/legal.ts (one place to fill in).
function Address({ lang }: { lang: "de" | "en" }) {
  const o = OPERATOR;
  return (
    <p>
      {o.name}
      {o.representative && (
        <>
          <br />
          {lang === "de" ? "Vertreten durch" : "Represented by"}: {o.representative}
        </>
      )}
      <br />
      {o.street}
      <br />
      {o.postcode} {o.city}
      <br />
      {o.country[lang]}
    </p>
  );
}

function Contact({ lang }: { lang: "de" | "en" }) {
  return (
    <p>
      {lang === "de" ? "E-Mail" : "E-mail"}: <Mail address={OPERATOR.email} />
      {OPERATOR.phone && (
        <>
          <br />
          {lang === "de" ? "Telefon" : "Phone"}: {OPERATOR.phone}
        </>
      )}
    </p>
  );
}

const German = (
  <>
    <LegalTitle lang="de" title="Impressum" subtitle="Angaben gemäß § 5 DDG" draft={LEGAL_DRAFT.imprint} />
    <H>Anbieter</H>
    <Address lang="de" />
    <H>Kontakt</H>
    <Contact lang="de" />
    {OPERATOR.register && (
      <>
        <H>Registereintrag</H>
        <p>{OPERATOR.register}</p>
      </>
    )}
    {OPERATOR.vatId && (
      <>
        <H>Umsatzsteuer-Identifikationsnummer</H>
        <p>USt-IdNr. gemäß § 27a Umsatzsteuergesetz: {OPERATOR.vatId}</p>
      </>
    )}
    <H>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</H>
    <p>{OPERATOR.name}, Anschrift wie oben.</p>
    <H>Verbraucherstreitbeilegung</H>
    <p>
      Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer
      Verbraucherschlichtungsstelle teilzunehmen.
    </p>
  </>
);

const English = (
  <>
    <LegalTitle
      lang="en"
      title="Imprint"
      subtitle="Legal notice (Impressum) under § 5 of the German Digital Services Act (DDG)"
      draft={LEGAL_DRAFT.imprint}
    />
    <H>Operator</H>
    <Address lang="en" />
    <H>Contact</H>
    <Contact lang="en" />
    {OPERATOR.register && (
      <>
        <H>Commercial register</H>
        <p>{OPERATOR.register}</p>
      </>
    )}
    {OPERATOR.vatId && (
      <>
        <H>VAT ID</H>
        <p>VAT identification number under § 27a of the German VAT Act: {OPERATOR.vatId}</p>
      </>
    )}
    <H>Responsible for the content under § 18(2) MStV</H>
    <p>{OPERATOR.name}, address as above.</p>
    <H>Consumer dispute resolution</H>
    <p>
      We are neither willing nor obliged to take part in dispute resolution proceedings before a consumer
      arbitration board.
    </p>
  </>
);

export default function ImprintPage() {
  return <LegalPage de={German} en={English} />;
}
