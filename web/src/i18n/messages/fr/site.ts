import type { SiteKey } from "../en";

export const frSite: Partial<Record<SiteKey, string>> = {
  // ── Landing: header ── //
  "site.header.homeAria": "Accueil CleoCuts",
  "site.header.openEditor": "Ouvrir l'éditeur",

  // ── Landing: hero ── //
  "site.hero.badge": "Bêta ouverte · gratuit",
  "site.hero.badgePricing": "Voir les offres et les tarifs",
  "site.hero.titleLead": "Monte en",
  "site.hero.titleAccent": "filmant.",
  "site.hero.sub":
    "Dis {cut} quand tu te trompes. Dis {finish} quand tu as fini. Prêt à publier en quelques minutes, sous-titres et coupes inclus.",
  "site.hero.cta": "Essayer CleoCuts",

  // ── Landing: caption showcase ── //
  "site.showcase.listening": "CleoCuts à l'écoute",
  "site.showcase.captionStyle": "style de sous-titres",
  "site.showcase.clipper": "LA PAROLE FAIT LE MONTAGE",
  "site.showcase.highlight": "PRÊT À PUBLIER",
  "site.showcase.flash": "DIS CUT",
  "site.showcase.punch": "NICKEL",
  "site.showcase.elegant": "Ça écoute, tout simplement.",

  // ── Landing: features ── //
  "site.features.title": "Ce que fait CleoCuts.",
  "site.features.voice.title": "Déclencheurs vocaux",
  "site.features.voice.body": "Dis {cut} en pleine prise. CleoCuts supprime la tentative ratée.",
  "site.features.cleanup.title": "Nettoyage IA",
  "site.features.cleanup.body":
    "Corrige les mots mal reconnus et les noms de marque dans tes sous-titres.",
  "site.features.captions.title": "Sous-titres animés",
  "site.features.captions.body": "Plusieurs styles, d'Épuré à Clipper.",
  "site.features.vertical.title": "Vertical automatique",
  "site.features.vertical.body": "Paysage → 9:16 avec suivi du visage.",
  "site.features.hooks.title": "Les meilleurs moments en clips",
  "site.features.hooks.body":
    "Pour les vidéos de 90 secondes ou plus, CleoCuts trouve jusqu'à {count} des meilleurs moments et fait de chacun un clip court.",

  // ── Landing: how it works ── //
  "site.steps.title": "Trois étapes.",
  "site.steps.sub": "Filme. Parle à CleoCuts. Publie.",
  "site.steps.record.title": "Filmer",
  "site.steps.record.body": "Dis {cut} quand tu te trompes. Pas besoin de refaire.",
  "site.steps.record.hint": "Prises de n'importe quelle durée",
  "site.steps.upload.title": "Importer",
  "site.steps.upload.body": "Dépose ta vidéo. Choisis un workflow. L'IA fait le reste.",
  "site.steps.upload.hint": "Quelques minutes, selon la durée",
  "site.steps.post.title": "Publier",
  "site.steps.post.body": "Télécharge ta vidéo finie, prête pour TikTok, Instagram et YouTube.",
  "site.steps.post.hint": "Télécharge une fois prêt",

  // ── Landing: footer ── //
  "site.footer.editor": "Éditeur",
  "site.footer.library": "Bibliothèque",
  "site.footer.imprint": "Mentions légales",
  "site.footer.privacy": "Confidentialité",
  "site.footer.terms": "Conditions d'utilisation",
  "site.footer.pricing": "Tarifs",

  // ── Pricing page ── //
  "site.pricing.title": "Des tarifs simples",
  "site.pricing.subtitle": "Paie chaque mois pour les minutes de vidéo que tu envoies. Résiliable à tout moment.",
  "site.pricing.perMonth": "/ mois",
  "site.pricing.perYear": "/ an",
  "site.pricing.priceAtCheckout": "Prix affiché au paiement",
  "site.pricing.popular": "Le plus populaire",
  "site.pricing.minutes": "{minutes} min de vidéo par mois",
  "site.pricing.retention": "Projets conservés {days} jours",
  "site.pricing.featureWorkflows": "Tous les workflows et styles de sous-titres",
  "site.pricing.featureVoice": "Commandes vocales et nettoyage IA",
  "site.pricing.choose": "Choisir {plan}",
  "site.pricing.current": "Ton offre actuelle",
  "site.pricing.manage": "Gérer l'abonnement",
  "site.pricing.switch": "Passer à {plan}",
  "site.pricing.unavailable": "Pas encore disponible",
  "site.pricing.redirecting": "Ouverture du paiement…",
  "site.pricing.checkoutFailed": "Impossible d'ouvrir la page de paiement. Réessaie dans un instant.",
  "site.pricing.loadFailed": "Impossible de charger les offres. Réessaie dans un instant.",
  "site.pricing.minutesHint":
    "Les minutes correspondent à la durée des vidéos que tu envoies. Les minutes non utilisées ne sont pas reportées au mois suivant.",
  "site.pricing.vatNote":
    "Prix TTC. Les paiements sont gérés par Lemon Squeezy, notre revendeur officiel (Merchant of Record) — c'est lui qui encaisse tes paiements et t'envoie tes factures.",
  "site.pricing.testMode": "Mode test — aucun paiement réel",
  "site.pricing.testersOnly": "Les forfaits ne sont pas encore en vente — le paiement est en mode test, réservé aux testeurs invités.",
  "site.pricing.betaTitle": "Gratuit pendant la bêta ouverte",
  "site.pricing.betaBody": "CleoCuts est gratuit pendant la bêta. Des offres payantes avec plus de minutes arrivent bientôt.",

  // ── Library: header ── //
  "library.header.homeAria": "Éditeur CleoCuts",
  "library.header.title": "Bibliothèque",
  "library.header.newProject": "Nouveau projet",

  // ── Library: list ── //
  "library.count.one": "{count} projet",
  "library.count.other": "{count} projets",
  "library.confirmDelete": "Supprimer ce projet définitivement ? La vidéo et toutes les modifications sont effacées de nos serveurs.",
  "library.deleteFailed": "Suppression impossible pour le moment — si la vidéo est encore en traitement, réessaie dans un instant.",

  // ── Library: empty state ── //
  "library.empty.title": "Ta bibliothèque est vide",
  "library.empty.body":
    "Chaque vidéo terminée apparaît ici. Tu peux la retélécharger, récupérer tes sous-titres et partager des extraits accrocheurs à tout moment.",
  "library.empty.cta": "Lance ton premier projet",

  // ── Library: project card ── //
  "library.card.playAria": "Lire l'aperçu de {name}",
  "library.card.noPreview": "pas d'aperçu",
  "library.card.customPreset": "Personnalisé",
  "library.card.deleteAria": "Supprimer le projet",
  "library.card.expiresDays": "Suppression automatique dans {n} jours",
  "library.card.expiresSoon": "Suppression dans moins de 24 heures",
  "library.card.expired": "Expiré — les fichiers ont été supprimés",
  "library.card.hooks.one": "{count} extrait accrocheur",
  "library.card.hooks.other": "{count} extraits accrocheurs",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Légende",
  "library.card.copy": "copier",
  "library.card.copied": "copié",

  // ── Library: download labels ── //
  "library.format.primary": "Montage principal",
  "library.format.hook": "Extrait accrocheur {n}",

  // ── Library: relative time ── //
  "library.time.justNow": "à l'instant",
  "library.time.minutesAgo": "il y a {n} min",
  "library.time.hoursAgo": "il y a {n} h",
  "library.time.daysAgo": "il y a {n} j",

  // ── Shared components ── //
  "common.videoModal.closeAria": "Fermer l'aperçu",
  "common.videoModal.close": "Fermer",
  "common.videoModal.dialogLabel": "Aperçu de la vidéo",
  "common.auth.signIn": "Se connecter",
  "common.auth.account": "Compte",
  "common.auth.pricing": "Tarifs",
  "common.language": "Langue",
  "common.footer.legalAria": "Informations légales",
  "legal.onlyDeEn":
    "Cette page n'est disponible qu'en allemand et en anglais. Tu lis la version anglaise.",
  "common.backHome": "Retour à l'accueil",
  "common.notFound.title": "Page introuvable",
  "common.notFound.body": "Cette page n'existe pas ou a été déplacée.",
  "common.error.title": "Une erreur s'est produite",
  "common.error.body": "Impossible d'afficher cette page. Réessaie.",
  "common.error.retry": "Réessayer",
  "common.error.ref": "Référence de l'erreur : {id}",
};
