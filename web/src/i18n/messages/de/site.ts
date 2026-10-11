import type { SiteKey } from "../en";

export const deSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "CleoCuts Startseite",
  "site.header.openEditor": "Editor öffnen",

  "site.footer.editor": "Editor",
  "site.footer.library": "Bibliothek",
  "site.footer.imprint": "Impressum",
  "site.footer.privacy": "Datenschutz",
  "site.footer.terms": "AGB",
  "site.footer.pricing": "Preise",

  /* ── Pricing page ── */
  "site.pricing.title": "Einfache Preise",
  "site.pricing.subtitle": "Du zahlst monatlich für die Videominuten, die du hochlädst. Jederzeit kündbar.",
  "site.pricing.perMonth": "/ Monat",
  "site.pricing.perYear": "/ Jahr",
  "site.pricing.priceAtCheckout": "Preis wird beim Checkout angezeigt",
  "site.pricing.popular": "Am beliebtesten",
  "site.pricing.minutes": "{minutes} Min. Video pro Monat",
  "site.pricing.retention": "Projekte werden {days} Tage gespeichert",
  "site.pricing.featureWorkflows": "Alle Workflows und Untertitel-Stile",
  "site.pricing.featureVoice": "Sprachbefehle und KI-Bereinigung",
  "site.pricing.choose": "{plan} wählen",
  "site.pricing.current": "Dein aktueller Tarif",
  "site.pricing.manage": "Abo verwalten",
  "site.pricing.switch": "Zu {plan} wechseln",
  "site.pricing.unavailable": "Noch nicht verfügbar",
  "site.pricing.redirecting": "Checkout wird geöffnet…",
  "site.pricing.checkoutFailed": "Der Checkout konnte nicht geöffnet werden. Bitte versuch's gleich noch mal.",
  "site.pricing.loadFailed": "Die Tarife konnten nicht geladen werden. Bitte versuch's gleich noch mal.",
  "site.pricing.minutesHint":
    "Gezählt wird die Länge der Videos, die du hochlädst. Nicht genutzte Minuten werden nicht in den nächsten Monat übernommen.",
  "site.pricing.vatNote":
    "Preise inkl. MwSt. Die Zahlung wickelt Lemon Squeezy als unser Merchant of Record ab — sie buchen den Betrag ab und schicken dir deine Rechnungen.",
  "site.pricing.testMode": "Testmodus — keine echten Zahlungen",
  "site.pricing.testersOnly": "Pläne können noch nicht gekauft werden — der Checkout ist im Testmodus und nur für eingeladene Tester.",
  "site.pricing.betaTitle": "Kostenlos während der offenen Beta",
  "site.pricing.betaBody": "CleoCuts ist kostenlos, solange wir in der Beta sind. Bezahlte Tarife mit mehr Minuten kommen bald.",

  "library.header.homeAria": "CleoCuts Editor",
  "library.header.title": "Bibliothek",
  "library.header.newProject": "Neues Projekt",

  "library.count.one": "{count} Projekt",
  "library.count.other": "{count} Projekte",
  "library.confirmDelete": "Dieses Projekt endgültig löschen? Das Video und alle Änderungen werden von unseren Servern entfernt.",
  "library.deleteFailed": "Löschen gerade nicht möglich – falls das Video noch verarbeitet wird, versuch es gleich nochmal.",

  "library.empty.title": "Deine Bibliothek ist leer",
  "library.empty.body":
    "Jedes fertige Video erscheint hier. Du kannst es jederzeit erneut herunterladen, deine Untertitel holen und Hook-Clips teilen.",
  "library.empty.cta": "Starte dein erstes Projekt",

  "library.card.playAria": "Vorschau von {name} abspielen",
  "library.card.noPreview": "keine Vorschau",
  "library.card.customPreset": "Benutzerdefiniert",
  "library.card.deleteAria": "Projekt löschen",
  "library.card.expiresDays": "Wird in {n} Tagen automatisch gelöscht",
  "library.card.expiresSoon": "Wird innerhalb von 24 Stunden gelöscht",
  "library.card.expired": "Abgelaufen – Dateien wurden gelöscht",
  "library.card.hooks.one": "{count} Hook",
  "library.card.hooks.other": "{count} Hooks",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Beschreibung",
  "library.card.copy": "kopieren",
  "library.card.copied": "kopiert",

  "library.format.primary": "Hauptschnitt",
  "library.format.hook": "Hook-Clip {n}",

  "library.time.justNow": "gerade jetzt",
  "library.time.minutesAgo": "vor {n} Min.",
  "library.time.hoursAgo": "vor {n} Std.",
  "library.time.daysAgo": "vor {n} Tg.",

  "common.videoModal.closeAria": "Vorschau schließen",
  "common.videoModal.close": "Schließen",
  "common.videoModal.dialogLabel": "Videovorschau",

  /* ── Accounts (header, all pages) ── */
  "common.auth.signIn": "Anmelden",
  "common.auth.account": "Konto",
  "common.auth.pricing": "Preise",
  "common.language": "Sprache",
  "common.footer.legalAria": "Rechtliches",
  "legal.onlyDeEn":
    "Diese Seite gibt es nur auf Deutsch und Englisch. Du liest die englische Fassung.",
  "common.backHome": "Zur Startseite",
  "common.notFound.title": "Seite nicht gefunden",
  "common.notFound.body": "Diese Seite gibt es nicht oder sie ist umgezogen.",
  "common.error.title": "Etwas ist schiefgelaufen",
  "common.error.body": "Diese Seite konnte nicht angezeigt werden. Bitte versuch es noch einmal.",
  "common.error.retry": "Erneut versuchen",
  "common.error.ref": "Fehlerkennung: {id}",
};
