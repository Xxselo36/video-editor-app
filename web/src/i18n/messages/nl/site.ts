import type { SiteKey } from "../en";

export const nlSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "CleoCuts home",
  "site.header.openEditor": "Editor openen",

  "site.hero.badge": "Open beta · gratis",
  "site.hero.badgePricing": "Bekijk abonnementen & prijzen",
  "site.hero.titleLead": "Monteer terwijl je",
  "site.hero.titleAccent": "opneemt.",
  "site.hero.sub":
    "Zeg {cut} als je een fout maakt. Zeg {finish} als je klaar bent. Binnen een paar minuten klaar om te posten, met ondertitels en montage.",
  "site.hero.cta": "Probeer CleoCuts",

  "site.showcase.listening": "CleoCuts luistert",
  "site.showcase.captionStyle": "ondertitelstijl",
  "site.showcase.clipper": "SPRAAK IS DE EDITOR",
  "site.showcase.highlight": "KLAAR OM TE POSTEN",
  "site.showcase.flash": "ZEG CUT",
  "site.showcase.punch": "PERFECT GEDAAN",
  "site.showcase.elegant": "Het luistert gewoon.",

  "site.features.title": "Wat CleoCuts doet.",
  "site.features.voice.title": "Spraakcommando's",
  "site.features.voice.body": "Zeg {cut} midden in je take. CleoCuts verwijdert de mislukte poging.",
  "site.features.cleanup.title": "AI-opschoning",
  "site.features.cleanup.body":
    "Corrigeert verkeerd verstane woorden en merknamen in je ondertitels.",
  "site.features.captions.title": "Geanimeerde ondertitels",
  "site.features.captions.body": "Verschillende stijlen, van Clean tot Clipper.",
  "site.features.vertical.title": "Automatisch verticaal",
  "site.features.vertical.body": "Landschap → 9:16 met gezichtsdetectie.",
  "site.features.hooks.title": "De beste momenten als clips",
  "site.features.hooks.body":
    "Bij video's van 90 seconden of langer vindt CleoCuts tot {count} van de beste momenten en maakt van elk een eigen korte clip.",

  "site.steps.title": "Drie stappen.",
  "site.steps.sub": "Opnemen. Praat met CleoCuts. Posten.",
  "site.steps.record.title": "Opnemen",
  "site.steps.record.body": "Zeg {cut} als je een fout maakt. Geen herhaalopnames.",
  "site.steps.record.hint": "Takes van elke lengte",
  "site.steps.upload.title": "Uploaden",
  "site.steps.upload.body": "Sleep je video erin. Kies een workflow. De AI doet de rest.",
  "site.steps.upload.hint": "Een paar minuten, afhankelijk van de lengte",
  "site.steps.post.title": "Posten",
  "site.steps.post.body": "Download je afgewerkte video, klaar voor TikTok, Instagram en YouTube.",
  "site.steps.post.hint": "Downloaden zodra het klaar is",

  "site.footer.editor": "Editor",
  "site.footer.library": "Bibliotheek",
  "site.footer.imprint": "Colofon",
  "site.footer.privacy": "Privacy",
  "site.footer.terms": "Voorwaarden",
  "site.footer.pricing": "Prijzen",

  // ── Prijzenpagina ───────────────────────────────────────────────────
  "site.pricing.title": "Eenvoudige prijzen",
  "site.pricing.subtitle": "Betaal maandelijks voor de minuten video die je uploadt. Altijd opzegbaar.",
  "site.pricing.perMonth": "/ maand",
  "site.pricing.perYear": "/ jaar",
  "site.pricing.priceAtCheckout": "Prijs zie je bij het afrekenen",
  "site.pricing.popular": "Meest gekozen",
  "site.pricing.minutes": "{minutes} min video per maand",
  "site.pricing.retention": "Projecten worden {days} dagen bewaard",
  "site.pricing.featureWorkflows": "Alle workflows en ondertitelstijlen",
  "site.pricing.featureVoice": "Spraakcommando's en AI-opschoning",
  "site.pricing.choose": "Kies {plan}",
  "site.pricing.current": "Je huidige abonnement",
  "site.pricing.manage": "Abonnement beheren",
  "site.pricing.switch": "Overstappen naar {plan}",
  "site.pricing.unavailable": "Nog niet beschikbaar",
  "site.pricing.redirecting": "Afrekenen wordt geopend…",
  "site.pricing.checkoutFailed": "Afrekenen kon niet worden geopend. Probeer het straks nog eens.",
  "site.pricing.loadFailed": "De abonnementen konden niet worden geladen. Probeer het straks nog eens.",
  "site.pricing.minutesHint":
    "Minuten tellen de lengte van de video's die je uploadt. Ongebruikte minuten schuiven niet door naar de volgende maand.",
  "site.pricing.vatNote":
    "Prijzen zijn inclusief btw. Betalingen lopen via Lemon Squeezy, onze Merchant of Record — zij brengen de kosten in rekening en sturen je facturen.",
  "site.pricing.testMode": "Testmodus — geen echte betalingen",
  "site.pricing.testersOnly": "Abonnementen zijn nog niet te koop — de checkout staat in testmodus, alleen voor uitgenodigde testers.",
  "site.pricing.betaTitle": "Gratis tijdens de open beta",
  "site.pricing.betaBody": "CleoCuts is gratis zolang we in beta zijn. Betaalde abonnementen met meer minuten komen binnenkort.",

  "library.header.homeAria": "CleoCuts editor",
  "library.header.title": "Bibliotheek",
  "library.header.newProject": "Nieuw project",

  "library.count.one": "{count} project",
  "library.count.other": "{count} projecten",
  "library.confirmDelete": "Dit project definitief verwijderen? De video en alle bewerkingen worden van onze servers verwijderd.",
  "library.deleteFailed": "Verwijderen lukt nu niet — als de video nog wordt verwerkt, probeer het zo opnieuw.",

  "library.empty.title": "Je bibliotheek is leeg",
  "library.empty.body":
    "Elke video die je afrondt, verschijnt hier. Je kunt hem altijd opnieuw downloaden, je ondertitels ophalen en hook-clips delen.",
  "library.empty.cta": "Start je eerste project",

  "library.card.playAria": "Voorbeeld van {name} afspelen",
  "library.card.noPreview": "geen voorbeeld",
  "library.card.customPreset": "Aangepast",
  "library.card.deleteAria": "Project verwijderen",
  "library.card.expiresDays": "Wordt over {n} dagen automatisch verwijderd",
  "library.card.expiresSoon": "Wordt binnen 24 uur verwijderd",
  "library.card.expired": "Verlopen — bestanden zijn verwijderd",
  "library.card.hooks.one": "{count} hook",
  "library.card.hooks.other": "{count} hooks",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Bijschrift",
  "library.card.copy": "kopiëren",
  "library.card.copied": "gekopieerd",

  "library.format.primary": "Hoofdmontage",
  "library.format.hook": "Hook-clip {n}",

  "library.time.justNow": "net nu",
  "library.time.minutesAgo": "{n} min. geleden",
  "library.time.hoursAgo": "{n} u. geleden",
  "library.time.daysAgo": "{n} d. geleden",

  "common.videoModal.closeAria": "Voorbeeld sluiten",
  "common.videoModal.close": "Sluiten",
  "common.videoModal.dialogLabel": "Voorbeeld van de video",

  "common.auth.signIn": "Inloggen",
  "common.auth.account": "Account",
  "common.auth.pricing": "Prijzen",
  "common.language": "Taal",
  "common.footer.legalAria": "Juridisch",
  "legal.onlyDeEn":
    "Deze pagina is alleen beschikbaar in het Duits en het Engels. Je leest de Engelse versie.",
  "common.backHome": "Terug naar de startpagina",
  "common.notFound.title": "Pagina niet gevonden",
  "common.notFound.body": "Deze pagina bestaat niet of is verplaatst.",
  "common.error.title": "Er ging iets mis",
  "common.error.body": "Deze pagina kon niet worden weergegeven. Probeer het opnieuw.",
  "common.error.retry": "Opnieuw proberen",
  "common.error.ref": "Foutreferentie: {id}",
};
