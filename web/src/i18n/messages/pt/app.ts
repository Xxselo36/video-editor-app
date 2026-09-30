import type { AppKey } from "../en";

export const ptApp: Partial<Record<AppKey, string>> = {
  // ── app: header ──
  "app.header.homeAria": "Início da CleoCuts",
  "app.header.library": "Biblioteca",
  "app.header.beta": "Beta",
  "app.header.opening": "Abrindo…",

  // ── app: browser notifications ──
  "app.notify.readyTitle": "CleoCuts — seu vídeo está pronto",

  // ── app: toasts / notices ──
  "app.notice.loadFailed": "Não foi possível carregar o projeto agora. Tente novamente em um instante.",
  "app.notice.done": "Este vídeo está pronto — encontre-o em Recentes e na sua Biblioteca.",
  "app.notice.processing": "Este vídeo ainda está sendo processado. O card mostra o progresso.",
  "app.notice.alreadyExporting": "Este vídeo já está sendo exportado. O cartão dele mostra o progresso.",
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
  "app.errors.noSpeech": "Não encontramos fala neste vídeo. A CleoCuts corta e legenda vídeos em que alguém fala — tente um clipe com voz.",
  "app.errors.noSpeechRefunded": "Não encontramos fala neste vídeo. A CleoCuts corta e legenda vídeos em que alguém fala — tente um clipe com voz. Os minutos foram devolvidos.",
  "app.errors.noAudioTrack": "Este vídeo não tem faixa de áudio, então não há nada para cortar ou legendar. Nada foi cobrado.",
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
  "app.dashboard.readyCountOne": "{count} vídeo pronto para revisar",
  "app.dashboard.readyCountOther": "{count} vídeos prontos para revisar",
  "app.dashboard.failedCountOne": "{count} vídeo com falha",
  "app.dashboard.failedCountOther": "{count} vídeos com falha",
  "app.dashboard.readyWhenYouAre": "Pronto quando você quiser",
  "app.dashboard.newVideo": "Novo vídeo",
  "app.dashboard.inProgress": "Em andamento",
  "app.dashboard.recentProjects": "Projetos recentes",
  "app.dashboard.viewAll": "Ver todos",
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
  "app.upload.back": "Voltar",
  "app.upload.title": "Escolha um vídeo",
  "app.upload.hint":
    "MP4 ou MOV do seu celular ou computador. Mantenha esta página aberta até o envio terminar.",
  "app.upload.tapToChoose": "Toque para escolher",
  "app.upload.orDrag": "ou arraste um arquivo aqui",
  "app.upload.privacyLink": "Como tratamos seus vídeos",
  "app.upload.resuming":
    "Retomando o envio de onde parou — mantenha esta página aberta.",

  // ── app: configure (custom settings) ──
  "app.configure.back": "voltar",
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
  "app.card.open": "Abrir",
  "app.card.remove": "Remover",
  "app.card.renderFailedNote": "A renderização falhou — suas edições foram salvas. Abra e renderize novamente.",

  // ── app: captions tab ──
  "app.captions.styleHeading": "Estilo de legenda · {style}",
  "app.captions.appliedToOutput": "Aplicado à saída",
  "app.captions.disabled": "Legendas desativadas para esta renderização.",

  // ── app: voice test (dialog) ──
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
  "app.crash.saving": "Salvando suas últimas alterações…",
  "app.crash.saved": "Suas últimas alterações foram salvas.",
  "app.crash.unsaved": "Suas últimas alterações podem não ter sido salvas.",
  "app.crash.body": "Recarregue a página para continuar de onde parou.",
  "app.crash.reload": "Recarregar a página",

  // ── Error codes, warnings, stages (UX5, lib/errorKeys.ts) ────────
  "app.errors.noVideoTrack": "Isto é um arquivo de áudio. O CleoCuts precisa de um vídeo com som — escolha um arquivo de vídeo. Nada foi cobrado.",
  "app.errors.videoTooShort": "Este vídeo tem menos de {min} segundos — curto demais para cortar. Nada foi cobrado.",
  "app.errors.processingInterrupted": "O processamento foi interrompido. Envie o vídeo novamente.",
  "app.errors.mediaUnavailable": "O vídeo original não está mais disponível, então este projeto não pode ser editado de novo.",
  "app.errors.tooManyRenders": "Há exportações demais em andamento. Aguarde até que uma termine.",
  "app.errors.renderLimit": "Este vídeo atingiu o limite de exportações de hoje. Tente novamente amanhã.",
  "app.errors.staleRev": "Este projeto foi alterado em outra aba. Recarregue para ver a versão mais recente.",
  "app.errors.docNotReady": "Este projeto ainda não está pronto. Tente novamente em instantes.",
  "app.errors.refunded": "Os minutos foram devolvidos.",
  "app.errors.tryAnotherVideo": "Tentar outro vídeo",
  "app.warnings.scriptUnsupported": "Ainda não há legendas para a escrita deste idioma.",
  "app.warnings.smartcamFailed": "O rastreamento de quem fala não funcionou neste vídeo, então ele foi cortado pelo centro.",
  "app.audio.silent": "O áudio parece mudo — verifique se o microfone está ligado e não silenciado.",
  "app.audio.quiet": "O áudio está muito baixo — fale mais perto do microfone da próxima vez.",
  "app.audio.clipping": "O áudio está estourando nos picos — a gravação está alta demais, é provável que haja distorção.",
  "app.stage.queued": "Aguardando uma vaga livre",
  "app.stage.analyze.normalize": "Preparando seu vídeo",
  "app.stage.analyze.smartcam": "Acompanhando quem fala",
  "app.stage.analyze.transcribe": "Transcrevendo",
  "app.stage.analyze.cleanup": "Refinando a transcrição",
  "app.stage.analyze.cuts": "Encontrando os cortes",
  "app.stage.analyze.captions": "Preparando as legendas",
  "app.stage.analyze.done": "Pronto para revisar",
  "app.stage.render.prepare": "Preparando a exportação",
  "app.stage.render.captions": "Adicionando legendas ({i}/{n})",
  "app.stage.render.encode": "Exportando",
  "app.stage.render.hooks": "Cortando os destaques",
  "app.stage.render.finish": "Finalizando",
};
