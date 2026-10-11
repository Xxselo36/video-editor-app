import type { SiteKey } from "../en";

export const ruSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "CleoCuts — на главную",
  "site.header.openEditor": "Открыть редактор",

  "site.footer.editor": "Редактор",
  "site.footer.library": "Библиотека",
  "site.footer.imprint": "Реквизиты",
  "site.footer.privacy": "Конфиденциальность",
  "site.footer.terms": "Условия",
  "site.footer.pricing": "Цены",

  // ── Pricing page ────────────────────────────────────────────────────
  "site.pricing.title": "Простые цены",
  "site.pricing.subtitle": "Плати каждый месяц за минуты видео, которые загружаешь. Отменить можно в любой момент.",
  "site.pricing.perMonth": "/ мес.",
  "site.pricing.perYear": "/ год",
  "site.pricing.priceAtCheckout": "Цена будет показана при оплате",
  "site.pricing.popular": "Самый популярный",
  "site.pricing.minutes": "{minutes} мин видео в месяц",
  "site.pricing.retention": "Проекты хранятся {days} дн.",
  "site.pricing.featureWorkflows": "Все workflow и стили субтитров",
  "site.pricing.featureVoice": "Голосовые команды и ИИ-чистка",
  "site.pricing.choose": "Выбрать {plan}",
  "site.pricing.current": "Твой текущий тариф",
  "site.pricing.manage": "Управление подпиской",
  "site.pricing.switch": "Перейти на {plan}",
  "site.pricing.unavailable": "Пока недоступно",
  "site.pricing.redirecting": "Открываем оплату…",
  "site.pricing.checkoutFailed": "Не удалось открыть оплату. Попробуй ещё раз через минуту.",
  "site.pricing.loadFailed": "Не удалось загрузить тарифы. Попробуй ещё раз через минуту.",
  "site.pricing.minutesHint":
    "Минуты считаются по длительности загруженных видео. Неиспользованные минуты не переносятся на следующий месяц.",
  "site.pricing.vatNote":
    "Цены указаны с НДС. Платежи обрабатывает Lemon Squeezy — наш официальный продавец (Merchant of Record): он списывает оплату и присылает тебе счета.",
  "site.pricing.testMode": "Тестовый режим — без реальных платежей",
  "site.pricing.testersOnly": "Тарифы пока нельзя купить — оплата в тестовом режиме, только для приглашённых тестировщиков.",
  "site.pricing.betaTitle": "Бесплатно во время открытой беты",
  "site.pricing.betaBody": "CleoCuts бесплатен, пока мы в бете. Скоро появятся платные тарифы с большим количеством минут.",

  "library.header.homeAria": "Редактор CleoCuts",
  "library.header.title": "Библиотека",
  "library.header.newProject": "Новый проект",

  "library.count.one": "{count} проект",
  "library.count.other": "{count} проектов",
  "library.confirmDelete": "Удалить проект навсегда? Видео и все правки будут удалены с наших серверов.",
  "library.deleteFailed": "Сейчас не удалось удалить — если видео ещё обрабатывается, попробуй чуть позже.",

  "library.empty.title": "Твоя библиотека пуста",
  "library.empty.body":
    "Здесь появится каждое готовое видео. Ты всегда можешь скачать его снова, взять субтитры и поделиться хук-клипами.",
  "library.empty.cta": "Начни свой первый проект",

  "library.card.playAria": "Воспроизвести превью «{name}»",
  "library.card.noPreview": "нет превью",
  "library.card.customPreset": "Свой вариант",
  "library.card.deleteAria": "Удалить проект",
  "library.card.expiresDays": "Автоудаление через {n} дн.",
  "library.card.expiresSoon": "Удалится в течение 24 часов",
  "library.card.expired": "Срок истёк — файлы удалены",
  "library.card.hooks.one": "{count} хук",
  "library.card.hooks.other": "{count} хуков",
  "library.card.hookSeconds": "{seconds} сек",
  "library.card.caption": "Описание",
  "library.card.copy": "копировать",
  "library.card.copied": "скопировано",

  "library.format.primary": "Основной монтаж",
  "library.format.hook": "Хук-клип {n}",

  "library.time.justNow": "только что",
  "library.time.minutesAgo": "{n} мин назад",
  "library.time.hoursAgo": "{n} ч назад",
  "library.time.daysAgo": "{n} дн назад",

  "common.videoModal.closeAria": "Закрыть превью",
  "common.videoModal.close": "Закрыть",
  "common.videoModal.dialogLabel": "Превью видео",

  // ── Accounts (header, all pages) ────────────────────────────────────
  "common.auth.signIn": "Войти",
  "common.auth.account": "Аккаунт",
  "common.auth.pricing": "Цены",
  "common.language": "Язык",
  "common.footer.legalAria": "Правовая информация",
  "legal.onlyDeEn":
    "Эта страница доступна только на немецком и английском. Ты читаешь английскую версию.",
  "common.backHome": "На главную",
  "common.notFound.title": "Страница не найдена",
  "common.notFound.body": "Такой страницы нет, или она переехала.",
  "common.error.title": "Что-то пошло не так",
  "common.error.body": "Не удалось показать эту страницу. Попробуй ещё раз.",
  "common.error.retry": "Попробовать снова",
  "common.error.ref": "Код ошибки: {id}",
};
