import type { MessageKey } from "./en";

export const it: Partial<Record<MessageKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "Home di CleoCuts",
  "app.header.library": "Libreria",
  "app.header.beta": "Beta",
  "app.header.opening": "Apertura…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — il tuo video è pronto",
  "app.notify.clickToView": "Clicca per vederlo",
  "app.notify.reviewTitle": "CleoCuts — pronto per la revisione",
  "app.notify.reviewBody": "Tagli + trascrizione pronti. Tocca per rivedere.",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "Non riusciamo a caricare il progetto ora. Riprova in un momento.",
  "app.notice.done": "Questo video è pronto — lo trovi in Recenti e nella tua Libreria.",
  "app.notice.processing": "Questo video è ancora in elaborazione. La card mostra i progressi.",
  "app.notice.alreadyExporting": "Questo video è già in esportazione. La sua scheda mostra l'avanzamento.",
  "app.notice.offline": "Impossibile raggiungere il server. Controlla la connessione e riprova.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Questo progetto non esiste più sul server (scaduto o aggiornamento server). Carica di nuovo il video.",
  "app.errors.generic": "Qualcosa è andato storto. Riprova.",
  "app.errors.connection": "La connessione si è interrotta. Controlla la rete e riprova.",
  "app.errors.interrupted":
    "L'upload è stato interrotto (pagina ricaricata o app cambiata). Carica di nuovo il video.",
  "app.errors.tooLarge": "Il file è troppo grande. Taglia il video o esportalo più leggero.",
  "app.errors.noAudio": "Non è stato trovato audio utilizzabile nel video.",
  "app.errors.noSpeech": "In questo video non abbiamo trovato parlato. CleoCuts taglia e sottotitola video in cui qualcuno parla: prova con una clip con una voce.",
  "app.errors.noSpeechRefunded": "In questo video non abbiamo trovato parlato. CleoCuts taglia e sottotitola video in cui qualcuno parla: prova con una clip con una voce. I minuti ti sono stati riaccreditati.",
  "app.errors.noAudioTrack": "Questo video non ha una traccia audio, quindi non c'è niente da tagliare o sottotitolare. Non ti è stato addebitato nulla.",
  "app.errors.renderFailed":
    "Il rendering è fallito. Le tue modifiche sono salvate — apri il progetto e renderizza di nuovo.",
  "app.errors.serverNoResponse": "Il server non ha risposto. Riprova.",
  "app.errors.serverBusy": "I nostri server sono occupati in questo momento. Riprova tra qualche minuto.",
  "app.errors.saveEditsFailed": "Non siamo riusciti a salvare le modifiche — controlla la connessione e riprova.",
  "app.errors.title": "Qualcosa è andato storto",
  "app.errors.tryAgain": "Riprova",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "La tua sessione è scaduta. Accedi di nuovo e riprova.",
  "app.errors.subscriptionRequired": "Per caricare video serve un piano. Scegline uno nella pagina dei prezzi.",
  "app.errors.quotaExceeded":
    "Non ti restano abbastanza minuti in questo periodo per questo video. Passa a un piano superiore o aspetta il rinnovo dei minuti.",
  "app.errors.unreadableVideo":
    "Non riusciamo a leggere questo file video. Esportalo di nuovo come MP4 o MOV e ricaricalo.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "Questo file supera i {max} GB. Taglia il video o esportalo più leggero.",
  "app.errors.videoTooLong":
    "Questo video dura più di {max} minuti. Taglialo o dividilo in più parti.",
  "app.errors.tooManyJobs":
    "Hai già il numero massimo di video in elaborazione. Aspetta che uno sia pronto, poi riprova.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Accedi per aprire i tuoi progetti.",
  "app.auth.loadFailed":
    "Impossibile caricare l'accesso. Controlla la connessione (o consenti questo sito nel tuo blocco contenuti) e riprova.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Scegli un piano per caricare",
  "app.paywall.subscriptionBody":
    "Per caricare video serve un piano attivo. Scegline uno — ci vuole un minuto e puoi disdire quando vuoi.",
  "app.paywall.quotaTitle": "Minuti insufficienti",
  "app.paywall.quotaBody": "Ti restano {left} min in questo periodo — questo video ne richiede {needed}.",
  "app.paywall.quotaBodyUnknown": "Questo video supera i minuti che ti restano in questo periodo.",
  "app.paywall.seePlans": "Vedi i piani",
  "app.paywall.upgrade": "Passa a un piano superiore",
  "app.paywall.close": "Non ora",
  "app.billing.minutesLeft": "{n} min rimasti in questo periodo",
  "app.billing.choosePlan": "Scegli un piano per caricare",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Account",
  "app.account.signedInAs": "Accesso effettuato come {email}",
  "app.account.plan": "Piano",
  "app.account.noPlan": "Ancora nessun piano",
  "app.account.freeBeta": "CleoCuts è gratis durante la beta aperta — nessun piano necessario.",
  "app.account.status.active": "Attivo · si rinnova il {date}",
  "app.account.status.activeNoDate": "Attivo",
  "app.account.status.trial": "Prova · primo pagamento il {date}",
  "app.account.status.cancelled": "Termina il {date}",
  "app.account.status.pastDue": "Pagamento in ritardo — aggiorna il tuo metodo di pagamento.",
  "app.account.status.paused": "In pausa",
  "app.account.status.expired": "Scaduto",
  "app.account.status.comp": "Omaggio",
  "app.account.usage": "Minuti in questo periodo",
  "app.account.usageOf": "{used} di {limit} min usati",
  "app.account.resetsOn": "Si rinnova il {date}",
  "app.account.manage": "Gestisci abbonamento",
  "app.account.manageHint": "Fatture, metodo di pagamento e disdetta si gestiscono nel portale clienti di Lemon Squeezy.",
  "app.account.changePlan": "Cambia piano",
  "app.account.choosePlan": "Scegli un piano",
  "app.account.portalFailed": "Impossibile aprire il portale di fatturazione. Riprova tra un momento.",
  "app.account.loadFailed": "Non riusciamo a caricare il tuo account ora. Riprova tra un momento.",
  "app.account.testMode": "Modalità test",
  "app.account.successPending": "Grazie! Il pagamento è andato a buon fine — stiamo attivando il tuo piano…",
  "app.account.successDone": "Il tuo piano {plan} è attivo. Buon montaggio!",
  "app.account.successSlow":
    "Ci sta mettendo più del solito. Il tuo piano comparirà qui entro pochi minuti — ricarica la pagina per controllare.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Senza titolo",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Verticale, short-form",
  "app.preset.tiktok.desc": "Comandi vocali, sottotitoli Clipper, crop verticale automatico",
  "app.preset.tiktok.bullet1": "Comandi vocali attivi: di' “Cleo cut” per rifare",
  "app.preset.tiktok.bullet2": "Sottotitoli in grassetto stile Clipper",
  "app.preset.tiktok.bullet3": "Verticale 9:16 automatico con face tracking",
  "app.preset.podcast.label": "Podcast Long-Form",
  "app.preset.podcast.tagline": "Episodio intero + clip",
  "app.preset.podcast.desc": "Pulizia AI, rilevamento hook, esportazione multi-formato",
  "app.preset.podcast.bullet1": "Pulizia AI sulla trascrizione",
  "app.preset.podcast.bullet2": "3 clip hook scelte automaticamente",
  "app.preset.podcast.bullet3": "Episodio intero + clip 9:16 esportati",
  "app.preset.vlog.label": "Pulizia Vlog",
  "app.preset.vlog.tagline": "Solo talking-head",
  "app.preset.vlog.desc": "Rimuove le esitazioni, sottotitoli discreti, mantiene le proporzioni",
  "app.preset.vlog.bullet1": "Rimuove “ehm”, “uh”, pause lunghe",
  "app.preset.vlog.bullet2": "Sottotitoli discreti che non distraggono",
  "app.preset.vlog.bullet3": "Mantiene le proporzioni originali",
  "app.preset.captions.label": "Solo sottotitoli",
  "app.preset.captions.tagline": "Aggiungi solo i sottotitoli",
  "app.preset.captions.desc": "Incide i sottotitoli sul video — nessun taglio, nessuna pulizia",
  "app.preset.captions.bullet1": "Incide i sottotitoli nello stile scelto",
  "app.preset.captions.bullet2": "Nessun taglio, nessuna pulizia",
  "app.preset.captions.bullet3": "Il più rapido — solo sottotitoli",
  "app.preset.custom.label": "Personalizzato",
  "app.preset.custom.tagline": "Configura tutto",
  "app.preset.custom.desc": "Impostazioni complete — scegli tu ogni opzione",
  "app.preset.custom.bullet1": "Ogni impostazione visibile",
  "app.preset.custom.bullet2": "Scegli tu sottotitoli, tagli, formato",
  "app.preset.custom.bullet3": "Per quando sai già cosa vuoi",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Pulito",
  "app.captions.classic": "Classico",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegante",
  "app.captions.subtle": "Discreto",
  "app.captions.none": "Nessun sottotitolo",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Serrato",
  "app.cutStyle.tight.desc": "Aggressivo",
  "app.cutStyle.balanced.label": "Bilanciato",
  "app.cutStyle.balanced.desc": "Predefinito",
  "app.cutStyle.smooth.label": "Fluido",
  "app.cutStyle.smooth.desc": "Mantiene le pause",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Feed Instagram",
  "app.format.16x9.desc": "YouTube / desktop",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Il tuo spazio di lavoro",
  "app.dashboard.inProgressCountOne": "{count} video in corso",
  "app.dashboard.inProgressCountOther": "{count} video in corso",
  "app.dashboard.readyCountOne": "{count} video pronto da rivedere",
  "app.dashboard.readyCountOther": "{count} video pronti da rivedere",
  "app.dashboard.failedCountOne": "{count} video non riuscito",
  "app.dashboard.failedCountOther": "{count} video non riusciti",
  "app.dashboard.readyWhenYouAre": "Pronti quando vuoi",
  "app.dashboard.newVideo": "Nuovo video",
  "app.dashboard.inProgress": "In corso",
  "app.dashboard.recentProjects": "Progetti recenti",
  "app.dashboard.viewAll": "Vedi tutti →",
  "app.dashboard.startFirst": "Inizia il tuo primo video",
  "app.dashboard.startFirstSub": "Scegli un workflow — CleoCuts gestisce sottotitoli, formato e pulizia",
  "app.dashboard.voiceTeaser": "Di' “Cleo” mentre registri — risparmia ore di editing",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Torna alla dashboard",
  "app.picker.freeDuringBeta": "Gratis durante la beta",
  "app.picker.title": "Cosa stai pubblicando?",
  "app.picker.subtitle":
    "Scegli un workflow — CleoCuts preconfigura sottotitoli, formato e pulizia per la piattaforma.",
  "app.picker.chipCaptions": "Sottotitoli {style}",
  "app.picker.chipVoice": "\"Cleo cut\" attivo",
  "app.picker.customTitle": "Configurazione personalizzata",
  "app.picker.customSub": "Scegli tu ogni opzione — sottotitoli, tagli, formati",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "← Indietro",
  "app.upload.title": "Scegli un video",
  "app.upload.hint":
    "MP4 o MOV dal telefono o dal computer. Tieni questa pagina aperta finché l'upload non è terminato.",
  "app.upload.tapToChoose": "Tocca per scegliere",
  "app.upload.orDrag": "oppure trascinane uno qui",
  "app.upload.keepTabOpen":
    "Tieni questa scheda aperta finché l'upload non termina. Cambiare app o bloccare il telefono annullerà l'upload.",
  "app.upload.resuming":
    "Il caricamento riprende da dove si era interrotto — tieni questa pagina aperta.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "← indietro",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "Stile sottotitoli",
  "app.configure.captionPreviewAlt": "Anteprima sottotitoli {style}",
  "app.configure.cutStyle": "Stile di taglio",
  "app.configure.cleanup": "Pulizia",
  "app.configure.voiceTriggers": "Ascolta \"Cleo cut\" / \"Cleo go\"",
  "app.configure.voiceTriggersDesc": "Rimuove automaticamente le riprese fallite",
  "app.configure.removeFillers": "Rimuovi le parole di riempimento",
  "app.configure.removeFillersDesc": "Elimina \"ehm\", \"uh\", \"cioè\"…",
  "app.configure.smartReframe": "Riquadratura intelligente",
  "app.configure.smartcam": "Face-tracking SmartCam",
  "app.configure.smartcamDesc": "Riquadratura automatica per output verticale/orizzontale",
  "app.configure.portrait": "verticale",
  "app.configure.landscape": "orizzontale",
  "app.configure.portraitDesc": "Verticale 9:16",
  "app.configure.landscapeDesc": "Orizzontale 16:9",
  "app.configure.extraFormats": "Formati di output extra",
  "app.configure.extraFormatsHint":
    "L'export principale usa il tuo formato SmartCam (o le proporzioni originali). Scegli versioni extra con bordi neri per altre piattaforme.",
  "app.configure.process": "Elabora il video",

  // ── Progress screen ─────────────────────────────────────────────────
  "app.progress.uploading": "Caricamento",
  "app.progress.rendering": "Rendering",
  "app.progress.processing": "Elaborazione",
  "app.progress.stage.prep": "Preparazione del video",
  "app.progress.stage.listen": "Ascolto della tua voce",
  "app.progress.stage.polish": "Ricerca delle riprese migliori",
  "app.progress.stage.preview": "Quasi pronto",
  "app.progress.stage.burn": "Applicazione delle modifiche",
  "app.progress.stage.stitch": "Montaggio in corso",
  "app.progress.stage.finish": "Ultimi ritocchi",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Pronto per la pubblicazione",
  "app.done.captionSuggestion": "Suggerimento di caption",
  "app.done.copy": "copia",
  "app.done.downloadPrimary": "Scarica principale",
  "app.done.downloadFormat": "Scarica {format}",
  "app.done.mainEdit": "Montaggio principale",
  "app.done.bonusClips": "Clip bonus",
  "app.done.aiPicked": "Scelte dall'AI",
  "app.done.processAnother": "Elabora un altro",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "nessuna anteprima",
  "app.card.uploading.title": "Caricamento",
  "app.card.uploading.sub": "Caricamento in corso — tieni questa pagina aperta e non bloccare il telefono.",
  "app.card.analyzing.title": "Analisi",
  "app.card.analyzing.sub": "Trascrizione e rimozione di pause e parole di riempimento.",
  "app.card.reviewing.title": "Pronto per l'editing",
  "app.card.reviewing.sub": "Tocca per aprire l'editor e perfezionare il montaggio.",
  "app.card.rendering.title": "Rendering",
  "app.card.rendering.sub": "Montaggio del video finale in corso.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "In coda (#{n})",
  "app.card.queued.titleNoPos": "In coda",
  "app.card.queued.sub":
    "Ci sono molti video in questo momento — il tuo partirà in automatico. Puoi lasciare questa pagina.",
  "app.card.open": "Apri →",
  "app.card.remove": "✕ Rimuovi",
  "app.card.renderFailedNote": "Rendering fallito — le tue modifiche sono salvate. Apri e renderizza di nuovo.",

  // ── Review (editor) ─────────────────────────────────────────────────
  "app.review.backToDashboard": "← Dashboard",
  "app.review.audioHeadsUp": "Avviso audio",
  "app.review.updatingPreview": "Aggiornamento anteprima…",
  "app.review.tabTimeline": "Timeline",
  "app.review.tabTranscript": "Trascrizione",
  "app.review.tabCaptions": "Sottotitoli",
  "app.review.preparing": "Preparazione…",
  "app.review.applyRender": "Applica e renderizza",

  // ── Transcript tab ──────────────────────────────────────────────────
  "app.transcript.lineDeleted": "Riga eliminata",
  "app.transcript.undo": "↶ Annulla",
  "app.transcript.headingOne": "Trascrizione · {count} riga",
  "app.transcript.headingOther": "Trascrizione · {count} righe",
  "app.transcript.hint": "Correggi errori, elimina una riga con ✕, tocca una card per andare a quel momento.",
  "app.transcript.empty": "Nessun sottotitolo. L'output sarà solo video.",
  "app.transcript.verify": "verifica",
  "app.transcript.deleteSentence": "Elimina frase",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Stile sottotitoli · {style}",
  "app.captions.appliedToOutput": "Applicato all'output",
  "app.captions.disabled": "Sottotitoli disattivati per questo rendering.",

  // ── Timeline editor ─────────────────────────────────────────────────
  "app.timeline.title": "Timeline",
  "app.timeline.clipsOne": "{count} clip · {dur}",
  "app.timeline.clipsOther": "{count} clip · {dur}",
  "app.timeline.saving": "salvataggio",
  "app.timeline.saveFailedTitle":
    "Il server non accetta più modifiche per questo video (potrebbe essere in rendering o scaduto).",
  "app.timeline.saveRetryingTitle": "L'ultima modifica non è ancora arrivata al server. Nuovo tentativo…",
  "app.timeline.notSaved": "non salvato",
  "app.timeline.notSavedRetrying": "non salvato · nuovo tentativo",
  "app.timeline.undoTitle": "Annulla (⌘Z)",
  "app.timeline.undoAria": "Annulla",
  "app.timeline.redoTitle": "Ripeti (⌘⇧Z)",
  "app.timeline.redoAria": "Ripeti",
  "app.timeline.splitTitle": "Dividi la clip sotto il cursore",
  "app.timeline.split": "⧉ Dividi",
  "app.timeline.splitUnavailable": "Porta il cursore dentro una clip per dividerla (non proprio all'inizio o alla fine).",
  "app.timeline.zoomOutTitle": "Rimpicciolisci (mostra più video)",
  "app.timeline.zoomOutAria": "Rimpicciolisci",
  "app.timeline.fitTitle": "Adatta l'intero video",
  "app.timeline.fit": "Adatta",
  "app.timeline.zoomInTitle": "Ingrandisci (più dettaglio, taglio più preciso)",
  "app.timeline.zoomInAria": "Ingrandisci",
  "app.timeline.clipLabel": "Clip {n}",
  "app.timeline.moveLeft": "Sposta la clip a sinistra",
  "app.timeline.moveRight": "Sposta la clip a destra",
  "app.timeline.deleteTitle": "Elimina clip (⌫)",
  "app.timeline.delete": "✕ Elimina",
  "app.timeline.speed": "Velocità",
  "app.timeline.speedNormal": "1× (normale)",
  "app.timeline.volume": "Volume",
  "app.timeline.muteBadge": "M",
  "app.timeline.fadeIn": "Dissolvenza in entrata",
  "app.timeline.fadeOut": "Dissolvenza in uscita",
  "app.timeline.resetEffects": "Azzera effetti",
  // Legacy cut strip
  "app.timeline.cuts": "Tagli",
  "app.timeline.cutsRemoved": "{sec}s rimossi",
  "app.timeline.cutsRestored": " · {count} ripristinati",
  "app.timeline.cutTitleRestore": "Tagliato {from}–{to} (tocca per ripristinare)",
  "app.timeline.cutTitleRemoveAgain": "Tagliato {from}–{to} (tocca per rimuovere di nuovo)",
  "app.timeline.cutsLegend": "Rosso = rimosso · tocca per ripristinare. Trattini verdi = mantenuto.",

  // ── Voice commands (test modal + scene panel) ───────────────────────
  "app.voice.title": "Testa la tua voce",
  "app.voice.subtitle": "Pronuncia i comandi — verifica se Cleo ti sente.",
  "app.voice.close": "Chiudi",
  "app.voice.heardYou": "Ti ho sentito!",
  "app.voice.listening": "In ascolto…",
  "app.voice.heardPrefix": "sentito: ",
  "app.voice.permissionHint": "Usa il microfono. Il browser trasforma la tua voce in testo: Chrome la invia a Google, Safari ad Apple. A CleoCuts non arriva nulla.",
  "app.voice.requesting": "Richiesta in corso…",
  "app.voice.start": "Avvia",
  "app.voice.denied": "Permesso negato. Attivalo nelle impostazioni del browser e ricarica.",
  "app.voice.unsupported": "Non supportato in questo browser. Prova Safari o Chrome.",
  "app.voice.done": "Fatto",
  "app.voice.cmd.start": "Inizia la tua ripresa",
  "app.voice.cmd.cut": "Rifai, scarta la ripresa attuale",
  "app.voice.cmd.keep": "Confermare la ripresa, scena successiva",
  "app.voice.cmd.finish": "Termina il video, taglia tutto ciò che segue",
  "app.voice.cmd.stop": "Salta una frase sbagliata (usalo insieme a 'go')",
  "app.voice.cmd.go": "Riprendi dopo 'stop'",
  "app.voice.scene.heading": "Comandi vocali · {count} attivi",
  "app.voice.scene.hint": "Deseleziona i falsi rilevamenti, aggiungi quelli mancanti. I tagli si aggiornano automaticamente.",
  "app.voice.scene.add": "+ Aggiungi",
  "app.voice.scene.addAt": "Aggiungi comando al momento attuale del video",
  "app.voice.scene.none": "Nessun comando vocale rilevato.",
  "app.voice.scene.disable": "Disattiva",
  "app.voice.scene.enable": "Attiva",
  "app.voice.scene.heard": "sentito: “{text}”",
  "app.voice.scene.type.start": "Inizio",
  "app.voice.scene.type.keep": "Mantieni",
  "app.voice.scene.type.restart": "Taglia / Ricomincia",
  "app.voice.scene.type.finish": "Fine",

  // ── Landing: header ── */
  "site.header.homeAria": "Home di CleoCuts",
  "site.header.openEditor": "Apri l'editor",

  // ── Landing: hero ── */
  "site.hero.badge": "Beta aperta · gratis",
  // Replaces the badge once paid plans are live (NEXT_PUBLIC_BILLING_ENABLED).
  "site.hero.badgePricing": "Scopri piani e prezzi",
  "site.hero.titleLead": "Monta mentre",
  "site.hero.titleAccent": "registri.",
  "site.hero.sub":
    "Di' {cut} quando sbagli. Di' {finish} quando hai finito. Pronto da pubblicare in pochi minuti, con sottotitoli e tagli inclusi.",
  "site.hero.cta": "Prova CleoCuts",

  // ── Landing: caption showcase ── */
  "site.showcase.listening": "CleoCuts in ascolto",
  "site.showcase.captionStyle": "stile sottotitoli",
  "site.showcase.clipper": "IL PARLATO È L'EDITOR",
  "site.showcase.highlight": "PRONTO PER LA PUBBLICAZIONE",
  "site.showcase.flash": "DI' CUT",
  "site.showcase.punch": "PERFETTO",
  "site.showcase.elegant": "Ascolta e basta.",

  // ── Landing: features ── */
  "site.features.title": "Cosa fa CleoCuts.",
  "site.features.voice.title": "Comandi vocali",
  "site.features.voice.body":
    "Di' {cut} durante la ripresa. CleoCuts rimuove il tentativo fallito.",
  "site.features.cleanup.title": "Pulizia AI",
  "site.features.cleanup.body":
    "Corregge le parole riconosciute male e i nomi dei marchi nei tuoi sottotitoli.",
  "site.features.captions.title": "Sottotitoli animati",
  "site.features.captions.body": "Diversi stili, da Pulito a Clipper.",
  "site.features.vertical.title": "Verticale automatico",
  "site.features.vertical.body": "Orizzontale → 9:16 con face tracking.",
  "site.features.hooks.title": "I momenti migliori come clip",
  "site.features.hooks.body":
    "Nei video da 90 secondi in su, CleoCuts trova fino a {count} dei momenti migliori e ricava da ognuno una clip breve.",

  // ── Landing: how it works ── */
  "site.steps.title": "Tre passi.",
  "site.steps.sub": "Registra. Parla con CleoCuts. Pubblica.",
  "site.steps.record.title": "Registra",
  "site.steps.record.body": "Di' {cut} quando sbagli. Niente riprese ripetute.",
  "site.steps.record.hint": "Riprese di qualsiasi durata",
  "site.steps.upload.title": "Carica",
  "site.steps.upload.body": "Carica il tuo video. Scegli un workflow. L'AI fa il resto.",
  "site.steps.upload.hint": "Pochi minuti, in base alla durata",
  "site.steps.post.title": "Pubblica",
  "site.steps.post.body": "Scarica il tuo video finito, pronto per TikTok, Instagram e YouTube.",
  "site.steps.post.hint": "Scarica quando è pronto",

  // ── Landing: footer ── */
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
  "app.crash.saving": "Salvataggio delle ultime modifiche…",
  "app.crash.saved": "Le tue ultime modifiche sono salvate.",
  "app.crash.unsaved": "Le tue ultime modifiche potrebbero non essere state salvate.",
  "app.crash.body": "Ricarica la pagina per riprendere da dove eri rimasto.",
  "app.crash.reload": "Ricarica la pagina",
};
