import type { SiteKey } from "../en";

export const frSite: Partial<Record<SiteKey, string>> = {
  // ── Landing: header ── //
  "site.header.homeAria": "Accueil CleoCuts",
  "site.header.openEditor": "Ouvrir l'éditeur",

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
