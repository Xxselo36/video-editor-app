import type { SiteKey } from "../en";

export const esSite: Partial<Record<SiteKey, string>> = {
  /* ── Landing: header ── */
  "site.header.homeAria": "Inicio de CleoCuts",
  "site.header.openEditor": "Abrir editor",

  /* ── Landing: hero ── */
  "site.hero.badge": "Beta abierta · gratis",
  "site.hero.badgePricing": "Ver planes y precios",
  "site.hero.titleLead": "Edita mientras",
  "site.hero.titleAccent": "grabas.",
  "site.hero.sub":
    "Di {cut} cuando te equivoques. Di {finish} cuando termines. Listo para publicar en minutos, con subtítulos y cortes incluidos.",
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
  "site.features.cleanup.body":
    "Corrige palabras mal reconocidas y nombres de marca en tus subtítulos.",
  "site.features.captions.title": "Subtítulos animados",
  "site.features.captions.body": "Varios estilos, de Limpio a Clipper.",
  "site.features.vertical.title": "Vertical automático",
  "site.features.vertical.body": "Horizontal → 9:16 con seguimiento facial.",
  "site.features.hooks.title": "Los mejores momentos, como clips",
  "site.features.hooks.body":
    "En videos de 90 segundos o más, CleoCuts encuentra hasta {count} de los mejores momentos y convierte cada uno en un clip corto.",

  /* ── Landing: how it works ── */
  "site.steps.title": "Tres pasos.",
  "site.steps.sub": "Graba. Habla con CleoCuts. Publica.",
  "site.steps.record.title": "Grabar",
  "site.steps.record.body": "Di {cut} cuando te equivoques. Sin repetir tomas.",
  "site.steps.record.hint": "Tomas de cualquier duración",
  "site.steps.upload.title": "Subir",
  "site.steps.upload.body": "Sube tu video. Elige un flujo de trabajo. La IA hace el resto.",
  "site.steps.upload.hint": "Unos minutos, según la duración",
  "site.steps.post.title": "Publicar",
  "site.steps.post.body": "Descarga tu video terminado, listo para TikTok, Instagram y YouTube.",
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
  "common.videoModal.dialogLabel": "Vista previa del video",

  /* ── Accounts (header, all pages) ── */
  "common.auth.signIn": "Iniciar sesión",
  "common.auth.account": "Cuenta",
  "common.auth.pricing": "Precios",
  "common.language": "Idioma",
  "common.footer.legalAria": "Información legal",
  "legal.onlyDeEn":
    "Esta página solo está disponible en alemán e inglés. Estás leyendo la versión en inglés.",
  "common.backHome": "Volver al inicio",
  "common.notFound.title": "Página no encontrada",
  "common.notFound.body": "Esta página no existe o se ha movido.",
  "common.error.title": "Algo salió mal",
  "common.error.body": "No se pudo mostrar esta página. Inténtalo de nuevo.",
  "common.error.retry": "Intentar de nuevo",
  "common.error.ref": "Referencia del error: {id}",
};
