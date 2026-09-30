import type { SiteKey } from "../en";

export const ruSite: Partial<Record<SiteKey, string>> = {
  // ── site.* (Landing) ─────────────────────────────────────────────────
  "site.header.homeAria": "CleoCuts — на главную",
  "site.header.openEditor": "Открыть редактор",

  "site.hero.badge": "Открытая бета · бесплатно",
  "site.hero.badgePricing": "Тарифы и цены",
  "site.hero.titleLead": "Монтируй прямо во время",
  "site.hero.titleAccent": "записи.",
  "site.hero.sub":
    "Скажи {cut}, если ошибся. Скажи {finish}, когда закончишь. Готово к публикации за пару минут — с субтитрами и монтажом.",
  "site.hero.cta": "Попробовать CleoCuts",

  "site.showcase.listening": "CleoCuts слушает",
  "site.showcase.captionStyle": "стиль субтитров",
  "site.showcase.clipper": "РЕДАКТОР — ЭТО ГОЛОС",
  "site.showcase.highlight": "ГОТОВО К ПУБЛИКАЦИИ",
  "site.showcase.flash": "СКАЖИ CUT",
  "site.showcase.punch": "ИДЕАЛЬНО",
  "site.showcase.elegant": "Просто слушает.",

  "site.features.title": "Что умеет CleoCuts.",
  "site.features.voice.title": "Голосовые команды",
  "site.features.voice.body": "Скажи {cut} прямо во время дубля. CleoCuts удалит неудачную попытку.",
  "site.features.cleanup.title": "ИИ-чистка",
  "site.features.cleanup.body":
    "Исправляет неверно распознанные слова и названия брендов в субтитрах.",
  "site.features.captions.title": "Анимированные субтитры",
  "site.features.captions.body": "Несколько стилей — от Clean до Clipper.",
  "site.features.vertical.title": "Автовертикаль",
  "site.features.vertical.body": "Горизонтальное → 9:16 с трекингом лица.",
  "site.features.hooks.title": "Лучшие моменты — отдельными клипами",
  "site.features.hooks.body":
    "В видео от 90 секунд CleoCuts находит до {count} лучших моментов и делает из каждого отдельный короткий клип.",

  "site.steps.title": "Три шага.",
  "site.steps.sub": "Записывай. Говори с CleoCuts. Публикуй.",
  "site.steps.record.title": "Записывай",
  "site.steps.record.body": "Скажи {cut}, если ошибся. Никаких пересъёмок.",
  "site.steps.record.hint": "Дубли любой длины",
  "site.steps.upload.title": "Загружай",
  "site.steps.upload.body": "Загрузи видео. Выбери workflow. Остальное сделает ИИ.",
  "site.steps.upload.hint": "Пара минут — в зависимости от длины",
  "site.steps.post.title": "Публикуй",
  "site.steps.post.body": "Скачай готовое видео — оно подходит для TikTok, Instagram и YouTube.",
  "site.steps.post.hint": "Скачай, когда будет готово",

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
