import type { MessageKey } from "./en";

export const es: Partial<Record<MessageKey, string>> = {
  // ── Header ──────────────────────────────────────────────────────────
  "app.header.homeAria": "Inicio de CleoCuts",
  "app.header.library": "Biblioteca",
  "app.header.beta": "Beta",
  "app.header.opening": "Abriendo…",

  // ── Browser notifications ───────────────────────────────────────────
  "app.notify.readyTitle": "CleoCuts — tu video está listo",
  "app.notify.clickToView": "Haz clic para verlo",
  "app.notify.reviewTitle": "CleoCuts — listo para tu revisión",
  "app.notify.reviewBody": "Los cortes y la transcripción están listos. Toca para revisar.",

  // ── Toasts / notices ────────────────────────────────────────────────
  "app.notice.loadFailed": "No pudimos cargar el proyecto en este momento. Inténtalo de nuevo en un momento.",
  "app.notice.done": "Este video está listo — lo encontrarás en Recientes y en tu Biblioteca.",
  "app.notice.processing": "Este video todavía se está procesando. La tarjeta muestra su progreso.",
  "app.notice.offline": "No podemos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.",

  // ── Errors ──────────────────────────────────────────────────────────
  "app.errors.expired":
    "Este proyecto ya no existe en el servidor (expiró o hubo una actualización). Vuelve a subir el video.",
  "app.errors.generic": "Algo salió mal. Inténtalo de nuevo.",
  "app.errors.connection": "Se perdió la conexión. Revisa tu internet e inténtalo de nuevo.",
  "app.errors.interrupted":
    "La subida se interrumpió (recargaste la página o cambiaste de app). Vuelve a subir el video.",
  "app.errors.tooLarge": "El archivo es demasiado grande. Recorta el video o expórtalo en un tamaño menor.",
  "app.errors.noAudio": "No se encontró audio utilizable en el video.",
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
  "app.dashboard.readyWhenYouAre": "Listo cuando quieras",
  "app.dashboard.newVideo": "Nuevo video",
  "app.dashboard.inProgress": "En progreso",
  "app.dashboard.recentProjects": "Proyectos recientes",
  "app.dashboard.viewAll": "Ver todos →",
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
  "app.upload.back": "← Atrás",
  "app.upload.title": "Elige un video",
  "app.upload.hint":
    "MP4 o MOV desde tu teléfono o computadora. Mantén esta página abierta hasta que termine la subida.",
  "app.upload.tapToChoose": "Toca para elegir",
  "app.upload.orDrag": "o arrastra uno aquí",
  "app.upload.keepTabOpen":
    "Mantén esta pestaña abierta hasta que termine la subida. Cambiar de app o bloquear tu teléfono cancelará la subida.",

  // ── Configure (custom settings) ─────────────────────────────────────
  "app.configure.back": "← atrás",
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

  // ── Progress screen ─────────────────────────────────────────────────
  "app.progress.uploading": "Subiendo",
  "app.progress.rendering": "Renderizando",
  "app.progress.processing": "Procesando",
  "app.progress.stage.prep": "Preparando tu video",
  "app.progress.stage.listen": "Escuchando tu voz",
  "app.progress.stage.polish": "Buscando las mejores tomas",
  "app.progress.stage.preview": "Casi listo",
  "app.progress.stage.burn": "Aplicando tus ediciones",
  "app.progress.stage.stitch": "Uniéndolo todo",
  "app.progress.stage.finish": "Últimos detalles",

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
  "app.card.open": "Abrir →",
  "app.card.remove": "✕ Eliminar",
  "app.card.renderFailedNote": "El renderizado falló — tus ediciones están guardadas. Ábrelo y vuelve a renderizar.",

  // ── Review (editor) ─────────────────────────────────────────────────
  "app.review.backToDashboard": "← Panel",
  "app.review.sentencesOne": "{count} oración",
  "app.review.sentencesOther": "{count} oraciones",
  "app.review.audioHeadsUp": "Aviso de audio",
  "app.review.updatingPreview": "Actualizando vista previa…",
  "app.review.captionSampleAlt": "Ejemplo de subtítulos {style}",
  "app.review.captionsLookLike": "Los subtítulos se verán así",
  "app.review.tabTimeline": "Línea de tiempo",
  "app.review.tabTranscript": "Transcripción",
  "app.review.tabCaptions": "Subtítulos",
  "app.review.preparing": "Preparando…",
  "app.review.applyRender": "Aplicar y renderizar",

  // ── Transcript tab ──────────────────────────────────────────────────
  "app.transcript.lineDeleted": "Línea eliminada",
  "app.transcript.undo": "↶ Deshacer",
  "app.transcript.headingOne": "Transcripción · {count} línea",
  "app.transcript.headingOther": "Transcripción · {count} líneas",
  "app.transcript.hint": "Corrige errores, elimina una línea con ✕, toca una tarjeta para ir a ese momento.",
  "app.transcript.empty": "Sin subtítulos. La salida será solo video.",
  "app.transcript.verify": "verificar",
  "app.transcript.deleteSentence": "Eliminar oración",

  // ── Captions tab ────────────────────────────────────────────────────
  "app.captions.styleHeading": "Estilo de subtítulos · {style}",
  "app.captions.appliedToOutput": "Aplicado a la salida",
  "app.captions.disabled": "Subtítulos desactivados para este renderizado.",

  // ── Timeline editor ─────────────────────────────────────────────────
  "app.timeline.title": "Línea de tiempo",
  "app.timeline.clipsOne": "{count} clip · {dur}",
  "app.timeline.clipsOther": "{count} clips · {dur}",
  "app.timeline.saving": "guardando",
  "app.timeline.saveFailedTitle":
    "El servidor ya no acepta cambios para este video (puede estar renderizando o haber expirado).",
  "app.timeline.saveRetryingTitle": "Tu último cambio aún no llegó al servidor. Reintentando…",
  "app.timeline.notSaved": "no guardado",
  "app.timeline.notSavedRetrying": "no guardado · reintentando",
  "app.timeline.hintDesktop":
    "Desplaza para mover · Ctrl/⌘ + desplazar para zoom · arrastra los bordes para recortar · Espacio reproducir · ⌫ eliminar · ⌘Z deshacer",
  "app.timeline.hintMobile":
    "Desliza para desplazar · pellizca para zoom · toca un clip para editar · arrastra la regla para navegar",
  "app.timeline.undoTitle": "Deshacer (⌘Z)",
  "app.timeline.undoAria": "Deshacer",
  "app.timeline.redoTitle": "Rehacer (⌘⇧Z)",
  "app.timeline.redoAria": "Rehacer",
  "app.timeline.splitTitle": "Divide el clip bajo el cabezal de reproducción",
  "app.timeline.split": "⧉ Dividir",
  "app.timeline.zoomOutTitle": "Alejar (mostrar más del video)",
  "app.timeline.zoomOutAria": "Alejar",
  "app.timeline.fitTitle": "Ajustar todo el video",
  "app.timeline.fit": "Ajustar",
  "app.timeline.zoomInTitle": "Acercar (más detalle, recorte más fino)",
  "app.timeline.zoomInAria": "Acercar",
  "app.timeline.clipLabel": "Clip {n}",
  "app.timeline.moveLeft": "Mover clip a la izquierda",
  "app.timeline.moveRight": "Mover clip a la derecha",
  "app.timeline.deleteTitle": "Eliminar clip (⌫)",
  "app.timeline.delete": "✕ Eliminar",
  "app.timeline.speed": "Velocidad",
  "app.timeline.speedNormal": "1× (normal)",
  "app.timeline.volume": "Volumen",
  "app.timeline.muteBadge": "M",
  "app.timeline.fadeIn": "Aparición gradual",
  "app.timeline.fadeOut": "Desaparición gradual",
  "app.timeline.resetEffects": "Restablecer efectos",
  // Legacy cut strip
  "app.timeline.cuts": "Cortes",
  "app.timeline.cutsRemoved": "{sec}s eliminados",
  "app.timeline.cutsRestored": " · {count} restaurados",
  "app.timeline.cutTitleRestore": "Corte {from}–{to} (toca para restaurar)",
  "app.timeline.cutTitleRemoveAgain": "Corte {from}–{to} (toca para eliminar de nuevo)",
  "app.timeline.cutsLegend": "Rojo = eliminado · toca para restaurar. Líneas verdes = conservado.",

  // ── Voice commands (test modal + scene panel) ───────────────────────
  "app.voice.title": "Prueba tu voz",
  "app.voice.subtitle": "Di los comandos — comprueba si Cleo te escucha.",
  "app.voice.close": "Cerrar",
  "app.voice.heardYou": "¡Te escuché!",
  "app.voice.listening": "Escuchando…",
  "app.voice.heardPrefix": "escuché: ",
  "app.voice.permissionHint": "Usa tu cámara y micrófono. Todo se queda en tu navegador.",
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
  "app.voice.scene.heading": "Comandos de voz · {count} activos",
  "app.voice.scene.hint": "Desmarca detecciones falsas, agrega las que falten. Los cortes se actualizan automáticamente.",
  "app.voice.scene.add": "+ Agregar",
  "app.voice.scene.addAt": "Agregar comando en el momento actual del video",
  "app.voice.scene.none": "No se detectaron comandos de voz.",
  "app.voice.scene.disable": "Desactivar",
  "app.voice.scene.enable": "Activar",
  "app.voice.scene.heard": "escuché: “{text}”",
  "app.voice.scene.type.start": "Inicio",
  "app.voice.scene.type.keep": "Conservar",
  "app.voice.scene.type.restart": "Cortar / Reiniciar",
  "app.voice.scene.type.finish": "Finalizar",

  /* ── Landing: header ── */
  "site.header.homeAria": "Inicio de CleoCuts",
  "site.header.openEditor": "Abrir editor",

  /* ── Landing: hero ── */
  "site.hero.badge": "Beta abierta · gratis",
  "site.hero.badgePricing": "Ver planes y precios",
  "site.hero.titleLead": "Edita mientras",
  "site.hero.titleAccent": "grabas.",
  "site.hero.sub":
    "Di {cut} cuando te equivoques. Di {finish} cuando termines. Listo para publicar en minutos, con subtítulos, cortes y varios formatos incluidos.",
  "site.hero.cta": "Probar CleoCuts",

  /* ── Landing: caption showcase ── */
  "site.showcase.listening": "CleoCuts escuchando",
  "site.showcase.captionStyle": "estilo de subtítulos",
  "site.showcase.clipper": "TU VOZ ES EL EDITOR",
  "site.showcase.highlight": "LISTO PARA PUBLICAR",
  "site.showcase.flash": "DI CUT",
  "site.showcase.punch": "LO CLAVASTE",
  "site.showcase.elegant": "Simplemente escucha.",

  /* ── Landing: features ── */
  "site.features.title": "Qué hace CleoCuts.",
  "site.features.voice.title": "Comandos de voz",
  "site.features.voice.body": "Di {cut} a mitad de la toma. CleoCuts elimina el intento fallido.",
  "site.features.cleanup.title": "Limpieza con IA",
  "site.features.cleanup.body": "Corrige errores de tipeo, nombres de marca y homófonos.",
  "site.features.captions.title": "{count} estilos de subtítulos",
  "site.features.captions.body": "De Clean a Clipper. Fuentes reales.",
  "site.features.captions.decoration": "FUENTES REALES",
  "site.features.vertical.title": "Vertical automático",
  "site.features.vertical.body": "Horizontal → 9:16 con seguimiento facial.",
  "site.features.multiformat.title": "Multiformato",
  "site.features.multiformat.body": "{formats} en un solo renderizado.",
  "site.features.hooks.title": "Selector de clips gancho",
  "site.features.hooks.body":
    "CleoCuts encuentra los {count} mejores momentos de tu video largo y los convierte en reels independientes.",

  /* ── Landing: how it works ── */
  "site.steps.title": "Tres pasos.",
  "site.steps.sub": "Graba. Habla con CleoCuts. Publica.",
  "site.steps.record.title": "Grabar",
  "site.steps.record.body": "Di {cut} cuando te equivoques. Sin retomas.",
  "site.steps.record.hint": "Tomas de cualquier duración",
  "site.steps.upload.title": "Subir",
  "site.steps.upload.body": "Sube tu video. Elige un flujo de trabajo. La IA hace el resto.",
  "site.steps.upload.hint": "Unos minutos, según la duración",
  "site.steps.post.title": "Publicar",
  "site.steps.post.body": "Obtén {formats} listos para TikTok, Instagram y YouTube.",
  "site.steps.post.hint": "Descárgalo cuando esté listo",

  /* ── Landing: footer ── */
  "site.footer.editor": "Editor",
  "site.footer.library": "Biblioteca",
  "site.footer.imprint": "Aviso legal",
  "site.footer.privacy": "Privacidad",
  "site.footer.terms": "Términos",
  "site.footer.pricing": "Precios",

  /* ── Pricing page ── */
  "site.pricing.title": "Precios sencillos",
  "site.pricing.subtitle": "Paga cada mes por los minutos de video que subes. Cancela cuando quieras.",
  "site.pricing.perMonth": "/ mes",
  "site.pricing.perYear": "/ año",
  "site.pricing.priceAtCheckout": "Precio indicado al pagar",
  "site.pricing.popular": "El más popular",
  "site.pricing.minutes": "{minutes} min de video al mes",
  "site.pricing.retention": "Proyectos guardados durante {days} días",
  "site.pricing.featureWorkflows": "Todos los flujos de trabajo y estilos de subtítulos",
  "site.pricing.featureVoice": "Comandos de voz y limpieza con IA",
  "site.pricing.featureFormats": "Exportaciones en {formats}",
  "site.pricing.choose": "Elegir {plan}",
  "site.pricing.current": "Tu plan actual",
  "site.pricing.manage": "Gestionar suscripción",
  "site.pricing.switch": "Cambiar a {plan}",
  "site.pricing.unavailable": "Aún no disponible",
  "site.pricing.redirecting": "Abriendo el pago…",
  "site.pricing.checkoutFailed": "No pudimos abrir el pago. Inténtalo de nuevo en un momento.",
  "site.pricing.loadFailed": "No pudimos cargar los planes. Inténtalo de nuevo en un momento.",
  "site.pricing.minutesHint":
    "Los minutos cuentan la duración de los videos que subes. Los minutos que no uses no se acumulan para el mes siguiente.",
  "site.pricing.vatNote":
    "Los precios incluyen IVA. Los pagos los gestiona Lemon Squeezy, nuestro comerciante registrado (Merchant of Record) — ellos te cobran y te envían las facturas.",
  "site.pricing.testMode": "Modo de prueba — sin pagos reales",
  "site.pricing.testersOnly": "Aún no se pueden comprar planes: el pago está en modo de prueba, solo para testers invitados.",
  "site.pricing.betaTitle": "Gratis durante la beta abierta",
  "site.pricing.betaBody": "CleoCuts es gratis mientras estamos en beta. Pronto llegarán planes de pago con más minutos.",

  /* ── Library: header ── */
  "library.header.homeAria": "Editor de CleoCuts",
  "library.header.title": "Biblioteca",
  "library.header.newProject": "Nuevo proyecto",

  /* ── Library: list ── */
  "library.count.one": "{count} proyecto",
  "library.count.other": "{count} proyectos",
  "library.confirmDelete": "¿Eliminar este proyecto para siempre? El vídeo y todas las ediciones se borran de nuestros servidores.",
  "library.deleteFailed": "No se pudo eliminar ahora: si el vídeo aún se está procesando, inténtalo de nuevo en un momento.",

  /* ── Library: empty state ── */
  "library.empty.title": "Tu biblioteca está vacía",
  "library.empty.body":
    "Cada video que termines aparecerá aquí. Puedes volver a descargarlo, copiar tus subtítulos y compartir clips gancho en cualquier momento.",
  "library.empty.cta": "Empieza tu primer proyecto",

  /* ── Library: project card ── */
  "library.card.playAria": "Reproducir vista previa de {name}",
  "library.card.noPreview": "sin vista previa",
  "library.card.customPreset": "Personalizado",
  "library.card.deleteAria": "Eliminar proyecto",
  "library.card.expiresDays": "Se elimina automáticamente en {n} días",
  "library.card.expiresSoon": "Se elimina en menos de 24 horas",
  "library.card.expired": "Caducado: los archivos se eliminaron",
  "library.card.hooks.one": "{count} gancho",
  "library.card.hooks.other": "{count} ganchos",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Descripción",
  "library.card.copy": "copiar",
  "library.card.copied": "copiado",

  /* ── Library: download labels ── */
  "library.format.primary": "Edición principal",
  "library.format.hook": "Clip gancho {n}",

  /* ── Library: relative time ── */
  "library.time.justNow": "justo ahora",
  "library.time.minutesAgo": "hace {n} min",
  "library.time.hoursAgo": "hace {n} h",
  "library.time.daysAgo": "hace {n} d",

  /* ── Shared components ── */
  "common.videoModal.closeAria": "Cerrar vista previa",
  "common.videoModal.close": "Cerrar",

  /* ── Accounts (header, all pages) ── */
  "common.auth.signIn": "Iniciar sesión",
  "common.auth.account": "Cuenta",
  "common.auth.pricing": "Precios",
};
