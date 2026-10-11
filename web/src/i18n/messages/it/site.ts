import type { SiteKey } from "../en";

export const itSite: Partial<Record<SiteKey, string>> = {
  // ── Landing: header ── */
  "site.header.homeAria": "Home di CleoCuts",
  "site.header.openEditor": "Apri l'editor",

  "site.footer.editor": "Editor",
  "site.footer.library": "Libreria",
  "site.footer.imprint": "Note legali",
  "site.footer.privacy": "Privacy",
  "site.footer.terms": "Termini",
  "site.footer.pricing": "Prezzi",

  // ── Pricing page ── */
  "site.pricing.title": "Prezzi semplici",
  "site.pricing.subtitle": "Paghi ogni mese per i minuti di video che carichi. Disdici quando vuoi.",
  "site.pricing.perMonth": "/ mese",
  "site.pricing.perYear": "/ anno",
  "site.pricing.priceAtCheckout": "Prezzo mostrato al checkout",
  "site.pricing.popular": "Il più scelto",
  "site.pricing.minutes": "{minutes} min di video al mese",
  "site.pricing.retention": "Progetti conservati per {days} giorni",
  "site.pricing.featureWorkflows": "Tutti i workflow e gli stili di sottotitoli",
  "site.pricing.featureVoice": "Comandi vocali e pulizia AI",
  "site.pricing.choose": "Scegli {plan}",
  "site.pricing.current": "Il tuo piano attuale",
  "site.pricing.manage": "Gestisci abbonamento",
  "site.pricing.switch": "Passa a {plan}",
  "site.pricing.unavailable": "Non ancora disponibile",
  "site.pricing.redirecting": "Apertura del checkout…",
  "site.pricing.checkoutFailed": "Impossibile aprire il checkout. Riprova tra un momento.",
  "site.pricing.loadFailed": "Impossibile caricare i piani. Riprova tra un momento.",
  "site.pricing.minutesHint":
    "I minuti corrispondono alla durata dei video che carichi. I minuti non usati non passano al mese successivo.",
  "site.pricing.vatNote":
    "I prezzi includono l'IVA. I pagamenti sono gestiti da Lemon Squeezy, il nostro Merchant of Record — ti addebita l'importo e ti invia le fatture.",
  "site.pricing.testMode": "Modalità test — nessun pagamento reale",
  "site.pricing.testersOnly": "I piani non si possono ancora acquistare: il checkout è in modalità test, solo per i tester invitati.",
  "site.pricing.betaTitle": "Gratis durante la beta aperta",
  "site.pricing.betaBody": "CleoCuts è gratis finché siamo in beta. I piani a pagamento con più minuti arriveranno presto.",

  // ── Library: header ── */
  "library.header.homeAria": "Editor di CleoCuts",
  "library.header.title": "Libreria",
  "library.header.newProject": "Nuovo progetto",

  // ── Library: list ── */
  "library.count.one": "{count} progetto",
  "library.count.other": "{count} progetti",
  "library.confirmDelete": "Eliminare definitivamente questo progetto? Il video e tutte le modifiche vengono rimossi dai nostri server.",
  "library.deleteFailed": "Impossibile eliminare ora — se il video è ancora in elaborazione, riprova tra un attimo.",

  // ── Library: empty state ── */
  "library.empty.title": "La tua libreria è vuota",
  "library.empty.body":
    "Ogni video che completi appare qui. Puoi riscaricarlo, prendere i sottotitoli e condividere le clip hook in qualsiasi momento.",
  "library.empty.cta": "Inizia il tuo primo progetto",

  // ── Library: project card ── */
  "library.card.playAria": "Riproduci anteprima di {name}",
  "library.card.noPreview": "nessuna anteprima",
  "library.card.customPreset": "Personalizzato",
  "library.card.deleteAria": "Elimina progetto",
  "library.card.expiresDays": "Eliminazione automatica tra {n} giorni",
  "library.card.expiresSoon": "Eliminazione entro 24 ore",
  "library.card.expired": "Scaduto — i file sono stati eliminati",
  "library.card.hooks.one": "{count} hook",
  "library.card.hooks.other": "{count} hook",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Caption",
  "library.card.copy": "copia",
  "library.card.copied": "copiato",

  // ── Library: download labels ── */
  "library.format.primary": "Montaggio principale",
  "library.format.hook": "Clip hook {n}",

  // ── Library: relative time ── */
  "library.time.justNow": "proprio ora",
  "library.time.minutesAgo": "{n}m fa",
  "library.time.hoursAgo": "{n}h fa",
  "library.time.daysAgo": "{n}g fa",

  // ── Shared components ── */
  "common.videoModal.closeAria": "Chiudi anteprima",
  "common.videoModal.close": "Chiudi",
  "common.videoModal.dialogLabel": "Anteprima del video",

  // ── Accounts (header, all pages) ── */
  "common.auth.signIn": "Accedi",
  "common.auth.account": "Account",
  "common.auth.pricing": "Prezzi",
  "common.language": "Lingua",
  "common.footer.legalAria": "Note legali",
  "legal.onlyDeEn":
    "Questa pagina è disponibile solo in tedesco e in inglese. Stai leggendo la versione inglese.",
  "common.backHome": "Torna alla home",
  "common.notFound.title": "Pagina non trovata",
  "common.notFound.body": "Questa pagina non esiste o è stata spostata.",
  "common.error.title": "Qualcosa è andato storto",
  "common.error.body": "Impossibile mostrare questa pagina. Riprova.",
  "common.error.retry": "Riprova",
  "common.error.ref": "Riferimento errore: {id}",
};
