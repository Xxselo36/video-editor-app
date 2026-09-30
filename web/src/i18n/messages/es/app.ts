import type { AppKey } from "../en";

export const esApp: Partial<Record<AppKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "Inicio de CleoCuts",
  "app.header.library": "Biblioteca",
  "app.header.beta": "Beta",
  "app.header.opening": "Abriendo…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — tu video está listo",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "No pudimos cargar el proyecto en este momento. Inténtalo de nuevo en un momento.",
  "app.notice.alreadyExporting": "Este video ya se está exportando. Su tarjeta muestra el progreso.",
  "app.notice.offline": "No podemos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Este proyecto ya no existe en el servidor (expiró o hubo una actualización). Vuelve a subir el video.",
  "app.errors.generic": "Algo salió mal. Inténtalo de nuevo.",
  "app.errors.connection": "Se perdió la conexión. Revisa tu internet e inténtalo de nuevo.",
  "app.errors.interrupted":
    "La subida se interrumpió (recargaste la página o cambiaste de app). Vuelve a subir el video.",
  "app.errors.tooLarge": "El archivo es demasiado grande. Recorta el video o expórtalo en un tamaño menor.",
  "app.errors.noSpeech": "No encontramos voz en este video. CleoCuts corta y subtitula videos en los que alguien habla: prueba con un clip con voz.",
  "app.errors.noSpeechRefunded": "No encontramos voz en este video. CleoCuts corta y subtitula videos en los que alguien habla: prueba con un clip con voz. Te devolvimos los minutos.",
  "app.errors.noAudioTrack": "Este video no tiene pista de audio, así que no hay nada que cortar ni subtitular. No se cobró nada.",
  "app.errors.renderFailed":
    "El renderizado falló. Tus ediciones están guardadas — abre el proyecto y vuelve a renderizar.",
  "app.errors.serverNoResponse": "El servidor no respondió. Inténtalo de nuevo.",
  "app.errors.serverBusy": "Nuestros servidores están ocupados ahora mismo. Inténtalo de nuevo en unos minutos.",
  "app.errors.saveEditsFailed": "No pudimos guardar tus ediciones — revisa tu conexión e inténtalo de nuevo.",
  "app.errors.title": "Algo salió mal",
  "app.errors.tryAgain": "Intentar de nuevo",
  // Accounts + billing (only reachable when they are switched on)
  "app.errors.signInRequired": "Tu sesión ha terminado. Vuelve a iniciar sesión e inténtalo de nuevo.",
  "app.errors.subscriptionRequired": "Para subir videos necesitas un plan. Elige uno en la página de precios.",
  "app.errors.quotaExceeded":
    "No te quedan suficientes minutos en este periodo para este video. Mejora tu plan o espera al reinicio.",
  "app.errors.unreadableVideo":
    "No pudimos leer este archivo de video. Vuelve a exportarlo como MP4 o MOV y súbelo.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "Este archivo pesa más de {max} GB. Recorta el video o expórtalo en un tamaño menor.",
  "app.errors.videoTooLong":
    "Este video dura más de {max} minutos. Recórtalo o divídelo en partes.",
  "app.errors.tooManyJobs":
    "Ya tienes el número máximo de videos en proceso. Espera a que uno esté listo y vuelve a intentarlo.",

  // ── Accounts ────────────────────────────────────────────────────────
  "app.auth.signInToContinue": "Inicia sesión para abrir tus proyectos.",
  "app.auth.loadFailed":
    "No pudimos cargar el inicio de sesión. Revisa tu conexión (o permite este sitio en tu bloqueador de contenido) e inténtalo de nuevo.",

  // ── Billing: upload blocked (402) + minutes left ────────────────────
  "app.paywall.subscriptionTitle": "Elige un plan para subir videos",
  "app.paywall.subscriptionBody":
    "Para subir videos necesitas un plan activo. Elige uno — solo te llevará un minuto y puedes cancelar cuando quieras.",
  "app.paywall.quotaTitle": "No te quedan suficientes minutos",
  "app.paywall.quotaBody": "Te quedan {left} min en este periodo — este video necesita {needed} min.",
  "app.paywall.quotaBodyUnknown": "Este video dura más que los minutos que te quedan en este periodo.",
  "app.paywall.seePlans": "Ver planes",
  "app.paywall.upgrade": "Mejorar plan",
  "app.paywall.close": "Ahora no",
  "app.billing.minutesLeft": "Te quedan {n} min en este periodo",
  "app.billing.choosePlan": "Elige un plan para subir videos",

  // ── Account page (/app/account) ─────────────────────────────────────
  "app.account.title": "Cuenta",
  "app.account.signedInAs": "Sesión iniciada como {email}",
  "app.account.plan": "Plan",
  "app.account.noPlan": "Aún no tienes plan",
  "app.account.freeBeta": "CleoCuts es gratis durante la beta abierta — no necesitas ningún plan.",
  "app.account.status.active": "Activo · se renueva el {date}",
  "app.account.status.activeNoDate": "Activo",
  "app.account.status.trial": "Prueba · primer pago el {date}",
  "app.account.status.cancelled": "Se cancela el {date}",
  "app.account.status.pastDue": "Pago vencido — actualiza tu método de pago.",
  "app.account.status.paused": "En pausa",
  "app.account.status.expired": "Caducado",
  "app.account.status.comp": "De cortesía",
  "app.account.usage": "Minutos de este periodo",
  "app.account.usageOf": "{used} de {limit} min usados",
  "app.account.resetsOn": "Se reinicia el {date}",
  "app.account.manage": "Gestionar suscripción",
  "app.account.manageHint":
    "Las facturas, el método de pago y la cancelación se gestionan en el portal de clientes de Lemon Squeezy.",
  "app.account.changePlan": "Cambiar plan",
  "app.account.choosePlan": "Elegir un plan",
  "app.account.portalFailed": "No pudimos abrir el portal de facturación. Inténtalo de nuevo en un momento.",
  "app.account.loadFailed": "No pudimos cargar tu cuenta en este momento. Inténtalo de nuevo en un momento.",
  "app.account.testMode": "Modo de prueba",
  "app.account.successPending": "¡Gracias! Tu pago se completó — activando tu plan…",
  "app.account.successDone": "Tu plan {plan} está activo. ¡A editar!",
  "app.account.successSlow":
    "Esto está tardando más de lo normal. Tu plan aparecerá aquí en unos minutos — recarga la página para comprobarlo.",

  // ── Library fallbacks ───────────────────────────────────────────────
  "app.library.untitled": "Sin título",

  // ── Workflow presets ────────────────────────────────────────────────
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Formato corto vertical",
  "app.preset.tiktok.desc": "Comandos de voz, subtítulos Clipper, recorte vertical automático",
  "app.preset.tiktok.bullet1": "Comandos de voz activados: di “Cleo cut” para repetir",
  "app.preset.tiktok.bullet2": "Subtítulos llamativos estilo Clipper",
  "app.preset.tiktok.bullet3": "Vertical automático 9:16 con seguimiento facial",
  "app.preset.podcast.label": "Podcast en formato largo",
  "app.preset.podcast.tagline": "Episodio completo + clips",
  "app.preset.podcast.desc": "Limpieza con IA, detección de ganchos, exportación multiformato",
  "app.preset.podcast.bullet1": "Limpieza con IA en tu transcripción",
  "app.preset.podcast.bullet2": "3 clips gancho elegidos automáticamente",
  "app.preset.podcast.bullet3": "Episodio completo + clips 9:16 exportados",
  "app.preset.vlog.label": "Limpieza de vlog",
  "app.preset.vlog.tagline": "Solo hablando a cámara",
  "app.preset.vlog.desc": "Elimina muletillas, subtítulos discretos, mantiene el formato",
  "app.preset.vlog.bullet1": "Elimina “ehh”, “eh”, pausas largas",
  "app.preset.vlog.bullet2": "Subtítulos discretos que no distraen",
  "app.preset.vlog.bullet3": "Mantiene tu formato original",
  "app.preset.captions.label": "Solo subtítulos",
  "app.preset.captions.tagline": "Solo agrega subtítulos",
  "app.preset.captions.desc": "Incrusta subtítulos en tu video — sin cortes, sin limpieza",
  "app.preset.captions.bullet1": "Incrusta subtítulos en el estilo que elijas",
  "app.preset.captions.bullet2": "Sin cortes, sin limpieza",
  "app.preset.captions.bullet3": "El más rápido — solo subtítulos",
  "app.preset.custom.label": "Personalizado",
  "app.preset.custom.tagline": "Configura todo",
  "app.preset.custom.desc": "Ajustes completos — elige cada detalle tú mismo",
  "app.preset.custom.bullet1": "Todos los ajustes disponibles",
  "app.preset.custom.bullet2": "Elige subtítulos, cortes y formato tú mismo",
  "app.preset.custom.bullet3": "Para cuando ya sabes lo que quieres",

  // ── Caption styles ──────────────────────────────────────────────────
  "app.captions.clean": "Limpio",
  "app.captions.classic": "Clásico",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Resaltado",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Impacto",
  "app.captions.elegant": "Elegante",
  "app.captions.subtle": "Sutil",
  "app.captions.none": "Sin subtítulos",

  // ── Cut styles ──────────────────────────────────────────────────────
  "app.cutStyle.tight.label": "Ajustado",
  "app.cutStyle.tight.desc": "Agresivo",
  "app.cutStyle.balanced.label": "Equilibrado",
  "app.cutStyle.balanced.desc": "Predeterminado",
  "app.cutStyle.smooth.label": "Suave",
  "app.cutStyle.smooth.desc": "Conserva pausas",

  // ── Export formats ──────────────────────────────────────────────────
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Feed de Instagram",
  "app.format.16x9.desc": "YouTube / escritorio",

  // ── Dashboard ───────────────────────────────────────────────────────
  "app.dashboard.workspace": "Tu espacio de trabajo",
  "app.dashboard.inProgressCountOne": "{count} video en progreso",
  "app.dashboard.inProgressCountOther": "{count} videos en progreso",
  "app.dashboard.readyCountOne": "{count} video listo para revisar",
  "app.dashboard.readyCountOther": "{count} videos listos para revisar",
  "app.dashboard.failedCountOne": "{count} video con error",
  "app.dashboard.failedCountOther": "{count} videos con error",
  "app.dashboard.readyWhenYouAre": "Listo cuando quieras",
  "app.dashboard.newVideo": "Nuevo video",
  "app.dashboard.inProgress": "En progreso",
  "app.dashboard.recentProjects": "Proyectos recientes",
  "app.dashboard.viewAll": "Ver todos",
  "app.dashboard.startFirst": "Empieza tu primer video",
  "app.dashboard.startFirstSub": "Elige un flujo de trabajo — CleoCuts se encarga de subtítulos, formato y limpieza",
  "app.dashboard.voiceTeaser": "Di “Cleo” mientras grabas — ahorra horas de edición",

  // ── Workflow picker ─────────────────────────────────────────────────
  "app.picker.backToDashboard": "Volver al panel",
  "app.picker.freeDuringBeta": "Gratis durante la beta",
  "app.picker.title": "¿Qué vas a publicar?",
  "app.picker.subtitle":
    "Elige un flujo de trabajo — CleoCuts preconfigura subtítulos, formato y limpieza para la plataforma.",
  "app.picker.chipCaptions": "Subtítulos {style}",
  "app.picker.chipVoice": "\"Cleo cut\" activado",
  "app.picker.customTitle": "Configuración personalizada",
  "app.picker.customSub": "Elige cada detalle tú mismo — subtítulos, cortes, formatos",

  // ── Upload (choose a file) ──────────────────────────────────────────
  "app.upload.back": "Atrás",
  "app.upload.title": "Elige un video",
  "app.upload.hint":
    "MP4 o MOV desde tu teléfono o computadora. Mantén esta página abierta hasta que termine la subida.",
  "app.upload.tapToChoose": "Toca para elegir",
  "app.upload.orDrag": "o arrastra uno aquí",
  "app.upload.privacyLink": "Cómo tratamos tus videos",
  "app.upload.resuming":
    "Reanudando la subida donde se quedó — mantén esta página abierta.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "atrás",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "Estilo de subtítulos",
  "app.configure.captionPreviewAlt": "Vista previa de subtítulos {style}",
  "app.configure.cutStyle": "Estilo de corte",
  "app.configure.cleanup": "Limpieza",
  "app.configure.voiceTriggers": "Escuchar \"Cleo cut\" / \"Cleo go\"",
  "app.configure.voiceTriggersDesc": "Elimina automáticamente las tomas fallidas",
  "app.configure.removeFillers": "Eliminar muletillas",
  "app.configure.removeFillersDesc": "Elimina \"ehh\", \"eh\", \"o sea\"…",
  "app.configure.smartReframe": "Reencuadre inteligente",
  "app.configure.smartcam": "Seguimiento facial SmartCam",
  "app.configure.smartcamDesc": "Reencuadre automático para salida vertical/horizontal",
  "app.configure.portrait": "vertical",
  "app.configure.landscape": "horizontal",
  "app.configure.portraitDesc": "Vertical 9:16",
  "app.configure.landscapeDesc": "Horizontal 16:9",
  "app.configure.extraFormats": "Formatos de salida adicionales",
  "app.configure.extraFormatsHint":
    "La exportación principal usa tu formato SmartCam (o el formato original). Elige versiones adicionales con barras negras para otras plataformas.",
  "app.configure.process": "Procesar video",

  // ── Done screen ─────────────────────────────────────────────────────
  "app.done.readyToPost": "Listo para publicar",
  "app.done.captionSuggestion": "Sugerencia de descripción",
  "app.done.copy": "copiar",
  "app.done.downloadPrimary": "Descargar principal",
  "app.done.downloadFormat": "Descargar {format}",
  "app.done.mainEdit": "Edición principal",
  "app.done.bonusClips": "Clips extra",
  "app.done.aiPicked": "Elegido por IA",
  "app.done.processAnother": "Procesar otro",

  // ── Dashboard job cards ─────────────────────────────────────────────
  "app.card.noPreview": "sin vista previa",
  "app.card.uploading.title": "Subiendo",
  "app.card.uploading.sub": "Subiendo — mantén esta página abierta y no bloquees tu teléfono.",
  "app.card.analyzing.title": "Analizando",
  "app.card.analyzing.sub": "Transcribiendo y cortando pausas y muletillas.",
  "app.card.reviewing.title": "Listo para editar",
  "app.card.reviewing.sub": "Toca para abrir el editor y ajustar el corte.",
  "app.card.rendering.title": "Renderizando",
  "app.card.rendering.sub": "Armando tu video final.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "En cola (#{n})",
  "app.card.queued.titleNoPos": "En cola",
  "app.card.queued.sub":
    "Hay muchos videos ahora mismo — el tuyo empezará automáticamente. Puedes salir de esta página.",
  "app.card.open": "Abrir",
  "app.card.remove": "Eliminar",
  "app.card.renderFailedNote": "El renderizado falló — tus ediciones están guardadas. Ábrelo y vuelve a renderizar.",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Estilo de subtítulos · {style}",
  "app.captions.appliedToOutput": "Aplicado a la salida",
  "app.captions.disabled": "Subtítulos desactivados para este renderizado.",

  // ── Voice test (dialog) ─────────────────────────────────────────────
  "app.voice.title": "Prueba tu voz",
  "app.voice.subtitle": "Di los comandos — comprueba si Cleo te escucha.",
  "app.voice.close": "Cerrar",
  "app.voice.heardYou": "¡Te escuché!",
  "app.voice.listening": "Escuchando…",
  "app.voice.heardPrefix": "escuché: ",
  "app.voice.permissionHint": "Usa tu micrófono. Tu navegador convierte tu voz en texto: Chrome la envía a Google para eso y Safari a Apple. Nada llega a CleoCuts.",
  "app.voice.requesting": "Solicitando…",
  "app.voice.start": "Iniciar",
  "app.voice.denied": "Permiso denegado. Actívalo en la configuración del navegador y recarga.",
  "app.voice.unsupported": "No es compatible con este navegador. Prueba Safari o Chrome.",
  "app.voice.done": "Listo",
  "app.voice.cmd.start": "Comienza tu toma",
  "app.voice.cmd.cut": "Repetir, descarta la toma actual",
  "app.voice.cmd.keep": "Confirma la toma, siguiente escena",
  "app.voice.cmd.finish": "Termina el video, corta todo lo que sigue",
  "app.voice.cmd.stop": "Salta una oración mala (combínalo con 'go')",
  "app.voice.cmd.go": "Reanuda después de 'stop'",
  "app.crash.saving": "Guardando tus últimos cambios…",
  "app.crash.saved": "Tus últimos cambios están guardados.",
  "app.crash.unsaved": "Es posible que tus últimos cambios no se hayan guardado.",
  "app.crash.body": "Recarga la página para seguir donde lo dejaste.",
  "app.crash.reload": "Recargar la página",

  // ── Error codes, warnings, stages (UX5, lib/errorKeys.ts) ────────
  "app.errors.noVideoTrack": "Esto es un archivo de audio. CleoCuts necesita un vídeo con sonido: elige un archivo de vídeo. No se ha cobrado nada.",
  "app.errors.videoTooShort": "Este vídeo dura menos de {min} segundos: es demasiado corto para cortarlo. No se ha cobrado nada.",
  "app.errors.processingInterrupted": "El procesamiento se interrumpió. Vuelve a subir el vídeo.",
  "app.errors.mediaUnavailable": "El vídeo original ya no está disponible, así que este proyecto no se puede volver a editar.",
  "app.errors.tooManyRenders": "Hay demasiadas exportaciones en curso. Espera a que termine una.",
  "app.errors.renderLimit": "Este vídeo ha alcanzado su límite de exportaciones de hoy. Vuelve a intentarlo mañana.",
  "app.errors.staleRev": "Este proyecto se cambió en otra pestaña. Recarga para ver la versión más reciente.",
  "app.errors.docNotReady": "Este proyecto aún no está listo. Vuelve a intentarlo en un momento.",
  "app.errors.refunded": "Te hemos devuelto los minutos.",
  "app.errors.tryAnotherVideo": "Probar con otro vídeo",
  "app.warnings.scriptUnsupported": "Los subtítulos aún no están disponibles para la escritura de este idioma.",
  "app.warnings.smartcamFailed": "El seguimiento del hablante no funcionó en este vídeo, así que se recortó por el centro.",
  "app.audio.silent": "El audio parece estar en silencio: comprueba que el micrófono esté encendido y no silenciado.",
  "app.audio.quiet": "El audio es muy bajo: la próxima vez habla más cerca del micrófono.",
  "app.audio.clipping": "El audio satura en los picos: la grabación está demasiado alta y habrá distorsión.",
  "app.stage.queued": "Esperando un hueco libre",
  "app.stage.analyze.normalize": "Preparando tu vídeo",
  "app.stage.analyze.smartcam": "Siguiendo al hablante",
  "app.stage.analyze.transcribe": "Transcribiendo",
  "app.stage.analyze.cleanup": "Puliendo la transcripción",
  "app.stage.analyze.cuts": "Buscando los cortes",
  "app.stage.analyze.captions": "Preparando subtítulos",
  "app.stage.analyze.done": "Listo para revisar",
  "app.stage.render.prepare": "Preparando la exportación",
  "app.stage.render.captions": "Añadiendo subtítulos ({i}/{n})",
  "app.stage.render.encode": "Exportando",
  "app.stage.render.hooks": "Cortando momentos destacados",
  "app.stage.render.finish": "Terminando",
};
