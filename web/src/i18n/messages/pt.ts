import type { MessageKey } from "./en";

export const pt: Partial<Record<MessageKey, string>> = {
  // ── site: header ──
  "site.header.homeAria": "Início da CleoCuts",
  "site.header.openEditor": "Abrir editor",

  // ── site: hero ──
  "site.hero.badge": "Beta aberto · gratuito",
  "site.hero.badgePricing": "Ver planos e preços",
  "site.hero.titleLead": "Edite enquanto",
  "site.hero.titleAccent": "grava.",
  "site.hero.sub":
    "Diga {cut} quando errar. Diga {finish} quando terminar. Pronto para postar em minutos, com legendas e cortes incluídos.",
  "site.hero.cta": "Experimentar a CleoCuts",

  // ── site: caption showcase ──
  "site.showcase.listening": "CleoCuts ouvindo",
  "site.showcase.captionStyle": "estilo de legenda",
  "site.showcase.clipper": "A FALA É A EDIÇÃO",
  "site.showcase.highlight": "PRONTO PARA POSTAR",
  "site.showcase.flash": "DIGA CUT",
  "site.showcase.punch": "ARRASOU",
  "site.showcase.elegant": "Ela só escuta.",

  // ── site: features ──
  "site.features.title": "O que a CleoCuts faz.",
  "site.features.voice.title": "Comandos de voz",
  "site.features.voice.body": "Diga {cut} no meio da tomada. A CleoCuts remove a tentativa falha.",
  "site.features.cleanup.title": "Limpeza com IA",
  "site.features.cleanup.body":
    "Corrige palavras mal reconhecidas e nomes de marca nas suas legendas.",
  "site.features.captions.title": "Legendas animadas",
  "site.features.captions.body": "Vários estilos, de Clean a Clipper.",
  "site.features.vertical.title": "Vertical automático",
  "site.features.vertical.body": "Paisagem → 9:16 com rastreamento de rosto.",
  "site.features.hooks.title": "Os melhores momentos em clipes",
  "site.features.hooks.body":
    "Em vídeos de 90 segundos ou mais, a CleoCuts encontra até {count} dos melhores momentos e transforma cada um em um clipe curto.",

  // ── site: how it works ──
  "site.steps.title": "Três passos.",
  "site.steps.sub": "Grave. Fale com a CleoCuts. Poste.",
  "site.steps.record.title": "Grave",
  "site.steps.record.body": "Diga {cut} quando errar. Sem regravações.",
  "site.steps.record.hint": "Tomadas de qualquer duração",
  "site.steps.upload.title": "Envie",
  "site.steps.upload.body": "Envie seu vídeo. Escolha um fluxo de trabalho. A IA faz o resto.",
  "site.steps.upload.hint": "Alguns minutos, dependendo da duração",
  "site.steps.post.title": "Poste",
  "site.steps.post.body": "Baixe seu vídeo finalizado, pronto para TikTok, Instagram e YouTube.",
  "site.steps.post.hint": "Baixe quando estiver pronto",

  // ── site: footer ──
  "site.footer.editor": "Editor",
  "site.footer.library": "Biblioteca",
  "site.footer.imprint": "Aviso legal",
  "site.footer.privacy": "Privacidade",
  "site.footer.terms": "Termos",
  "site.footer.pricing": "Preços",

  // ── site: pricing page ──
  "site.pricing.title": "Preços simples",
  "site.pricing.subtitle": "Pague por mês pelos minutos de vídeo que você envia. Cancele quando quiser.",
  "site.pricing.perMonth": "/ mês",
  "site.pricing.perYear": "/ ano",
  "site.pricing.priceAtCheckout": "Preço exibido no checkout",
  "site.pricing.popular": "Mais popular",
  "site.pricing.minutes": "{minutes} min de vídeo por mês",
  "site.pricing.retention": "Projetos guardados por {days} dias",
  "site.pricing.featureWorkflows": "Todos os fluxos de trabalho e estilos de legenda",
  "site.pricing.featureVoice": "Comandos de voz e limpeza com IA",
  "site.pricing.choose": "Escolher {plan}",
  "site.pricing.current": "Seu plano atual",
  "site.pricing.manage": "Gerenciar assinatura",
  "site.pricing.switch": "Mudar para {plan}",
  "site.pricing.unavailable": "Ainda não disponível",
  "site.pricing.redirecting": "Abrindo o checkout…",
  "site.pricing.checkoutFailed": "Não foi possível abrir o checkout. Tente novamente em um instante.",
  "site.pricing.loadFailed": "Não foi possível carregar os planos. Tente novamente em um instante.",
  "site.pricing.minutesHint":
    "Os minutos contam a duração dos vídeos que você envia. Minutos não usados não passam para o mês seguinte.",
  "site.pricing.vatNote":
    "Os preços já incluem impostos. Os pagamentos são processados pela Lemon Squeezy, nossa revendedora oficial (Merchant of Record) — ela faz a cobrança e envia suas faturas.",
  "site.pricing.testMode": "Modo de teste — sem pagamentos reais",
  "site.pricing.testersOnly": "Ainda não é possível comprar planos — o checkout está em modo de teste, só para testadores convidados.",
  "site.pricing.betaTitle": "Gratuito durante o beta aberto",
  "site.pricing.betaBody": "A CleoCuts é gratuita enquanto estamos em beta. Planos pagos com mais minutos chegam em breve.",

  // ── library: header ──
  "library.header.homeAria": "Editor da CleoCuts",
  "library.header.title": "Biblioteca",
  "library.header.newProject": "Novo projeto",

  // ── library: list ──
  "library.count.one": "{count} projeto",
  "library.count.other": "{count} projetos",
  "library.confirmDelete": "Excluir este projeto permanentemente? O vídeo e todas as edições são removidos dos nossos servidores.",
  "library.deleteFailed": "Não foi possível excluir agora — se o vídeo ainda estiver sendo processado, tente de novo em instantes.",

  // ── library: empty state ──
  "library.empty.title": "Sua biblioteca está vazia",
  "library.empty.body":
    "Todo vídeo que você finaliza aparece aqui. Você pode baixá-lo de novo, pegar suas legendas e compartilhar clipes de gancho a qualquer momento.",
  "library.empty.cta": "Comece seu primeiro projeto",

  // ── library: project card ──
  "library.card.playAria": "Reproduzir prévia de {name}",
  "library.card.noPreview": "sem prévia",
  "library.card.customPreset": "Personalizado",
  "library.card.deleteAria": "Excluir projeto",
  "library.card.expiresDays": "Excluído automaticamente em {n} dias",
  "library.card.expiresSoon": "Excluído em menos de 24 horas",
  "library.card.expired": "Expirado — os arquivos foram excluídos",
  "library.card.hooks.one": "{count} gancho",
  "library.card.hooks.other": "{count} ganchos",
  "library.card.hookSeconds": "{seconds}s",
  "library.card.caption": "Legenda",
  "library.card.copy": "copiar",
  "library.card.copied": "copiado",

  // ── library: download labels ──
  "library.format.primary": "Edição principal",
  "library.format.hook": "Clipe de gancho {n}",

  // ── library: relative time ──
  "library.time.justNow": "agora mesmo",
  "library.time.minutesAgo": "há {n}min",
  "library.time.hoursAgo": "há {n}h",
  "library.time.daysAgo": "há {n}d",

  // ── shared components ──
  "common.videoModal.closeAria": "Fechar prévia",
  "common.videoModal.close": "Fechar",
  "common.videoModal.dialogLabel": "Prévia do vídeo",
  "common.auth.signIn": "Entrar",
  "common.auth.account": "Conta",
  "common.auth.pricing": "Preços",

  // ── app: header ──
  "app.header.homeAria": "Início da CleoCuts",
  "app.header.library": "Biblioteca",
  "app.header.beta": "Beta",
  "app.header.opening": "Abrindo…",

  // ── app: browser notifications ──
  "app.notify.readyTitle": "CleoCuts — seu vídeo está pronto",
  "app.notify.clickToView": "Clique para ver",
  "app.notify.reviewTitle": "CleoCuts — pronto para sua revisão",
  "app.notify.reviewBody": "Cortes + transcrição concluídos. Toque para revisar.",

  // ── app: toasts / notices ──
  "app.notice.loadFailed": "Não foi possível carregar o projeto agora. Tente novamente em um instante.",
  "app.notice.done": "Este vídeo está pronto — encontre-o em Recentes e na sua Biblioteca.",
  "app.notice.processing": "Este vídeo ainda está sendo processado. O card mostra o progresso.",
  "app.notice.offline": "Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.",

  // ── app: errors ──
  "app.errors.expired":
    "Este projeto não existe mais no servidor (expirou ou o servidor foi atualizado). Envie o vídeo novamente.",
  "app.errors.generic": "Algo deu errado. Tente novamente.",
  "app.errors.connection": "A conexão caiu. Verifique sua internet e tente novamente.",
  "app.errors.interrupted":
    "O envio foi interrompido (a página recarregou ou você trocou de app). Envie o vídeo novamente.",
  "app.errors.tooLarge": "O arquivo é muito grande. Corte o vídeo ou exporte em um tamanho menor.",
  "app.errors.noAudio": "Nenhum áudio utilizável foi encontrado no vídeo.",
  "app.errors.renderFailed":
    "A renderização falhou. Suas edições foram salvas — abra o projeto e renderize novamente.",
  "app.errors.serverNoResponse": "O servidor não respondeu. Tente novamente.",
  "app.errors.serverBusy": "Nossos servidores estão ocupados agora. Tente novamente em alguns minutos.",
  "app.errors.saveEditsFailed": "Não foi possível salvar suas edições — verifique sua conexão e tente novamente.",
  "app.errors.signInRequired": "Sua sessão expirou. Faça login de novo e tente novamente.",
  "app.errors.subscriptionRequired": "Para enviar vídeos, você precisa de um plano. Escolha um na página de preços.",
  "app.errors.quotaExceeded":
    "Não há minutos suficientes neste período para este vídeo. Faça upgrade do seu plano ou aguarde a renovação.",
  "app.errors.unreadableVideo":
    "Não conseguimos ler este arquivo de vídeo. Exporte-o novamente como MP4 ou MOV e envie de novo.",
  // Upload limits (413 / 429 from the backend, also checked before uploading)
  "app.errors.fileTooLarge":
    "Este arquivo tem mais de {max} GB. Corte o vídeo ou exporte em um tamanho menor.",
  "app.errors.videoTooLong": "Este vídeo tem mais de {max} minutos. Corte-o ou divida-o em partes.",
  "app.errors.tooManyJobs":
    "Você já tem o número máximo de vídeos em processamento. Aguarde até um ficar pronto e tente novamente.",
  "app.errors.title": "Algo deu errado",
  "app.errors.tryAgain": "Tentar novamente",

  // ── app: accounts ──
  "app.auth.signInToContinue": "Faça login para abrir seus projetos.",
  "app.auth.loadFailed":
    "Não foi possível carregar o login. Verifique sua conexão (ou libere este site no seu bloqueador de conteúdo) e tente novamente.",

  // ── app: billing (upload blocked + minutes left) ──
  "app.paywall.subscriptionTitle": "Escolha um plano para enviar",
  "app.paywall.subscriptionBody":
    "Para enviar vídeos, você precisa de um plano ativo. Escolha um — leva só um minuto, e você pode cancelar quando quiser.",
  "app.paywall.quotaTitle": "Minutos insuficientes",
  "app.paywall.quotaBody": "Você tem {left} min restantes neste período — este vídeo precisa de {needed} min.",
  "app.paywall.quotaBodyUnknown": "Este vídeo é mais longo do que os minutos que você ainda tem neste período.",
  "app.paywall.seePlans": "Ver planos",
  "app.paywall.upgrade": "Fazer upgrade",
  "app.paywall.close": "Agora não",
  "app.billing.minutesLeft": "{n} min restantes neste período",
  "app.billing.choosePlan": "Escolha um plano para enviar",

  // ── app: account page ──
  "app.account.title": "Conta",
  "app.account.signedInAs": "Conectado como {email}",
  "app.account.plan": "Plano",
  "app.account.noPlan": "Nenhum plano ainda",
  "app.account.freeBeta": "A CleoCuts é gratuita durante o beta aberto — não é preciso ter um plano.",
  "app.account.status.active": "Ativo · renova em {date}",
  "app.account.status.activeNoDate": "Ativo",
  "app.account.status.trial": "Período de teste · primeiro pagamento em {date}",
  "app.account.status.cancelled": "Será cancelado em {date}",
  "app.account.status.pastDue": "Pagamento em atraso — atualize sua forma de pagamento.",
  "app.account.status.paused": "Pausado",
  "app.account.status.expired": "Expirado",
  "app.account.status.comp": "Cortesia",
  "app.account.usage": "Minutos neste período",
  "app.account.usageOf": "{used} de {limit} min usados",
  "app.account.resetsOn": "Renova em {date}",
  "app.account.manage": "Gerenciar assinatura",
  "app.account.manageHint": "Faturas, forma de pagamento e cancelamento ficam no portal do cliente da Lemon Squeezy.",
  "app.account.changePlan": "Trocar de plano",
  "app.account.choosePlan": "Escolher um plano",
  "app.account.portalFailed": "Não foi possível abrir o portal de cobrança. Tente novamente em um instante.",
  "app.account.loadFailed": "Não foi possível carregar sua conta agora. Tente novamente em um instante.",
  "app.account.testMode": "Modo de teste",
  "app.account.successPending": "Obrigado! Seu pagamento foi aprovado — ativando seu plano…",
  "app.account.successDone": "Seu plano {plan} está ativo. Boas edições!",
  "app.account.successSlow":
    "Está demorando mais que o normal. Seu plano vai aparecer aqui em alguns minutos — recarregue a página para conferir.",

  // ── app: library fallbacks ──
  "app.library.untitled": "Sem título",

  // ── app: workflow presets ──
  "app.preset.tiktok.label": "TikTok / Reels",
  "app.preset.tiktok.tagline": "Vertical de formato curto",
  "app.preset.tiktok.desc": "Comandos de voz, legendas estilo Clipper, corte vertical automático",
  "app.preset.tiktok.bullet1": "Comandos de voz ativados: diga “Cleo cut” para refazer",
  "app.preset.tiktok.bullet2": "Legendas em negrito estilo Clipper",
  "app.preset.tiktok.bullet3": "Vertical 9:16 automático com rastreamento de rosto",
  "app.preset.podcast.label": "Podcast Longo",
  "app.preset.podcast.tagline": "Episódio completo + clipes",
  "app.preset.podcast.desc": "Limpeza com IA, detecção de ganchos, exportação multiformato",
  "app.preset.podcast.bullet1": "Limpeza com IA na sua transcrição",
  "app.preset.podcast.bullet2": "3 clipes de gancho escolhidos automaticamente",
  "app.preset.podcast.bullet3": "Episódio completo + clipes 9:16 exportados",
  "app.preset.vlog.label": "Limpeza de Vlog",
  "app.preset.vlog.tagline": "Falando sozinho para a câmera",
  "app.preset.vlog.desc": "Remove vícios de fala, legendas discretas, mantém o formato",
  "app.preset.vlog.bullet1": "Remove “ééé”, “tipo assim”, pausas longas",
  "app.preset.vlog.bullet2": "Legendas discretas que não distraem",
  "app.preset.vlog.bullet3": "Mantém seu formato original",
  "app.preset.captions.label": "Só Legendas",
  "app.preset.captions.tagline": "Adiciona só legendas",
  "app.preset.captions.desc": "Grava as legendas no seu vídeo — sem cortes, sem limpeza",
  "app.preset.captions.bullet1": "Grava as legendas no estilo escolhido",
  "app.preset.captions.bullet2": "Sem cortes, sem limpeza",
  "app.preset.captions.bullet3": "Mais rápido — só legendas",
  "app.preset.custom.label": "Personalizado",
  "app.preset.custom.tagline": "Configure tudo",
  "app.preset.custom.desc": "Configurações completas — escolha cada detalhe você mesmo",
  "app.preset.custom.bullet1": "Todas as configurações disponíveis",
  "app.preset.custom.bullet2": "Escolha legendas, cortes e formato você mesmo",
  "app.preset.custom.bullet3": "Para quando você já sabe o que quer",

  // ── app: caption styles ──
  "app.captions.clean": "Clean",
  "app.captions.classic": "Classic",
  "app.captions.clipper": "Clipper",
  "app.captions.highlight": "Highlight",
  "app.captions.flash": "Flash",
  "app.captions.punch": "Punch",
  "app.captions.elegant": "Elegant",
  "app.captions.subtle": "Subtle",
  "app.captions.none": "Sem legendas",

  // ── app: cut styles ──
  "app.cutStyle.tight.label": "Apertado",
  "app.cutStyle.tight.desc": "Agressivo",
  "app.cutStyle.balanced.label": "Equilibrado",
  "app.cutStyle.balanced.desc": "Padrão",
  "app.cutStyle.smooth.label": "Suave",
  "app.cutStyle.smooth.desc": "Mantém pausas",

  // ── app: export formats ──
  "app.format.9x16.desc": "TikTok / Reels / Shorts",
  "app.format.1x1.desc": "Feed do Instagram",
  "app.format.16x9.desc": "YouTube / desktop",

  // ── app: dashboard ──
  "app.dashboard.workspace": "Seu espaço de trabalho",
  "app.dashboard.inProgressCountOne": "{count} vídeo em andamento",
  "app.dashboard.inProgressCountOther": "{count} vídeos em andamento",
  "app.dashboard.readyWhenYouAre": "Pronto quando você quiser",
  "app.dashboard.newVideo": "Novo vídeo",
  "app.dashboard.inProgress": "Em andamento",
  "app.dashboard.recentProjects": "Projetos recentes",
  "app.dashboard.viewAll": "Ver todos →",
  "app.dashboard.startFirst": "Comece seu primeiro vídeo",
  "app.dashboard.startFirstSub": "Escolha um fluxo de trabalho — a CleoCuts cuida das legendas, do formato e da limpeza",
  "app.dashboard.voiceTeaser": "Diga “Cleo” enquanto grava — economize horas de edição",

  // ── app: workflow picker ──
  "app.picker.backToDashboard": "Voltar ao painel",
  "app.picker.freeDuringBeta": "Gratuito durante o beta",
  "app.picker.title": "O que você vai postar?",
  "app.picker.subtitle":
    "Escolha um fluxo de trabalho — a CleoCuts pré-configura legendas, formato e limpeza para a plataforma.",
  "app.picker.chipCaptions": "Legendas {style}",
  "app.picker.chipVoice": "\"Cleo cut\" ativado",
  "app.picker.customTitle": "Configuração personalizada",
  "app.picker.customSub": "Escolha cada detalhe você mesmo — legendas, cortes, formatos",

  // ── app: upload (choose a file) ──
  "app.upload.back": "← Voltar",
  "app.upload.title": "Escolha um vídeo",
  "app.upload.hint":
    "MP4 ou MOV do seu celular ou computador. Mantenha esta página aberta até o envio terminar.",
  "app.upload.tapToChoose": "Toque para escolher",
  "app.upload.orDrag": "ou arraste um arquivo aqui",
  "app.upload.keepTabOpen":
    "Mantenha esta aba aberta até o envio terminar. Trocar de app ou bloquear o celular vai cancelar o envio.",
  "app.upload.resuming":
    "Retomando o envio de onde parou — mantenha esta página aberta.",

  // ── app: configure (custom settings) ──
  "app.configure.back": "← voltar",
  "app.configure.fileInfo": "{name} · {size} MB",
  "app.configure.captionStyle": "Estilo de legenda",
  "app.configure.captionPreviewAlt": "Prévia da legenda {style}",
  "app.configure.cutStyle": "Estilo de corte",
  "app.configure.cleanup": "Limpeza",
  "app.configure.voiceTriggers": "Detectar \"Cleo cut\" / \"Cleo go\"",
  "app.configure.voiceTriggersDesc": "Remove tomadas erradas automaticamente",
  "app.configure.removeFillers": "Remover vícios de fala",
  "app.configure.removeFillersDesc": "Corta \"ééé\", \"tipo\", \"né\"…",
  "app.configure.smartReframe": "Reenquadramento inteligente",
  "app.configure.smartcam": "Rastreamento de rosto SmartCam",
  "app.configure.smartcamDesc": "Reenquadra automaticamente para saída vertical/horizontal",
  "app.configure.portrait": "retrato",
  "app.configure.landscape": "paisagem",
  "app.configure.portraitDesc": "Vertical 9:16",
  "app.configure.landscapeDesc": "Horizontal 16:9",
  "app.configure.extraFormats": "Formatos de saída extras",
  "app.configure.extraFormatsHint":
    "A exportação principal usa seu formato SmartCam (ou o formato original). Escolha versões extras com tarjas pretas para outras plataformas.",
  "app.configure.process": "Processar vídeo",

  // ── app: progress screen ──
  "app.progress.uploading": "Enviando",
  "app.progress.rendering": "Renderizando",
  "app.progress.processing": "Processando",
  "app.progress.stage.prep": "Preparando seu vídeo",
  "app.progress.stage.listen": "Ouvindo sua voz",
  "app.progress.stage.polish": "Encontrando as melhores tomadas",
  "app.progress.stage.preview": "Quase pronto",
  "app.progress.stage.burn": "Aplicando suas edições",
  "app.progress.stage.stitch": "Montando tudo",
  "app.progress.stage.finish": "Últimos ajustes",

  // ── app: done screen ──
  "app.done.readyToPost": "Pronto para postar",
  "app.done.captionSuggestion": "Sugestão de legenda",
  "app.done.copy": "copiar",
  "app.done.downloadPrimary": "Baixar principal",
  "app.done.downloadFormat": "Baixar {format}",
  "app.done.mainEdit": "Edição principal",
  "app.done.bonusClips": "Clipes bônus",
  "app.done.aiPicked": "Escolhido pela IA",
  "app.done.processAnother": "Processar outro",

  // ── app: dashboard job cards ──
  "app.card.noPreview": "sem prévia",
  "app.card.uploading.title": "Enviando",
  "app.card.uploading.sub": "Enviando — mantenha esta página aberta e não bloqueie o celular.",
  "app.card.analyzing.title": "Analisando",
  "app.card.analyzing.sub": "Transcrevendo e cortando pausas e vícios de fala.",
  "app.card.reviewing.title": "Pronto para editar",
  "app.card.reviewing.sub": "Toque para abrir o editor e ajustar o corte.",
  "app.card.rendering.title": "Renderizando",
  "app.card.rendering.sub": "Montando seu vídeo final.",
  // Waiting for a free server slot (status "processing", message "queued")
  "app.card.queued.title": "Na fila (#{n})",
  "app.card.queued.titleNoPos": "Na fila",
  "app.card.queued.sub":
    "Muitos vídeos no momento — o seu começa automaticamente. Você pode sair desta página.",
  "app.card.open": "Abrir →",
  "app.card.remove": "✕ Remover",
  "app.card.renderFailedNote": "A renderização falhou — suas edições foram salvas. Abra e renderize novamente.",

  // ── app: review (editor) ──
  "app.review.backToDashboard": "← Painel",
  "app.review.sentencesOne": "{count} frase",
  "app.review.sentencesOther": "{count} frases",
  "app.review.audioHeadsUp": "Aviso de áudio",
  "app.review.updatingPreview": "Atualizando prévia…",
  "app.review.captionSampleAlt": "Exemplo de legenda {style}",
  "app.review.captionsLookLike": "As legendas vão parecer com isto",
  "app.review.tabTimeline": "Linha do tempo",
  "app.review.tabTranscript": "Transcrição",
  "app.review.tabCaptions": "Legendas",
  "app.review.preparing": "Preparando…",
  "app.review.applyRender": "Aplicar e renderizar",

  // ── app: transcript tab ──
  "app.transcript.lineDeleted": "Linha excluída",
  "app.transcript.undo": "↶ Desfazer",
  "app.transcript.headingOne": "Transcrição · {count} linha",
  "app.transcript.headingOther": "Transcrição · {count} linhas",
  "app.transcript.hint": "Corrija erros de digitação, remova uma linha com ✕, toque em um card para ir até aquele momento.",
  "app.transcript.empty": "Sem legendas. A saída será só o vídeo.",
  "app.transcript.verify": "verificar",
  "app.transcript.deleteSentence": "Excluir frase",

  // ── app: captions tab ──
  "app.captions.styleHeading": "Estilo de legenda · {style}",
  "app.captions.appliedToOutput": "Aplicado à saída",
  "app.captions.disabled": "Legendas desativadas para esta renderização.",

  // ── app: timeline editor ──
  "app.timeline.title": "Linha do tempo",
  "app.timeline.clipsOne": "{count} clipe · {dur}",
  "app.timeline.clipsOther": "{count} clipes · {dur}",
  "app.timeline.saving": "salvando",
  "app.timeline.saveFailedTitle":
    "O servidor não aceita mais alterações para este vídeo (pode estar renderizando ou ter expirado).",
  "app.timeline.saveRetryingTitle": "Sua última alteração ainda não chegou ao servidor. Tentando novamente…",
  "app.timeline.notSaved": "não salvo",
  "app.timeline.notSavedRetrying": "não salvo · tentando novamente",
  "app.timeline.hintDesktop":
    "Role para mover · Ctrl/⌘ + rolar para zoom · arraste as bordas para cortar · Espaço para reproduzir · ⌫ excluir · ⌘Z desfazer",
  "app.timeline.hintMobile":
    "Deslize para rolar · pince para zoom · toque em um clipe para editar · arraste a régua para navegar",
  "app.timeline.undoTitle": "Desfazer (⌘Z)",
  "app.timeline.undoAria": "Desfazer",
  "app.timeline.redoTitle": "Refazer (⌘⇧Z)",
  "app.timeline.redoAria": "Refazer",
  "app.timeline.splitTitle": "Dividir o clipe sob o cursor",
  "app.timeline.split": "⧉ Dividir",
  "app.timeline.zoomOutTitle": "Diminuir zoom (ver mais do vídeo)",
  "app.timeline.zoomOutAria": "Diminuir zoom",
  "app.timeline.fitTitle": "Ajustar o vídeo inteiro",
  "app.timeline.fit": "Ajustar",
  "app.timeline.zoomInTitle": "Aumentar zoom (mais detalhe, corte mais fino)",
  "app.timeline.zoomInAria": "Aumentar zoom",
  "app.timeline.clipLabel": "Clipe {n}",
  "app.timeline.moveLeft": "Mover clipe para a esquerda",
  "app.timeline.moveRight": "Mover clipe para a direita",
  "app.timeline.deleteTitle": "Excluir clipe (⌫)",
  "app.timeline.delete": "✕ Excluir",
  "app.timeline.speed": "Velocidade",
  "app.timeline.speedNormal": "1× (normal)",
  "app.timeline.volume": "Volume",
  "app.timeline.muteBadge": "M",
  "app.timeline.fadeIn": "Fade in",
  "app.timeline.fadeOut": "Fade out",
  "app.timeline.resetEffects": "Redefinir efeitos",
  // Legacy cut strip
  "app.timeline.cuts": "Cortes",
  "app.timeline.cutsRemoved": "{sec}s removidos",
  "app.timeline.cutsRestored": " · {count} restaurados",
  "app.timeline.cutTitleRestore": "Corte {from}–{to} (toque para restaurar)",
  "app.timeline.cutTitleRemoveAgain": "Corte {from}–{to} (toque para remover de novo)",
  "app.timeline.cutsLegend": "Vermelho = removido · toque para restaurar. Tracejado verde = mantido.",

  // ── app: voice commands (test modal + scene panel) ──
  "app.voice.title": "Teste sua voz",
  "app.voice.subtitle": "Diga os comandos — veja se a Cleo te escuta.",
  "app.voice.close": "Fechar",
  "app.voice.heardYou": "Ouvi você!",
  "app.voice.listening": "Ouvindo…",
  "app.voice.heardPrefix": "ouvi: ",
  "app.voice.permissionHint": "Usa seu microfone. Seu navegador transforma sua fala em texto: o Chrome envia a voz para o Google, o Safari para a Apple. Nada vai para a CleoCuts.",
  "app.voice.requesting": "Solicitando…",
  "app.voice.start": "Começar",
  "app.voice.denied": "Permissão negada. Ative nas configurações do navegador e recarregue.",
  "app.voice.unsupported": "Não suportado neste navegador. Tente o Safari ou o Chrome.",
  "app.voice.done": "Concluído",
  "app.voice.cmd.start": "Começa sua tomada",
  "app.voice.cmd.cut": "Refaça, descarta a tomada atual",
  "app.voice.cmd.keep": "Confirma a tomada, próxima cena",
  "app.voice.cmd.finish": "Termina o vídeo, corta tudo depois",
  "app.voice.cmd.stop": "Pula uma frase ruim (use com 'go')",
  "app.voice.cmd.go": "Retoma depois do 'stop'",
  "app.voice.scene.heading": "Comandos de voz · {count} ativos",
  "app.voice.scene.hint": "Desmarque detecções falsas, adicione as que faltam. Os cortes são atualizados automaticamente.",
  "app.voice.scene.add": "+ Adicionar",
  "app.voice.scene.addAt": "Adicionar comando no momento atual do vídeo",
  "app.voice.scene.none": "Nenhum comando de voz detectado.",
  "app.voice.scene.disable": "Desativar",
  "app.voice.scene.enable": "Ativar",
  "app.voice.scene.heard": "ouvi: “{text}”",
  "app.voice.scene.type.start": "Início",
  "app.voice.scene.type.keep": "Manter",
  "app.voice.scene.type.restart": "Cortar / Reiniciar",
  "app.voice.scene.type.finish": "Finalizar",
  "common.language": "Idioma",
  "common.footer.legalAria": "Informações legais",
  "legal.onlyDeEn":
    "Esta página só está disponível em alemão e inglês. Você está lendo a versão em inglês.",
  "common.backHome": "Voltar ao início",
  "common.notFound.title": "Página não encontrada",
  "common.notFound.body": "Esta página não existe ou foi movida.",
  "common.error.title": "Algo deu errado",
  "common.error.body": "Não foi possível mostrar esta página. Tente novamente.",
  "common.error.retry": "Tentar novamente",
  "common.error.ref": "Referência do erro: {id}",
  "app.crash.saving": "Salvando suas últimas alterações…",
  "app.crash.saved": "Suas últimas alterações foram salvas.",
  "app.crash.unsaved": "Suas últimas alterações podem não ter sido salvas.",
  "app.crash.body": "Recarregue a página para continuar de onde parou.",
  "app.crash.reload": "Recarregar a página",
};
