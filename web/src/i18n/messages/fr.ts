import type { MessageKey } from "./en";
export const fr: Partial<Record<MessageKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "Accueil CleoCuts",
  "app.header.library": "Bibliothèque",
  "app.header.beta": "Bêta",
  "app.header.opening": "Ouverture…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — ta vidéo est prête",
  "app.notify.clickToView": "Clique pour voir",
  "app.notify.reviewTitle": "CleoCuts — prêt pour ta relecture",
  "app.notify.reviewBody": "Coupes + transcription terminées. Touche pour relire.",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "Impossible de charger le projet pour le moment. Réessaie dans un instant.",
  "app.notice.done": "Cette vidéo est terminée — retrouve-la dans Récents et dans ta bibliothèque.",
  "app.notice.processing": "Cette vidéo est encore en traitement. La carte affiche sa progression.",
  "app.notice.alreadyExporting": "Cette vidéo est déjà en cours d'export. Sa carte affiche la progression.",
  "app.notice.offline": "Impossible de joindre le serveur. Vérifie ta connexion et réessaie.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Ce projet n'existe plus sur le serveur (expiré ou mise à jour du serveur). Merci de réenvoyer la vidéo.",
  "app.errors.generic": "Une erreur est survenue. Réessaie.",
  "app.errors.connection": "La connexion a été coupée. Vérifie ta connexion et réessaie.",
  "app.errors.interrupted":
    "L'envoi a été interrompu (page rechargée ou changement d'appli). Merci de réenvoyer la vidéo.",
  "app.errors.tooLarge": "Le fichier est trop volumineux. Rogne la vidéo ou exporte-la en plus petit.",
  "app.errors.noAudio": "Aucun son exploitable n'a été trouvé dans la vidéo.",
  "app.errors.noSpeech": "Nous n'avons trouvé aucune parole dans cette vidéo. CleoCuts coupe et sous-titre les vidéos où quelqu'un parle — essaie avec un clip où l'on entend une voix.",
  "app.errors.noSpeechRefunded": "Nous n'avons trouvé aucune parole dans cette vidéo. CleoCuts coupe et sous-titre les vidéos où quelqu'un parle — essaie avec un clip où l'on entend une voix. Les minutes t'ont été recréditées.",
  "app.errors.noAudioTrack": "Cette vidéo n'a pas de piste audio : il n'y a rien à couper ni à sous-titrer. Rien n'a été facturé.",
  "app.errors.renderFailed":
    "Le rendu a échoué. Tes modifications sont enregistrées — ouvre le projet et relance le rendu.",
  "app.errors.serverNoResponse": "Le serveur ne répond pas. Réessaie.",
  "app.errors.serverBusy": "Nos serveurs sont très sollicités en ce moment. Réessaie dans quelques minutes.",
  "app.errors.saveEditsFailed": "Impossible d'enregistrer tes modifications — vérifie ta connexion et réessaie.",
  "app.errors.title": "Une erreur est survenue",
  "app.errors.tryAgain": "Réessayer",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "Ta session a expiré. Reconnecte-toi et réessaie.",
  "app.errors.subscriptionRequired": "L'envoi nécessite une offre. Choisis-en une sur la page des tarifs.",
  "app.errors.quotaExceeded":
    "Il ne te reste pas assez de minutes sur cette période pour cette vidéo. Passe à une offre supérieure ou attends la réinitialisation.",
  "app.errors.unreadableVideo":
    "Impossible de lire ce fichier vidéo. Exporte-le à nouveau en MP4 ou MOV, puis renvoie-le.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "Ce fichier dépasse {max} Go. Rogne la vidéo ou exporte-la en plus petit.",
  "app.errors.videoTooLong":
    "Cette vidéo dure plus de {max} minutes. Rogne-la ou découpe-la en plusieurs parties.",
  "app.errors.tooManyJobs":
    "Tu as déjà le nombre maximal de vidéos en cours de traitement. Attends qu'une soit prête, puis réessaie.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Connecte-toi pour ouvrir tes projets.",
  "app.auth.loadFailed":
    "Impossible de charger l'écran de connexion. Vérifie ta connexion internet (ou autorise ce site dans ton bloqueur de contenu) et réessaie.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Choisis une offre pour envoyer tes vidéos",
  "app.paywall.subscriptionBody":
    "Les envois nécessitent une offre active. Choisis-en une — ça ne prend qu'une minute, et tu peux résilier à tout moment.",
  "app.paywall.quotaTitle": "Plus assez de minutes",
  "app.paywall.quotaBody": "Il te reste {left} min sur cette période — cette vidéo nécessite {needed} min.",
  "app.paywall.quotaBodyUnknown": "Cette vidéo dépasse les minutes qu'il te reste sur cette période.",
  "app.paywall.seePlans": "Voir les offres",
  "app.paywall.upgrade": "Passer à l'offre supérieure",
  "app.paywall.close": "Pas maintenant",
  "app.billing.minutesLeft": "{n} min restantes sur cette période",
  "app.billing.choosePlan": "Choisis une offre pour envoyer tes vidéos",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Compte",
  "app.account.signedInAs": "Connecté en tant que {email}",
  "app.account.plan": "Offre",
  "app.account.noPlan": "Aucune offre pour l'instant",
  "app.account.freeBeta": "CleoCuts est gratuit pendant la bêta ouverte — aucune offre nécessaire.",
  "app.account.status.active": "Active · renouvellement le {date}",
  "app.account.status.activeNoDate": "Active",
  "app.account.status.trial": "Essai · premier paiement le {date}",
  "app.account.status.cancelled": "Prend fin le {date}",
  "app.account.status.pastDue": "Paiement en retard — mets à jour ton moyen de paiement.",
  "app.account.status.paused": "En pause",
  "app.account.status.expired": "Expirée",
  "app.account.status.comp": "Offerte",
  "app.account.usage": "Minutes sur cette période",
  "app.account.usageOf": "{used} min utilisées sur {limit}",
  "app.account.resetsOn": "Réinitialisation le {date}",
  "app.account.manage": "Gérer l'abonnement",
  "app.account.manageHint":
    "Les factures, le moyen de paiement et la résiliation se gèrent dans le portail client Lemon Squeezy.",
  "app.account.changePlan": "Changer d'offre",
  "app.account.choosePlan": "Choisir une offre",
  "app.account.portalFailed": "Impossible d'ouvrir le portail de facturation. Réessaie dans un instant.",
  "app.account.loadFailed": "Impossible de charger ton compte pour le moment. Réessaie dans un instant.",
  "app.account.testMode": "Mode test",
  "app.account.successPending": "Merci ! Ton paiement est passé — activation de ton offre…",
  "app.account.successDone": "Ton offre {plan} est active. Bon montage !",
  "app.account.successSlow":
    "Ça prend plus de temps que d'habitude. Ton offre apparaîtra ici d'ici quelques minutes — recharge la page pour vérifier.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Sans titre",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Format court vertical",
  "app.preset.tiktok.desc": "Déclencheurs vocaux, sous-titres Clipper, recadrage vertical auto",
  "app.preset.tiktok.bullet1": "Déclencheurs vocaux activés : dis « Cleo cut » pour refaire",
  "app.preset.tiktok.bullet2": "Sous-titres audacieux façon Clipper",
  "app.preset.tiktok.bullet3": "Format vertical 9:16 auto avec suivi du visage",
  "app.preset.podcast.label": "Podcast long format",
  "app.preset.podcast.tagline": "Épisode complet + extraits",
  "app.preset.podcast.desc": "Nettoyage IA, détection des accroches, export multi-format",
  "app.preset.podcast.bullet1": "Nettoyage IA de ta transcription",
  "app.preset.podcast.bullet2": "3 extraits accrocheurs choisis automatiquement",
  "app.preset.podcast.bullet3": "Épisode complet + extraits 9:16 exportés",
  "app.preset.vlog.label": "Nettoyage de vlog",
  "app.preset.vlog.tagline": "Face caméra en solo",
  "app.preset.vlog.desc": "Supprime les hésitations, sous-titres discrets, garde le format",
  "app.preset.vlog.bullet1": "Supprime les « euh », « hum », les longs silences",
  "app.preset.vlog.bullet2": "Sous-titres discrets qui ne distraient pas",
  "app.preset.vlog.bullet3": "Garde ton format d'origine",
  "app.preset.captions.label": "Sous-titres seulement",
  "app.preset.captions.tagline": "Ajoute uniquement des sous-titres",
  "app.preset.captions.desc": "Incruste des sous-titres sur ta vidéo — sans coupes, sans nettoyage",
  "app.preset.captions.bullet1": "Incruste les sous-titres dans le style choisi",
  "app.preset.captions.bullet2": "Sans coupes, sans nettoyage",
  "app.preset.captions.bullet3": "Le plus rapide — juste des sous-titres",
  "app.preset.custom.label": "Personnalisé",
  "app.preset.custom.tagline": "Tout configurer",
  "app.preset.custom.desc": "Réglages complets — choisis chaque option toi-même",
  "app.preset.custom.bullet1": "Tous les réglages accessibles",
  "app.preset.custom.bullet2": "Choisis toi-même les sous-titres, les coupes, le format",
  "app.preset.custom.bullet3": "Pour quand tu sais ce que tu veux",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Épuré",
  "app.captions.classic": "Classique",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Surligné",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Élégant",
  "app.captions.subtle": "Discret",
  "app.captions.none": "Sans sous-titres",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Serré",
  "app.cutStyle.tight.desc": "Agressif",
  "app.cutStyle.balanced.label": "Équilibré",
  "app.cutStyle.balanced.desc": "Par défaut",
  "app.cutStyle.smooth.label": "Fluide",
  "app.cutStyle.smooth.desc": "Garde les pauses",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Fil Instagram",
  "app.format.16x9.desc": "YouTube / ordinateur",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Ton espace de travail",
  "app.dashboard.inProgressCountOne": "{count} vidéo en cours",
  "app.dashboard.inProgressCountOther": "{count} vidéos en cours",
  "app.dashboard.readyCountOne": "{count} vidéo prête à vérifier",
  "app.dashboard.readyCountOther": "{count} vidéos prêtes à vérifier",
  "app.dashboard.failedCountOne": "{count} vidéo en échec",
  "app.dashboard.failedCountOther": "{count} vidéos en échec",
  "app.dashboard.readyWhenYouAre": "Prêt quand tu veux",
  "app.dashboard.newVideo": "Nouvelle vidéo",
  "app.dashboard.inProgress": "En cours",
  "app.dashboard.recentProjects": "Projets récents",
  "app.dashboard.viewAll": "Tout voir →",
  "app.dashboard.startFirst": "Lance ta première vidéo",
  "app.dashboard.startFirstSub": "Choisis un workflow — CleoCuts gère les sous-titres, le format, le nettoyage",
  "app.dashboard.voiceTeaser": "Dis « Cleo » en filmant — gagne des heures de montage",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Retour au tableau de bord",
  "app.picker.freeDuringBeta": "Gratuit pendant la bêta",
  "app.picker.title": "Qu'est-ce que tu publies ?",
  "app.picker.subtitle":
    "Choisis un workflow — CleoCuts préconfigure les sous-titres, le format et le nettoyage pour la plateforme.",
  "app.picker.chipCaptions": "Sous-titres {style}",
  "app.picker.chipVoice": "« Cleo cut » activé",
  "app.picker.customTitle": "Configuration personnalisée",
  "app.picker.customSub": "Choisis toi-même chaque option — sous-titres, coupes, formats",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "← Retour",
  "app.upload.title": "Choisir une vidéo",
  "app.upload.hint":
    "MP4 ou MOV depuis ton téléphone ou ton ordinateur. Garde cette page ouverte jusqu'à la fin de l'envoi.",
  "app.upload.tapToChoose": "Touche pour choisir",
  "app.upload.orDrag": "ou dépose-la ici",
  "app.upload.privacyLink": "Comment nous traitons tes vidéos",
  "app.upload.keepTabOpen":
    "Garde cet onglet ouvert jusqu'à la fin de l'envoi. Changer d'appli ou verrouiller ton téléphone annulera l'envoi.",
  "app.upload.resuming":
    "Reprise de l'envoi là où il s'était arrêté — garde cette page ouverte.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "← retour",
  "app.configure.fileInfo": "{name} · {size} Mo",
  "app.configure.captionStyle": "Style de sous-titres",
  "app.configure.captionPreviewAlt": "Aperçu des sous-titres {style}",
  "app.configure.cutStyle": "Style de coupe",
  "app.configure.cleanup": "Nettoyage",
  "app.configure.voiceTriggers": "Écoute « Cleo cut » / « Cleo go »",
  "app.configure.voiceTriggersDesc": "Supprime automatiquement les prises ratées",
  "app.configure.removeFillers": "Supprimer les mots de remplissage",
  "app.configure.removeFillersDesc": "Coupe les « euh », « hum », « en fait »…",
  "app.configure.smartReframe": "Recadrage intelligent",
  "app.configure.smartcam": "SmartCam suivi du visage",
  "app.configure.smartcamDesc": "Recadrage auto pour la sortie verticale/horizontale",
  "app.configure.portrait": "portrait",
  "app.configure.landscape": "paysage",
  "app.configure.portraitDesc": "Vertical 9:16",
  "app.configure.landscapeDesc": "Horizontal 16:9",
  "app.configure.extraFormats": "Formats de sortie supplémentaires",
  "app.configure.extraFormatsHint":
    "L'export principal est ton format SmartCam (ou le format d'origine). Choisis des versions supplémentaires avec bandes noires pour d'autres plateformes.",
  "app.configure.process": "Traiter la vidéo",

  // ── Progress screen ─────────────────────────────────────────────────
  "app.progress.uploading": "Envoi en cours",
  "app.progress.rendering": "Rendu en cours",
  "app.progress.processing": "Traitement en cours",
  "app.progress.stage.prep": "Préparation de ta vidéo",
  "app.progress.stage.listen": "Écoute de ta voix",
  "app.progress.stage.polish": "Recherche des bonnes prises",
  "app.progress.stage.preview": "Presque prêt",
  "app.progress.stage.burn": "Application de tes modifications",
  "app.progress.stage.stitch": "Assemblage en cours",
  "app.progress.stage.finish": "Touches finales",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Prêt à publier",
  "app.done.captionSuggestion": "Suggestion de légende",
  "app.done.copy": "copier",
  "app.done.downloadPrimary": "Télécharger la version principale",
  "app.done.downloadFormat": "Télécharger {format}",
  "app.done.mainEdit": "Montage principal",
  "app.done.bonusClips": "Extraits bonus",
  "app.done.aiPicked": "Choisi par l'IA",
  "app.done.processAnother": "Traiter une autre vidéo",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "pas d'aperçu",
  "app.card.uploading.title": "Envoi en cours",
  "app.card.uploading.sub": "Envoi en cours — garde cette page ouverte et ne verrouille pas ton téléphone.",
  "app.card.analyzing.title": "Analyse en cours",
  "app.card.analyzing.sub": "Transcription et suppression des pauses et mots de remplissage.",
  "app.card.reviewing.title": "Prêt à modifier",
  "app.card.reviewing.sub": "Touche pour ouvrir l'éditeur et ajuster le montage.",
  "app.card.rendering.title": "Rendu en cours",
  "app.card.rendering.sub": "Assemblage de ta vidéo finale.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "En file d'attente (#{n})",
  "app.card.queued.titleNoPos": "En file d'attente",
  "app.card.queued.sub":
    "Beaucoup de vidéos en ce moment — la tienne démarrera automatiquement. Tu peux quitter cette page.",
  "app.card.open": "Ouvrir →",
  "app.card.remove": "✕ Supprimer",
  "app.card.renderFailedNote": "Le rendu a échoué — tes modifications sont enregistrées. Ouvre-le et relance le rendu.",

  // ── Review (editor) ─────────────────────────────────────────────────
  "app.review.backToDashboard": "← Tableau de bord",
  "app.review.audioHeadsUp": "À savoir sur l'audio",
  "app.review.updatingPreview": "Mise à jour de l'aperçu…",
  "app.review.captionPreviewChip": "Aperçu",
  "app.review.captionPreviewTip": "L'export peut légèrement différer tant que la nouvelle technologie de sous-titres n'est pas en ligne.",
  "app.review.tabTimeline": "Chronologie",
  "app.review.tabTranscript": "Transcription",
  "app.review.tabCaptions": "Sous-titres",
  "app.review.preparing": "Préparation…",
  "app.review.applyRender": "Appliquer et rendre",

  // ── Transcript tab ──────────────────────────────────────────────────
  "app.transcript.lineDeleted": "Ligne supprimée",
  "app.transcript.undo": "↶ Annuler",
  "app.transcript.headingOne": "Transcription · {count} ligne",
  "app.transcript.headingOther": "Transcription · {count} lignes",
  "app.transcript.hint": "Corrige les fautes, supprime une ligne avec ✕, touche une carte pour aller à ce moment.",
  "app.transcript.empty": "Pas de sous-titres. La sortie sera vidéo uniquement.",
  "app.transcript.verify": "vérifier",
  "app.transcript.deleteSentence": "Supprimer la phrase",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Style de sous-titres · {style}",
  "app.captions.appliedToOutput": "Appliqué à la sortie",
  "app.captions.disabled": "Sous-titres désactivés pour ce rendu.",

  // ── Timeline editor ─────────────────────────────────────────────────
  "app.timeline.title": "Chronologie",
  "app.timeline.clipsOne": "{count} clip · {dur}",
  "app.timeline.clipsOther": "{count} clips · {dur}",
  "app.timeline.saving": "enregistrement",
  "app.timeline.saveFailedTitle":
    "Le serveur n'accepte plus les modifications pour cette vidéo (rendu en cours ou expiré).",
  "app.timeline.saveRetryingTitle": "Ta dernière modification n'a pas encore atteint le serveur. Nouvelle tentative…",
  "app.timeline.notSaved": "non enregistré",
  "app.timeline.notSavedRetrying": "non enregistré · nouvelle tentative",
  "app.timeline.undoTitle": "Annuler (⌘Z)",
  "app.timeline.undoAria": "Annuler",
  "app.timeline.redoTitle": "Rétablir (⌘⇧Z)",
  "app.timeline.redoAria": "Rétablir",
  "app.timeline.splitTitle": "Scinder le clip sous la tête de lecture",
  "app.timeline.split": "⧉ Scinder",
  "app.timeline.splitUnavailable": "Place la tête de lecture dans un clip pour le scinder (pas pile au début ni à la fin).",
  "app.timeline.zoomOutTitle": "Dézoomer (afficher plus de vidéo)",
  "app.timeline.zoomOutAria": "Dézoomer",
  "app.timeline.fitTitle": "Ajuster pour voir toute la vidéo",
  "app.timeline.fit": "Ajuster",
  "app.timeline.zoomInTitle": "Zoomer (plus de détail, rognage plus précis)",
  "app.timeline.zoomInAria": "Zoomer",
  "app.timeline.clipLabel": "Clip {n}",
  "app.timeline.moveLeft": "Déplacer le clip vers la gauche",
  "app.timeline.moveRight": "Déplacer le clip vers la droite",
  "app.timeline.deleteTitle": "Supprimer le clip (⌫)",
  "app.timeline.delete": "✕ Supprimer",
  "app.timeline.speed": "Vitesse",
  "app.timeline.speedNormal": "1× (normal)",
  "app.timeline.volume": "Volume",
  "app.timeline.muteBadge": "M",
  "app.timeline.fadeIn": "Fondu d'entrée",
  "app.timeline.fadeOut": "Fondu de sortie",
  "app.timeline.resetEffects": "Réinitialiser les effets",
  // Legacy cut strip
  "app.timeline.cuts": "Coupes",
  "app.timeline.cutsRemoved": "{sec}s supprimées",
  "app.timeline.cutsRestored": " · {count} restaurée(s)",
  "app.timeline.cutTitleRestore": "Coupe {from}–{to} (toucher pour restaurer)",
  "app.timeline.cutTitleRemoveAgain": "Coupe {from}–{to} (toucher pour supprimer à nouveau)",
  "app.timeline.cutsLegend": "Rouge = supprimé · toucher pour restaurer. Tirets verts = conservé.",

  // ── Voice commands (test modal + scene panel) ───────────────────────
  "app.voice.title": "Teste ta voix",
  "app.voice.subtitle": "Dis les commandes — vérifie si Cleo t'entend.",
  "app.voice.close": "Fermer",
  "app.voice.heardYou": "Entendu !",
  "app.voice.listening": "Écoute…",
  "app.voice.heardPrefix": "entendu : ",
  "app.voice.permissionHint": "Utilise ton micro. Ton navigateur transforme ta voix en texte : Chrome l'envoie pour cela à Google, Safari à Apple. Rien n'est envoyé à CleoCuts.",
  "app.voice.requesting": "Demande en cours…",
  "app.voice.start": "Démarrer",
  "app.voice.denied": "Autorisation refusée. Active-la dans les réglages du navigateur + recharge.",
  "app.voice.unsupported": "Non pris en charge par ce navigateur. Essaie Safari ou Chrome.",
  "app.voice.done": "Terminé",
  "app.voice.cmd.start": "Démarre ta prise",
  "app.voice.cmd.cut": "Refaire, annule la prise en cours",
  "app.voice.cmd.keep": "Valide la prise, scène suivante",
  "app.voice.cmd.finish": "Termine la vidéo, coupe tout ce qui suit",
  "app.voice.cmd.stop": "Ignore une mauvaise phrase (à combiner avec « go »)",
  "app.voice.cmd.go": "Reprend après « stop »",
  "app.voice.scene.heading": "Commandes vocales · {count} active(s)",
  "app.voice.scene.hint": "Décoche les fausses détections, ajoute celles qui manquent. Les coupes se mettent à jour automatiquement.",
  "app.voice.scene.add": "+ Ajouter",
  "app.voice.scene.addAt": "Ajouter une commande au moment actuel de la vidéo",
  "app.voice.scene.none": "Aucune commande vocale détectée.",
  "app.voice.scene.disable": "Désactiver",
  "app.voice.scene.enable": "Activer",
  "app.voice.scene.heard": "entendu : « {text} »",
  "app.voice.scene.type.start": "Début",
  "app.voice.scene.type.keep": "Garder",
  "app.voice.scene.type.restart": "Couper / Recommencer",
  "app.voice.scene.type.finish": "Terminer",

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
  "app.crash.saving": "Enregistrement de tes dernières modifications…",
  "app.crash.saved": "Tes dernières modifications sont enregistrées.",
  "app.crash.unsaved": "Tes dernières modifications n'ont peut-être pas été enregistrées.",
  "app.crash.body": "Recharge la page pour reprendre là où tu en étais.",
  "app.crash.reload": "Recharger la page",
};
