import type { SiteKey } from "../en";

export const ptSite: Partial<Record<SiteKey, string>> = {
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
};
